/**
 * v1.5 Stream-D — coalesce buffer sweep (R1 mitigation per P10 push back).
 *
 * Cloud Tasks at-least-once does NOT mean at-least-once-fire — quota,
 * IAM regression, paused queue, or a deleted task all cause buffers to
 * sit in `status="pending"` indefinitely. With paMessageCoalesceEnabled
 * flipping to even 1% of users, ANY stuck buffer = a user message in
 * limbo, never replied to.
 *
 * This module runs a scheduled CF every 60s (registered in src/index.ts):
 *   - Query `pa-message-coalesce-buffer` where status="pending" AND
 *     firstReceivedAt < now - 30s.
 *   - For each stale buffer, call `processCoalescedTurn` directly.
 *     The same idempotency guarantees apply: markFiredTransaction flips
 *     status atomically, and a concurrent Cloud Tasks delivery sees
 *     status="fired" and returns null.
 *
 * Why 30s threshold (and not the 12s hard cap):
 *   - 12s hard cap is ENFORCED VIA delay=0 enqueue at write time. By 30s
 *     the buffer SHOULD have fired naturally; if it hasn't, Cloud Tasks
 *     is stuck and we forcibly drain.
 *   - Buffer aging past 30s is PATHOLOGICAL — the user has waited 30+
 *     seconds for a reply. Sweep latency itself is bounded at +60s = a
 *     90s worst case, which is still well under the iMessage timeout
 *     where the user would assume the bot is dead.
 *
 * Failure mode: sweep itself never throws — every per-buffer call is
 * wrapped so one stuck row doesn't tank the rest of the batch.
 */

import type { Firestore } from "firebase-admin/firestore"

import { findStaleBuffers, type BufferDoc } from "./buffer.js"
import { processCoalescedTurn, type CoalescerDeps } from "./paMessageCoalescer.js"

export type SweepResult = {
  scanned: number
  fired: number
  errors: number
}

export type SweepOptions = {
  staleAfterMs?: number
  limit?: number
}

/**
 * Single sweep tick. Returns counts for observability. Caller (the scheduled
 * CF wrapper in src/index.ts) typically just logs the result.
 */
export async function runCoalesceBufferSweep(
  deps: CoalescerDeps,
  opts: SweepOptions = {}
): Promise<SweepResult> {
  const log = deps.log ?? console.log
  const now = deps.now ?? (() => new Date())
  const staleAfterMs = opts.staleAfterMs ?? 30_000

  let stale: BufferDoc[]
  try {
    stale = await findStaleBuffers(deps.db, {
      now,
      staleAfterMs,
      limit: opts.limit,
    })
  } catch (err) {
    log("[coalesce-sweep] query failed", err instanceof Error ? err.message : String(err))
    return { scanned: 0, fired: 0, errors: 1 }
  }

  let fired = 0
  let errors = 0
  for (const buf of stale) {
    try {
      const r = await processCoalescedTurn(deps, buf.userId, buf.turnSeq)
      if (r.status === "fired") fired++
    } catch (err) {
      errors++
      log("[coalesce-sweep] processCoalescedTurn threw", {
        userId: buf.userId,
        turnSeq: buf.turnSeq,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (stale.length > 0) {
    log("pa.coalesce.swept", {
      severity: "WARNING",
      scanned: stale.length,
      fired,
      errors,
      staleAfterMs,
    })
  }
  return { scanned: stale.length, fired, errors }
}

/**
 * Probe used by tests — runs a single sweep and returns the result. Lives
 * here (not in test file) to avoid duplicating the deps wiring.
 */
export async function _runOneSweep(
  deps: CoalescerDeps,
  opts: SweepOptions = {}
): Promise<SweepResult> {
  return runCoalesceBufferSweep(deps, opts)
}

export type SweepDeps = {
  db: Firestore
  // remaining deps live on CoalescerDeps; the CF wrapper merges them.
}
