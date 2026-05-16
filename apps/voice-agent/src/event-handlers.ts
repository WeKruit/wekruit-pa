/**
 * v2.1 S2 — LiveKit AgentSession + Room event handler registration.
 *
 * Lock L7 (verbatim): "Adaptive turn model + register all 7 event handlers —
 * NO `min` `Endpointing` `Delay` literal in source." (concatenated to avoid
 * tripping the lint-grep test in `__tests__/no-min-endpointing.test.ts`.)
 *
 * The 7 events:
 *   1. user_speech_committed       — final transcript → trigger turn loop
 *   2. conversation_item_added     — log each chat item for audit
 *   3. agent_false_interruption    — S4 metric hook
 *   4. participant_disconnected    — graceful shutdown
 *   5. ErrorEvent                  — graceful shutdown + log
 *   6. session_usage_updated       — S4 cost/token aggregator hook
 *   7. close                       — final teardown signal
 *
 * Implementation notes:
 *   - The voice worker depends on `@livekit/agents` at runtime, but we keep
 *     this module SDK-agnostic via the `EventEmitterLike` shapes below so
 *     tests can register against a stub. The real entrypoint (`cli.ts`)
 *     binds the live SDK objects.
 *   - For `user_speech_committed`, LiveKit Node SDK currently surfaces
 *     transcript finalization on `AgentSessionEventTypes.UserInputTranscribed`
 *     with `event.isFinal === true`. We register that handler and filter
 *     inside the callback. The handler-spec name "user_speech_committed"
 *     matches the conceptual event; the SDK-side wire name is mapped via
 *     `EVENT_NAMES`.
 *   - For `ErrorEvent`, LiveKit's session emits an "error" event with an
 *     ErrorEvent payload. We register against the stringly-named "error".
 *   - For `participant_disconnected`, the source is `ctx.room` (RoomEvent
 *     enum), not the AgentSession. We accept both as separate emitters.
 *
 * This module exposes:
 *   - `EVENT_NAMES`: stable mapping from spec-name → SDK-name (used by
 *     `event-handlers.test.ts` to assert each was registered).
 *   - `registerEventHandlers(session, room, sinks)`: wires all 7 + returns
 *     a `dispose()` that removes them.
 */

import type { OnUserCommitInput, OnUserCommitOutput } from "./turn-loop.js"

// ────────────────────────────────────────────────────────────────────────────
// SDK-name mapping. EXPORTED so tests can assert exact wire names.
// ────────────────────────────────────────────────────────────────────────────

export const EVENT_NAMES = {
  /** AgentSession event: STT final transcript. We filter isFinal inside cb. */
  user_speech_committed: "user_input_transcribed",
  /** AgentSession event: chat history item appended. */
  conversation_item_added: "conversation_item_added",
  /** AgentSession event: VAD/agent-state detected a non-real interruption. */
  agent_false_interruption: "agent_false_interruption",
  /** Room event (NOT session): SIP/WS participant left. */
  participant_disconnected: "participant_disconnected",
  /** AgentSession event: any error mid-session. */
  ErrorEvent: "error",
  /** AgentSession event: per-model billing/cost update. */
  session_usage_updated: "session_usage_updated",
  /** AgentSession event: session closing. */
  close: "close",
} as const

export type SpecEventName = keyof typeof EVENT_NAMES

// ────────────────────────────────────────────────────────────────────────────
// SDK-agnostic emitter shape
// ────────────────────────────────────────────────────────────────────────────

export interface EventEmitterLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off?(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
}

// ────────────────────────────────────────────────────────────────────────────
// Sinks — the integration points the entrypoint provides.
// ────────────────────────────────────────────────────────────────────────────

export interface UserSpeechCommittedPayload {
  transcript: string
  isFinal: boolean
  lang?: string
}

export interface ConversationItemPayload {
  role: string
  textContent: string
}

export interface FalseInterruptionPayload {
  resumed: boolean
}

export interface UsageUpdatedPayload {
  modelUsage: Array<Record<string, unknown>>
}

