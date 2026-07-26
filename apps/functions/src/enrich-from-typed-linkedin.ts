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
import { linkAndEnrichLinkedin } from "./linkedin-connect/linkedin-connect-submit.js"
import { normalizeLinkedinProfileUrl } from "./linkedin-url.js"

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

/**
 * First LinkedIn profile URL in a free-text message, or null.
 *
 * Widened 2026-07-25 against the day's real inbound: of 74 messages that mentioned LinkedIn, the
 * strict `linkedin.com/in/` form missed people who were genuinely handing us their profile —
 * `"Sure it's LinkedIn/in/jasonmilad"` (domain typed without `.com`) and `"my linkedin is at
 * /in/adiprabs"` (bare path, iOS having eaten the link). Both are read now.
 *
 * The bare `/in/<slug>` form is gated on the message ALSO saying "linkedin" — on its own it is far
 * too loose (`/in/` shows up in ordinary prose and other URLs) and a false positive here resolves a
 * STRANGER, which is the one failure mode this file is written to avoid.
 */
export function extractLinkedinProfileUrl(text: string): string | null {
  const s = text ?? ""
  const strip = (u: string) => normalizeTypedLinkedinUrl(u.replace(/[.,;:!?]+$/, ""))

  const full = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/in\/[^\s<>"')\]]+/i.exec(s)
  if (full) return strip(full[0])

  // `LinkedIn/in/<slug>` — the domain typed without `.com`. Rebuild the canonical host.
  const noTld = /(?:^|[\s:"'(])linked\s?in\/in\/([a-z0-9_%-]+)/i.exec(s)
  if (noTld?.[1]) return strip(`https://www.linkedin.com/in/${noTld[1]}`)

  // Bare `/in/<slug>` — only when the message says "linkedin" somewhere, see the note above.
  if (/linked\s?in/i.test(s)) {
    const bare = /(?:^|[\s:"'(])\/in\/([a-z0-9_%-]+)/i.exec(s)
    if (bare?.[1]) return strip(`https://www.linkedin.com/in/${bare[1]}`)
  }
  return null
}

/**
 * True when the message READS like the person is handing us their profile, even though we could not
 * pull a usable slug out of it — so the caller can ask them again instead of going silent.
 *
 * Real examples this catches (all from 2026-07-25, all previously answered with nothing):
 *   "Check out Rucha Agashe's profile on LinkedIn"   ← iOS share sheet, URL stripped
 *   "Consultez le profil de Adi Prabs sur LinkedIn"  ← same, French
 *   "https://www.linkedin.com/me?trk=…"              ← the /me self-link, no slug to resolve
 *   "Check my LinkedIn"
 *
 * Deliberately NOT matched: talking ABOUT LinkedIn ("i connected my linkedin", "linkedin login
 * doesn't work", "I forgot my LinkedIn password", "give me the LinkedIn of VPs of Engineering").
 * Those are conversation and the agent answers them properly today.
 */
export function looksLikeLinkedinShareAttempt(text: string): boolean {
  const s = (text ?? "").trim()
  if (!s) return false
  if (extractLinkedinProfileUrl(s)) return false
  if (!/linked\s?in|lnkd\.in/i.test(s)) return false
  // The /me self-link and any other linkedin.com URL with no /in/ slug.
  if (/linkedin\.com\/(me|profile|pub)\b/i.test(s)) return true
  // Share-sheet prose, in whatever language: "<verb> ... profile/profil ... LinkedIn".
  if (/\b(profile|profil|perfil|profilo)\b/i.test(s) && /linked\s?in/i.test(s)) return true
  if (/\b(check|see|view|here'?s|this is|that'?s)\b[^.!?]{0,40}\blinked\s?in\b/i.test(s)) return true
  return false
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
  /** URL supplied THIS turn (pasted into chat). */
  rawUrl?: string
  /** Test seams — forwarded to the shared enricher. */
  search?: Parameters<typeof linkAndEnrichLinkedin>[0]["searchByUrl"]
  fetch?: Parameters<typeof linkAndEnrichLinkedin>[0]["fetchOne"]
}): Promise<TypedLinkedinEnrichResult> {
  // THIN SHIM OVER THE OAUTH PATH (2026-07-25). This function used to be a SECOND implementation of
  // resolve -> mirror -> tags -> pool, duplicating `enrichFromCoresignal` step for step, comments
  // included. The two drifted, and every LinkedIn bug reported during the YC event was a symptom:
  // the copy had no `linkCandidateHandle` (so no identity-conflict detection), no photo rung, and a
  // lenient URL fallback that preserved the `?utm_*` and locale-host forms the provider rejects.
  //
  // There is now ONE implementation. This wrapper only maps the old result shape so the remaining
  // callers (openLayoff, backfill/probe scripts) keep working unchanged.
  const nowIso = args.nowIso ?? new Date().toISOString()
  // NO rawUrl → fall back to the URL ALREADY ON THE PROFILE. This is the original reason this file
  // exists: 2056 users typed a URL into the signup form and were never enriched from it. Dropping
  // this in the shim would silently re-open that gap. `normalizeTypedLinkedinUrl` returns null for
  // our own `/oauth-linked/<sub>` marker, so a bind-only user is still correctly unusable here.
  let raw = args.rawUrl?.trim()
  if (!raw) {
    try {
      const snap = await args.db.collection(PA_COLLECTIONS.users).doc(args.userId).get()
      const stored = (snap.data() ?? {}) as { linkedinUrl?: unknown }
      if (typeof stored.linkedinUrl === "string") raw = normalizeTypedLinkedinUrl(stored.linkedinUrl) ?? undefined
    } catch {
      /* read error → no stored URL to work from */
    }
  }
  if (!raw) return { ok: false, reason: "no_url" }
  // Add the scheme BEFORE canonicalizing: `canonicalizeLinkedInUrl` requires one, so a bare
  // `linkedin.com/in/ada` (very common from a phone) would otherwise return null and fall through
  // to the raw string — skipping exactly the normalization that makes `?utm_*` and locale hosts
  // resolve.
  const canonical = normalizeLinkedinProfileUrl(raw)
  const out = await linkAndEnrichLinkedin({
    db: args.db,
    userId: args.userId,
    nowIso,
    apiKey: args.apiKey,
    ...(canonical ? { canonicalUrl: canonical } : {}),
    ...(raw ? { rawUrl: raw } : {}),
    source: "paste",
    ...(args.search ? { searchByUrl: args.search } : {}),
    ...(args.fetch ? { fetchOne: args.fetch } : {}),
  })
  if (out.enriched) {
    const snap = await args.db.collection(PA_COLLECTIONS.users).doc(args.userId).get()
    const u = (snap.data() ?? {}) as Record<string, unknown>
    return {
      ok: true,
      employeeId: typeof u.coresignalEmployeeId === "number" ? u.coresignalEmployeeId : 0,
      experienceCount: Array.isArray(u.experienceHighlights) ? u.experienceHighlights.length : 0,
    }
  }
  if (out.reason === "already_bound") return { ok: false, reason: "already_enriched" }
  if (out.reason === "no_key") return { ok: false, reason: "no_key" }
  if (out.reason === "error") return { ok: false, reason: "error" }
  return { ok: false, reason: "no_match" }
}
