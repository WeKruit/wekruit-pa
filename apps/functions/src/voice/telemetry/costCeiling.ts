/**
 * S4 — $1/call cost ceiling watchdog (Lock L11).
 *
 * Wraps a `VoiceCallTelemetryHook` and decorates its
 * `onSessionUsageUpdated` so that:
 *
 *   - running cost ≥ $0.90 → emit `cost_ceiling_warning` (records
 *     `costWarningAt` on the lifecycle doc; logged once per call).
 *   - running cost ≥ $1.00 → invoke the registered close-callback
 *     EXACTLY ONCE; mark `costExceededAt`; finalize the lifecycle
 *     status as `failed:cost_ceiling`.
 *
 * Idempotency: duplicate `session_usage_updated` events with totals
 * already past the threshold do NOT re-fire the warning or the close-
 * callback. The watchdog tracks per-call flags in memory; the warning
 * is also persisted to Firestore so a fresh process attaches to an
 * already-warned call gracefully (we leave the flag alone if already
 * set in the lifecycle doc).
 */

import type { Firestore } from "firebase-admin/firestore"

import type { TelemetryStatePatch } from "./metricsWriter.js"
import {
  type CostCeilingCallback,
  type SessionUsageUpdatedArgs,
  type VoiceCallTelemetryHook,
  COST_CEILING_HARD_USD,
  COST_CEILING_WARN_USD,
} from "./types.js"

interface PerCallFlags {
  warned: boolean
  exceeded: boolean
  callback: CostCeilingCallback | null
}

export interface CostCeilingDeps {
  db: Firestore
  log?: (msg: string, ctx?: Record<string, unknown>) => void
  now?: () => number
}

export interface CostCeilingWatchdog {
  /** S2 registers the close-callback once at session start. */
  registerCloseCallback(voiceCallSid: string, cb: CostCeilingCallback): void
  /** The decorated hook; substitute for the raw writer hook in S2. */
  hook: VoiceCallTelemetryHook
}

/**
 * Decorate the underlying telemetry hook with the L11 watchdog.
 *
 * Usage in S2:
 *   const writerHook = createTelemetryHook({ db })
 *   const watchdog   = createCostCeilingWatchdog({ db, inner: writerHook })
 *   watchdog.registerCloseCallback(sid, gracefulHangupFn)
 *   session.on(...) → watchdog.hook.onSessionUsageUpdated(...)
 */
export function createCostCeilingWatchdog(args: {
  db?: Firestore
  inner: VoiceCallTelemetryHook
  /**
   * Optional shared state patch — recommended path. When provided, the
   * watchdog flips warning/exceeded flags on the writer's in-memory state
   * so subsequent lifecycle writes don't clobber them. Pass the `state`
   * field from `createTelemetryHookBundle`.
   */
  state?: TelemetryStatePatch
  log?: (msg: string, ctx?: Record<string, unknown>) => void
  now?: () => number
}): CostCeilingWatchdog {
  const { inner, state } = args
  const log = args.log ?? (() => undefined)

  const flags = new Map<string, PerCallFlags>()

  function getFlags(sid: string): PerCallFlags {
    let f = flags.get(sid)
    if (!f) {
      f = { warned: false, exceeded: false, callback: null }
      flags.set(sid, f)
    }
    return f
  }

  async function markWarning(sid: string, at: number): Promise<void> {
    if (state) {
      await state.markCostWarning(sid, at)
    }
  }

  async function markExceeded(sid: string, at: number): Promise<void> {
    if (state) {
      await state.markCostExceeded(sid, at)
    }
  }

  const hook: VoiceCallTelemetryHook = {
    onSessionStart: (a) => inner.onSessionStart(a),
    onUserSpeechCommitted: (a) => inner.onUserSpeechCommitted(a),
    onAgentFirstAudio: (a) => inner.onAgentFirstAudio(a),
    onFalseInterruption: (a) => inner.onFalseInterruption(a),
    onAgentTurnEnded: (a) => inner.onAgentTurnEnded(a),
    onSessionClose: (a) => inner.onSessionClose(a),

    async onSessionUsageUpdated(a: SessionUsageUpdatedArgs): Promise<void> {
      // 1. Always forward to inner first so lifecycle totals are current.
      await inner.onSessionUsageUpdated(a)

      const f = getFlags(a.voiceCallSid)
      const cost = a.runningCostUsd

      // 2. Warn at $0.90 — exactly once.
      if (!f.warned && cost >= COST_CEILING_WARN_USD) {
        f.warned = true
        log("voice.telemetry.cost_warning", {
          voiceCallSid: a.voiceCallSid,
          runningCostUsd: cost,
        })
        await markWarning(a.voiceCallSid, a.at)
      }

      // 3. Hard ceiling at $1.00 — fire callback EXACTLY once.
      if (!f.exceeded && cost >= COST_CEILING_HARD_USD) {
        f.exceeded = true
        log("voice.telemetry.cost_exceeded", {
          voiceCallSid: a.voiceCallSid,
          runningCostUsd: cost,
        })
        await markExceeded(a.voiceCallSid, a.at)
        const cb = f.callback
        if (cb) {
          try {
            await cb({
              voiceCallSid: a.voiceCallSid,
              reason: "cost_ceiling_exceeded",
              finalCostUsd: cost,
            })
          } catch (err) {
            log("voice.telemetry.cost_callback_error", {
              voiceCallSid: a.voiceCallSid,
              err: err instanceof Error ? err.message : String(err),
            })
          }
        } else {
          log("voice.telemetry.cost_callback_missing", {
            voiceCallSid: a.voiceCallSid,
            note: "ceiling crossed but no close callback registered",
          })
        }
      }
    },
  }

  return {
    hook,
    registerCloseCallback(voiceCallSid: string, cb: CostCeilingCallback): void {
      const f = getFlags(voiceCallSid)
      f.callback = cb
    },
  }
}
