/**
 * iter34 P3 — production bridge between OnboardingPipeline and the
 * orchestrator's processInboundEvent call site.
 *
 * Adam directive 2026-05-05 ("接近去啊要不然我们做他干嘛?? ... 现在状态
 * 是什么?? 为什么要说下一个回合做而不是直接做"). Bridge IS wired now.
 *
 * Function `runOnboardingPipelineTurn` is a drop-in for the legacy
 * `runDeterministicOnboardingTurn`: same input shape, same `{ handled,
 * action }` return. The CALLER (processInboundEvent) decides which to
 * dispatch based on `paOnboardingPipelineEnabled` flag.
 *
 * Safety net: any throw inside the pipeline (missing hook, judge crash,
 * Firestore tx hiccup) is logged + caught at the boundary. Caller falls
 * back to legacy automatically. This prevents flag-on users from getting
 * stuck if the new pipeline has incomplete coverage.
 *
 * Wiring scope (this commit):
 *   ✓ emit (sendDirect pattern: appendMessage + enqueueOutbound)
 *   ✓ FirestoreStateProvider on pa-users.{id}.pipelineState
 *   ✓ q_lang.onAccepted writes statedPreferences.preferredLang
 *   ✓ q_email.onAccepted delegates to legacy applyOnboarding
 *     "ask_q_email_verify_start" so Mailgun fires
 *   ✓ q_email_verify.onAccepted stamps contactEmailVerifiedAt
 *   ✓ q_tos.onAccepted advances state via applyOnboarding
 *   ✓ q_resume.onAccepted enqueues cv-ingest (delegates to legacy hook)
 *
 * Out of scope (Adam-deferred):
 *   ✗ postCollect job-match trigger (placeholder logger; integration in
 *     follow-up commit)
 */
import type { AgentDef, InboundEvent } from "@pa/core-types"
import { createHash } from "node:crypto"
import { OnboardingPipeline, type RunTurnResult } from "./pipeline.js"
import { defaultQuestionsV2 } from "./questions.js"
import { FirestorePipelineStateProvider } from "./state-firestore.js"
import { makePostCollectHook } from "./post-collect.js"
import type { Lang } from "./question.js"
import { composeInterimResumeAck } from "../onboarding-deterministic.js"
import { formatCvSummaryForUser } from "../cv-summary.js"
import {
  pollParsedCandidateResume,
  type PollParsedResumeOpts,
} from "./cv-poll.js"

export type PipelineLogFn = (event: string, payload: Record<string, unknown>) => void

export interface PipelineEmitDeps {
  appendMessage(args: {
    sessionId: string
    userId: string
    role: "assistant"
    body: string
    createdAt: string
    idempotencyKey: string
    rawMeta?: Record<string, unknown>
  }): Promise<void>
  enqueueOutbound(
    userId: string,
    to: string,
    body: string,
    opts: { sessionId: string; role: "assistant"; idempotencyKey: string }
  ): Promise<void>
  applyOnboarding?(
    userId: string,
    phoneE164: string,
    step: string,
    opts?: Record<string, unknown>
  ): Promise<void>
  // Loose typing — accepts the legacy OnboardingUser shape (which has many
  // optional fields beyond what we read here). We only need id/phoneE164.
  getOnboardingUser?(userId: string): Promise<{
    id: string
    phoneE164: string
    statedPreferences?: { preferredLang?: "zh" | "en" | "mixed" }
    [k: string]: unknown
  } | null>
  extractEmailIntent?: import("../index.js").OrchestratorStoreDeps["extractEmailIntent"]
  sendVerificationEmail?: import("../index.js").OrchestratorStoreDeps["sendVerificationEmail"]
  nowIso(): string
  log: PipelineLogFn
  /** Firestore handle. Optional — pipeline degrades to in-memory state when missing. */
  db?: unknown
  /**
   * iter34 Sprint A.6 — CV gate poll injection point. Tests pass a
   * fake `sleep` + `now` to fast-forward virtual time. Production
   * leaves these undefined so pollParsedCandidateResume uses real
   * setTimeout + Date.now.
   */
  cvPollOpts?: PollParsedResumeOpts
}

export interface RunPipelineTurnInput {
  event: InboundEvent
  turnId: string
  agent: AgentDef
  suppressOutbound: boolean
  deps: PipelineEmitDeps
}

export interface RunPipelineTurnResult {
  handled: boolean
  action: { kind: "pipeline" }
  raw?: RunTurnResult
}

/**
 * The bridged onboarding turn — drop-in for runDeterministicOnboardingTurn
 * for users who have `paOnboardingPipelineEnabled=true`.
 */
