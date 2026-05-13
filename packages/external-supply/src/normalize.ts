/**
 * Wave B normalize lib — pure helpers shared between the import callable
 * and (later) C's identity resolver.
 *
 * Sole responsibilities:
 *  - Canonicalize a LinkedIn profile URL down to a single string form
 *    (`https://linkedin.com/in/<slug>`) so we can deterministically hash it.
 *  - Re-use marketplace.ts handle helpers (`candidateHandleHashMaterial` +
 *    `sha256Hex`) so external-supply hashes are byte-identical to the rest
 *    of the platform (v2.0 S1 identity layer).
 *  - Normalize email + phone strings to a single canonical representation
 *    suitable for hashing.
 *  - Deduplicate records within a single import batch.
 *
 * Lead resolutions (PLAN §11 Wave B):
 *  - B Q2 → `meta` on batch carries adapter audit; this file stays pure.
 *  - B Q3 → phone normalization NEVER assumes a country code. Anything
 *    non-E.164 returns `{ ok: false, value: null }` and adapters surface
 *    `normalizationErrors.push("phone_not_e164")`.
 */

import { candidateHandleHashMaterial } from "@pa/core-types"
import { sha256Hex } from "@wekruit/shared-tags"

// ---------------------------------------------------------------------------
// LinkedIn URL canonicalization
// ---------------------------------------------------------------------------

/**
 * Canonicalize a raw LinkedIn profile URL.
 *
 * Accepts: `https://`, `http://`, `//` schemes or no scheme at all.
 * Drops:   query string, hash, trailing slash, locale `/{cc}/in/` prefix.
 * Requires: host ends with `linkedin.com` (any case), path starts with
 *           `/in/<slug>` where `<slug>` is alphanumeric, hyphen, underscore
 *           or percent-encoded byte.
 *
 * Returns: `https://linkedin.com/in/<lowercase-slug>` on success, or `null`
 * for any malformed input (including `null` / `undefined` / empty).
 */
export function canonicalizeLinkedInUrl(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null

  // Reject `mailto:`, `tel:`, etc. up front — they pass `new URL()` and
  // would otherwise show up as host-less URLs later.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return null
  }

  // Coerce to a fully-qualified URL string so we can use the URL parser.
  let withScheme = trimmed
  if (/^\/\//.test(withScheme)) {
    withScheme = `https:${withScheme}`
  } else if (!/^https?:\/\//i.test(withScheme)) {
    withScheme = `https://${withScheme}`
  }

  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return null
  }

  // Host must end with linkedin.com (case-insensitive). Accept www., m.,
  // etc. as long as the apex matches.
  const host = parsed.host.toLowerCase()
  if (!/(^|\.)linkedin\.com$/.test(host)) return null

  // Drop locale prefix `/{cc}/in/...` (2- or 3-letter country code).
  // `/in/...` stays as-is.
  let path = parsed.pathname
  const localeMatch = /^\/[a-z]{2,3}\/in\//i.exec(path)
  if (localeMatch) {
    path = path.slice(localeMatch[0].length - "/in/".length)
  }

  // Require `/in/<slug>` shape.
  const m = /^\/in\/([A-Za-z0-9\-_%]+)\/?$/.exec(path)
  if (!m) return null

  const slug = m[1]!.toLowerCase()
  return `https://linkedin.com/in/${slug}`
}

/**
 * sha256 over the canonical LinkedIn URL hash material — byte-identical to
 * `candidateHandleHashMaterial("linkedin", canonical)` so external-supply
 * hashes match `pa-candidate-handles` ids from S2.
 */
export function linkedinHash(canonicalUrl: string): string {
  return sha256Hex(candidateHandleHashMaterial("linkedin", canonicalUrl))
}

// ---------------------------------------------------------------------------
// Email normalization
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Trim + lowercase. Reject anything that doesn't pass our RFC-5322-lite
 * regex. Plus-aliases (`foo+bar@baz.com`) are preserved verbatim — we don't
 * collapse them because providers like Outlook treat them as distinct.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const trimmed = String(raw).trim().toLowerCase()
  if (!trimmed) return null
  if (!EMAIL_RE.test(trimmed)) return null
  return trimmed
}

