/**
 * YC Startup School people-lane predicate — THE single source of truth.
 *
 * Adam-LOCKED 2026-07-24: a YC Startup School user receives ZERO job-related content AND
 * ZERO job-related questions/asks — no job listings, no role pitches, no prescreen invites,
 * no job-search intake questions (target role / salary / visa / job type), and no daily
 * job-recommendation opt-in or push. YC is PEOPLE matching (founders, investors, operators
 * meeting each other); investors sign up too, so "candidate looking for a role" is the wrong
 * frame for the entire cohort.
 *
 * WHY THIS LIVES IN core-types: the predicate was duplicated with DIFFERENT conditions across
 * packages that cannot import each other (apps/functions vs apps/job-rec). The narrow
 * `source === "yc_startup_school"` copy in job-rec's audience-provision silently admitted QR
 * event entrants whose `source` is `candidate` / `qr_imessage` but who carry `ycEventEntryAt`
 * — live 2026-07-24, that is exactly how real YC users (xoIzGJpT06GvrmIQwHlt,
 * f3f16f3f-0056-4418-a206-6781c71f423c) ended up with active `pa-job-profiles` rows in the
 * job-rec audience. core-types is a dependency of BOTH, so every reader can share one
 * definition. Do NOT re-inline a narrower copy.
 *
 * THREE independent signals, ORed — a user is YC people if ANY holds:
 *  1. `source === "yc_startup_school"`        — website /yc-startup signup
 *  2. `ycEventEntryAt` present                — event QR cold-start (source may be qr_imessage/candidate)
 *  3. `firstTouchCampaign === "yc-startup-school"` — campaign attribution
 */

/** The pa-users fields that mark a YC people-lane user. All optional — callers pass raw docs. */
export type YcPeopleSignals = {
  source?: unknown
  ycEventEntryAt?: unknown
  firstTouchCampaign?: unknown
}

/** pa-users.source value written by the website /yc-startup signup. */
export const YC_PEOPLE_SOURCE = "yc_startup_school"

/** firstTouchCampaign value written by the YC event QR campaign. */
export const YC_PEOPLE_CAMPAIGN = "yc-startup-school"

/**
 * True when this pa-users doc belongs to the YC Startup School people lane.
 *
 * Deliberately permissive across the three signals: a false positive costs one user a job rec
 * they can still get by asking outside the YC lane, while a false negative sends job content to
 * a founder or investor — the exact violation this predicate exists to prevent. When in doubt,
 * treat as YC.
 */
export function isYcPeopleUser(user: YcPeopleSignals | null | undefined): boolean {
  if (!user) return false
  return (
    user.source === YC_PEOPLE_SOURCE ||
    Boolean(user.ycEventEntryAt) ||
    user.firstTouchCampaign === YC_PEOPLE_CAMPAIGN
  )
}
