/**
 * v2.0 External Supply V1 — Wave D — Pure helpers for the badge components.
 * Extracted so we can unit-test the status→label/tone mappings without
 * mounting React (the dashboard package's test runner is `node --test`,
 * mirroring `MatchCandidates.helpers.ts` + `CanonicalTags.helpers.ts`).
 */
import type {
  EvaluationTier,
  IdentityResolutionStatus,
  InstantlySyncStatus,
  OutreachApprovalStatus,
} from "@pa/core-types"

/**
 * Tone aligns with the existing `.status-badge` classes — "good"/"bad"/"warn"
 * are already styled in `styles.css`; "muted" / "neutral" reuse the muted
 * variant. Any extra tones below resolve to `muted` to keep this file the
 * single source of truth across pages.
 */
export type BadgeTone = "good" | "bad" | "warn" | "muted"

export interface BadgeSpec {
  label: string
  tone: BadgeTone
}

export const IDENTITY_STATUS_BADGES: Record<IdentityResolutionStatus, BadgeSpec> = {
  pending: { label: "Pending", tone: "muted" },
  create_new: { label: "Create new", tone: "good" },
  merge_existing: { label: "Merge existing", tone: "good" },
  needs_review: { label: "Needs review", tone: "warn" },
  blocked: { label: "Blocked", tone: "bad" },
}

export function identityStatusBadge(status: IdentityResolutionStatus): BadgeSpec {
  return IDENTITY_STATUS_BADGES[status] ?? { label: status, tone: "muted" }
}

export const EVALUATION_TIER_BADGES: Record<EvaluationTier, BadgeSpec> = {
  tier_1_personal_linkedin_and_email: { label: "Tier 1 · LI + email", tone: "good" },
  tier_2_personal_email: { label: "Tier 2 · personal email", tone: "good" },
  tier_3_general_email: { label: "Tier 3 · general email", tone: "warn" },
  retain_only: { label: "Retain only", tone: "muted" },
  blocked: { label: "Blocked", tone: "bad" },
}

export function evaluationTierBadge(tier: EvaluationTier): BadgeSpec {
  return EVALUATION_TIER_BADGES[tier] ?? { label: tier, tone: "muted" }
}

export const INSTANTLY_SYNC_BADGES: Record<InstantlySyncStatus, BadgeSpec> = {
  not_synced: { label: "Not synced", tone: "muted" },
  dry_run_planned: { label: "Dry run", tone: "warn" },
  queued: { label: "Queued", tone: "warn" },
  synced: { label: "Synced", tone: "good" },
  sync_failed: { label: "Sync failed", tone: "bad" },
  suppressed: { label: "Suppressed", tone: "bad" },
}

export function instantlySyncBadge(status: InstantlySyncStatus): BadgeSpec {
  return INSTANTLY_SYNC_BADGES[status] ?? { label: status, tone: "muted" }
}

export const OUTREACH_APPROVAL_BADGES: Record<OutreachApprovalStatus, BadgeSpec> = {
  draft: { label: "Draft", tone: "muted" },
  awaiting_approval: { label: "Awaiting approval", tone: "warn" },
  approved: { label: "Approved", tone: "good" },
  rejected: { label: "Rejected", tone: "bad" },
  sent: { label: "Sent", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
}

export function outreachApprovalBadge(status: OutreachApprovalStatus): BadgeSpec {
  return OUTREACH_APPROVAL_BADGES[status] ?? { label: status, tone: "muted" }
}

/**
 * Mask an email like `a***@gmail.com`. Returns the original on non-email.
 */
export function maskEmail(email: string | undefined | null): string {
  if (!email || typeof email !== "string") return ""
  const trimmed = email.trim()
  const at = trimmed.indexOf("@")
  if (at < 1) return trimmed
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  const lead = local.slice(0, 1)
  return `${lead}${"*".repeat(Math.max(2, Math.min(8, local.length - 1)))}@${domain}`
}

/**
 * Mask an E.164 phone like `+1 *** *** 1234`.
 */
export function maskPhone(phone: string | undefined | null): string {
  if (!phone || typeof phone !== "string") return ""
  const trimmed = phone.trim()
  if (trimmed.length < 4) return trimmed
  const last = trimmed.slice(-4)
  const lead = trimmed.startsWith("+") ? trimmed.slice(0, 3) : ""
  return `${lead} *** *** ${last}`.trim()
}
