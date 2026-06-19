/**
 * v2.1 S2 — Voice turn loop.
 *
 * Single entry point invoked when STT commits a final user transcript:
 *
 *   user_speech_committed (final transcript)
 *     ↓
 *   PII gate (L6 redactor) — applied to AGENT output, not user input
 *     ↓
 *   PreScreenPipeline.runTurn(input)
 *     ↓
 *   redactForVoice(agentText, profile)
 *     ↓
 *   speakText returned to caller (entrypoint calls session.say)
 *
 * The pipeline + loaders are DEPENDENCY INJECTED so tests can use scripted
 * fakes without booting Firestore Admin or the LiveKit Agents SDK.
 *
 * Lock compliance:
 *   L1: pipeline imported from `@pa/pa-orchestrator` — agent-runtime is NOT
 *       called from this module (pipeline owns LLM, if any, via composeClarify).
 *   L2: pipeline.runTurn is the single scoring call site.
 *   L6: PII handler always runs against the agent text BEFORE TTS.
 */

import { redactForVoice, type PiiHandoffToken } from "./pii-handler.js"
import type { VoiceCallContext, VoiceLang } from "./voice-context-types.js"

/**
 * Local alias matching `@pa/pa-orchestrator`'s internal `Lang` type. We do
 * NOT import from pa-orchestrator at runtime — the pipeline is dependency-
 * injected so the worker stays light. This must stay in sync with
 * `packages/pa-orchestrator/src/onboarding/question.ts` `type Lang`.
 */
type Lang = VoiceLang

// We import the type only; the runtime instance is dependency-injected. This
// keeps tests from booting the full pipeline.
type RunTurnInputLite = {
  sessionId: string
  reply: string
  lang: Lang
  nowIso: string
  judgeCtx: {
    userId: string
    turnId: string
    rawPayload?: unknown
    db?: unknown
    log?: (event: string, payload: Record<string, unknown>) => void
  }
}

// We don't pull the full RunTurnResult type from pa-orchestrator (that would
// pull the whole orchestrator-deps chain into the voice worker). The shape
// below tracks @pa/pa-orchestrator's PreScreenPipeline.runTurn return.
export type RunTurnActionLite =
  | { kind: "clarify"; qId: string; kAfter: number }
  | { kind: "advance"; fromQId: string; toQId: string }
  | { kind: "terminal"; terminal: string; reason: string }
  | { kind: "complete"; reason?: string }
  | { kind: "error"; reason: string }

export interface RunTurnResultLite {
  text: string
  action: RunTurnActionLite
  state?: unknown
}

export interface VoicePipelineLite {
  runTurn(input: RunTurnInputLite): Promise<RunTurnResultLite>
}

export interface TurnEvent {
  bookingId: string
  qIdBefore: string | null
  action: RunTurnActionLite
  redacted: boolean
  emitChars: number
  smsHandoffTokens: PiiHandoffToken[]
  /** ms between `onUserCommit` entry and pipeline `runTurn` resolve. */
  pipelineLatencyMs: number
  /** S4 will fill this from session_usage_updated. Always undefined in S2. */
  ttfaMs?: number
}

export interface TurnLoopDeps {
  pipeline: VoicePipelineLite
  context: VoiceCallContext
  /** Optional metric/observer hook (S4 plugs its writer here). */
  onTurn?: (event: TurnEvent) => void
  log?: (event: string, payload: Record<string, unknown>) => void
  /** Test seam — defaults to Date.now. */
  now?: () => number
}

export interface OnUserCommitInput {
  reply: string
  nowIso: string
  lang?: Lang
}

export interface OnUserCommitOutput {
  /** Safe text to TTS. Empty string when redaction ate everything. */
  speakText: string
  /** True iff PII redaction occurred. */
  redacted: boolean
  /** SMS handoff slices for S5's dispatcher. */
  smsHandoffTokens: PiiHandoffToken[]
  /** Echo of the pipeline action so the entrypoint can detect terminals. */
  action: RunTurnActionLite
}

export function createTurnLoop(deps: TurnLoopDeps) {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Date.now())

  return {
    /** Invoked once per finalized STT transcript. */
    async onUserCommit(input: OnUserCommitInput): Promise<OnUserCommitOutput> {
      const started = now()
      const lang: Lang = input.lang ?? deps.context.userProfile.preferredLang ?? "en"

      const qIdBefore =
        deps.context.purpose === "prescreen"
          ? deps.context.prescreenConfig.questions[0]?.qId ?? null
          : null

      log("voice.turn.runTurn.start", {
        bookingId: deps.context.bookingId,
        replyLen: input.reply.length,
        lang,
      })

      const result = await deps.pipeline.runTurn({
        sessionId:
          deps.context.purpose === "prescreen"
            ? deps.context.prescreenSessionId
            : deps.context.bookingId,
        reply: input.reply,
        lang,
        nowIso: input.nowIso,
        judgeCtx: {
          userId: deps.context.userProfile.userId,
          turnId: `${deps.context.bookingId}:${input.nowIso}`,
          log,
        },
      })

      const pipelineLatencyMs = now() - started

      const pii = redactForVoice({
        agentText: result.text,
        profile: deps.context.userProfile,
      })

      const event: TurnEvent = {
        bookingId: deps.context.bookingId,
        qIdBefore,
        action: result.action,
        redacted: pii.redacted,
        emitChars: pii.speakText.length,
        smsHandoffTokens: pii.smsHandoffTokens,
        pipelineLatencyMs,
      }

      log("voice.turn.runTurn.done", {
        bookingId: deps.context.bookingId,
        action: result.action.kind,
        redacted: pii.redacted,
        speakChars: pii.speakText.length,
        pipelineLatencyMs,
      })

      try {
        deps.onTurn?.(event)
      } catch (err) {
        // Telemetry hook MUST NOT crash the turn loop.
        log("voice.turn.onTurn.threw", {
          bookingId: deps.context.bookingId,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      return {
        speakText: pii.speakText,
        redacted: pii.redacted,
        smsHandoffTokens: pii.smsHandoffTokens,
        action: result.action,
      }
    },
  }
}
