/**
 * Submitter ordering for the recruiter-submissions board — external recruiters first.
 *
 * Adam 2026-07-27: "sort by recruiter, prefer 非wekruit的recruiter (for view only)".
 *
 * Measured that day: 3,917 of 4,676 submissions (84%) carry an @wekruit.com submitter — our own
 * bulk-sourced batches — leaving 759 from outside recruiters, which are the ones with a person on
 * the other end waiting on an answer.
 *
 * Lives in its own dependency-free module ON PURPOSE: the page imports `lib/firebase.ts`, which
 * reads `import.meta.env` and therefore cannot be imported from a plain `node --test` run. Keeping
 * this here is what lets the rule have real unit tests instead of a source-string assertion.
 *
 * VIEW ONLY — this changes row order and nothing else. No status, payout, or recruiter-visible
 * field depends on it.
 */

/**
 * Domain, not display name: the internal batches have run under three different names
 * (WeKruit Admin / Admin WeKruit / WeKruit YC Sourcing (auto)) against the same mailbox, so a
 * name-based rule would silently miss the next one.
 */
export const WEKRUIT_INTERNAL_EMAIL_DOMAIN = "wekruit.com"

export function isWekruitInternalSubmitter(email?: string | null): boolean {
  return (email ?? "").trim().toLowerCase().endsWith(`@${WEKRUIT_INTERNAL_EMAIL_DOMAIN}`)
}

/**
 * Sort key: external recruiters (band 0) → unclassifiable (band 1) → ours (band 2), alphabetical
 * within each band. A string so the table's generic `localeCompare` orders it with no special
 * casing in the hook.
 */
export function submitterSortKey(
  submitter?: { name?: string | null; email?: string | null } | null,
): string {
  const email = (submitter?.email ?? "").trim().toLowerCase()
  const name = (submitter?.name ?? "").trim().toLowerCase()
  // No email → a handful of legacy rows. Ranked between rather than lumped in with ours, so an
  // unclassifiable submitter is never buried below 3,900 internal rows.
  const band = !email ? 1 : isWekruitInternalSubmitter(email) ? 2 : 0
  return `${band}|${name || email}`
}