export async function runOnboardingPipelineTurn(
  input: RunPipelineTurnInput
): Promise<RunPipelineTurnResult> {
  const { event, turnId, deps, suppressOutbound } = input

  // Synthetic cv-ingest completion (`[cv-parsed]`). Not a user answer to
  // q_resume — ResumeJudge would bump/re-ask and swallow the event before
  // `runDeterministicOnboardingTurn` Route 4 (DiscussionPhase + job recs).
  const reply = (event.body ?? "").trim()
  if (reply.startsWith("[cv-parsed]")) {
    deps.log("pa.onboarding.pipeline.defer_cv_parsed_to_deterministic", {
      userId: event.userId,
      turnId,
      eventId: event.id,
    })
    return { handled: false, action: { kind: "pipeline" } }
  }

  // Resolve user phone for outbound. The pipeline doesn't carry user
  // metadata so we read it once via getOnboardingUser if available.
  let phoneE164: string = event.from
  if (deps.getOnboardingUser) {
    const u = await deps.getOnboardingUser(event.userId)
    if (u?.phoneE164) phoneE164 = u.phoneE164
  }

  // sendDirect-equivalent emit. Mirrors packages/pa-orchestrator/src/
  // onboarding-deterministic.ts sendDirect():
  //   1. appendMessage assistant turn (idempotent)
  //   2. enqueueOutbound (skipped on suppress)
  const emit: Parameters<typeof OnboardingPipeline.prototype.startTurn> extends never
    ? never
    : (text: string, meta: { qId: string | null; kind: string }) => Promise<void> = async (
    text,
    meta
  ) => {
    if (!text) return
    const at = deps.nowIso()
    await deps.appendMessage({
      sessionId: event.sessionId,
      userId: event.userId,
      role: "assistant",
      body: text,
      createdAt: at,
      idempotencyKey: `out-pipeline-${event.id}-${meta.qId ?? "x"}-${meta.kind}`,
      rawMeta: {
        source: "pa_orchestrator",
        turnId,
        eventId: event.id,
        onboarding: "pipeline",
        qId: meta.qId,
        kind: meta.kind,
      },
    })
    if (suppressOutbound) return
    await deps.enqueueOutbound(event.userId, phoneE164, text, {
      sessionId: event.sessionId,
      role: "assistant",
      idempotencyKey: `outbound-pipeline-${event.id}-${meta.qId ?? "x"}-${meta.kind}`,
    })
  }

  // State lives in Firestore at pa-users/{id}.pipelineState — separate
  // from legacy `onboardingState` so the cutover is safe-rollback.
  const state = deps.db
    ? new FirestorePipelineStateProvider({ db: deps.db as never })
    : null
  if (!state) {
    // No db means we can't run pipeline statefully. Bail; caller falls back.
    deps.log("pa.onboarding.pipeline.no_db_skip", { userId: event.userId, turnId })
    throw new Error("runOnboardingPipelineTurn: db required for state persistence")
  }

  // Build defaultQuestionsV2 with concrete onAccepted hooks that delegate
  // to the legacy applyOnboarding store method so existing state writes
  // (preferredLang, contactEmail, emailVerification, contactEmailVerifiedAt,
  // resume request) carry over without re-implementation. This keeps the
  // pipeline + legacy paths writing the SAME shape.
  const questions = defaultQuestionsV2({
    extractEmailIntent: deps.extractEmailIntent ?? (async () => null),
    onLangAccepted: async (lang, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_lang.accepted", { userId: ctx.userId, lang })
      if (deps.applyOnboarding) {
        // iter34 hotfix 2026-05-05 — Adam directive "为什么还在用 regex??".
        // Pass canonical Judge output via `parsedAnswer`, no re-parse.
        const fsLang: "zh" | "en" | "mixed" = lang === "mixed" ? "mixed" : lang
        await deps.applyOnboarding(event.userId, phoneE164, "ask_q_email", {
          parsedAnswer: { preferredLang: fsLang },
        })
      }
    },
    onEmailAccepted: async (email, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_email.accepted", { userId: ctx.userId, email })
      if (deps.applyOnboarding) {
        const sent = deps.sendVerificationEmail
          ? await deps.sendVerificationEmail(email)
          : null
        const emailVerification = sent
          ? {
              codeHash: createHash("sha256").update(sent.rawCode).digest("hex"),
              email,
              sentAt: sent.sentAt,
              expiresAt: sent.expiresAt,
              ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}),
            }
          : undefined
        await deps.applyOnboarding(event.userId, phoneE164, "ask_q_email_verify", {
          parsedAnswer: { contactEmail: email },
          ...(emailVerification ? { emailVerification } : {}),
        })
      }
    },
    onEmailCodeVerified: async (_code, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_email_verify.accepted", { userId: ctx.userId })
      if (deps.applyOnboarding) {
        await deps.applyOnboarding(event.userId, phoneE164, "ask_q_tos", {
          emailVerificationVerified: true,
          parsedAnswer: { contactEmailVerifiedAt: deps.nowIso() },
        })
      }
    },
    // iter34 hotfix 2026-05-05 — wire previously-deferred probe Q hooks.
    // VisaJudge / RoleJudge / etc produce canonical values; we pass them
    // via parsedAnswer so applyOnboarding writes statedPreferences without
    // any regex re-parse.
    onRoleAccepted: async (role, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_role.accepted", { userId: ctx.userId, role })
      if (deps.applyOnboarding && Array.isArray(role) && role.length > 0) {
        await deps.applyOnboarding(event.userId, phoneE164, "ask_q_yoe", {
          parsedAnswer: { targetRole: role },
        })
      }
    },
    onYoeAccepted: async (yoe, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_yoe.accepted", { userId: ctx.userId, yoe })
      if (deps.applyOnboarding) {
        const yoeRange: [number, number] | null =
          yoe === "fresh" || yoe === 0
            ? [0, 1]
            : typeof yoe === "number" && Number.isFinite(yoe)
              ? [yoe, yoe]
              : null
        await deps.applyOnboarding(event.userId, phoneE164, "ask_q_visa", {
          parsedAnswer: { yoeRange },
        })
      }
    },
    onVisaAccepted: async (visa, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_visa.accepted", { userId: ctx.userId, visa })
      if (deps.applyOnboarding && typeof visa === "string") {
        // Map LLM-extracted visa intent to our canonical VisaStatus enum.
        const norm = (visa as string).toLowerCase()
        const visaStatus =
          norm === "citizen" ? "citizen"
          : norm === "gc" || norm === "green_card" || norm === "permanent_resident" ? "gc"
          : norm === "opt" || norm === "cpt" || norm === "h1b" || norm === "sponsorship" || norm === "sponsorship_needed" ? "sponsorship_needed"
          : "unknown"
        await deps.applyOnboarding(event.userId, phoneE164, "ask_q_startup_pref", {
          parsedAnswer: { visaStatus },
        })
      }
    },
    onStartupPrefAccepted: async (pref, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_startup_pref.accepted", { userId: ctx.userId, pref })
      if (deps.applyOnboarding) {
        // pref ∈ "startup" | "bigtech" | "either"
        const prefersStartup =
          pref === "startup" ? true : pref === "bigtech" ? false : null
        await deps.applyOnboarding(event.userId, phoneE164, "ask_q_country", {
          parsedAnswer: { prefersStartup },
        })
      }
    },
    onCountryAccepted: async (country, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_country.accepted", { userId: ctx.userId, country })
      if (deps.applyOnboarding) {
        const targetCountry = Array.isArray(country) ? country : []
        await deps.applyOnboarding(event.userId, phoneE164, "ask_q_location", {
          parsedAnswer: { targetCountry },
        })
      }
    },
    onLocationAccepted: async (loc, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_location.accepted", { userId: ctx.userId, loc })
      if (deps.applyOnboarding) {
        const arr = Array.isArray(loc) ? loc : []
        await deps.applyOnboarding(event.userId, phoneE164, "ask_q_resume", {
          parsedAnswer: { targetLocations: arr },
        })
      }
    },
    onResumeAccepted: async (_attachments, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_resume.accepted", { userId: ctx.userId })
      await runResumeAcceptedFlow({
        userId: event.userId,
        phoneE164,
        getOnboardingUser: deps.getOnboardingUser,
        applyOnboarding: deps.applyOnboarding,
        emit,
        db: deps.db,
        log: deps.log,
        cvPollOpts: deps.cvPollOpts,
        preferredLang: ctx.lang,
      })
    },
  })

  const haltMessageDefault = {
    zh: "请联系 admin1@wekruit.com 解决问题. 你现在连续失败了五次, 请不要继续",
    en: "please contact admin1@wekruit.com — you've failed 5 times in a row, please stop",
  }

  const postCollect = makePostCollectHook({
    triggerJobMatch: async (args, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.post_collect.job_match_stub", {
        userId: ctx.userId,
        fields: Object.keys(args.collected),
      })
      // Future: write a pa-job-match-triggers doc that the matching
      // worker subscribes to. Stubbed for now so postCollect is a no-op
      // beyond the audit log.
    },
  })

  const pipeline = new OnboardingPipeline({
    questions,
    state,
    haltMessageDefault,
    emit: emit as unknown as OnboardingPipeline["opts"]["emit"],
    postCollect,
    log: deps.log,
    db: deps.db,
  })

  const result = await pipeline.startTurn({
    userId: event.userId,
    turnId,
    reply: event.body ?? "",
    rawPayload: event.rawMeta,
  })

  return {
    handled: result.handled,
    action: { kind: "pipeline" },
    raw: result,
  }
}

