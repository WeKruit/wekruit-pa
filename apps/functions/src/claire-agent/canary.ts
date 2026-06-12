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

/**
 * DEDICATED gate for the PRESCREEN-SEAM RETENTION HANDOFF (2026-06-05).
 *
 * The post-prescreen-terminal / retention turn is a SENSITIVE prod path (it runs on every
 * candidate's reply after a screen pauses, fails, or passes). The risk-gating rule for this change
 * says it MUST ship dev-phone-only FIRST and ramp ONLY on Adam's explicit say-so — SEPARATELY from
 * the onboarding ramp.
 *
 * `isCanaryUser` cannot be used here: in prod `PA_ONBOARDING_RAMP_ALL=1` (.env.wekruit-5f89b) makes
 * `isRampedToAll()` true → `isCanaryUser` returns true for EVERYONE. Routing every post-terminal turn
 * through the thin agent for all users on first deploy would violate the risk gate.
 *
 * So this gate keys ONLY on the static `CANARY_UIDS` dev cohort and DELIBERATELY ignores
 * `isRampedToAll()` / `PA_ONBOARDING_RAMP_ALL`. To ramp the retention handoff, Adam adds a separate
 * env switch here (or widens CANARY_UIDS) — never swept live by the onboarding ramp.
 */
/**
 * DEDICATED gate for the STALLED-SCREEN 24h NUDGE (2026-06-10 trust audit, fix 10).
 *
 * NEW outbound behavior (a proactive message to a mid-screen candidate), so it must ship
 * dev-cohort-only first. `isCanaryUser` cannot gate it: prod sets PA_ONBOARDING_RAMP_ALL=1,
 * which makes `isCanaryUser` true for EVERYONE — a fresh proactive sender would mass-send on
 * first deploy. Same reasoning + pattern as isPrescreenRetentionHandoffCanary below: keys on
 * the static CANARY_UIDS dev cohort and DELIBERATELY ignores the onboarding ramp. To ramp,
 * Adam sets PA_PRESCREEN_NUDGE_RAMP_ALL=1 (its own kill switch) or widens CANARY_UIDS.
 */
export function isPrescreenNudgeCanary(userId: string | null | undefined): boolean {
  if (process.env.PA_PRESCREEN_NUDGE_RAMP_ALL === "1") return true
  return typeof userId === "string" && CANARY_UIDS.has(userId)
}

/**
 * DEDICATED gate for CLAIRE ENTRY UX rebuild slices (2026-06-11).
 *
 * This covers candidate-entry polish that changes when Claire holds, resumes, or starts a screen
 * around profile enrichment. It must start with dev phones only and must NOT be swept live by the
 * onboarding ramp (`PA_ONBOARDING_RAMP_ALL=1` makes `isCanaryUser` true for everyone in prod).
 *
 * To ramp this specific UX later, set PA_CLAIRE_ENTRY_UX_RAMP_ALL=1 or widen CANARY_UIDS.
 */
export function isClaireEntryUxCanary(userId: string | null | undefined): boolean {
  if (process.env.PA_CLAIRE_ENTRY_UX_RAMP_ALL === "1") return true
  return typeof userId === "string" && CANARY_UIDS.has(userId)
}

export function isPrescreenRetentionHandoffCanary(userId: string | null | undefined): boolean {
  // RAMPED (Adam 2026-06-05 explicit "yes" — real affected users, e.g. Sai +18578918525, must get
  // the fix, not just dev phones). Uses a DEDICATED switch independent of the onboarding
  // `PA_ONBOARDING_RAMP_ALL`, so this sensitive prescreen path keeps its OWN kill switch: clear
  // PA_PRESCREEN_HANDOFF_RAMP_ALL + redeploy to revert to dev-cohort-only. NOT `isRampedToAll()`.
  if (process.env.PA_PRESCREEN_HANDOFF_RAMP_ALL === "1") return true
  return typeof userId === "string" && CANARY_UIDS.has(userId)
}
