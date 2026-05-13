/**
 * Wave C Block D1 — `rubric.ts` deterministic engine tests.
 *
 * Covers:
 *  - Each hard-gate path (role, visa, location, careerStage, jobType,
 *    freshness) — both pass and fail.
 *  - Soft-score boundaries (0, near-0.5, 1).
 *  - All 5 tier bucket transitions (blocked → retain_only → tier_3 →
 *    tier_2 → tier_1) including competitor-adjacency promotion to tier_1.
 *  - Missing-info detection.
 *  - `composeEvaluation` aggregated shape + idempotency.
 *  - `proposeTier` deterministic on input.
 *  - General rubric: presence of LinkedIn / email / YoE / skills / careerStage
 *    / resume artifact.
 *  - Company rubric: industry / competitor / school / size signals.
 *  - Job rubric: skill overlap / industry overlap / salary fit / yoe alignment.
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  type CandidateProfile,
  type ExternalCandidateRecord,
} from "@pa/core-types"
import {
  RUBRIC_VERSION_DEFAULT,
  TIER_WEIGHTS,
  composeEvaluation,
  evaluateCompanyRubric,
  evaluateGeneralRubric,
  evaluateJobRubric,
  proposeTier,
  type CompanyContext,
  type JobContext,
  type RubricInputs,
} from "./rubric.js"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-05-13T12:00:00.000Z"

/** Profile with all signals strong — used as a baseline pass case. */
function richProfile(over: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    candidateId: "cand-rich",
    candidateLifecycleState: "profile_ready",
    createdAt: NOW_ISO,
    latestResumeArtifactId: "resume-1",
    linkedinUrl: "https://linkedin.com/in/rich",
    globalTags: {
      roleFunction: ["software_engineering"],
      skills: [
        { name: "typescript", bucket: "language_or_runtime", proficiency: "expert", evidenceCount: 5, baseWeight: 0.9 },
        { name: "react", bucket: "framework_or_library", proficiency: "expert", evidenceCount: 4, baseWeight: 0.9 },
        { name: "node_js", bucket: "language_or_runtime", proficiency: "expert", evidenceCount: 3, baseWeight: 0.8 },
        { name: "graphql", bucket: "domain_concept", proficiency: "intermediate", evidenceCount: 2, baseWeight: 0.7 },
        { name: "postgresql", bucket: "infrastructure_tool", proficiency: "intermediate", evidenceCount: 2, baseWeight: 0.7 },
        { name: "kubernetes", bucket: "infrastructure_tool", proficiency: "intermediate", evidenceCount: 1, baseWeight: 0.6 },
      ],
      careerStage: "senior",
      yoeRange: [6, 10],
      industrySector: ["financial_technology"],
      targetLocations: ["san_francisco_bay_area", "remote_americas"],
      visaStatus: "citizen",
      targetJobType: ["full_time"],
      relevantTags: [],
      minSalaryUsd: 180000,
      maxSalaryUsd: 250000,
      companySizePreference: ["scale_up", "mid_market"],
    },
    ...over,
  }
}

/** Minimal record — LinkedIn + email + experience at "Acme" + Harvard. */
function richRecord(over: Partial<ExternalCandidateRecord> = {}): ExternalCandidateRecord {
  return {
    recordId: "rec-rich",
    batchId: "batch-1",
    source: "juicebox",
    rawPayload: {},
    canonicalLinkedInUrl: "https://linkedin.com/in/rich",
    linkedinProfileHash: "x".repeat(64),
    emails: [{ value: "rich@example.com", hash: "y".repeat(64) }],
    name: "Rich Candidate",
    currentTitle: "Staff Engineer",
    currentCompany: "Stripe",
    experience: [
      { company: "Stripe", title: "Staff Engineer" },
      { company: "Square", title: "Senior Engineer" },
    ],
    education: [{ school: "Harvard", degree: "BS", field: "CS" }],
    location: "San Francisco, CA",
    sourceTags: [],
    normalizationStatus: "ok",
    identityResolutionStatus: "merge_existing",
    evidence: [],
    createdAt: NOW_ISO,
    ...over,
  }
}

