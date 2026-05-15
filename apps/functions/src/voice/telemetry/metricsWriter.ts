/**
 * S4 — Voice telemetry writer.
 *
 * Subscribes to S2's `VoiceCallTelemetryHook` (defined in ./types.ts) and
 * persists per-turn rows plus a call-level lifecycle doc into Firestore.
 *
 * - One lifecycle doc per call: `voice-call-metrics/{voiceCallSid}`.
 * - One turn row per agent turn: `voice-call-metrics/{voiceCallSid}/turns/{turnIndex}`.
 *
 * Reasons we own this and not S2:
 *   - S2 is LiveKit-Cloud-hosted Python; coupling it directly to Firestore
 *     means any schema change forces a S2 deploy. Behind a hook, schema
 *     evolves in TS-land.
 *   - Cost-ceiling watchdog (./costCeiling.ts) wraps the same hook with
 *     an idempotent state machine; S2 sees one consistent interface.
 *
 * NOT in scope for S4: PII redaction of transcripts. We accept whatever
 * S2 hands us. v2.2 will fold a redactor in.
 */

import type { Firestore } from "firebase-admin/firestore"

import {
  type AgentFirstAudioArgs,
  type AgentTurnEndedArgs,
  type FalseInterruptionArgs,
  type SessionCloseArgs,
  type SessionStartArgs,
  type SessionUsageUpdatedArgs,
  type UserSpeechCommittedArgs,
  type VoiceCallLifecycle,
  type VoiceCallStatus,
  type VoiceCallTelemetryHook,
  type VoiceTurnMetric,
  VOICE_CALL_METRICS_COLLECTION,
  VOICE_TELEMETRY_TTL_MS,
} from "./types.js"

/** Per-call mutable state held only in memory for the duration of a call. */
interface CallState {
  voiceCallSid: string
  startedAt: number
  endedAt: number | null
  turnIndex: number
  /** Current open turn — null between `onAgentTurnEnded` and next user commit. */
  currentTurn: OpenTurn | null
  totalCostUsd: number
  runningLlmTokensIn: number
  runningLlmTokensOut: number
  runningSttSeconds: number
  runningTtsSeconds: number
  status: VoiceCallStatus
  costWarningAt: number | null
  costExceededAt: number | null
  /** S2-provided identity bridge fields. */
  paUserId: string | null
  paJobId: string | null
}

interface OpenTurn {
  startedAt: number
  userSpeechCommittedAt: number | null
  agentFirstAudioAt: number | null
  falseInterruption: boolean
  /** Snapshot of per-call cost when turn opened — used to attribute slice. */
  costAtTurnStart: number
  transcriptUser: string | null
}

export interface MetricsWriterDeps {
  db: Firestore
  now?: () => number
  log?: (msg: string, ctx?: Record<string, unknown>) => void
}

/**
 * Read-only handle the cost-ceiling watchdog uses to flip per-call state
 * fields that the writer otherwise wouldn't know about. Keeping a single
 * state owner avoids the lifecycle-doc clobbering bug where the writer's
 * `persistLifecycle` would otherwise overwrite watchdog-set fields.
 */
export interface TelemetryStatePatch {
  markCostWarning(voiceCallSid: string, at: number): Promise<boolean>
  markCostExceeded(voiceCallSid: string, at: number): Promise<boolean>
}

/** The hook + state-patch handle the watchdog binds to. */
export interface TelemetryHookBundle {
  hook: VoiceCallTelemetryHook
  state: TelemetryStatePatch
}

/**
 * Factory: returns a per-call hook bound to `voiceCallSid`. S2 calls this
 * at session start, then forwards LiveKit events into the returned hook.
 *
 * The hook is internally stateful and is NOT safe to share across calls.
 * S2 builds one per call.
 */
/**
 * Convenience: keep the simple shape for callers that don't need the
 * state-patch handle. Internally delegates to `createTelemetryHookBundle`.
 */
export function createTelemetryHook(deps: MetricsWriterDeps): VoiceCallTelemetryHook {
  return createTelemetryHookBundle(deps).hook
}

