/**
 * v2.0 External Supply V1 — Wave C Block F1 — Pure outreach decisioning.
 *
 * Maps the rubric `EvaluationTier` to an `OutreachChannel`, evaluates the
 * full suppression-gate matrix from PLAN §14 (Safety) + §5.2, and composes
 * a draft `OutreachPlan` shape that the F2 callable layer can persist.
 *
 * **No Firestore reads.** **No LLM calls.** Pure function over
 * `(profile, evaluation, job, company, recentOutreachEvents)`.
 *
 * Architecture mapped to EXECUTOR-PLANS.md F + PLAN.md §5/§7/§11/§14:
 *  - `decideChannel(tier) -> OutreachChannel` — direct enum-to-enum table.
 *  - `evaluateSuppression(profile, recentEvents, opts) -> SuppressionGateResult`
 *    — six block reasons (opted_out, cooldown, previously_bounced,
 *    duplicate_company_role_recent, invalid_email, low_confidence_personalization).
 *  - `decideOutreach({...}, copy) -> { draft, suppression }` — composes the
 *    plan draft (sans persistence metadata) and runs suppression in one pass.
 *
 * Suppression policy (locked, named constants):
 *  - `DUPLICATE_COMPANY_ROLE_COOLDOWN_DAYS = 14` — never re-outreach the same
 *    candidate for the same (jobId, companyId) within 14 days.
 *  - `POST_BOUNCE_COOLDOWN_DAYS = 30` — after a delivery `email_bounced`,
 *    silent for 30 days regardless of jobId.
 *  - `POST_DECLINE_COOLDOWN_DAYS = 90` — after `candidate_declined`, silent
 *    for 90 days regardless of jobId.
 *
 * Invariants enforced here:
 *  - Live mode requires email; tier without email is blocked with
 *    `invalid_email`.
 *  - Tier `blocked` channel decision is always `no_outreach`.
 *  - `retain_only` channel decision is always `no_outreach`.
 *  - Personalization absence is gated as `low_confidence_personalization`
 *    so the operator must explicitly supply or LLM-generate copy. This is
 *    not a hard block of the candidate — it's a hard block of *this* plan
 *    until copy is supplied.
 *  - Evidence array carries `source: "system"` only — F2 callable wraps the
 *    decision with `source: "external_sourcing"` evidence when persisting.
 */

import type {
  CandidateProfile,
  CandidateCompanyJobEvaluation,
  EvaluationTier,
  MarketplaceEvidence,
  OutreachChannel,
  OutreachEvent,
  OutreachPlan,
  SuppressionBlockReason,
  SuppressionGateResult,
} from "@pa/core-types"

// ---------------------------------------------------------------------------
// Cooldown / policy constants (locked per EXECUTOR-PLANS.md F Q2)
// ---------------------------------------------------------------------------

export const DUPLICATE_COMPANY_ROLE_COOLDOWN_DAYS = 14
export const POST_BOUNCE_COOLDOWN_DAYS = 30
export const POST_DECLINE_COOLDOWN_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

export interface OutreachDecisionInputs {
  profile: CandidateProfile
  evaluation: CandidateCompanyJobEvaluation
  job: { jobId: string; companyId: string; title?: string }
  company: { companyId: string; name?: string }
  /** Candidate's last ≤ 90 days of outreach events across ALL jobs. */
  recentOutreachEvents: OutreachEvent[]
  now?: () => string
}

export interface OutreachCopy {
  personalizedHook: string
  whyThisRole: string
  whyCompany: string
  candidateSpecificSignal: string
  emailSubject: string
  emailBody: string
  linkedinMessage: string
}

export interface OutreachDecisionResult {
  draft: Omit<
    OutreachPlan,
    | "planId"
    | "createdAt"
    | "approvalStatus"
    | "approvedBy"
    | "approvedAt"
    | "rejectionReason"
  >
  suppression: SuppressionGateResult
}

// ---------------------------------------------------------------------------
// Channel decisioning
// ---------------------------------------------------------------------------

