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

/** True when `userId` is in the new-behavior canary cohort (dev phones today). */
export function isCanaryUser(userId: string | null | undefined): boolean {
  return typeof userId === "string" && CANARY_UIDS.has(userId)
}
