/**
 * iter34 P3 — production bridge between OnboardingPipeline and the
 * orchestrator's processInboundEvent call site.
 *
 * Adam directive 2026-05-05 (wire it now, do not defer to a later turn).
 * Bridge IS wired now.
 *
 * Function `runOnboardingPipelineTurn` is the onboarding runtime used by
 * `runDeterministicOnboardingTurn`. The caller does not flag-gate it or
 * route to any alternate composer; pipeline failures surface as runtime
 * failures so we do not silently send from a parallel path.
 *
 * Wiring scope (this commit):
 *   ✓ emit (sendDirect pattern: appendMessage + enqueueOutbound)
 *   ✓ FirestoreStateProvider on pa-users.{id}.pipelineState
 *   ✓ q_tos.onAccepted advances state via applyOnboarding
 *   ✓ q_resume.onAccepted enqueues cv-ingest (delegates to legacy hook)
 *
 * Out of scope (Adam-deferred):
 *   ✗ postCollect job-match trigger (placeholder logger; integration in
 *     follow-up commit)
 */
import type { AgentDef, InboundEvent } from "@pa/core-types"
import {
  OnboardingPipeline,
  emptyPipelineState,
  type PipelineStateProvider,
  type RunTurnResult,
} from "./pipeline.js"
import { defaultQuestionsV2 } from "./questions.js"
import { FirestorePipelineStateProvider } from "./state-firestore.js"
import { InMemoryPipelineStateProvider } from "./state-memory.js"
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
    onboardingState?: string
    pipelineState?: { currentQId?: string | null }
    statedPreferences?: { preferredLang?: "zh" | "en" | "mixed" }
    [k: string]: unknown
  } | null>
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

function pipelineQIdFromOnboardingState(state: string | undefined | null): string | null {
  switch (state) {
    case "q_lang_asked":
    case "first_mes_sent":
      return "q_tos"
    case "q_tos_asked":
      return "q_tos"
    case "grounding_q1_asked":
    case "q_role_asked":
      return "q_role"
    case "q_yoe_asked":
      return "q_yoe"
    case "q_visa_asked":
      return "q_visa"
    case "q_startup_pref_asked":
      return "q_startup_pref"
    case "q_country_asked":
      return "q_country"
    case "q_location_asked":
      return "q_location"
    case "q_resume_asked":
      return "q_resume"
    default:
      return null
  }
}

function supportsFirestorePipelineState(db: unknown): boolean {
  return (
    typeof db === "object" &&
    db !== null &&
    typeof (db as { runTransaction?: unknown }).runTransaction === "function"
  )
}

async function seedPipelineStateFromLegacy(input: {
  state: PipelineStateProvider
  userId: string
  onboardingState?: string
  preferredLang?: "zh" | "en" | "mixed"
  userMessage?: string
  log: PipelineLogFn
  turnId: string
}): Promise<void> {
  const qId = pipelineQIdFromOnboardingState(input.onboardingState)
  const current = await input.state.load(input.userId)
  if (current.currentQId || current.completed || current.halted) {
    const nextCurrentQId = current.currentQId === "q_lang" ? "q_tos" : current.currentQId
    const nextHalted = current.halted?.qId === "q_lang" ? null : current.halted
    if (current.lang !== "en" || nextCurrentQId !== current.currentQId || nextHalted !== current.halted) {
      await input.state.save(input.userId, {
        ...current,
        currentQId: nextCurrentQId,
        halted: nextHalted,
        lang: "en",
      })
      input.log("pa.onboarding.pipeline.beta_english_state_normalized", {
        userId: input.userId,
        turnId: input.turnId,
        previousQId: current.currentQId,
        nextQId: nextCurrentQId,
        clearedLangHalt: current.halted?.qId === "q_lang",
      })
    }
    return
  }
  if (!qId) {
    await input.state.save(input.userId, {
      ...emptyPipelineState(),
      ...current,
      lang: "en",
    })
    return
  }
  const seeded = {
    ...emptyPipelineState(),
    ...current,
    currentQId: qId,
    lang: "en" as const,
  }
  await input.state.save(input.userId, seeded)
  input.log("pa.onboarding.pipeline.seeded_from_legacy_state", {
    userId: input.userId,
    turnId: input.turnId,
    onboardingState: input.onboardingState ?? null,
    qId,
  })
}

/**
 * The bridged onboarding turn used by the single onboarding dispatcher.
 */
export async function runOnboardingPipelineTurn(
  input: RunPipelineTurnInput
): Promise<RunPipelineTurnResult> {
  const { event, turnId, deps, suppressOutbound } = input

  if (event.rawMeta?.runtimeEvent === true) {
    deps.log("pa.onboarding.pipeline.reject_runtime_event", {
      userId: event.userId,
      turnId,
      eventId: event.id,
      runtimeEventSource: event.rawMeta.runtimeEventSource,
      runtimeEventKind: event.rawMeta.runtimeEventKind,
    })
    return { handled: false, action: { kind: "pipeline" } }
  }

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
  let onboardingUser:
    | Awaited<ReturnType<NonNullable<PipelineEmitDeps["getOnboardingUser"]>>>
    | null = null
  if (deps.getOnboardingUser) {
    onboardingUser = await deps.getOnboardingUser(event.userId)
    if (onboardingUser?.phoneE164) phoneE164 = onboardingUser.phoneE164
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

  // State lives in Firestore at pa-users/{id}.pipelineState in production.
  // Tests and isolated harnesses without Firestore use the same pipeline
  // with an in-memory provider; the message-generation path remains identical.
  const state = supportsFirestorePipelineState(deps.db)
    ? new FirestorePipelineStateProvider({ db: deps.db as never })
    : new InMemoryPipelineStateProvider()

  await seedPipelineStateFromLegacy({
    state,
    userId: event.userId,
    onboardingState: onboardingUser?.onboardingState,
    preferredLang: onboardingUser?.statedPreferences?.preferredLang,
    userMessage: event.body,
    log: deps.log,
    turnId,
  })

  // Build defaultQuestionsV2 with concrete onAccepted hooks that delegate
  // to the legacy applyOnboarding store method so existing state writes
  // carry over without re-implementation. Website registration owns email;
  // this pipeline never asks for it.
  const questions = defaultQuestionsV2({
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
    zh: "please contact admin1@wekruit.com — you've failed 5 times in a row, please stop",
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
 *   2. Emit interim ack ("ok — give me a sec to read your resume" + variants).
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
    summaryMsg = "resume still parsing — going by what you told me for now, i'll retune once it lands"
  } else if (pollResult.cv) {
    summaryMsg = formatCvSummaryForUser(pollResult.cv, userLang)
  } else {
    // Defensive — pollResult was non-timeout but cv null. Shouldn't
    // happen; treat as "couldn't extract much" fallback.
    summaryMsg = "skimmed your resume — not much in there, going by chat for now"
  }
  await emit(summaryMsg, { qId: "q_resume", kind: "cv_summary_tag" })

  // Step 5 — advance state. Caller's match pipeline (postCollect →
  // triggerJobMatch + legacy generateJobRecs) runs after this and now
  // gets a populated parsedCandidateResumes row when poll succeeded.
  if (applyOnboarding) {
    await applyOnboarding(userId, phoneE164, "complete", {})
  }
}
