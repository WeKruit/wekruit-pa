/**
 * iter34 P3 — pipeline bridge (NOT YET WIRED into processInboundEvent).
 *
 * This module hosts the integration shim between the Q-as-class
 * OnboardingPipeline and the orchestrator's existing call site
 * (packages/pa-orchestrator/src/index.ts → processInboundEvent →
 * runDeterministicOnboardingTurn). The shim:
 *
 *   1. Builds an OnboardingPipeline with FirestoreStateProvider +
 *      defaultQuestions() composed against orchestrator deps
 *      (extractAnswerIntent / extractEmailIntent / Mailgun verify /
 *      cv-ingest worker / job-rec trigger).
 *   2. Calls pipeline.startTurn(input).
 *   3. Translates the pipeline's emit callback into orchestrator
 *      outbound calls (sendDirect / sendMemoryReply with proper event
 *      tagging + retry semantics).
 *   4. Returns a result shape compatible with runDeterministicOnboardingTurn
 *      so the call site can swap with a single feature-flag check.
 *
 * Status: exported but UNUSED. Integration into processInboundEvent
 * happens in iter34 P3 follow-up after Adam reviews the abstraction
 * design + decides per-user vs global rollout cadence.
 *
 * Rollout plan once integration lands:
 *   - paOnboardingPipelineEnabled flag, default OFF
 *   - Allowlist by userId for initial test (Adam's UID first)
 *   - Backfill tool reads legacy onboardingState → derives pipelineState
 *     so existing in-flight users continue cleanly
 *   - Global flip after E2E parity confirmed against legacy path
 */
import type { Lang } from "./question.js"
import { OnboardingPipeline, type PipelineStateProvider, type RunTurnResult, type TurnEmitKind } from "./pipeline.js"
import { defaultQuestions, type DefaultQuestionsDeps } from "./questions.js"
import { makePostCollectHook, type PostCollectDeps } from "./post-collect.js"

export interface OnboardingPipelineBridgeDeps extends DefaultQuestionsDeps, PostCollectDeps {
  state: PipelineStateProvider
  /**
   * Emit callback — receives the text to send + metadata. Concrete impl
   * lives in apps/functions and routes to sendMemoryReply or sendDirect
   * with proper inboundEventId tagging.
   */
  emit: (
    text: string,
    meta: { qId: string | null; kind: TurnEmitKind; userId: string; turnId: string }
  ) => Promise<void>
  /** Logger (event, payload). */
  log?: (event: string, payload: Record<string, unknown>) => void
  /** Firestore handle for judges that need it (CodeJudge, etc.). */
  db?: unknown
  /**
   * Default halt message override. Falls back to the persona-locked
   * "请联系 admin1@wekruit.com 解决问题..." string.
   */
  haltMessageDefault?: { zh: string; en: string }
}

/**
 * Returns a function that takes a single inbound turn and runs it through
 * the OnboardingPipeline. Build once at orchestrator boot, call per turn.
 */
export function buildOnboardingPipeline(deps: OnboardingPipelineBridgeDeps) {
  const halt = deps.haltMessageDefault ?? {
    zh: "请联系 admin1@wekruit.com 解决问题. 你现在连续失败了五次, 请不要继续",
    en: "please contact admin1@wekruit.com — you've failed 5 times in a row, please stop",
  }

  const postCollect = makePostCollectHook({
    enrichResume: deps.enrichResume,
    triggerJobMatch: deps.triggerJobMatch,
  })

  const questions = defaultQuestions(deps)

  return new OnboardingPipeline({
    questions,
    state: deps.state,
    haltMessageDefault: halt,
    emit: async (text, meta) => {
      // Forward to caller-provided emit. The bridge layer passes through
      // userId + turnId so the outbound is properly tagged.
      // userId/turnId come from the closure that invoked startTurn.
      // We snapshot them via a per-turn wrapper below.
      throw new Error(
        "[onboarding-bridge] emit must be wrapped per-turn — use runOnboardingPipelineTurn instead of calling pipeline.emit directly"
      )
    },
    postCollect,
    log: deps.log,
    db: deps.db,
  })
}

export interface RunPipelineTurnInput {
  userId: string
  turnId: string
  reply: string
  rawPayload?: unknown
}

export interface RunPipelineTurnDeps extends OnboardingPipelineBridgeDeps {}

/**
 * Run a single onboarding turn through the pipeline. Returns a result
 * shape comparable to runDeterministicOnboardingTurn so the legacy call
 * site can swap behind a feature flag with minimal change.
 */
export async function runOnboardingPipelineTurn(
  input: RunPipelineTurnInput,
  deps: RunPipelineTurnDeps
): Promise<{ handled: boolean; result?: RunTurnResult }> {
  const halt = deps.haltMessageDefault ?? {
    zh: "请联系 admin1@wekruit.com 解决问题. 你现在连续失败了五次, 请不要继续",
    en: "please contact admin1@wekruit.com — you've failed 5 times in a row, please stop",
  }
  const postCollect = makePostCollectHook({
    enrichResume: deps.enrichResume,
    triggerJobMatch: deps.triggerJobMatch,
  })
  const questions = defaultQuestions(deps)
  const pipeline = new OnboardingPipeline({
    questions,
    state: deps.state,
    haltMessageDefault: halt,
    // Per-turn emit wrapper — passes userId + turnId from input into the
    // bridge's emit, enabling proper outbound tagging.
    emit: async (text, meta) => {
      await deps.emit(text, {
        ...meta,
        userId: input.userId,
        turnId: input.turnId,
      })
    },
    postCollect,
    log: deps.log,
    db: deps.db,
  })

  const result = await pipeline.startTurn({
    userId: input.userId,
    turnId: input.turnId,
    reply: input.reply,
    rawPayload: input.rawPayload,
  })
  return { handled: result.handled, result }
}
