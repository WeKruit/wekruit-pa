/**
 * canary.ts — THE single gate for new (post-baseline) behavior.
 *
 * Adam directive 2026-06-01: when we merge to main + deploy, NEW changes must be
 * live for the DEV PHONES ONLY; everyone else keeps the existing deployed run —
 * and WITHOUT adding a new feature flag per change ("no infinite flagging").
 *
 * So every new code path funnels through ONE check: `isCanaryUser(userId)`.
 *   - canary user  → run the new behavior
 *   - everyone else → fall through to the existing/old behavior (unchanged)
 *
 * To RELEASE to everyone, you change ONE thing here (add uids, or make
 * isCanaryUser return true for all) — you do NOT touch each feature. This is the
 * single ramp 抓手. Replaces the scattered SCHEDULING_DEV_UIDS / ack-always-on /
 * etc. — those should import from here so there is exactly one cohort to widen.
 *
 * (Kept as an in-code Set for now — deliberately NOT a Firestore flag doc, to
 * avoid the per-feature flag sprawl. When a runtime ramp is needed, back this
 * one function with one `pa-feature-flags/paCanaryCohort` doc — still one gate.)
 */

/** The dev-phone cohort. Widen HERE to ramp ALL new behavior at once. */
export const CANARY_UIDS: ReadonlySet<string> = new Set<string>([
  "8fEwIduUrzxZsblHHsNz", // Adam  +14243201960
  "UKFaKdsMzzfPW2CDl5ve", // Noah  +12154034668
])

/**
 * RAMP (Adam 2026-06-03, explicit "ramp"): the onboarding program (résumé/LinkedIn dual-path,
 * enrichment+pitch, website-short, Gmail-nudge, connect-phone) is verified to the limit possible
 * without a live phone, so the new behavior is RELEASED TO ALL USERS. This is the single ramp 抓手.
 * To REVERT to dev-phone-only, set RAMPED_TO_ALL=false (the CANARY_UIDS set is preserved) + redeploy.
 */
// Env-gated so the canary-SPLIT unit tests (which assert non-canary fallthrough) keep their two
// cohorts by DEFAULT (env unset → false), while PROD sets PA_ONBOARDING_RAMP_ALL=1
// (.env.wekruit-5f89b) → everyone. Reversible by clearing the env var + redeploy. One ramp 抓手.
function isRampedToAll(): boolean {
  return process.env.PA_ONBOARDING_RAMP_ALL === "1"
}

/** True when `userId` should get the new behavior. Ramped (prod) → everyone; else the dev cohort. */
export function isCanaryUser(userId: string | null | undefined): boolean {
  if (isRampedToAll()) return true
  return typeof userId === "string" && CANARY_UIDS.has(userId)
}