export function createTelemetryHookBundle(deps: MetricsWriterDeps): TelemetryHookBundle {
  const { db } = deps
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? (() => undefined)

  /** Map keyed by voiceCallSid so a single hook instance can multiplex if S2 chooses. */
  const calls = new Map<string, CallState>()

  function getCall(voiceCallSid: string): CallState | null {
    return calls.get(voiceCallSid) ?? null
  }

  async function persistLifecycle(state: CallState): Promise<void> {
    const doc: VoiceCallLifecycle = {
      voiceCallSid: state.voiceCallSid,
      paUserId: state.paUserId,
      paJobId: state.paJobId,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      turnCount: state.turnIndex,
      totalCostUsd: state.totalCostUsd,
      runningLlmTokensIn: state.runningLlmTokensIn,
      runningLlmTokensOut: state.runningLlmTokensOut,
      runningSttSeconds: state.runningSttSeconds,
      runningTtsSeconds: state.runningTtsSeconds,
      status: state.status,
      costWarningAt: state.costWarningAt,
      costExceededAt: state.costExceededAt,
      expiresAt: state.startedAt + VOICE_TELEMETRY_TTL_MS,
    }
    await db
      .collection(VOICE_CALL_METRICS_COLLECTION)
      .doc(state.voiceCallSid)
      .set(doc, { merge: true })
  }

  const hook: VoiceCallTelemetryHook = {
    async onSessionStart(args: SessionStartArgs): Promise<void> {
      if (calls.has(args.voiceCallSid)) {
        log("voice.telemetry.session_start_duplicate", {
          voiceCallSid: args.voiceCallSid,
        })
        return
      }
      const state: CallState = {
        voiceCallSid: args.voiceCallSid,
        startedAt: args.startedAt,
        endedAt: null,
        turnIndex: 0,
        currentTurn: null,
        totalCostUsd: 0,
        runningLlmTokensIn: 0,
        runningLlmTokensOut: 0,
        runningSttSeconds: 0,
        runningTtsSeconds: 0,
        status: "in_progress",
        costWarningAt: null,
        costExceededAt: null,
        paUserId: args.paUserId,
        paJobId: args.paJobId,
      }
      calls.set(args.voiceCallSid, state)
      await persistLifecycle(state)
    },

    onUserSpeechCommitted(args: UserSpeechCommittedArgs): void {
      const state = getCall(args.voiceCallSid)
      if (!state) {
        log("voice.telemetry.user_commit_no_session", {
          voiceCallSid: args.voiceCallSid,
        })
        return
      }
      // Open a new turn if none open. If a previous turn somehow stayed
      // open without onAgentTurnEnded, replace it (defensive — shouldn't
      // happen in normal flow).
      state.currentTurn = {
        startedAt: args.at,
        userSpeechCommittedAt: args.at,
        agentFirstAudioAt: null,
        falseInterruption: false,
        costAtTurnStart: state.totalCostUsd,
        transcriptUser: args.transcript,
      }
    },

    onAgentFirstAudio(args: AgentFirstAudioArgs): void {
      const state = getCall(args.voiceCallSid)
      if (!state || !state.currentTurn) {
        log("voice.telemetry.agent_first_audio_no_turn", {
          voiceCallSid: args.voiceCallSid,
        })
        return
      }
      // Only record the EARLIEST first-audio sample of this turn.
      if (state.currentTurn.agentFirstAudioAt === null) {
        state.currentTurn.agentFirstAudioAt = args.at
      }
    },

    onFalseInterruption(args: FalseInterruptionArgs): void {
      const state = getCall(args.voiceCallSid)
      if (!state || !state.currentTurn) {
        return
      }
      state.currentTurn.falseInterruption = true
    },

    async onAgentTurnEnded(args: AgentTurnEndedArgs): Promise<void> {
      const state = getCall(args.voiceCallSid)
      if (!state) return
      const open = state.currentTurn
      if (!open) {
        log("voice.telemetry.turn_end_no_open_turn", {
          voiceCallSid: args.voiceCallSid,
        })
        return
      }

      const ttfaMs =
        open.userSpeechCommittedAt !== null && open.agentFirstAudioAt !== null
          ? Math.max(0, open.agentFirstAudioAt - open.userSpeechCommittedAt)
          : null

      const userUtteranceMs =
        open.userSpeechCommittedAt !== null
          ? Math.max(0, open.userSpeechCommittedAt - open.startedAt)
          : null

      const agentResponseMs =
        open.agentFirstAudioAt !== null
          ? Math.max(0, args.at - open.agentFirstAudioAt)
          : null

      // A "false commit" = STT marked user-finished, but the user kept
      // talking AND the agent had to back off (false_interruption fired
      // before agent could complete its response).
      const falseCommit = open.falseInterruption

      // Turn cost = either explicit caller-provided, or attributed slice
      // (delta between turn-start cost and current running total).
      const turnCostUsd =
        typeof args.turnCostUsd === "number"
          ? Math.max(0, args.turnCostUsd)
          : Math.max(0, state.totalCostUsd - open.costAtTurnStart)

      const turnIndex = state.turnIndex
      state.turnIndex += 1
      state.currentTurn = null

      const row: VoiceTurnMetric = {
        voiceCallSid: state.voiceCallSid,
        turnIndex,
        startedAt: open.startedAt,
        endedAt: args.at,
        ttfaMs,
        userUtteranceMs,
        agentResponseMs,
        falseCommit,
        falseInterruption: open.falseInterruption,
        costUsd: turnCostUsd,
        llmTokensIn: Math.max(0, args.llmTokensIn),
        llmTokensOut: Math.max(0, args.llmTokensOut),
        sttSeconds: Math.max(0, args.sttSeconds),
        ttsSeconds: Math.max(0, args.ttsSeconds),
        transcriptUser: open.transcriptUser,
        transcriptAgent: args.transcript,
        expiresAt: args.at + VOICE_TELEMETRY_TTL_MS,
      }

      await db
        .collection(VOICE_CALL_METRICS_COLLECTION)
        .doc(state.voiceCallSid)
        .collection("turns")
        .doc(String(turnIndex))
        .set(row)

      await persistLifecycle(state)
    },

    async onSessionUsageUpdated(args: SessionUsageUpdatedArgs): Promise<void> {
      const state = getCall(args.voiceCallSid)
      if (!state) return

      // Running totals are monotonic-non-decreasing per LiveKit semantics.
      // Defensive clamp — don't let a stale event lower the totals.
      state.totalCostUsd = Math.max(state.totalCostUsd, args.runningCostUsd)
      state.runningLlmTokensIn = Math.max(
        state.runningLlmTokensIn,
        args.runningLlmTokensIn,
      )
      state.runningLlmTokensOut = Math.max(
        state.runningLlmTokensOut,
        args.runningLlmTokensOut,
      )
      state.runningSttSeconds = Math.max(state.runningSttSeconds, args.runningSttSeconds)
      state.runningTtsSeconds = Math.max(state.runningTtsSeconds, args.runningTtsSeconds)

      await persistLifecycle(state)
    },

    async onSessionClose(args: SessionCloseArgs): Promise<void> {
      const state = getCall(args.voiceCallSid)
      if (!state) return
      state.endedAt = args.at
      // Watchdog may already have set `failed:cost_ceiling`. Don't downgrade
      // an already-failed status if a generic "completed" close arrives.
      if (state.status !== "failed:cost_ceiling") {
        state.status = args.reason === "completed" ? "completed" : args.reason
      }
      await persistLifecycle(state)
      calls.delete(args.voiceCallSid)
    },
  }

  const statePatch: TelemetryStatePatch = {
    async markCostWarning(voiceCallSid: string, at: number): Promise<boolean> {
      const state = getCall(voiceCallSid)
      if (!state) return false
      if (state.costWarningAt !== null) return false
      state.costWarningAt = at
      await persistLifecycle(state)
      return true
    },
    async markCostExceeded(voiceCallSid: string, at: number): Promise<boolean> {
      const state = getCall(voiceCallSid)
      if (!state) return false
      if (state.costExceededAt !== null) return false
      state.costExceededAt = at
      state.status = "failed:cost_ceiling"
      await persistLifecycle(state)
      return true
    },
  }

  return { hook, state: statePatch }
}

