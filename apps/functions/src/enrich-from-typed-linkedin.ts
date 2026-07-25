/**
 * enrich-from-typed-linkedin.ts — fetch a candidate's LinkedIn background from the URL they typed
 * on the signup form (Adam 2026-07-24).
 *
 * WHY THIS EXISTS: `getOrFetchCoresignalByLinkedin()` has always been available, but it was wired
 * ONLY to the browser extension, recruiter-submission-eval and prescreen-candidate-eval. The
 * candidate's own signup path never called it — the form collected `linkedinUrl` and just stored
 * the string. Combined with `hasIngestedBackground()` treating that string as "we already have
 * them", users were never enriched AND never offered the one-tap connect that would have produced
 * the data. A self-sealing gap: 2056 of 6500 users (32%) sat typed-URL-only with zero background.
 *
 * IDENTITY CAVEAT (deliberate, read before changing): a typed URL is the user ASSERTING "this is
 * me". It is not verified — only an OAuth connect proves identity. We enrich from it because the
 * user supplied it about themselves, but we stamp provenance so nothing downstream can mistake it
 * for a verified bind. We do NOT hard-gate on a name match: the 2026-07-24 dry-run showed a
 * legitimate user whose form name ("Chris Liu") differs from their legal name on LinkedIn
 * ("Xuanzuo Liu") — an English-name/legal-name split that a strict check would wrongly block.
 * A mismatch is recorded, not enforced.
 *
 * NEVER emits a runtime event: enriching is a DATA operation. Emitting `resume_parse_completed`
 * here would text a real person unprompted, which is a different decision with its own approval.
 */
