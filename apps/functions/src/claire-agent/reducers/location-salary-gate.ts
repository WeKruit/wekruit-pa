/**
 * location-salary-gate.ts — the ONE conditional pre-match ask in the canonical candidate flow.
 *
 * Canonical flow (Adam-LOCKED, .planning/CANONICAL-CANDIDATE-FLOW.md, Step 4): right before matching,
 * ask the candidate for their US location + rough target salary ONCE — but ONLY IF we are missing
 * BOTH and they never mentioned either. If we already have location OR salary (from LinkedIn / résumé
 * / conversation), skip silently. Never re-ask.
 *
 * Pure + deterministic — no LLM, no regex, no Firestore. The caller (mode-selector) reads the user doc
 * and stamps the once-only marker. Fail-open: a malformed user doc → returns false (don't block match).
 */

/** The durable once-only stamp written when the gate fires, so it never re-asks. */
export const LOCATION_SALARY_ASKED_AT = "locationSalaryAskedAt"

function hasLocation(tags: Record<string, unknown>): boolean {
  const locs = tags.targetLocations
  return Array.isArray(locs) && locs.some((l) => typeof l === "string" && l.trim().length > 0)
}

function hasSalary(tags: Record<string, unknown>): boolean {
  const s = tags.minSalary
  return typeof s === "number" && Number.isFinite(s) && s > 0
}

/**
 * True ONLY when BOTH location and salary are missing AND we have not already asked. If either is
 * present (they mentioned it, or it came from enrichment), returns false — we never ask redundantly.
 */
export function needsLocationSalaryAsk(user: Record<string, unknown>): boolean {
  if (user[LOCATION_SALARY_ASKED_AT]) return false
  const tags = (user.tags ?? {}) as Record<string, unknown>
  if (hasLocation(tags) || hasSalary(tags)) return false
  return true
}