/**
 * iter34 Sprint A.6 — exported for testability + reuse from any path
 * that fires "user just sent a resume". Does the full sequence:
 *   1. Resolve user lang (from statedPreferences.preferredLang).
 *   2. Emit interim ack ("OK 让我看一下你简历, 等我一下下" + variants).
 *   3. Poll parsedCandidateResumes up to 90s.
 *   4. Emit either:
 *        - tag-summary line (formatCvSummaryForUser) when poll succeeded
 *        - "still parsing, going by chat" line on timeout
 *   5. applyOnboarding("complete", {}) so caller's match pipeline runs
 *      AFTER the user has SEEN what CV signal we have. This is the fix
 *      for the iter34 bug where generateJobRecs was running with empty CV.
 */
export interface RunResumeAcceptedFlowInput {
  userId: string
  phoneE164: string
  getOnboardingUser?: PipelineEmitDeps["getOnboardingUser"]
  applyOnboarding?: PipelineEmitDeps["applyOnboarding"]
  emit: (
    text: string,
    meta: { qId: string | null; kind: string }
  ) => Promise<void>
  db?: unknown
  log: PipelineLogFn
  cvPollOpts?: PipelineEmitDeps["cvPollOpts"]
  preferredLang?: "zh" | "en" | "mixed"
}