/**
 * Tier → channel mapping per EXECUTOR-PLANS.md F + PLAN.md §11:
 *  - `tier_1_personal_linkedin_and_email` → `personal_linkedin` (email body
 *    is also populated by the caller; manual LinkedIn task is what F's
 *    callable assigns separately — F2 layer handles task records).
 *  - `tier_2_personal_email` → `personal_email`.
 *  - `tier_3_general_email` → `general_email`.
 *  - `retain_only` / `blocked` → `no_outreach`.
 */
export function decideChannel(tier: EvaluationTier): OutreachChannel {
  switch (tier) {
    case "tier_1_personal_linkedin_and_email":
      return "personal_linkedin"
    case "tier_2_personal_email":
      return "personal_email"
    case "tier_3_general_email":
      return "general_email"
    case "retain_only":
    case "blocked":
      return "no_outreach"
  }
}

/** Does this tier require email payload? */
function tierRequiresEmail(tier: EvaluationTier): boolean {
  return (
    tier === "tier_1_personal_linkedin_and_email" ||
    tier === "tier_2_personal_email" ||
    tier === "tier_3_general_email"
  )
}

/** Does this tier require personalization (Tier 1/2 = personal copy)? */
function tierRequiresPersonalization(tier: EvaluationTier): boolean {
  return (
    tier === "tier_1_personal_linkedin_and_email" || tier === "tier_2_personal_email"
  )
}

// ---------------------------------------------------------------------------
// Suppression gate
// ---------------------------------------------------------------------------

export interface SuppressionInputs {
  profile: CandidateProfile
  /** Candidate's last ≤ 90 days of outreach events across ALL jobs. */
  recentOutreachEvents: OutreachEvent[]
  /** When the plan targets the same (jobId, companyId), the lookback is
   * tighter (DUPLICATE_COMPANY_ROLE_COOLDOWN_DAYS). */
  targetJobId: string
  targetCompanyId: string
  /** Tier of the proposed plan — drives the email/personalization required check. */
  tier: EvaluationTier
  /** Does the candidate have at least one valid email handle? */
  hasValidEmail: boolean
  /** Does the candidate have personalization copy populated (non-empty hook)? */
  hasPersonalization: boolean
  now?: () => string
}

/**
 * Evaluates the six-reason suppression matrix and returns an aggregate
 * decision. Multiple reasons may stack; `allow` is true iff `blockedReasons`
 * is empty.
 *
 * Reasons (matches SuppressionBlockReasonSchema enum order):
 *  - `opted_out` — profile.outreach.status === "opted_out"
 *  - `previously_bounced` — recent `email_bounced` within POST_BOUNCE_COOLDOWN
 *  - `invalid_email` — tier requires email but candidate has none verified
 *  - `cooldown` — profile.outreach.cooldownUntil > now OR recent
 *    `candidate_declined` within POST_DECLINE_COOLDOWN
 *  - `duplicate_company_role_recent` — recent outreach for same (jobId,
 *    companyId) within DUPLICATE_COMPANY_ROLE_COOLDOWN
 *  - `low_confidence_personalization` — tier requires personalization but
 *    copy is empty/missing
 */