export interface RegisterSinks {
  /** Called for every final user transcript. Returns void; awaits are fine. */
  onUserSpeechCommitted: (
    payload: UserSpeechCommittedPayload
  ) => Promise<OnUserCommitOutput | void> | OnUserCommitOutput | void
  /** Audit log of conversation items. */
  onConversationItemAdded?: (payload: ConversationItemPayload) => void
  /** S4 plug — false interruption ratio. */
  onAgentFalseInterruption?: (payload: FalseInterruptionPayload) => void
  /** S3 plug — clean up booking row, halt outbound. */
  onParticipantDisconnected?: (payload: { identity?: string }) => void
  /** Surface session errors. Always fire `shutdown` after this returns. */
  onError?: (payload: { error?: Error; message?: string }) => void
  /** S4 plug — session_usage_updated → cost ledger. */
  onSessionUsageUpdated?: (payload: UsageUpdatedPayload) => void
  /** Final teardown hook. */
  onClose?: (payload: { reason?: string }) => void

  /**
   * Optional shutdown function invoked from `participant_disconnected` +
   * `error` paths. Idempotent expected.
   */
  shutdown?: () => void | Promise<void>

  log?: (event: string, payload: Record<string, unknown>) => void
}

export interface RegisterEventHandlersResult {
  /** Map of spec-name → the (event, listener) tuple registered with the SDK. */
  registered: Record<SpecEventName, { sdkEvent: string; listener: (...args: unknown[]) => void }>
  /** Remove all registered listeners. Idempotent. */
  dispose: () => void
}

/**
 * Register the L7 mandated 7 event handlers across the AgentSession +
 * Room. Returns a `dispose()` to unwire (used in shutdown paths + tests).
 */
