/**
 * Phase 52 — Canonical token validation. [TAG-12]
 *
 * Write-time validation rejects:
 *  - Spaces (`software engineering` → reject; must be `software_engineering`)
 *  - Uppercase (must be lowercase + underscore only)
 *  - Common abbreviations (`swe`, `pm`, `sf`, `nyc`, `k8s`, `js`, `ts`, `py` …)
 *  - Tokens shorter than 3 chars (likely abbreviation)
 *
 * Adam-locked: D5 — LLM gets confused on abbreviations; force spelled-out form.
 */

/**
 * Common abbreviations rejected by `validateCanonicalToken` and
 * `validateRelevantTag`. Extend cautiously — every entry here is a token
 * that LLM consumers will be encouraged to spell out instead.
 */
export const KNOWN_ABBREVIATIONS = new Set<string>([
  // Roles
  "swe",
  "pm",
  "tpm",
  "epm",
  "sde",
  "qa",
  "sre",
  "ds",
  "fe",
  "be",
  // Locations
  "sf",
  "nyc",
  "la",
  "dc",
  "uk",
  "us",
  "usa",
  "eu",
  // Tech
  "js",
  "ts",
  "py",
  "k8s",
  "ml",
  "ai",
  "ux",
  "ui",
  "oss",
  "pr",
  "cd",
  "ci",
  "db",
  "vm",
  "iam",
  "ide",
  "cli",
  "api",
  // Executives
  "svp",
  "evp",
  "ceo",
  "cto",
  "cfo",
  "coo",
  "cmo",
  "cpo",
  "ciso",
  // Misc
  "hr",
  "rfp",
  "kpi",
  "saas",
])

export interface ValidateResult {
  ok: boolean
  reason?: string
}

/**
 * Generic write-time validator for canonical-tag tokens.
 *
 * @param value  Candidate token (e.g., `"software_engineering"`, `"swe"`).
 * @param vocab  Human-readable vocab name for error context (e.g.,
 *               `"roleFunction"`, `"industrySector"`).
 * @returns      `{ ok: true }` if accepted, else `{ ok: false, reason }`.
 */
export function validateCanonicalToken(
  value: string,
  vocab: string,
): ValidateResult {
  if (typeof value !== "string") {
    return { ok: false, reason: `${vocab}: token must be a string` }
  }
  if (value.length === 0) {
    return { ok: false, reason: `${vocab}: token must be non-empty` }
  }
  if (value !== value.toLowerCase()) {
    return { ok: false, reason: `${vocab}: must be lowercase` }
  }
  if (/\s/.test(value)) {
    return {
      ok: false,
      reason: `${vocab}: must use underscore not space`,
    }
  }
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    return {
      ok: false,
      reason: `${vocab}: must match [a-z][a-z0-9_]*`,
    }
  }
  if (KNOWN_ABBREVIATIONS.has(value)) {
    return {
      ok: false,
      reason: `${vocab}: abbreviation '${value}' rejected — use spelled-out form`,
    }
  }
  if (value.length < 3) {
    return {
      ok: false,
      reason: `${vocab}: too short, likely abbreviation`,
    }
  }
  return { ok: true }
}

/**
 * Throwing variant — used in code paths where a fail-fast contract is
 * preferred (e.g., backfills, admin-write tools).
 */
export function assertValidCanonicalToken(value: string, vocab: string): void {
  const result = validateCanonicalToken(value, vocab)
  if (!result.ok) {
    throw new Error(`Invalid canonical token: ${result.reason}`)
  }
}