import { randomUUID } from "crypto"
import type { Firestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions/v2"
import { fetchEmployeeCollect, searchEmployeeIdByLinkedinUrl } from "@pa/external-supply"
import { PA_COLLECTIONS, type ExternalCandidateRecord } from "@pa/core-types"
import {
  runCoresignalExperiencesMirror,
  makeFirestoreMirrorDeps,
} from "./external-supply/coresignal-experiences-mirror.js"
import { dualWriteLegacyUserTagsFromExternal } from "./external-supply/legacy-user-tags-bridge.js"
import { normalizeCoresignalCollectV2 } from "./external-supply/adapters/coresignal-collect-v2.js"

export type TypedLinkedinEnrichResult =
  | { ok: true; employeeId: number; experienceCount: number }
  | { ok: false; reason: "no_key" | "no_url" | "already_enriched" | "no_match" | "error" }

/**
 * Normalize a hand-typed LinkedIn URL enough for the Coresignal lookup.
 * Live values included `Linkedin.com/in/avnithv` (no scheme) and `in/zelin` (fragment only).
 * We only add a scheme — we never invent a path, because guessing is how you resolve a stranger.
 */
export function normalizeTypedLinkedinUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, "")}`
  try {
    const u = new URL(withScheme)
    if (!/linkedin\.com$/i.test(u.hostname) && !/\.linkedin\.com$/i.test(u.hostname)) return null
    return u.toString()
  } catch {
    return null
  }
}

/** True when we already hold REAL fetched background — mirrors mode-selector.hasIngestedBackground. */
function alreadyHasRealBackground(user: Record<string, unknown>): boolean {
  if (user.linkedinOauthLinked === true) return true
  if (typeof user.linkedinOauthSub === "string" && user.linkedinOauthSub.trim()) return true
  if (Array.isArray(user.experienceHighlights) && user.experienceHighlights.length > 0) return true
  if (typeof user.latestResumeArtifactId === "string" && user.latestResumeArtifactId.trim()) return true
  return false
}

export async function enrichFromTypedLinkedinUrl(args: {
  db: Firestore
  userId: string
  apiKey: string | null
  nowIso?: string
  /** Test seams — default to the real Coresignal calls. */
  search?: typeof searchEmployeeIdByLinkedinUrl
  fetch?: typeof fetchEmployeeCollect
}): Promise<TypedLinkedinEnrichResult> {
  const { db, userId } = args
  const nowIso = args.nowIso ?? new Date().toISOString()
  const search = args.search ?? searchEmployeeIdByLinkedinUrl
  const fetchOne = args.fetch ?? fetchEmployeeCollect
  const log = (event: string, fields?: Record<string, unknown>) =>
    logger.info(`typed_linkedin_enrich.${event}`, { userId, ...(fields ?? {}) })

  if (!args.apiKey) {
    log("skipped_no_api_key")
    return { ok: false, reason: "no_key" }
  }
  const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
  const user = (snap.data() ?? {}) as Record<string, unknown>

  // Never re-fetch when real background is already on file — OAuth/résumé data always wins over a
  // claim, and this keeps the job idempotent if the signup write retries.
  if (alreadyHasRealBackground(user)) {
    log("skipped_already_enriched")
    return { ok: false, reason: "already_enriched" }
  }
  const raw = typeof user.linkedinUrl === "string" ? user.linkedinUrl : ""
  const url = normalizeTypedLinkedinUrl(raw)
  if (!url) {
    log("skipped_unusable_url", { raw: raw.slice(0, 60) })
    return { ok: false, reason: "no_url" }
  }

  try {
    const employeeId = await search(url, { apiKey: args.apiKey })
    if (employeeId === null) {
      // Coresignal declining to guess is the SAFE outcome — the user still gets the one-tap
      // connect offer, which is the verified path.
      log("no_match", { url })
      return { ok: false, reason: "no_match" }
    }
    const employee = await fetchOne(employeeId, { apiKey: args.apiKey })
    const draft = normalizeCoresignalCollectV2(employee)

    // Provenance, not a gate: record whether the fetched name looks like the name on the form, so
    // a wrong-identity write is auditable after the fact. See the identity caveat in the header.
    const fetchedName = String((draft as Record<string, unknown>).fullName ?? "").toLowerCase().trim()
    const formName = String(user.displayName ?? "").toLowerCase().trim()
    const nameLooksConsistent =
      !fetchedName || !formName || fetchedName.split(/\s+/).some((p) => formName.includes(p))

    const record: ExternalCandidateRecord = {
      ...draft,
      recordId: `typed-linkedin:${userId}:${employeeId}`,
      batchId: `typed-linkedin:${randomUUID()}`,
      createdAt: nowIso,
      identityResolutionStatus: "merge_existing",
      resolvedUserId: userId,
    }
    const mirror = await runCoresignalExperiencesMirror(record, userId, {
      ...makeFirestoreMirrorDeps(db),
      now: () => nowIso,
      log: (e, p) => logger.info(`typed_linkedin_enrich.mirror.${e}`, { userId, ...(p ?? {}) }),
    })
    try {
      await dualWriteLegacyUserTagsFromExternal(db, userId, record, {
        nowIso,
        log: (e, p) => logger.info(`typed_linkedin_enrich.tags.${e}`, { userId, ...(p ?? {}) }),
      })
    } catch (err) {
      // Tags are a bonus; the experience mirror is the payload. Never fail the whole enrich on it.
      logger.warn("typed_linkedin_enrich.tags_failed", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    // Stamp provenance so downstream can tell an unverified typed-URL enrich from an OAuth bind.
    await db.collection(PA_COLLECTIONS.users).doc(userId).set(
      {
        linkedinEnrichSource: "typed_url_unverified",
        linkedinEnrichedAt: nowIso,
        ...(nameLooksConsistent ? {} : { linkedinEnrichNameMismatch: true }),
        updatedAt: nowIso,
      },
      { merge: true },
    )
    const experienceCount = Array.isArray((draft as Record<string, unknown>).experiences)
      ? ((draft as Record<string, unknown>).experiences as unknown[]).length
      : 0
    log("ok", { employeeId, mirror: mirror?.status, nameLooksConsistent })
    return { ok: true, employeeId, experienceCount }
  } catch (err) {
    // Fail-open: enrichment is best-effort and must never break signup.
    logger.warn("typed_linkedin_enrich.error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: "error" }
  }
}
