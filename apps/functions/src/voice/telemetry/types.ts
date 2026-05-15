/**
 * S4 — Voice turn telemetry public types.
 *
 * Sprint contract: S2 voice worker (LiveKit Cloud Agent) imports this
 * `VoiceCallTelemetryHook` interface at session start and forwards
 * LiveKit Agents events into it. S4 owns the implementation behind the
 * interface (writer + cost ceiling watchdog). S2 does NOT need to know
 * the Firestore shape — it only calls hook methods.
 *
 * Locks:
 *   - L11 cost ceiling: $1/call hard stop, fired exactly once via
 *     `CostCeilingCallback` registered at session start.
 *   - Hook methods are SDK-version stable: S2 normalizes whichever
 *     LiveKit event variant it consumes (v0 `user_speech_committed`
 *     vs. v1 `user_input_transcribed` with `is_final=true`) into the
 *     stable `onUserSpeechCommitted` callback.
 */

/** Per-turn metric row written to `voice-call-metrics/{sid}/turns/{i}`. */
export interface VoiceTurnMetric {
  voiceCallSid: string
  turnIndex: number
  startedAt: number
  endedAt: number
  ttfaMs: number | null
  userUtteranceMs: number | null
  agentResponseMs: number | null
  falseCommit: boolean
  falseInterruption: boolean
  costUsd: number
  llmTokensIn: number
  llmTokensOut: number
  sttSeconds: number
  ttsSeconds: number
  transcriptUser: string | null
  transcriptAgent: string | null
  /** Firestore TTL field — default 90 days from row insert. */
  expiresAt: number
}

/** Call-level lifecycle doc written to `voice-call-metrics/{sid}`. */
export interface VoiceCallLifecycle {
  voiceCallSid: string
  paUserId: string | null
  paJobId: string | null
  startedAt: number
  endedAt: number | null
  turnCount: number
  totalCostUsd: number
  runningLlmTokensIn: number
  runningLlmTokensOut: number
  runningSttSeconds: number
  runningTtsSeconds: number
  status: VoiceCallStatus
  costWarningAt: number | null
  costExceededAt: number | null
  expiresAt: number
}

export type VoiceCallStatus =
  | "in_progress"
  | "completed"
  | "failed:cost_ceiling"
  | "failed:other"

/**
 * Runtime hook S2 wires at start-of-call.
 *
 * Lifecycle:
 *   1. onSessionStart            — exactly once, creates lifecycle doc.
 *   2. onUserSpeechCommitted     — once per user turn (final STT segment).
 *   3. onAgentFirstAudio         — once per turn, earliest agent audio.
 *   4. onFalseInterruption       — zero+ times per turn.
 *   5. onSessionUsageUpdated     — zero+ times, idempotent; running totals.
 *   6. onAgentTurnEnded          — once per turn, flushes the turn row.
 *   7. onSessionClose            — exactly once, finalizes lifecycle doc.
 *
 * No method throws. All Firestore work is awaited where the caller awaits.
 */
export interface VoiceCallTelemetryHook {
  onSessionStart(args: SessionStartArgs): Promise<void>
  onUserSpeechCommitted(args: UserSpeechCommittedArgs): void
  onAgentFirstAudio(args: AgentFirstAudioArgs): void
  onAgentTurnEnded(args: AgentTurnEndedArgs): Promise<void>
  onFalseInterruption(args: FalseInterruptionArgs): void
  onSessionUsageUpdated(args: SessionUsageUpdatedArgs): Promise<void>
  onSessionClose(args: SessionCloseArgs): Promise<void>
}

export interface SessionStartArgs {
  voiceCallSid: string
  paUserId: string | null
  paJobId: string | null
  startedAt: number
}

export interface UserSpeechCommittedArgs {
  voiceCallSid: string
  at: number
  transcript: string | null
}

export interface AgentFirstAudioArgs {
  voiceCallSid: string
  at: number
}

export interface AgentTurnEndedArgs {
  voiceCallSid: string
  at: number
  transcript: string | null
  sttSeconds: number
  ttsSeconds: number
  llmTokensIn: number
  llmTokensOut: number
  /** Optional explicit turn cost override; otherwise derived from usage updates. */
  turnCostUsd?: number
}

export interface FalseInterruptionArgs {
  voiceCallSid: string
  at: number
}

export interface SessionUsageUpdatedArgs {
  voiceCallSid: string
  at: number
  runningCostUsd: number
  runningLlmTokensIn: number
  runningLlmTokensOut: number
  runningSttSeconds: number
  runningTtsSeconds: number
}

export interface SessionCloseArgs {
  voiceCallSid: string
  at: number
  reason: "completed" | "failed:cost_ceiling" | "failed:other"
}

/**
 * Adam-locked $1/call ceiling callback. S2 registers exactly one of these
 * at session start; the cost-ceiling watchdog invokes it exactly once
 * when running cost crosses $1.00. S2 then performs the graceful hangup.
 */
export type CostCeilingCallback = (args: {
  voiceCallSid: string
  reason: "cost_ceiling_exceeded"
  finalCostUsd: number
}) => void | Promise<void>

/** Default 90-day TTL window for telemetry rows (L8 default). */
export const VOICE_TELEMETRY_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** L11 thresholds, both in USD. */
export const COST_CEILING_WARN_USD = 0.9
export const COST_CEILING_HARD_USD = 1.0

/** Firestore collection root for v2.1 voice telemetry. */
export const VOICE_CALL_METRICS_COLLECTION = "voice-call-metrics"