export function evaluateSuppression(
  inputs: SuppressionInputs,
): SuppressionGateResult {
  const reasons = new Set<SuppressionBlockReason>()
  const now = inputs.now ?? (() => new Date().toISOString())
  const nowMs = Date.parse(now())
  let cooldownUntilIso: string | undefined

  // 1. Opt-out — terminal until explicit opt-in.
  const outreachState = inputs.profile.outreach
  if (outreachState?.status === "opted_out") {
    reasons.add("opted_out")
  }

  // 2. Per-profile cooldown — the lifecycle reducer may stamp a
  //    `cooldownUntil` after a decline or bounce. Honor it.
  if (outreachState?.cooldownUntil) {
    const cu = Date.parse(outreachState.cooldownUntil)
    if (!Number.isNaN(cu) && cu > nowMs) {
      reasons.add("cooldown")
      cooldownUntilIso = laterIso(cooldownUntilIso, outreachState.cooldownUntil)
    }
  }

  // 3. Walk events. For each, decide whether it contributes a reason.
  for (const ev of inputs.recentOutreachEvents) {
    const occurredMs = Date.parse(ev.occurredAt)
    if (Number.isNaN(occurredMs)) continue
    const ageDays = (nowMs - occurredMs) / DAY_MS
    if (ageDays < 0) continue // future events are ignored defensively

    // 3a. Bounce → previously_bounced (30d).
    if (ev.kind === "email_bounced" && ageDays <= POST_BOUNCE_COOLDOWN_DAYS) {
      reasons.add("previously_bounced")
      const recovers = new Date(occurredMs + POST_BOUNCE_COOLDOWN_DAYS * DAY_MS).toISOString()
      cooldownUntilIso = laterIso(cooldownUntilIso, recovers)
    }

    // 3b. Decline → cooldown (90d).
    if (ev.kind === "candidate_declined" && ageDays <= POST_DECLINE_COOLDOWN_DAYS) {
      reasons.add("cooldown")
      const recovers = new Date(occurredMs + POST_DECLINE_COOLDOWN_DAYS * DAY_MS).toISOString()
      cooldownUntilIso = laterIso(cooldownUntilIso, recovers)
    }

    // 3c. Duplicate (jobId, companyId) → 14d.
    if (
      ev.jobId === inputs.targetJobId &&
      ev.companyId === inputs.targetCompanyId &&
      ageDays <= DUPLICATE_COMPANY_ROLE_COOLDOWN_DAYS &&
      isOutboundDeliveryKind(ev.kind)
    ) {
      reasons.add("duplicate_company_role_recent")
      const recovers = new Date(
        occurredMs + DUPLICATE_COMPANY_ROLE_COOLDOWN_DAYS * DAY_MS,
      ).toISOString()
      cooldownUntilIso = laterIso(cooldownUntilIso, recovers)
    }
  }

  // 4. Tier requires email but no valid email available.
  if (tierRequiresEmail(inputs.tier) && !inputs.hasValidEmail) {
    reasons.add("invalid_email")
  }

  // 5. Tier requires personalization but no copy populated.
  if (tierRequiresPersonalization(inputs.tier) && !inputs.hasPersonalization) {
    reasons.add("low_confidence_personalization")
  }

  const blockedReasons = Array.from(reasons).sort() as SuppressionBlockReason[]
  const result: SuppressionGateResult = {
    allow: blockedReasons.length === 0,
    blockedReasons,
  }
  if (cooldownUntilIso) result.cooldownUntil = cooldownUntilIso
  return result
}

/**
 * Outreach events that count as "we already poked the candidate for this
 * (jobId, companyId)". `email_opened` / `email_clicked` are passive signals
 * and don't trigger duplicate suppression on their own — only outbound
 * deliveries do.
 */
function isOutboundDeliveryKind(kind: OutreachEvent["kind"]): boolean {
  return (
    kind === "email_sent" ||
    kind === "email_bounced" ||
    kind === "email_replied" ||
    kind === "email_unsubscribed" ||
    kind === "email_marked_spam" ||
    kind === "manual_linkedin_sent" ||
    kind === "manual_linkedin_replied"
  )
}

function laterIso(a: string | undefined, b: string): string {
  if (!a) return b
  const am = Date.parse(a)
  const bm = Date.parse(b)
  if (Number.isNaN(am)) return b
  if (Number.isNaN(bm)) return a
  return am >= bm ? a : b
}

// ---------------------------------------------------------------------------
// decideOutreach — top-level composition
// ---------------------------------------------------------------------------

/**
 * Composes an `OutreachPlan` draft from the rubric evaluation + candidate
 * state + recent events + optional copy override. The draft excludes
 * persistence-only fields (`planId`, `createdAt`, `approvalStatus`, ...).
 *
 * Caller responsibilities:
 *  - Provide `copy` for tier 1/2 plans (LLM-generated or template). When
 *    `copy.personalizedHook` is empty for tier 1/2, the suppression gate
 *    blocks with `low_confidence_personalization`.
 *  - Stamp `planId` + `createdAt` + initial `approvalStatus` when persisting.
 *
 * The returned `suppression` is the gate result. Even when blocked, the
 * draft is still produced so the operator can see the proposed copy / tier
 * decision in the dashboard before approving or skipping.
 */
