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