export function registerEventHandlers(
  session: EventEmitterLike,
  room: EventEmitterLike,
  sinks: RegisterSinks
): RegisterEventHandlersResult {
  const log = sinks.log ?? (() => {})

  // ── 1. user_speech_committed ─────────────────────────────────────────────
  const userSpeechHandler = (...args: unknown[]) => {
    const ev = (args[0] ?? {}) as {
      transcript?: string
      isFinal?: boolean
      is_final?: boolean
      language?: string
    }
    const isFinal = ev.isFinal ?? ev.is_final ?? false
    if (!isFinal) return // ignore partial transcripts
    void Promise.resolve(
      sinks.onUserSpeechCommitted({
        transcript: ev.transcript ?? "",
        isFinal: true,
        lang: ev.language,
      })
    ).catch((err) => {
      log("voice.handler.user_speech_committed.threw", {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
  session.on(EVENT_NAMES.user_speech_committed, userSpeechHandler)

  // ── 2. conversation_item_added ───────────────────────────────────────────
  const itemAddedHandler = (...args: unknown[]) => {
    const ev = (args[0] ?? {}) as {
      item?: { role?: string; textContent?: string; text_content?: string }
    }
    const item = ev.item ?? {}
    sinks.onConversationItemAdded?.({
      role: item.role ?? "unknown",
      textContent: item.textContent ?? item.text_content ?? "",
    })
  }
  session.on(EVENT_NAMES.conversation_item_added, itemAddedHandler)

  // ── 3. agent_false_interruption ──────────────────────────────────────────
  const falseInterruptHandler = (...args: unknown[]) => {
    const ev = (args[0] ?? {}) as { resumed?: boolean }
    sinks.onAgentFalseInterruption?.({ resumed: ev.resumed ?? false })
  }
  session.on(EVENT_NAMES.agent_false_interruption, falseInterruptHandler)

  // ── 4. participant_disconnected (room scope) ─────────────────────────────
  const participantHandler = (...args: unknown[]) => {
    const ev = (args[0] ?? {}) as { identity?: string }
    sinks.onParticipantDisconnected?.({ identity: ev.identity })
    if (sinks.shutdown) {
      try {
        void Promise.resolve(sinks.shutdown()).catch((err) => {
          log("voice.handler.participant_disconnected.shutdown.threw", {
            error: err instanceof Error ? err.message : String(err),
          })
        })
      } catch (err) {
        // Sync throw from shutdown — swallow + log.
        log("voice.handler.participant_disconnected.shutdown.threw", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
  room.on(EVENT_NAMES.participant_disconnected, participantHandler)

  // ── 5. ErrorEvent ────────────────────────────────────────────────────────
  const errorHandler = (...args: unknown[]) => {
    const arg = args[0]
    let payload: { error?: Error; message?: string }
    if (arg instanceof Error) {
      payload = { error: arg, message: arg.message }
    } else if (typeof arg === "object" && arg !== null && "error" in arg) {
      const o = arg as { error?: unknown; message?: string }
      payload = {
        error: o.error instanceof Error ? o.error : undefined,
        message: o.message,
      }
    } else {
      payload = { message: typeof arg === "string" ? arg : "unknown error" }
    }
    sinks.onError?.(payload)
    if (sinks.shutdown) {
      try {
        void Promise.resolve(sinks.shutdown()).catch((err) => {
          log("voice.handler.error.shutdown.threw", {
            error: err instanceof Error ? err.message : String(err),
          })
        })
      } catch (err) {
        log("voice.handler.error.shutdown.threw", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
  session.on(EVENT_NAMES.ErrorEvent, errorHandler)

  // ── 6. session_usage_updated ─────────────────────────────────────────────
  const usageHandler = (...args: unknown[]) => {
    const ev = (args[0] ?? {}) as {
      usage?: { modelUsage?: Array<Record<string, unknown>>; model_usage?: Array<Record<string, unknown>> }
    }
    const usage = ev.usage ?? {}
    sinks.onSessionUsageUpdated?.({
      modelUsage: usage.modelUsage ?? usage.model_usage ?? [],
    })
  }
  session.on(EVENT_NAMES.session_usage_updated, usageHandler)

  // ── 7. close ─────────────────────────────────────────────────────────────
  const closeHandler = (...args: unknown[]) => {
    const ev = (args[0] ?? {}) as { reason?: string }
    sinks.onClose?.({ reason: ev.reason })
  }
  session.on(EVENT_NAMES.close, closeHandler)

  const registered = {
    user_speech_committed: {
      sdkEvent: EVENT_NAMES.user_speech_committed,
      listener: userSpeechHandler,
    },
    conversation_item_added: {
      sdkEvent: EVENT_NAMES.conversation_item_added,
      listener: itemAddedHandler,
    },
    agent_false_interruption: {
      sdkEvent: EVENT_NAMES.agent_false_interruption,
      listener: falseInterruptHandler,
    },
    participant_disconnected: {
      sdkEvent: EVENT_NAMES.participant_disconnected,
      listener: participantHandler,
    },
    ErrorEvent: { sdkEvent: EVENT_NAMES.ErrorEvent, listener: errorHandler },
    session_usage_updated: {
      sdkEvent: EVENT_NAMES.session_usage_updated,
      listener: usageHandler,
    },
    close: { sdkEvent: EVENT_NAMES.close, listener: closeHandler },
  }

  const dispose = () => {
    const sessionEvents: Array<keyof typeof EVENT_NAMES> = [
      "user_speech_committed",
      "conversation_item_added",
      "agent_false_interruption",
      "ErrorEvent",
      "session_usage_updated",
      "close",
    ]
    for (const name of sessionEvents) {
      const entry = registered[name]
      const off = (session.off ?? session.removeListener)?.bind(session)
      off?.(entry.sdkEvent, entry.listener)
    }
    const roomOff = (room.off ?? room.removeListener)?.bind(room)
    roomOff?.(
      registered.participant_disconnected.sdkEvent,
      registered.participant_disconnected.listener
    )
  }

  return { registered, dispose }
}

// Re-export the consumer-facing turn-loop input/output so external test files
// can build payloads without reaching across modules.
export type { OnUserCommitInput, OnUserCommitOutput }
