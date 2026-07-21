/**
 * with-scheduled-alert.ts — wrap a scheduled Cloud Function so a failure is
 * never silent. 2026-06-14 (Adam alerting initiative): ~9 of ~17 scheduled CFs
 * catch-and-log (or hard-fail) with no external alert — a nightly job can stop
 * producing recs / stall a queue and nobody is told.
 *
 * wrap(name, handler):
 *   - handler throws  → alert (error) + RETHROW (scheduler records the failure).
 *   - handler returns → if `resultErrors(result) > 0`, alert (warn) for a
 *     partial-failure batch even though it didn't throw.
 *   - high-frequency jobs (1min/60min) can set `consecutiveFailThreshold` so we
 *     only alert after N consecutive failed runs (avoids Slack/email spam from a
 *     transient blip). Requires `db` for the durable counter
 *     (`pa-alerts/cf-fail-<name>`); a success resets it.
 *
 * Alerts dispatch via notifyOps (email → operators + Slack). Fail-soft: an alert
 * failure never masks the original error.
 */

import { logger } from "firebase-functions/v2"
import type { Firestore } from "firebase-admin/firestore"
import { notifyOps } from "./ops-alert.js"

export interface WithScheduledAlertOptions<T> {
  /** Only alert after this many CONSECUTIVE failed runs (default 1 = alert every failure). */
  consecutiveFailThreshold?: number
  /** Firestore for the consecutive-fail counter (required when threshold > 1). */
  db?: Firestore
  /** Extract a soft-failure count from a successful return (e.g. batch result.errors). */
  resultErrors?: (result: T) => number
  /** Test seam — defaults to notifyOps. */
  notify?: typeof notifyOps
  /** Test seam — defaults to Date.now. */
  now?: () => number
}

const ALERTS_COLLECTION = "pa-alerts"

function counterDocId(name: string): string {
  return `cf-fail-${name}`
}

async function bumpConsecutiveFailures(db: Firestore, name: string, nowMs: number): Promise<number> {
  const ref = db.collection(ALERTS_COLLECTION).doc(counterDocId(name))
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const prev = snap.exists ? Number((snap.data() as { count?: unknown })?.count ?? 0) : 0
      const count = (Number.isFinite(prev) ? prev : 0) + 1
      tx.set(ref, { count, lastFailureAt: new Date(nowMs).toISOString(), cf: name }, { merge: true })
      return count
    })
  } catch {
    // Counter store unreachable → treat as "1" so a real outage still alerts.
    return 1
  }
}

async function resetConsecutiveFailures(db: Firestore, name: string): Promise<void> {
  try {
    await db.collection(ALERTS_COLLECTION).doc(counterDocId(name)).set({ count: 0 }, { merge: true })
  } catch {
    /* best-effort */
  }
}

/**
 * Wrap a scheduled handler with failure alerting. Returns a function with the
 * same signature; rethrows the original error after alerting.
 */
export function withScheduledAlert<T>(
  name: string,
  handler: () => Promise<T>,
  opts: WithScheduledAlertOptions<T> = {},
): () => Promise<T> {
  const notify = opts.notify ?? notifyOps
  const now = opts.now ?? (() => Date.now())
  const threshold = Math.max(1, opts.consecutiveFailThreshold ?? 1)

  return async () => {
    let result: T
    try {
      result = await handler()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      let consecutive = 1
      if (threshold > 1 && opts.db) {
        consecutive = await bumpConsecutiveFailures(opts.db, name, now())
      }
      if (consecutive >= threshold) {
        try {
          await notify({
            level: "error",
            title: `Scheduled job failed: ${name}`,
            message:
              `${name} threw on its scheduled run` +
              (threshold > 1 ? ` (${consecutive} consecutive failures)` : "") +
              `. The job did not complete — investigate before the next tick.`,
            fields: [{ name: "error", value: message.slice(0, 500) }],
          })
        } catch {
          /* alert must never mask the real error */
        }
      } else {
        logger.warn(`[scheduled-alert] ${name} failed (${consecutive}/${threshold}) — below alert threshold`, {
          error: message.slice(0, 300),
        })
      }
      throw err
    }

    // Success: reset the consecutive-fail counter + optionally alert on a
    // partial-failure batch (returned errors > 0).
    if (threshold > 1 && opts.db) await resetConsecutiveFailures(opts.db, name)
    if (opts.resultErrors) {
      let errCount = 0
      try {
        errCount = opts.resultErrors(result)
      } catch {
        errCount = 0
      }
      if (errCount > 0) {
        try {
          await notify({
            level: "warn",
            title: `Scheduled job partial failure: ${name}`,
            message: `${name} completed but reported ${errCount} error(s) in its batch — some items did not process.`,
            fields: [{ name: "errors", value: String(errCount) }],
          })
        } catch {
          /* fail-soft */
        }
      }
    }
    return result
  }
}