export async function runResumeAcceptedFlow(
  input: RunResumeAcceptedFlowInput
): Promise<void> {
  const {
    userId,
    phoneE164,
    getOnboardingUser,
    applyOnboarding,
    emit,
    db,
    log,
    cvPollOpts,
    preferredLang,
  } = input

  // Step 1 — resolve user lang. The active pipeline turn wins; stored
  // preference is a fallback for non-pipeline callers.
  let userLang: "zh" | "en" | "mixed" = preferredLang ?? "zh"
  if (!preferredLang && getOnboardingUser) {
    try {
      const u = await getOnboardingUser(userId)
      const pref = u?.statedPreferences?.preferredLang
      if (pref === "mixed") userLang = "mixed"
      else if (pref === "en") userLang = "en"
      else userLang = "zh"
    } catch (err) {
      log("pa.onboarding.cv_flow.lang_resolve_error", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Step 2 — interim ack. iter 7 helper provides variants.
  const ackMsg = composeInterimResumeAck(userLang)
  await emit(ackMsg, { qId: "q_resume", kind: "cv_interim_ack" })

  // Step 3 — poll cv-ingest output.
  const pollResult = await pollParsedCandidateResume(db, userId, {
    ...cvPollOpts,
    log,
  })

  // Step 4 — tag-summary message.
  let summaryMsg: string
  if (pollResult.timedOut) {
    summaryMsg =
      userLang === "zh"
        ? "简历还在分析, 我先按你聊的方向找; 等我搞完会再调"
        : userLang === "en"
          ? "resume still parsing — going by what you told me for now, i'll retune once it lands"
          : "简历还在 parsing, 我先按你聊的方向找; 等 done 了再调"
  } else if (pollResult.cv) {
    summaryMsg = formatCvSummaryForUser(pollResult.cv, userLang)
  } else {
    // Defensive — pollResult was non-timeout but cv null. Shouldn't
    // happen; treat as "couldn't extract much" fallback.
    summaryMsg =
      userLang === "zh"
        ? "简历看了一下, 信息不多, 我按你聊的方向先推"
        : userLang === "en"
          ? "skimmed your resume — not much in there, going by chat for now"
          : "看了一下 CV, 信息不多, 我按你聊的方向先推"
  }
  await emit(summaryMsg, { qId: "q_resume", kind: "cv_summary_tag" })

  // Step 5 — advance state. Caller's match pipeline (postCollect →
  // triggerJobMatch + legacy generateJobRecs) runs after this and now
  // gets a populated parsedCandidateResumes row when poll succeeded.
  if (applyOnboarding) {
    await applyOnboarding(userId, phoneE164, "complete", {})
  }
}
