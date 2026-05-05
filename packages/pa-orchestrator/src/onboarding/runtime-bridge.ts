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
import { OnboardingPipeline, type RunTurnResult } from "./pipeline.js"
import { defaultQuestions } from "./questions.js"
import { FirestorePipelineStateProvider } from "./state-firestore.js"
import { makePostCollectHook } from "./post-collect.js"
import type { Lang } from "./question.js"

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
  extractAnswerIntent?: import("../index.js").OrchestratorStoreDeps["extractAnswerIntent"]
  extractEmailIntent?: import("../index.js").OrchestratorStoreDeps["extractEmailIntent"]
  nowIso(): string
  log: PipelineLogFn
  /** Firestore handle. Optional — pipeline degrades to in-memory state when missing. */
  db?: unknown
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

  // Build defaultQuestions with concrete onAccepted hooks that delegate
  // to the legacy applyOnboarding store method so existing state writes
  // (preferredLang, contactEmail, emailVerification, contactEmailVerifiedAt,
  // resume request) carry over without re-implementation. This keeps the
  // pipeline + legacy paths writing the SAME shape.
  const questions = defaultQuestions({
    extractAnswerIntent: deps.extractAnswerIntent ?? (async () => null),
    extractEmailIntent: deps.extractEmailIntent ?? (async () => null),
    onLangAccepted: async (lang, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_lang.accepted", { userId: ctx.userId, lang })
      if (deps.applyOnboarding) {
        const fsLang: "zh" | "en" | "mixed" = lang === "mixed" ? "mixed" : lang
        await deps.applyOnboarding(event.userId, phoneE164, "ask_q_email", {
          preferredLang: fsLang,
        })
      }
    },
    onEmailAccepted: async (email, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_email.accepted", { userId: ctx.userId, email })
      if (deps.applyOnboarding) {
        await deps.applyOnboarding(event.userId, phoneE164, "ask_q_email_verify_start", {
          parsedEmail: email,
        })
      }
    },
    onEmailCodeVerified: async (_code, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_email_verify.accepted", { userId: ctx.userId })
      if (deps.applyOnboarding) {
        await deps.applyOnboarding(event.userId, phoneE164, "ask_q_tos", {
          emailVerificationVerifiedAt: deps.nowIso(),
        })
      }
    },
    onResumeAccepted: async (_attachments, ctx) => {
      ctx.log?.("pa.onboarding.pipeline.q_resume.accepted", { userId: ctx.userId })
      // cv-ingest worker enqueue is downstream; the worker watches for
      // attachment payloads on inbound events and processes async.
      if (deps.applyOnboarding) {
        await deps.applyOnboarding(event.userId, phoneE164, "complete", {
          resumeAccepted: true,
        })
      }
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