/**
 * sha256 over `email:<normalized>` — matches the rest of the platform's
 * email handle id derivation.
 */
export function emailHash(normalizedEmail: string): string {
  return sha256Hex(candidateHandleHashMaterial("email", normalizedEmail))
}

// ---------------------------------------------------------------------------
// Phone normalization
// ---------------------------------------------------------------------------

const E164_RE = /^\+[1-9]\d{1,14}$/

/**
 * Result type for the phone normalizer. `ok:false` keeps the call site
 * from accidentally writing an empty string to Firestore.
 */
export type PhoneNormalizationResult =
  | { value: string; ok: true }
  | { value: null; ok: false }

/**
 * Strip everything except digits and a single leading `+`. Reject anything
 * that doesn't end up matching `+[1-9]\d{1,14}` (strict E.164). Per lead
 * resolution B Q3: no country-code guess.
 */
export function normalizePhoneE164(
  raw: string | null | undefined,
): PhoneNormalizationResult {
  if (raw == null) return { value: null, ok: false }
  const trimmed = String(raw).trim()
  if (!trimmed) return { value: null, ok: false }

  // Pull the leading `+` (if present) and join all remaining digits.
  const hasPlus = trimmed.startsWith("+")
  const digits = trimmed.replace(/[^0-9]/g, "")
  const candidate = hasPlus ? `+${digits}` : digits

  if (!E164_RE.test(candidate)) return { value: null, ok: false }
  return { value: candidate, ok: true }
}

/**
 * sha256 over `phone:<e164>` — matches the rest of the platform.
 */
export function phoneHash(e164: string): string {
  return sha256Hex(candidateHandleHashMaterial("phone", e164))
}

// ---------------------------------------------------------------------------
// In-batch dedupe
// ---------------------------------------------------------------------------

/**
 * Minimum shape `dedupeWithinBatch` needs to do its job. The full record
 * type is `ExternalCandidateRecord` (or its draft) but we narrow here so
 * the function stays usable by unit tests and adapters alike.
 */
export interface DedupeRecord {
  canonicalLinkedInUrl?: string | null
  linkedinProfileHash?: string | null
  emails?: ReadonlyArray<{ value: string; hash: string }>
}

export interface DedupeResult<T> {
  kept: T[]
  duplicateCount: number
  /** Indexes (into the input array) of records that were dropped. */
  duplicateIndexes: number[]
}

/**
 * Dedupe priority: LinkedIn hash first (most specific identity), then the
 * primary (`emails[0]`) email hash. Records with neither signal are kept
 * as-is — we have no way to know they're duplicates.
 *
 * First occurrence wins. Returns the kept records, a duplicate count, and
 * the input-array indexes that were dropped (for audit / error reporting).
 */
export function dedupeWithinBatch<T extends DedupeRecord>(
  records: ReadonlyArray<T>,
): DedupeResult<T> {
  const seenLinkedIn = new Set<string>()
  const seenEmail = new Set<string>()
  const kept: T[] = []
  const duplicateIndexes: number[] = []

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!
    const liHash = rec.linkedinProfileHash ?? null
    const emailHashValue = rec.emails && rec.emails.length > 0 ? rec.emails[0]!.hash : null

    if (liHash && seenLinkedIn.has(liHash)) {
      duplicateIndexes.push(i)
      continue
    }
    if (!liHash && emailHashValue && seenEmail.has(emailHashValue)) {
      duplicateIndexes.push(i)
      continue
    }

    if (liHash) seenLinkedIn.add(liHash)
    if (emailHashValue) seenEmail.add(emailHashValue)
    kept.push(rec)
  }

  return {
    kept,
    duplicateCount: duplicateIndexes.length,
    duplicateIndexes,
  }
}