function basicCompany(over: Partial<CompanyContext> = {}): CompanyContext {
  return {
    companyId: "co-1",
    name: "Acme Fintech",
    industrySector: ["financial_technology"],
    size: "scale_up",
    competitorCompanies: ["Stripe", "Plaid"],
    schoolPreferences: ["Harvard", "MIT"],
    ...over,
  }
}

function basicJob(over: Partial<JobContext> = {}): JobContext {
  return {
    jobId: "job-1",
    title: "Senior Software Engineer",
    roleFunction: ["software_engineering"],
    requiredSkills: ["typescript", "react", "node_js", "postgresql"],
    seniorityLevel: "senior",
    locationBuckets: ["san_francisco_bay_area"],
    sponsorship: true,
    jobType: "full_time",
    industrySector: ["financial_technology"],
    firstSeenAt: NOW_ISO,
    salaryMin: 180000,
    salaryMax: 250000,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// General rubric tests
// ---------------------------------------------------------------------------

test("evaluateGeneralRubric — rich profile scores high", () => {
  const res = evaluateGeneralRubric(richProfile(), richRecord())
  // LinkedIn (0.2) + email (0.1) + yoe_5_plus (0.25) + skills_5_plus (0.15)
  // + careerStage (0.1) + resume (0.1) = 0.90.
  assert.ok(res.score >= 0.85, `expected score >= 0.85, got ${res.score}`)
  assert.ok(res.signals.includes("linkedin_present"))
  assert.ok(res.signals.includes("email_present"))
  assert.ok(res.signals.includes("yoe_5_plus"))
  assert.ok(res.signals.includes("skills_5_plus"))
  assert.ok(res.signals.includes("career_stage_set"))
  assert.ok(res.signals.includes("resume_on_file"))
  assert.equal(res.missingInfo.length, 0)
  assert.equal(res.risks.length, 0)
})

test("evaluateGeneralRubric — top-tier scores (>=10 yoe and >=10 skills) hits ceiling", () => {
  const profile = richProfile()
  profile.globalTags!.yoeRange = [12, 18]
  profile.globalTags!.skills = [
    { name: "typescript", bucket: "language_or_runtime", proficiency: "expert", evidenceCount: 5, baseWeight: 0.9 },
    { name: "react", bucket: "framework_or_library", proficiency: "expert", evidenceCount: 4, baseWeight: 0.9 },
    { name: "node_js", bucket: "language_or_runtime", proficiency: "expert", evidenceCount: 3, baseWeight: 0.8 },
    { name: "graphql", bucket: "domain_concept", proficiency: "intermediate", evidenceCount: 2, baseWeight: 0.7 },
    { name: "postgresql", bucket: "infrastructure_tool", proficiency: "intermediate", evidenceCount: 2, baseWeight: 0.7 },
    { name: "kubernetes", bucket: "infrastructure_tool", proficiency: "intermediate", evidenceCount: 1, baseWeight: 0.6 },
    { name: "docker", bucket: "infrastructure_tool", proficiency: "intermediate", evidenceCount: 1, baseWeight: 0.6 },
    { name: "aws", bucket: "infrastructure_tool", proficiency: "intermediate", evidenceCount: 1, baseWeight: 0.6 },
    { name: "python", bucket: "language_or_runtime", proficiency: "intermediate", evidenceCount: 1, baseWeight: 0.6 },
    { name: "rust", bucket: "language_or_runtime", proficiency: "intermediate", evidenceCount: 1, baseWeight: 0.5 },
  ]
  const res = evaluateGeneralRubric(profile, richRecord())
  // 0.2 + 0.1 + 0.3 + 0.2 + 0.1 + 0.1 = 1.0 — clamped at 1.0.
  assert.equal(res.score, 1)
  assert.ok(res.signals.includes("yoe_10_plus"))
  assert.ok(res.signals.includes("skills_10_plus"))
})

test("evaluateGeneralRubric — sparse profile surfaces missing-info and risk", () => {
  const sparseProfile: CandidateProfile = {
    candidateId: "cand-sparse",
    candidateLifecycleState: "prospect",
    createdAt: NOW_ISO,
  }
  const sparseRecord: ExternalCandidateRecord = {
    recordId: "rec-sparse",
    batchId: "b-1",
    source: "juicebox",
    rawPayload: {},
    emails: [],
    experience: [],
    education: [],
    sourceTags: [],
    normalizationStatus: "ok",
    identityResolutionStatus: "needs_review",
    evidence: [],
    createdAt: NOW_ISO,
  }
  const res = evaluateGeneralRubric(sparseProfile, sparseRecord)
  assert.equal(res.score, 0)
  assert.ok(res.risks.includes("profile_completeness_low"))
  for (const tag of [
    "linkedin_missing",
    "email_missing",
    "yoe_unknown",
    "skills_missing",
    "career_stage_unknown",
    "resume_missing",
  ]) {
    assert.ok(res.missingInfo.includes(tag), `missing-info missing ${tag}`)
  }
})

// ---------------------------------------------------------------------------
// Company rubric tests
// ---------------------------------------------------------------------------

test("evaluateCompanyRubric — competitor adjacency hits and surfaces evidence", () => {
  const res = evaluateCompanyRubric(richProfile(), richRecord(), basicCompany())
  assert.ok(res.competitorAdjacency?.matched, "competitor should match — Stripe in history + competitor list")
  assert.ok(res.competitorAdjacency!.confidence >= 0.7)
  assert.ok(res.signals.some((s) => s.startsWith("competitor_overlap:stripe")))
  assert.ok(res.score >= 0.7, `expected company score >= 0.7, got ${res.score}`)
  assert.ok(res.industryAdjacency)
  assert.equal(res.industryAdjacency!.sector, "financial_technology")
})

test("evaluateCompanyRubric — no competitor list surfaces missing-info, no negative score", () => {
  const company = basicCompany({ competitorCompanies: [] })
  const res = evaluateCompanyRubric(richProfile(), richRecord(), company)
  assert.equal(res.competitorAdjacency, undefined)
  assert.ok(res.missingInfo.includes("competitor_list_unknown"))
  // industry + school + size still register.
  assert.ok(res.score > 0)
})

test("evaluateCompanyRubric — no industry overlap, no competitor → low score with risk", () => {
  const company = basicCompany({
    industrySector: ["healthcare_and_health_tech"],
    competitorCompanies: ["UnknownCo"],
    schoolPreferences: [],
    size: undefined,
  })
  const res = evaluateCompanyRubric(richProfile(), richRecord(), company)
  assert.equal(res.score, 0)
  assert.ok(res.risks.includes("company_fit_low"))
})

// ---------------------------------------------------------------------------
// Job rubric — hard-gate matrix
// ---------------------------------------------------------------------------

test("evaluateJobRubric — full pass hard gate + high soft score", () => {
  const res = evaluateJobRubric(richProfile(), richRecord(), basicJob())
  assert.equal(res.hardGateResult, "pass")
  assert.ok(res.hardGateReasons.includes("role_function_overlap"))
  assert.ok(res.hardGateReasons.includes("visa_ok"))
  assert.ok(res.hardGateReasons.includes("location_overlap"))
  assert.ok(res.hardGateReasons.includes("career_stage_ok"))
  assert.ok(res.hardGateReasons.includes("job_type_ok"))
  assert.ok(res.hardGateReasons.includes("freshness_ok"))
  assert.ok(res.score >= 0.9, `expected score >= 0.9, got ${res.score}`)
})

test("evaluateJobRubric — role function no overlap → hard_block", () => {
  const profile = richProfile()
  profile.globalTags!.roleFunction = ["sales"]
  const res = evaluateJobRubric(profile, richRecord(), basicJob())
  assert.equal(res.hardGateResult, "hard_block")
  assert.ok(res.hardGateReasons.includes("role_function_no_overlap"))
  assert.equal(res.score, 0)
})

test("evaluateJobRubric — visa sponsor_needed + sponsorship false → hard_block", () => {
  const profile = richProfile()
  profile.globalTags!.visaStatus = "sponsor_needed"
  const job = basicJob({ sponsorship: false })
  const res = evaluateJobRubric(profile, richRecord(), job)
  assert.equal(res.hardGateResult, "hard_block")
  assert.ok(res.hardGateReasons.includes("visa_blocks_sponsorship"))
})

test("evaluateJobRubric — visa sponsor_needed + sponsorship null → soft pass with missing-info", () => {
  const profile = richProfile()
  profile.globalTags!.visaStatus = "sponsor_needed"
  const job = basicJob({ sponsorship: null })
  const res = evaluateJobRubric(profile, richRecord(), job)
  // No hard block — but flag missing info so HITL can investigate.
  assert.notEqual(res.hardGateResult, "hard_block")
  assert.ok(res.missingInfo.includes("sponsorship_policy_unknown"))
})

test("evaluateJobRubric — location no overlap → hard_block", () => {
  const profile = richProfile()
  profile.globalTags!.targetLocations = ["new_york_metro"]
  const job = basicJob({ locationBuckets: ["los_angeles_metro"] })
  const res = evaluateJobRubric(profile, richRecord(), job)
  assert.equal(res.hardGateResult, "hard_block")
  assert.ok(res.hardGateReasons.includes("location_no_overlap"))
})

test("evaluateJobRubric — anywhere bypass passes location gate", () => {
  const profile = richProfile()
  profile.globalTags!.targetLocations = ["remote_anywhere"]
  const job = basicJob({ locationBuckets: ["los_angeles_metro"] })
  const res = evaluateJobRubric(profile, richRecord(), job)
  assert.notEqual(res.hardGateResult, "hard_block")
  assert.ok(res.hardGateReasons.includes("location_bypass_anywhere"))
})

test("evaluateJobRubric — career stage out of window → hard_block", () => {
  const profile = richProfile()
  profile.globalTags!.careerStage = "intern"
  const res = evaluateJobRubric(profile, richRecord(), basicJob())
  assert.equal(res.hardGateResult, "hard_block")
  assert.ok(res.hardGateReasons.includes("career_stage_out_of_window"))
})

test("evaluateJobRubric — career stage unknown on profile → soft_block + missing-info", () => {
  const profile = richProfile()
  profile.globalTags!.careerStage = undefined
  const res = evaluateJobRubric(profile, richRecord(), basicJob())
  assert.equal(res.hardGateResult, "soft_block")
  assert.ok(res.hardGateReasons.includes("career_stage_unknown"))
  assert.ok(res.missingInfo.includes("career_stage_unknown"))
})

test("evaluateJobRubric — job type mismatch → soft_block (never hard)", () => {
  const profile = richProfile()
  profile.globalTags!.targetJobType = ["internship"]
  const res = evaluateJobRubric(profile, richRecord(), basicJob({ jobType: "full_time" }))
  assert.equal(res.hardGateResult, "soft_block")
  assert.ok(res.hardGateReasons.includes("job_type_mismatch"))
})

test("evaluateJobRubric — freshness stale (180d old) → soft_block + risk", () => {
  const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString()
  const record = richRecord({ createdAt: oldDate })
  const job = basicJob({ firstSeenAt: oldDate })
  const res = evaluateJobRubric(richProfile(), record, job)
  assert.equal(res.hardGateResult, "soft_block")
  assert.ok(res.hardGateReasons.includes("freshness_stale"))
  assert.ok(res.risks.some((r) => r.startsWith("record_age_")))
})

// ---------------------------------------------------------------------------
// Job rubric — soft signals
// ---------------------------------------------------------------------------

test("evaluateJobRubric — skill jaccard contributes proportionally", () => {
  const profile = richProfile()
  // Skill list reduced — only 2/4 required skills covered.
  profile.globalTags!.skills = [
    { name: "typescript", bucket: "language_or_runtime", proficiency: "expert", evidenceCount: 5, baseWeight: 0.9 },
    { name: "react", bucket: "framework_or_library", proficiency: "expert", evidenceCount: 4, baseWeight: 0.9 },
  ]
  const res = evaluateJobRubric(profile, richRecord(), basicJob())
  assert.equal(res.hardGateResult, "pass")
  // Score should reflect partial skill overlap (2/4 = 0.5 * 0.45 = 0.225) + the
  // industry / salary / yoe contributions.
  assert.ok(res.score < 0.9)
  assert.ok(res.score > 0.45)
  assert.ok(res.signals.some((s) => s === "skill_overlap:2/4"))
})

test("evaluateJobRubric — salary below floor → risk + no salary bump", () => {
  const profile = richProfile()
  profile.globalTags!.minSalaryUsd = 300000
  const res = evaluateJobRubric(profile, richRecord(), basicJob())
  assert.equal(res.hardGateResult, "pass")
  assert.ok(res.risks.includes("salary_below_min"))
})

test("evaluateJobRubric — yoe early career path", () => {
  const profile = richProfile()
  profile.globalTags!.yoeRange = [0, 1]
  profile.globalTags!.careerStage = "entry_level"
  const job = basicJob({ seniorityLevel: "entry_level" })
  const res = evaluateJobRubric(profile, richRecord(), job)
  assert.equal(res.hardGateResult, "pass")
  assert.ok(res.signals.includes("yoe_fit_junior"))
})

// ---------------------------------------------------------------------------
// proposeTier — bucket boundaries
// ---------------------------------------------------------------------------

test("proposeTier — hard_block always → blocked", () => {
  assert.equal(
    proposeTier({
      general: 1,
      company: 1,
      job: 1,
      hardGate: "hard_block",
      missingInfo: [],
      risks: [],
    }),
    "blocked",
  )
})

test("proposeTier — soft_block with low combined → retain_only", () => {
  const tier = proposeTier({
    general: 0.2,
    company: 0.2,
    job: 0.2,
    hardGate: "soft_block",
    missingInfo: [],
    risks: [],
  })
  assert.equal(tier, "retain_only")
})

test("proposeTier — score 0 → retain_only", () => {
  const tier = proposeTier({
    general: 0,
    company: 0,
    job: 0,
    hardGate: "pass",
    missingInfo: [],
    risks: [],
  })
  assert.equal(tier, "retain_only")
})

test("proposeTier — just above 0.45 boundary → tier_3", () => {
  const tier = proposeTier({
    general: 0.5,
    company: 0.5,
    job: 0.45,
    hardGate: "pass",
    missingInfo: [],
    risks: [],
  })
  // combined = 0.25*0.5 + 0.25*0.5 + 0.5*0.45 = 0.125 + 0.125 + 0.225 = 0.475
  assert.equal(tier, "tier_3_general_email")
})

test("proposeTier — just below 0.45 → retain_only", () => {
  const tier = proposeTier({
    general: 0.4,
    company: 0.4,
    job: 0.4,
    hardGate: "pass",
    missingInfo: [],
    risks: [],
  })
  // combined = 0.40
  assert.equal(tier, "retain_only")
})

test("proposeTier — 0.60 boundary → tier_2", () => {
  const tier = proposeTier({
    general: 0.6,
    company: 0.6,
    job: 0.6,
    hardGate: "pass",
    missingInfo: [],
    risks: [],
  })
  // combined = 0.60
  assert.equal(tier, "tier_2_personal_email")
})

test("proposeTier — 0.75 boundary → tier_1", () => {
  const tier = proposeTier({
    general: 0.75,
    company: 0.75,
    job: 0.75,
    hardGate: "pass",
    missingInfo: [],
    risks: [],
  })
  // combined = 0.75
  assert.equal(tier, "tier_1_personal_linkedin_and_email")
})

test("proposeTier — 0.80 + competitor adjacency → tier_1 (boost still tier_1)", () => {
  const tier = proposeTier({
    general: 0.8,
    company: 0.8,
    job: 0.8,
    hardGate: "pass",
    missingInfo: [],
    risks: [],
    competitorAdjacency: { matched: true, confidence: 0.8 },
  })
  assert.equal(tier, "tier_1_personal_linkedin_and_email")
})

test("proposeTier — competitor adjacency at confidence < 0.7 does not promote", () => {
  // Without the boost this lands at 0.61 → tier_2.
  const baseTier = proposeTier({
    general: 0.5,
    company: 0.5,
    job: 0.7,
    hardGate: "pass",
    missingInfo: [],
    risks: [],
  })
  assert.equal(baseTier, "tier_2_personal_email")
  // With low-confidence competitor adjacency, still tier_2.
  const boosted = proposeTier({
    general: 0.5,
    company: 0.5,
    job: 0.7,
    hardGate: "pass",
    missingInfo: [],
    risks: [],
    competitorAdjacency: { matched: true, confidence: 0.4 },
  })
  assert.equal(boosted, "tier_2_personal_email")
})

test("proposeTier — soft_block but combined >= 0.55 lands tier_3", () => {
  // soft-block at 0.55 should NOT go retain_only — there's a meaningful signal.
  const tier = proposeTier({
    general: 0.6,
    company: 0.6,
    job: 0.5,
    hardGate: "soft_block",
    missingInfo: [],
    risks: [],
  })
  // combined = 0.55 → still tier_3 since combined >= 0.45.
  assert.equal(tier, "tier_3_general_email")
})

// ---------------------------------------------------------------------------
// composeEvaluation — aggregated shape + idempotency
// ---------------------------------------------------------------------------

test("composeEvaluation — happy path returns deterministic shape", () => {
  const inputs: RubricInputs = {
    profile: richProfile(),
    record: richRecord(),
    company: basicCompany(),
    job: basicJob(),
  }
  const draft = composeEvaluation(inputs, { nowIso: NOW_ISO })
  assert.equal(draft.candidateId, "cand-rich")
  assert.equal(draft.companyId, "co-1")
  assert.equal(draft.jobId, "job-1")
  assert.equal(draft.rubricVersion, RUBRIC_VERSION_DEFAULT)
  assert.equal(draft.hardGateResult, "pass")
  assert.equal(draft.proposedTier, "tier_1_personal_linkedin_and_email")
  assert.ok(draft.competitorAdjacency?.matched)
  assert.ok(draft.industryAdjacency)
  assert.ok(draft.explanation.length > 0)
  assert.equal(draft.createdAt, NOW_ISO)
  assert.ok(Array.isArray(draft.evidence) && draft.evidence.length > 0)
  // No undefined id placeholders — caller stamps these later.
  assert.equal(
    "evaluationId" in draft,
    false,
    "evaluationId must be omitted from the draft so callers can stamp it",
  )
  assert.equal(
    "evaluationRunId" in draft,
    false,
    "evaluationRunId must be omitted from the draft so callers can stamp it",
  )
})

test("composeEvaluation — same inputs produce identical scores (idempotent)", () => {
  const inputs: RubricInputs = {
    profile: richProfile(),
    record: richRecord(),
    company: basicCompany(),
    job: basicJob(),
  }
  const a = composeEvaluation(inputs, { nowIso: NOW_ISO })
  const b = composeEvaluation(inputs, { nowIso: NOW_ISO })
  assert.equal(a.generalRubricScore, b.generalRubricScore)
  assert.equal(a.companyRubricScore, b.companyRubricScore)
  assert.equal(a.jobRubricScore, b.jobRubricScore)
  assert.equal(a.softScore, b.softScore)
  assert.equal(a.proposedTier, b.proposedTier)
  assert.equal(a.explanation, b.explanation)
  assert.deepEqual(a.hardGateReasons, b.hardGateReasons)
})

test("composeEvaluation — hard-block flow returns 'blocked' + concise explanation", () => {
  const profile = richProfile()
  profile.globalTags!.roleFunction = ["sales"]
  const draft = composeEvaluation(
    {
      profile,
      record: richRecord(),
      company: basicCompany(),
      job: basicJob(),
    },
    { nowIso: NOW_ISO },
  )
  assert.equal(draft.hardGateResult, "hard_block")
  assert.equal(draft.proposedTier, "blocked")
  assert.ok(draft.explanation.startsWith("Hard-blocked"))
})

test("composeEvaluation — softScore matches TIER_WEIGHTS-weighted sum", () => {
  const draft = composeEvaluation(
    {
      profile: richProfile(),
      record: richRecord(),
      company: basicCompany(),
      job: basicJob(),
    },
    { nowIso: NOW_ISO },
  )
  const expected =
    TIER_WEIGHTS.general * draft.generalRubricScore +
    TIER_WEIGHTS.company * draft.companyRubricScore +
    TIER_WEIGHTS.job * draft.jobRubricScore
  // Clamped at 1.
  assert.ok(Math.abs(draft.softScore - Math.min(1, expected)) < 1e-9)
})

test("composeEvaluation — rubricVersion override honored", () => {
  const draft = composeEvaluation(
    {
      profile: richProfile(),
      record: richRecord(),
      company: basicCompany(),
      job: basicJob(),
    },
    { nowIso: NOW_ISO, rubricVersion: "rubric-ab-test-2026" },
  )
  assert.equal(draft.rubricVersion, "rubric-ab-test-2026")
})

test("composeEvaluation — missingInfo + risks dedup and sort", () => {
  // Sparse-everything path.
  const draft = composeEvaluation(
    {
      profile: {
        candidateId: "cand-sparse",
        candidateLifecycleState: "prospect",
        createdAt: NOW_ISO,
      },
      record: {
        recordId: "r1",
        batchId: "b-1",
        source: "juicebox",
        rawPayload: {},
        emails: [],
        experience: [],
        education: [],
        sourceTags: [],
        normalizationStatus: "ok",
        identityResolutionStatus: "needs_review",
        evidence: [],
        createdAt: NOW_ISO,
      },
      company: {
        companyId: "co-1",
      },
      job: {
        jobId: "job-1",
      },
    },
    { nowIso: NOW_ISO },
  )
  // Sorted + deduped.
  const sorted = [...draft.missingInfo].sort()
  assert.deepEqual(draft.missingInfo, sorted)
  const dedupSize = new Set(draft.missingInfo).size
  assert.equal(dedupSize, draft.missingInfo.length)
  // Should land hard_block or soft_block — not tier_1.
  assert.notEqual(draft.proposedTier, "tier_1_personal_linkedin_and_email")
})

test("composeEvaluation — competitor adjacency promotes to tier_1 even at threshold", () => {
  // Tune profile so combined sits ~0.81 — exactly the boundary the competitor
  // boost was designed for.
  const profile = richProfile()
  profile.globalTags!.skills = profile.globalTags!.skills.slice(0, 4) // 4 skills, 4 match
  const draft = composeEvaluation(
    {
      profile,
      record: richRecord(),
      company: basicCompany(),
      job: basicJob(),
    },
    { nowIso: NOW_ISO },
  )
  assert.equal(draft.proposedTier, "tier_1_personal_linkedin_and_email")
  assert.ok(draft.competitorAdjacency?.matched)
})

// ---------------------------------------------------------------------------
// TIER_WEIGHTS sanity
// ---------------------------------------------------------------------------

test("TIER_WEIGHTS sum to 1", () => {
  const sum = TIER_WEIGHTS.general + TIER_WEIGHTS.company + TIER_WEIGHTS.job
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights must sum to 1, got ${sum}`)
})
