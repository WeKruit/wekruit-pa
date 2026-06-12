/**
 * enrichment-inflight.ts — WS-1(b) durable "enrichment is running right now" marker.
 *
 * Adam 2026-06-03: while a candidate's résumé is parsing OR their LinkedIn is being
 * enriched via CoreSignal (between the ack and the resume_parse_completed event), if
 * they send ANOTHER message, Claire must KNOW enrichment is in progress and say
 * "still pulling your info, one sec 🔎" instead of pitching on empty data or answering
 * blind. This is the single source of truth for that marker so the SET (cutover résumé
 * path + linkedin-connect-submit) and CLEAR (cutover cv-parsed re-entry) share one
 * tested writer, and the READ (mode-selector) shares one tested predicate.
 *
 * Durable home = the pa-users doc (already read by selectClaireMode), NOT a new
 * collection. Field literal lives ONLY here.
 *
 * TTL self-heal: if the resume_parse_completed event never fires (a hard parse
 * failure with no completion event), the marker would otherwise stick true and make
 * Claire perpetually say "still loading". So the read predicate treats the marker as
 * EXPIRED once `enrichmentStartedAt` is older than ENRICHMENT_INFLIGHT_TTL_MS — résumé
 * parse + CoreSignal both finish well under that window, so a dropped completion event
 * self-heals on the next turn.
 */
import type { Firestore } from "firebase-admin/firestore"

const USERS = "pa-users"

/** Enrichment finishes well under 3 min (parse + CoreSignal). A stale marker past this
 *  is treated as cleared so a dropped completion event never strands the candidate. */
export const ENRICHMENT_INFLIGHT_TTL_MS = 3 * 60 * 1000

export type EnrichmentSource = "resume" | "linkedin"

/** Set the in-flight marker (best-effort; never throws upward). Called at the ack turn. */
export async function setEnrichmentInFlight(
  db: Firestore,
  userId: string,
  source: EnrichmentSource,
  nowIso: string,
): Promise<void> {
  try {
    await db
      .collection(USERS)
      .doc(userId)
      .set(
        {
          enrichmentInFlight: true,
          enrichmentStartedAt: nowIso,
          enrichmentSource: source,
          updatedAt: nowIso,
        },
        { merge: true },
      )
  } catch {
    /* best-effort — a missed marker just degrades to the pre-WS-1b behavior */
  }
}

/** Clear the in-flight marker (best-effort). Called on the resume_parse_completed re-entry. */
export async function clearEnrichmentInFlight(
  db: Firestore,
  userId: string,
  nowIso: string,
): Promise<void> {
  try {
    await db
      .collection(USERS)
      .doc(userId)
      .set({ enrichmentInFlight: false, updatedAt: nowIso }, { merge: true })
  } catch {
    /* best-effort — the TTL guard self-heals a missed clear */
  }
}

/**
 * Read predicate over an already-fetched pa-users doc (zero extra read).
 * True ONLY when the marker is set AND not past its TTL. A malformed / missing
 * `enrichmentStartedAt` is treated as fresh (the SET always writes it, so the only
 * way it's absent is a hand-written doc) — but a parseable, expired timestamp clears.
 */
export function isEnrichmentInFlight(
  userDoc: Record<string, unknown> | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!userDoc || userDoc.enrichmentInFlight !== true) return false
  const startedAtRaw = userDoc.enrichmentStartedAt
  if (typeof startedAtRaw === "string") {
    const startedAt = Date.parse(startedAtRaw)
    if (Number.isFinite(startedAt) && now - startedAt > ENRICHMENT_INFLIGHT_TTL_MS) {
      return false // stale → self-heal (a dropped completion event)
    }
  }
  return true
}

// ── ENTRY-UX ENRICHMENT HOLD NOTICE (PRD §2.3.6 / §2.4) ────────────────────────────────────────
// While enrichment is in flight, a candidate's "hi" / "what now?" / first Talk-to-Claire message
// gets ONE short deterministic progress line instead of a pitch from incomplete data — and exactly
// once per enrichment window (the once-only convention the progress heartbeat established). The
// stamp `enrichmentHoldNoticeAt` lives on the SAME pa-users doc as the marker; "this window" =
// noticeAt >= enrichmentStartedAt. A NEW enrichment (fresh enrichmentStartedAt) re-arms the notice.

/** PRD §2.3.6 copy shape: progress, understand-first, will-continue. One short bubble, no receipt prose. */
export const ENRICHMENT_HOLD_NOTICE_COPY =
  "still pulling in your background — let me understand you first, then i'll pick this right back up 🙏"

/**
 * Pure predicate: should the once-only hold notice send NOW for this user doc?
 * True only when enrichment is actually in flight (TTL-aware) AND no notice has
 * been sent yet for the CURRENT enrichment window.
 */
export function shouldSendEnrichmentHoldNotice(
  userDoc: Record<string, unknown> | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!isEnrichmentInFlight(userDoc, now)) return false
  const noticeAtRaw = userDoc?.enrichmentHoldNoticeAt
  if (typeof noticeAtRaw !== "string") return true
  const noticeAt = Date.parse(noticeAtRaw)
  if (!Number.isFinite(noticeAt)) return true
  const startedAtRaw = userDoc?.enrichmentStartedAt
  const startedAt = typeof startedAtRaw === "string" ? Date.parse(startedAtRaw) : Number.NaN
  // Notice already sent for THIS window → suppress. (Unparseable startedAt → treat the
  // existing notice as covering the window — never spam on malformed data.)
  if (!Number.isFinite(startedAt)) return false
  return noticeAt < startedAt
}

/**
 * Claim the once-only hold notice: reads the doc, checks the window, stamps
 * `enrichmentHoldNoticeAt`. Returns true exactly when the CALLER should send the
 * notice. Best-effort/fail-closed: any read/write error returns false (the agent
 * path still carries the softer enrichmentInFlight directive, so no one is stranded).
 */
export async function claimEnrichmentHoldNotice(
  db: Firestore,
  userId: string,
  nowIso: string,
): Promise<boolean> {
  try {
    const snap = await db.collection(USERS).doc(userId).get()
    const user = ((snap.exists ? snap.data() : {}) ?? {}) as Record<string, unknown>
    if (!shouldSendEnrichmentHoldNotice(user)) return false
    await db
      .collection(USERS)
      .doc(userId)
      .set({ enrichmentHoldNoticeAt: nowIso, updatedAt: nowIso }, { merge: true })
    return true
  } catch {
    return false
  }
}
