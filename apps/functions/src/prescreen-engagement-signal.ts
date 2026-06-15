/**
 * prescreen-engagement-signal.ts — compute + persist the ADVISORY engagement (effort)
 * signal for one prescreen session.
 *
 * Pure metric over the candidate's own replies (no LLM, no Coresignal) → cheap enough to
 * run on every session and to backfill over all of history. Stored on
 * `review.engagementSignal`. NEVER gates the session, never a reject reason — it only
 * ranks/triages effort for the operator. Fail-open: any error leaves the session as-is.
 *
 * Runs from the same `paPrescreenCandidateEval` trigger as the checklist eval, but
 * independently of it (a session with no job checklist still gets an engagement signal).
 */
import { type Firestore } from "firebase-admin/firestore"
import { computePrescreenEngagement, type PrescreenEngagementSignal } from "@pa/core-types"

const SESSIONS = "pa-prescreen-sessions"

export type PrescreenEngagementResult = {
  status: "written" | "skipped_no_session" | "skipped_existing" | "error"
  sessionId: string
  signal?: PrescreenEngagementSignal
}

/** Load the candidate's reply strings (one per turn), oldest first. */
async function loadReplies(db: Firestore, sessionId: string): Promise<string[]> {
  const snap = await db.collection(SESSIONS).doc(sessionId).collection("turns").orderBy("ts", "asc").get()
  return snap.docs.map((d) => {
    const t = d.data() as { reply?: unknown }
    return typeof t.reply === "string" ? t.reply : ""
  })
}

/**
 * Compute the engagement signal for ONE session and store it on `review.engagementSignal`.
 * Idempotent: skips a session that already has a signal of the current version unless
 * `force`. Advisory + fail-open.
 */
export async function runPrescreenEngagementSignal(
  sessionId: string,
  deps: { db: Firestore; now?: () => string; log?: (event: string, fields?: Record<string, unknown>) => void },
  opts: { force?: boolean } = {},
): Promise<PrescreenEngagementResult> {
  const log = deps.log ?? (() => {})
  const now = deps.now?.() ?? new Date().toISOString()
  try {
    const sessionSnap = await deps.db.collection(SESSIONS).doc(sessionId).get()
    if (!sessionSnap.exists) return { status: "skipped_no_session", sessionId }
    const session = (sessionSnap.data() ?? {}) as Record<string, unknown>
    const existing = (session.review as Record<string, unknown> | undefined)?.engagementSignal as
      | PrescreenEngagementSignal
      | undefined
    if (existing && existing.version === computePrescreenEngagement([]).version && !opts.force) {
      return { status: "skipped_existing", sessionId, signal: existing }
    }

    const replies = await loadReplies(deps.db, sessionId)
    const signal: PrescreenEngagementSignal = { ...computePrescreenEngagement(replies), computedAt: now }

    await deps.db.collection(SESSIONS).doc(sessionId).set(
      { review: { engagementSignal: signal }, updatedAt: now },
      { merge: true },
    )
    log("prescreen_engagement.written", { sessionId, level: signal.level, answers: signal.answeredCount, words: signal.totalWords })
    return { status: "written", sessionId, signal }
  } catch (err) {
    log("prescreen_engagement.error", { sessionId, error: err instanceof Error ? err.message : String(err) })
    return { status: "error", sessionId }
  }
}
