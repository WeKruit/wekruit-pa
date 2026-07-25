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
import {
  canonicalizeLinkedInUrl,
  fetchEmployeeCollect,
  searchEmployeeIdByLinkedinUrl,
} from "@pa/external-supply"
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
  // OUR OWN PLACEHOLDER IS NOT A PROFILE (2026-07-25). When LinkedIn's OIDC returns no vanity URL
  // we store `https://www.linkedin.com/oauth-linked/<sub>` as a bind marker. It passes every check
  // below (it IS a linkedin.com URL) and would be sent to Coresignal as if it were a profile —
  // live, 30 of the 32 stranded YC users carry exactly this string in `linkedinUrl`.
  if (s.includes("/oauth-linked/")) return null
  // CANONICAL WHEN WE CAN (2026-07-25). A URL typed into a phone arrives as `http://…`, `WWW.…`,
  // with a trailing slash, a `/de/in/…` locale prefix, or `?utm_source=share&…` tracking junk stuck
  // on the end — and the Coresignal lookup is a `match_phrase` on the indexed profile URL, so the
  // junk is a live miss risk. `canonicalizeLinkedInUrl` is the SAME normalizer the OAuth connect
  // runs before storing/searching, so a pasted URL and a connected one become byte-identical
  // strings. It only accepts the `/in/<slug>` shape; anything else keeps the lenient path below
  // (the signup form stores whatever LinkedIn URL the candidate typed).
  // `canonicalizeLinkedInUrl` matches the `/in/` segment case-SENSITIVELY (it feeds identity
  // hashing, so it is deliberately strict) — retry with that one segment folded rather than loosen
  // a normalizer that `pa-candidate-handles` ids depend on.
  const canonical = canonicalizeLinkedInUrl(s) ?? canonicalizeLinkedInUrl(s.replace(/\/in\//i, "/in/"))
  if (canonical) return canonical
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, "")}`
  try {
    const u = new URL(withScheme)
    if (!/linkedin\.com$/i.test(u.hostname) && !/\.linkedin\.com$/i.test(u.hostname)) return null
    return u.toString()
  } catch {
    return null
  }
}

/** First `linkedin.com/in/<slug>` profile URL in a free-text message, or null. */
export function extractLinkedinProfileUrl(text: string): string | null {
  const m = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/in\/[^\s<>"')\]]+/i.exec(text ?? "")
  if (!m) return null
  // Trailing sentence punctuation is not part of the slug ("here's mine: linkedin.com/in/ada.").
  return normalizeTypedLinkedinUrl(m[0].replace(/[.,;:!?]+$/, ""))
}

/**
 * True when we already hold REAL fetched background.
 *
 * DELIBERATELY NOT an OAuth-bind check (2026-07-25). It used to early-return on
 * `linkedinOauthLinked`, on the assumption that a bind implies data. It does not: LinkedIn's OIDC
 * only hands back a profile URL when the member's public profile is visible, so 32 of 87 YC users
 * who successfully connected had a bind, a placeholder URL and ZERO background — and this guard was
 * what made a later enrich attempt return `already_enriched` and do nothing. Test for the payload
 * (experiences / Coresignal row / résumé), never for the bind.
 */
function alreadyHasRealBackground(user: Record<string, unknown>): boolean {
  if (Array.isArray(user.experienceHighlights) && user.experienceHighlights.length > 0) return true
  if (typeof user.coresignalEmployeeId === "number") return true
  if (typeof user.latestResumeArtifactId === "string" && user.latestResumeArtifactId.trim()) return true
  return false
}

export async function enrichFromTypedLinkedinUrl(args: {
  db: Firestore
  userId: string
  apiKey: string | null
  nowIso?: string
  /** URL supplied THIS turn (pasted into chat) — wins over the stored `linkedinUrl`, and is
   *  persisted when it resolves so the placeholder marker stops shadowing a real profile. */
  rawUrl?: string
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
  const raw = args.rawUrl ?? (typeof user.linkedinUrl === "string" ? user.linkedinUrl : "")
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
    // YC POOL SYNC — make this person MATCHABLE BY OTHERS, not just a receiver of matches.
    // Without it the pool is the frozen 1066-row import: measured 2026-07-25 mid-event, 143 people
    // had scanned and 40 were fully enriched, and ZERO of them were in the pool — every attendee was
    // invisible to every attendee who arrived after them, which is exactly backwards for the
    // highest-intent people we have.
    // `syncYcPoolMember` gates on `isYcPeopleUser` itself (fail-closed), so a normal candidate
    // enriching here is stored globally and simply never joins the cohort. Fail-open: the pool is a
    // bonus, the enrich is the payload.
    try {
      const { syncYcPoolMember } = await import("./yc-pool-sync.js")
      const sync = await syncYcPoolMember({
        db,
        userId,
        record,
        nowIso,
        log: (e, p) => logger.info(`typed_linkedin_enrich.pool.${e}`, { userId, ...(p ?? {}) }),
      })
      logger.info("typed_linkedin_enrich.pool_sync", { userId, ok: sync?.ok === true, reason: sync?.reason ?? null, ms: sync?.ms ?? null })
    } catch (err) {
      logger.warn("typed_linkedin_enrich.pool_sync_failed", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    // Stamp provenance so downstream can tell an unverified typed-URL enrich from an OAuth bind.
    await db.collection(PA_COLLECTIONS.users).doc(userId).set(
      {
        linkedinEnrichSource: "typed_url_unverified",
        linkedinEnrichedAt: nowIso,
        // A pasted URL that RESOLVED replaces whatever was there (usually our own
        // `/oauth-linked/` placeholder) so every later reader sees a real profile.
        ...(args.rawUrl ? { linkedinUrl: url } : {}),
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