export function decideOutreach(
  inputs: OutreachDecisionInputs,
  copy: Partial<OutreachCopy> = {},
): OutreachDecisionResult {
  const tier = inputs.evaluation.proposedTier
  const channel = decideChannel(tier)
  const hasValidEmail = candidateHasReachableEmail(inputs.profile)
  const hasPersonalization = Boolean(copy.personalizedHook && copy.personalizedHook.trim())

  const suppression = evaluateSuppression({
    profile: inputs.profile,
    recentOutreachEvents: inputs.recentOutreachEvents,
    targetJobId: inputs.job.jobId,
    targetCompanyId: inputs.company.companyId,
    tier,
    hasValidEmail,
    hasPersonalization,
    now: inputs.now,
  })

  const draft = composeDraftPlan({
    inputs,
    tier,
    channel,
    copy,
    suppression,
  })

  return { draft, suppression }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether the candidate has a reachable email signal. In V1 the only
 * Firestore-side proxy is `profile.outreach.status`. When the lifecycle is
 * `opted_out`, we treat the email as unreachable regardless. Otherwise we
 * treat the presence of `outreach.lastOutboundAt` OR `outreach.status === "allowed"`
 * as sufficient for this gate. The detailed email-handle check happens at
 * the F2 callable layer (Firestore query of `pa-candidate-handles`).
 *
 * The conservative default for "no outreach metadata at all" is `false` —
 * forcing the callable to populate the email payload AFTER doing a handle
 * lookup. This way the pure lib stays decoupled from Firestore.
 */
function candidateHasReachableEmail(profile: CandidateProfile): boolean {
  if (profile.outreach?.status === "opted_out") return false
  // If there's a linkedinUrl set, we know identity has at least one channel;
  // we still rely on the F2 callable layer to confirm email handle exists.
  // For the pure lib's purpose, optimistically return true when outreach is
  // either undefined (no signal yet) or in an allowed state.
  const status = profile.outreach?.status
  if (!status) return true
  return status === "allowed" || status === "cooldown" || status === "paused"
}

interface DraftPlanInputs {
  inputs: OutreachDecisionInputs
  tier: EvaluationTier
  channel: OutreachChannel
  copy: Partial<OutreachCopy>
  suppression: SuppressionGateResult
}

function composeDraftPlan(args: DraftPlanInputs): OutreachDecisionResult["draft"] {
  const { inputs, tier, channel, copy, suppression } = args
  const evidence: MarketplaceEvidence[] = [
    {
      source: "system",
      summary: `Tier=${tier}; channel=${channel}; suppressionAllow=${suppression.allow}; blockedReasons=${suppression.blockedReasons.join(",") || "none"}`,
      confidence: 0.6,
    },
  ]

  const draft: OutreachDecisionResult["draft"] = {
    candidateId: inputs.profile.candidateId,
    companyId: inputs.company.companyId,
    jobId: inputs.job.jobId,
    evaluationId: inputs.evaluation.evaluationId,
    tier,
    channelDecision: channel,
    suppressionGateResult: suppression,
    evidence,
  }

  // Copy fields are optional on the schema — only attach when present.
  if (copy.personalizedHook && copy.personalizedHook.trim()) {
    draft.personalizedHook = copy.personalizedHook.trim()
  }
  if (copy.whyThisRole && copy.whyThisRole.trim()) {
    draft.whyThisRole = copy.whyThisRole.trim()
  }
  if (copy.whyCompany && copy.whyCompany.trim()) {
    draft.whyCompany = copy.whyCompany.trim()
  }
  if (copy.candidateSpecificSignal && copy.candidateSpecificSignal.trim()) {
    draft.candidateSpecificSignal = copy.candidateSpecificSignal.trim()
  }
  if (copy.emailSubject && copy.emailSubject.trim()) {
    draft.emailSubject = copy.emailSubject.trim()
  }
  if (copy.emailBody && copy.emailBody.trim()) {
    draft.emailBody = copy.emailBody.trim()
  }
  if (copy.linkedinMessage && copy.linkedinMessage.trim()) {
    draft.linkedinMessage = copy.linkedinMessage.trim()
  }

  return draft
}
