/**
 * v1.8 Phase 74.5 — paMemoryCompactionScheduled handler.
 *
 * Daily 05:00 UTC sweep. For each user with ≥20 pending raw turns since
 * last compaction, triggers runCompactionForUser. Per-user cost cap
 * enforced inside runCompactionTurn itself.
 *
 * Pending turns = pa-messages docs WHERE userId=X AND compactedAt
 * is unset.
 */
import type { Firestore } from "firebase-admin/firestore"
import { runCompactionForUser } from "./compaction-run.js"

const PENDING_TURNS_THRESHOLD = 20
const MAX_USERS_PER_SWEEP = 50 // cap to keep run within timeout

export interface CompactionSweepResult {
  scanned: number
  triggered: number
  completed: number
  errors: number
  durationMs: number
}

export async function runMemoryCompactionSweep(args: {
  db: Firestore
  log?: (event: string, payload: Record<string, unknown>) => void
}): Promise<CompactionSweepResult> {
  const log = args.log ?? (() => {})
  const start = Date.now()
  // Pull recent users with activity in the last 24h.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const recent = await args.db
    .collection("pa-messages")
    .where("createdAt", ">=", since)
    .limit(500)
    .get()
  const userIds = new Set<string>()
  for (const doc of recent.docs) {
    const uid = (doc.data() as { userId?: string }).userId
    if (uid) userIds.add(uid)
    if (userIds.size >= MAX_USERS_PER_SWEEP) break
  }

  let triggered = 0
  let completed = 0
  let errors = 0
  for (const userId of userIds) {
    try {
      // Count pending (uncompacted) turns for this user
      const pendingSnap = await args.db
        .collection("pa-messages")
        .where("userId", "==", userId)
        .where("compactedAt", "==", null)
        .limit(PENDING_TURNS_THRESHOLD + 1)
        .get()
      if (pendingSnap.size < PENDING_TURNS_THRESHOLD) continue
      triggered++
      const result = await runCompactionForUser({
        db: args.db,
        userId,
        reason: "turn_count",
        log: (e, p) => log(`compact.${userId.slice(0, 8)}.${e}`, p),
      })
      if (result.ok) completed++
      log("compact.user_done", { userId, ok: result.ok, reason: result.reason })
    } catch (err) {
      errors++
      log("compact.user_error", { userId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const result: CompactionSweepResult = {
    scanned: userIds.size,
    triggered,
    completed,
    errors,
    durationMs: Date.now() - start,
  }
  log("compact.sweep_complete", result as unknown as Record<string, unknown>)
  return result
}
