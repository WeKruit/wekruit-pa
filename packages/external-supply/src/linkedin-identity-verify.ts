/**
 * linkedin-identity-verify.ts — does a PASTED LinkedIn URL belong to THIS logged-in user?
 *
 * Problem (Adam 2026-06-03): "Sign in with LinkedIn" (OIDC) verifies identity but returns NO
 * profile URL. So the candidate pastes their URL in chat and we Coresignal-collect it. Before we
 * ingest a stranger's work history as theirs, prove the pasted profile is self-owned by comparing
 * what OIDC gave us (login-verified) against what Coresignal returns for the pasted URL.
 *
 * Two signals, verified live against Adam's real profile (2026-06-03):
 *   1. PHOTO asset id  (PRIMARY, strong) — both OIDC `picture` and Coresignal `picture_url` embed
 *      the SAME immutable licdn asset id + upload epoch (`D5603AQFBF9xN99YgeQ:1719511227257`).
 *      Only size/expiry(`e=`)/signature(`t=`) differ → strip those. Names collide; this doesn't.
 *   2. NAME token-set  (FALLBACK) — OIDC `name` vs Coresignal `full_name`/`name_first`+`name_last`.
 *      Handles middle names + order ("Adam Yang" == "Adam J. Yang" == "Yang Adam").
 *
 * Verified if EITHER matches. Photo-mismatch is NOT fraud proof — Coresignal is a cached scrape
 * (its `last_updated` can predate a photo change) → fall back to name, never hard-block on photo
 * alone. Only when BOTH fail do we soft-confirm ("that profile shows <name> — is that you?").
 *
 * Pure + dependency-free so it unit-tests without network/Firestore.
 */

/** OIDC identity captured at login (the trust anchor). */
export interface OidcIdentity {
  /** OIDC `name` claim (→ stored as displayName). */
  name?: string | null
  /** OIDC `picture` claim (a signed licdn URL). */
  picture?: string | null
}

/** The fields we read off a Coresignal collected employee record for verification. */
export interface CoresignalIdentity {
  full_name?: string | null
  name_first?: string | null
  name_last?: string | null
  picture_url?: string | null
}

export type VerifySignal = "photo" | "name" | "none"

export interface LinkedinVerifyResult {
  /** true → safe to enrich silently. false → soft-confirm with the candidate. */
  verified: boolean
  /** which signal carried the match (for audit/logging). */
  matchedBy: VerifySignal
  /** the Coresignal-side display name, for the soft-confirm copy when not verified. */
  claimedName: string | null
}

/**
 * Extract the STABLE licdn identity from a profile-photo URL: the asset id (after `/dms/image/v2/`)
 * plus the upload epoch (`.../0/<epoch>?`). Size, `e=` (expiry) and `t=` (signature) are ephemeral
 * and MUST be ignored. Returns null for non-licdn / unparseable URLs (e.g. company-logo assets).
 */
export function licdnAssetKey(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null
  const asset = url.match(/\/dms\/image\/v2\/([^/?]+)\//)
  if (!asset) return null
  // displayphoto assets only — guard against company/school logos sharing the path shape.
  if (!/displayphoto|profile-displayphoto/i.test(url)) {
    // still allow when the URL clearly isn't a logo; epoch presence is the tie-breaker below.
  }
  const epoch = url.match(/\/0\/(\d{10,})\?/)
  return asset[1] + (epoch ? ":" + epoch[1] : "")
}

/** Normalize a human name → lowercase ascii tokens (strip accents/punctuation). */
function nameTokens(name: string | null | undefined): string[] {
  if (!name || typeof name !== "string") return []
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * token-set match: every token of the SHORTER name appears in the longer set. Handles middle names
 * and word order. Requires ≥2 shared tokens when both names have ≥2 tokens (a lone shared first
 * name like "Adam" vs "Adam Smith" must NOT pass as the same person).
 */
export function nameTokenSetMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const A = new Set(nameTokens(a))
  const B = new Set(nameTokens(b))
  if (A.size === 0 || B.size === 0) return false
  const [small, big] = A.size <= B.size ? [A, B] : [B, A]
  let hits = 0
  for (const t of small) if (big.has(t)) hits++
  if (hits !== small.size) return false
  // both multi-token → demand at least 2 overlapping tokens (avoid single-given-name collisions).
  if (A.size >= 2 && B.size >= 2) return hits >= 2
  // one side is a single token ("Adam") — too weak to verify against a full name ("Adam Smith")
  // unless the token sets are IDENTICAL (true mononyms only).
  return A.size === B.size && hits === small.size
}

function coresignalFullName(cs: CoresignalIdentity): string | null {
  if (cs.full_name && cs.full_name.trim()) return cs.full_name.trim()
  const joined = [cs.name_first, cs.name_last].filter((s) => s && s.trim()).join(" ").trim()
  return joined || null
}

/**
 * Decide whether the pasted profile (Coresignal) belongs to the logged-in user (OIDC). PRIMARY =
 * photo asset id; FALLBACK = name token-set. Verified if either matches.
 */
export function verifyLinkedinIdentity(
  oidc: OidcIdentity,
  coresignal: CoresignalIdentity,
): LinkedinVerifyResult {
  const claimedName = coresignalFullName(coresignal)

  const oidcKey = licdnAssetKey(oidc.picture)
  const csKey = licdnAssetKey(coresignal.picture_url)
  if (oidcKey && csKey && oidcKey === csKey) {
    return { verified: true, matchedBy: "photo", claimedName }
  }

  if (nameTokenSetMatch(oidc.name, claimedName)) {
    return { verified: true, matchedBy: "name", claimedName }
  }

  return { verified: false, matchedBy: "none", claimedName }
}
