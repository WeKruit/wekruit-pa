/**
 * prescreen-guard.ts — "prescreen owns the thread" (2026-06-10 trust audit).
 *
 * Live evidence: the generic cold opener and proactive daily rec batches fired
 * BETWEEN a prescreen opener and the candidate's Q1 answer, burying the screen.
 * Every proactive/generic sender must therefore check whether the user has an
 * OPEN prescreen session before putting unrelated content on the wire.
 *
 * Cheap by design: prescreen-session-start.ts already mirrors the live screen
 * onto the user doc as `pa-users.workSession = { kind: "job_prescreen",
 * status: "active", startedAt, sessionId, jobId }` (and flips status:"ended"
 * at terminal — markUserPrescreenWorkSessionEnded). So the check is ONE
 * structured-field read over the pa-users doc — no pa-prescreen-sessions query.
 *
 * The 48h freshness window keeps an abandoned/stale screen from suppressing
 * recs forever: an active work session older than 48h no longer owns the thread
 * (the stalled-screen nudge + recovery sweeps handle those separately).
 */
import type { Firestore } from "firebase-admin/firestore"

export const OPEN_PRESCREEN_WINDOW_MS = 48 * 60 * 60 * 1000

/**
 * Pure check over an already-loaded pa-users doc: does this user have an open
 * (non-terminal) prescreen work session updated within the freshness window?
 */
export function hasOpenPrescreenWorkSession(
  user: Record<string, unknown> | null | undefined,
  nowMs: number,
  windowMs: number = OPEN_PRESCREEN_WINDOW_MS,
): boolean {
  const ws = (user?.workSession ?? null) as Record<string, unknown> | null
  if (!ws || ws.kind !== "job_prescreen") return false
  if (ws.status !== "active") return false
  // Freshness: prefer the most recent of updatedAt/startedAt on the work session.
  const stamps = [ws.updatedAt, ws.startedAt, (user as Record<string, unknown>)?.updatedAt]
    .map((v) => (typeof v === "string" ? Date.parse(v) : NaN))
    .filter((t) => Number.isFinite(t)) as number[]
  if (stamps.length === 0) return false
  const latest = Math.max(...stamps)
  return nowMs - latest <= windowMs
}

/**
 * Firestore-backed wrapper: ONE pa-users read + the pure check. FAIL-OPEN —
 * any read error returns false (the send proceeds as today), so this guard can
 * never block delivery on infrastructure noise.
 */
export async function userHasOpenPrescreen(
  db: Firestore,
  userId: string,
  nowMs: number = Date.now(),
  log?: (event: string, payload?: Record<string, unknown>) => void,
): Promise<boolean> {
  if (!userId) return false
  try {
    const snap = await db.collection("pa-users").doc(userId).get()
    const user = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null
    return hasOpenPrescreenWorkSession(user, nowMs)
  } catch (err) {
    log?.("pa.prescreen_guard.read_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
