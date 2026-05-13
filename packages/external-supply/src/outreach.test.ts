/**
 * Wave C Block F1 — outreach decisioning + suppression matrix tests.
 *
 * Covers:
 *  - Tier → channel mapping (5 enum values).
 *  - Each suppression block reason (6).
 *  - Combined block reasons stack correctly.
 *  - Cooldown windows for bounce (30d), decline (90d), duplicate
 *    (jobId,companyId) (14d).
 *  - decideOutreach happy path + each block path.
 *  - Personalization gate: tier 1/2 require copy; tier 3 does not.
 *  - Email gate: tier 1/2/3 require email; retain_only/blocked do not.
 *  - opted_out is terminal regardless of other state.
 *  - Recent passive events (email_opened) do NOT trigger duplicate
 *    suppression on their own.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type {
  CandidateCompanyJobEvaluation,
  CandidateProfile,
  OutreachEvent,
} from "@pa/core-types"
import {
  DUPLICATE_COMPANY_ROLE_COOLDOWN_DAYS,
  POST_BOUNCE_COOLDOWN_DAYS,
  POST_DECLINE_COOLDOWN_DAYS,
  decideChannel,
  decideOutreach,
  evaluateSuppression,
} from "./outreach.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-05-13T12:00:00.000Z"
const NOW_MS = Date.parse(NOW)
const DAY = 24 * 60 * 60 * 1000

function isoDaysAgo(days: number): string {
  return new Date(NOW_MS - days * DAY).toISOString()
}

function baseProfile(over: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    candidateId: "cand-1",
    candidateLifecycleState: "profile_ready",
    createdAt: NOW,
    linkedinUrl: "https://linkedin.com/in/cand-1",
    outreach: { status: "allowed" },
    ...over,
  }
}

function baseEvaluation(
  over: Partial<CandidateCompanyJobEvaluation> = {},
): CandidateCompanyJobEvaluation {
  return {
    evaluationId: "eval-1",
    evaluationRunId: "run-1",
    candidateId: "cand-1",
    companyId: "co-1",
    jobId: "job-1",
    rubricVersion: "rubric-2026-05-v1",
    generalRubricScore: 0.7,
    companyRubricScore: 0.6,
    jobRubricScore: 0.8,
    hardGateResult: "pass",
    hardGateReasons: ["role_function_overlap", "visa_ok", "location_overlap"],
    softScore: 0.75,
    missingInfo: [],
    risks: [],
    evidence: [],
    explanation: "Strong fit.",
    proposedTier: "tier_2_personal_email",
    createdAt: NOW,
    ...over,
  }
}

function baseInputs(
  over: { profile?: Partial<CandidateProfile>; evaluation?: Partial<CandidateCompanyJobEvaluation> } = {},
  recentOutreachEvents: OutreachEvent[] = [],
) {
  return {
    profile: baseProfile(over.profile),
    evaluation: baseEvaluation(over.evaluation),
    job: { jobId: "job-1", companyId: "co-1", title: "Senior Engineer" },
    company: { companyId: "co-1", name: "Acme" },
    recentOutreachEvents,
    now: () => NOW,
  }
}

function makeEvent(over: Partial<OutreachEvent>): OutreachEvent {
  return {
    eventId: "ev-1",
    provider: "instantly",
    providerEventId: "evp-1",
    candidateId: "cand-1",
    planId: "plan-prev",
    jobId: "job-1",
    companyId: "co-1",
    kind: "email_sent",
    payloadRedacted: {},
    occurredAt: isoDaysAgo(1),
    recordedAt: isoDaysAgo(1),
    ...over,
  }
}

// ---------------------------------------------------------------------------
// decideChannel — tier → channel table
// ---------------------------------------------------------------------------

test("decideChannel maps each tier to the right channel", () => {
  assert.equal(decideChannel("tier_1_personal_linkedin_and_email"), "personal_linkedin")
  assert.equal(decideChannel("tier_2_personal_email"), "personal_email")
  assert.equal(decideChannel("tier_3_general_email"), "general_email")
  assert.equal(decideChannel("retain_only"), "no_outreach")
  assert.equal(decideChannel("blocked"), "no_outreach")
})

// ---------------------------------------------------------------------------
// Suppression gate matrix
// ---------------------------------------------------------------------------

test("evaluateSuppression — opted_out blocks regardless", () => {
  const r = evaluateSuppression({
    profile: baseProfile({ outreach: { status: "opted_out" } }),
    recentOutreachEvents: [],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_2_personal_email",
    hasValidEmail: true,
    hasPersonalization: true,
    now: () => NOW,
  })
  assert.equal(r.allow, false)
  assert.ok(r.blockedReasons.includes("opted_out"))
})

test("evaluateSuppression — cooldownUntil > now blocks with cooldown", () => {
  const cooldown = new Date(NOW_MS + 5 * DAY).toISOString()
  const r = evaluateSuppression({
    profile: baseProfile({ outreach: { status: "cooldown", cooldownUntil: cooldown } }),
    recentOutreachEvents: [],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_2_personal_email",
    hasValidEmail: true,
    hasPersonalization: true,
    now: () => NOW,
  })
  assert.equal(r.allow, false)
  assert.ok(r.blockedReasons.includes("cooldown"))
  assert.equal(r.cooldownUntil, cooldown)
})

test("evaluateSuppression — cooldownUntil in past does NOT block", () => {
  const cooldown = new Date(NOW_MS - 1 * DAY).toISOString()
  const r = evaluateSuppression({
    profile: baseProfile({ outreach: { status: "cooldown", cooldownUntil: cooldown } }),
    recentOutreachEvents: [],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_2_personal_email",
    hasValidEmail: true,
    hasPersonalization: true,
    now: () => NOW,
  })
  assert.equal(r.allow, true)
})

test("evaluateSuppression — email_bounced within 30d → previously_bounced", () => {
  const r = evaluateSuppression({
    profile: baseProfile(),
    recentOutreachEvents: [
      makeEvent({ kind: "email_bounced", occurredAt: isoDaysAgo(10) }),
    ],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_3_general_email",
    hasValidEmail: true,
    hasPersonalization: false, // tier_3 doesn't need it
    now: () => NOW,
  })
  assert.equal(r.allow, false)
  assert.ok(r.blockedReasons.includes("previously_bounced"))
  assert.ok(r.cooldownUntil)
})

test(`evaluateSuppression — email_bounced older than ${POST_BOUNCE_COOLDOWN_DAYS}d does NOT block`, () => {
  const r = evaluateSuppression({
    profile: baseProfile(),
    recentOutreachEvents: [
      makeEvent({ kind: "email_bounced", occurredAt: isoDaysAgo(POST_BOUNCE_COOLDOWN_DAYS + 5) }),
    ],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_3_general_email",
    hasValidEmail: true,
    hasPersonalization: false,
    now: () => NOW,
  })
  assert.equal(r.allow, true)
})

test("evaluateSuppression — candidate_declined within 90d → cooldown", () => {
  const r = evaluateSuppression({
    profile: baseProfile(),
    recentOutreachEvents: [
      makeEvent({ kind: "candidate_declined", occurredAt: isoDaysAgo(60) }),
    ],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_2_personal_email",
    hasValidEmail: true,
    hasPersonalization: true,
    now: () => NOW,
  })
  assert.equal(r.allow, false)
  assert.ok(r.blockedReasons.includes("cooldown"))
})

test(`evaluateSuppression — candidate_declined older than ${POST_DECLINE_COOLDOWN_DAYS}d does NOT block`, () => {
  const r = evaluateSuppression({
    profile: baseProfile(),
    recentOutreachEvents: [
      makeEvent({
        kind: "candidate_declined",
        occurredAt: isoDaysAgo(POST_DECLINE_COOLDOWN_DAYS + 5),
      }),
    ],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_2_personal_email",
    hasValidEmail: true,
    hasPersonalization: true,
    now: () => NOW,
  })
  assert.equal(r.allow, true)
})

test("evaluateSuppression — duplicate same (jobId,companyId) within 14d → duplicate_company_role_recent", () => {
  const r = evaluateSuppression({
    profile: baseProfile(),
    recentOutreachEvents: [
      makeEvent({
        kind: "email_sent",
        jobId: "job-1",
        companyId: "co-1",
        occurredAt: isoDaysAgo(5),
      }),
    ],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_3_general_email",
    hasValidEmail: true,
    hasPersonalization: false,
    now: () => NOW,
  })
  assert.equal(r.allow, false)
  assert.ok(r.blockedReasons.includes("duplicate_company_role_recent"))
})

test(`evaluateSuppression — duplicate older than ${DUPLICATE_COMPANY_ROLE_COOLDOWN_DAYS}d does NOT block`, () => {
  const r = evaluateSuppression({
    profile: baseProfile(),
    recentOutreachEvents: [
      makeEvent({
        kind: "email_sent",
        jobId: "job-1",
        companyId: "co-1",
        occurredAt: isoDaysAgo(DUPLICATE_COMPANY_ROLE_COOLDOWN_DAYS + 5),
      }),
    ],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_3_general_email",
    hasValidEmail: true,
    hasPersonalization: false,
    now: () => NOW,
  })
  assert.equal(r.allow, true)
})

test("evaluateSuppression — duplicate different job does NOT block (only matches same jobId+companyId)", () => {
  const r = evaluateSuppression({
    profile: baseProfile(),
    recentOutreachEvents: [
      makeEvent({
        kind: "email_sent",
        jobId: "job-OTHER",
        companyId: "co-1",
        occurredAt: isoDaysAgo(3),
      }),
    ],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_3_general_email",
    hasValidEmail: true,
    hasPersonalization: false,
    now: () => NOW,
  })
  assert.equal(r.allow, true)
})

test("evaluateSuppression — passive email_opened does NOT trigger duplicate", () => {
  const r = evaluateSuppression({
    profile: baseProfile(),
    recentOutreachEvents: [
      makeEvent({
        kind: "email_opened",
        jobId: "job-1",
        companyId: "co-1",
        occurredAt: isoDaysAgo(2),
      }),
    ],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_3_general_email",
    hasValidEmail: true,
    hasPersonalization: false,
    now: () => NOW,
  })
  assert.equal(r.allow, true)
})

test("evaluateSuppression — invalid_email when tier requires email but candidate has none", () => {
  const r = evaluateSuppression({
    profile: baseProfile(),
    recentOutreachEvents: [],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_2_personal_email",
    hasValidEmail: false,
    hasPersonalization: true,
    now: () => NOW,
  })
  assert.equal(r.allow, false)
  assert.ok(r.blockedReasons.includes("invalid_email"))
})

test("evaluateSuppression — no_outreach tiers don't require email", () => {
  const r = evaluateSuppression({
    profile: baseProfile(),
    recentOutreachEvents: [],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "retain_only",
    hasValidEmail: false,
    hasPersonalization: false,
    now: () => NOW,
  })
  assert.equal(r.allow, true)
})

test("evaluateSuppression — low_confidence_personalization when tier 1/2 lacks copy", () => {
  const r1 = evaluateSuppression({
    profile: baseProfile(),
    recentOutreachEvents: [],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_1_personal_linkedin_and_email",
    hasValidEmail: true,
    hasPersonalization: false,
    now: () => NOW,
  })
  assert.ok(r1.blockedReasons.includes("low_confidence_personalization"))

  const r2 = evaluateSuppression({
    profile: baseProfile(),
    recentOutreachEvents: [],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_2_personal_email",
    hasValidEmail: true,
    hasPersonalization: false,
    now: () => NOW,
  })
  assert.ok(r2.blockedReasons.includes("low_confidence_personalization"))
})

test("evaluateSuppression — tier_3 does NOT require personalization", () => {
  const r = evaluateSuppression({
    profile: baseProfile(),
    recentOutreachEvents: [],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_3_general_email",
    hasValidEmail: true,
    hasPersonalization: false,
    now: () => NOW,
  })
  assert.equal(r.allow, true)
})

test("evaluateSuppression — multiple reasons stack into sorted array", () => {
  const r = evaluateSuppression({
    profile: baseProfile({ outreach: { status: "opted_out" } }),
    recentOutreachEvents: [
      makeEvent({ kind: "email_bounced", occurredAt: isoDaysAgo(5) }),
    ],
    targetJobId: "job-1",
    targetCompanyId: "co-1",
    tier: "tier_2_personal_email",
    hasValidEmail: false,
    hasPersonalization: false,
    now: () => NOW,
  })
  assert.equal(r.allow, false)
  // Reasons should be sorted alphabetically.
  const sorted = [...r.blockedReasons].sort()
  assert.deepEqual(r.blockedReasons, sorted)
  assert.ok(r.blockedReasons.includes("opted_out"))
  assert.ok(r.blockedReasons.includes("previously_bounced"))
  assert.ok(r.blockedReasons.includes("invalid_email"))
  assert.ok(r.blockedReasons.includes("low_confidence_personalization"))
})

// ---------------------------------------------------------------------------
// decideOutreach — composition
// ---------------------------------------------------------------------------

test("decideOutreach — tier_2 happy path with copy produces approved-ready draft", () => {
  const out = decideOutreach(baseInputs(), {
    personalizedHook: "I saw your work on Stripe payment infra.",
    whyThisRole: "Senior backend at Acme.",
    whyCompany: "Acme is scaling its fintech stack.",
    candidateSpecificSignal: "Open-source contributions to Stripe SDK.",
    emailSubject: "Open to a quick chat?",
    emailBody: "Hi Ada, ...",
    linkedinMessage: "",
  })
  assert.equal(out.suppression.allow, true)
  assert.equal(out.draft.tier, "tier_2_personal_email")
  assert.equal(out.draft.channelDecision, "personal_email")
  assert.equal(out.draft.candidateId, "cand-1")
  assert.equal(out.draft.companyId, "co-1")
  assert.equal(out.draft.jobId, "job-1")
  assert.equal(out.draft.evaluationId, "eval-1")
  assert.equal(out.draft.personalizedHook, "I saw your work on Stripe payment infra.")
  assert.equal(out.draft.emailSubject, "Open to a quick chat?")
  assert.equal(out.draft.linkedinMessage, undefined, "empty linkedinMessage should be undefined")
})

test("decideOutreach — tier_1 produces personal_linkedin channel and supports both payloads", () => {
  const out = decideOutreach(
    baseInputs({
      evaluation: { proposedTier: "tier_1_personal_linkedin_and_email" },
    }),
    {
      personalizedHook: "I noticed you led the auth team at Stripe.",
      emailBody: "Detailed email body.",
      linkedinMessage: "Short LI note.",
    },
  )
  assert.equal(out.suppression.allow, true)
  assert.equal(out.draft.channelDecision, "personal_linkedin")
  assert.equal(out.draft.linkedinMessage, "Short LI note.")
  assert.equal(out.draft.emailBody, "Detailed email body.")
})

test("decideOutreach — retain_only tier produces no_outreach channel and is not gated by personalization", () => {
  const out = decideOutreach(
    baseInputs({ evaluation: { proposedTier: "retain_only" } }),
    {},
  )
  assert.equal(out.draft.channelDecision, "no_outreach")
  assert.equal(out.suppression.allow, true)
})

test("decideOutreach — blocked tier maps to no_outreach", () => {
  const out = decideOutreach(
    baseInputs({ evaluation: { proposedTier: "blocked" } }),
    {},
  )
  assert.equal(out.draft.channelDecision, "no_outreach")
})

test("decideOutreach — suppression includes evidence in draft", () => {
  const out = decideOutreach(baseInputs(), {
    personalizedHook: "Hi",
  })
  assert.equal(out.draft.evidence.length, 1)
  assert.equal(out.draft.evidence[0]!.source, "system")
})

test("decideOutreach — suppression result is reflected on the draft", () => {
  const out = decideOutreach(
    baseInputs(
      { profile: { outreach: { status: "opted_out" } } },
      [],
    ),
    { personalizedHook: "Hi" },
  )
  assert.equal(out.suppression.allow, false)
  // Draft still carries the suppression result so dashboard renders the
  // explanation even on blocked plans.
  assert.deepEqual(out.draft.suppressionGateResult, out.suppression)
})

test("decideOutreach — empty/whitespace personalizedHook is treated as missing", () => {
  const out = decideOutreach(baseInputs(), {
    personalizedHook: "   ",
  })
  assert.equal(out.suppression.allow, false)
  assert.ok(out.suppression.blockedReasons.includes("low_confidence_personalization"))
})

test("decideOutreach — copies are trimmed when persisted", () => {
  const out = decideOutreach(baseInputs(), {
    personalizedHook: "  Hello world  ",
    whyThisRole: "  This role  ",
  })
  assert.equal(out.draft.personalizedHook, "Hello world")
  assert.equal(out.draft.whyThisRole, "This role")
})
