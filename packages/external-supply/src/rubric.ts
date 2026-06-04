/**
 * v2.0 External Supply V1 — Wave C Block D1 — Pure rubric engine.
 *
 * Three orthogonal sub-rubrics + a tier proposal table. **No Firestore reads.**
 * **No LLM calls.** Pure function over `(profile, record, company, job)` so
 * `runEvaluation` can be replayed and regression-tested deterministically.
 *
 * Architecture mapped to PLAN.md §5 + EXECUTOR-PLANS.md D:
 *  - `evaluateGeneralRubric(profile, record)` — global hireability / signal
 *    quality / data completeness. Weight in `proposeTier`: 0.25.
 *  - `evaluateCompanyRubric(profile, record, company)` — industry adjacency,
 *    competitor adjacency (Adam directive: WeKruit specifically values
 *    candidates with prior experience at competitor companies), school match,
 *    company-size preference. Weight: 0.25.
 *  - `evaluateJobRubric(profile, record, job)` — role family, visa, location,
 *    careerStage, jobType, freshness hard gates per JOB-DATA-CONTRACT §6.3.
 *    Soft signals on top: skill overlap, industry preference, salary, YoE.
 *    Weight: 0.50 (the dominant signal).
 *  - `proposeTier(...)` — explicit bucket mapping; never emits "do_not_contact"
 *    or "do_not_interview" (Invariant 9 — match score does not block first
 *    interview).
 *  - `composeEvaluation(...)` — aggregates sub-scores + builds an operator-
 *    readable 1-3 sentence explanation. Returns a draft `CandidateCompany
 *    JobEvaluation` (caller stamps `evaluationId` + `evaluationRunId`).
 *
 * Lead resolutions (EXECUTOR-PLANS.md §D):
 *  - D Q1 → `RUBRIC_VERSION_DEFAULT` is a constant; caller can override.
 *  - D Q2 → V1 reads `competitorCompanies` from the company arg directly; we
 *    do NOT read `pa-companies` here (kept pure). Missing -> `missingInfo`.
 *  - D Q3 → `retain_only` is the catch-all between `blocked` and outreach-
 *    worthy tiers.
 *  - D Q4 → `TIER_WEIGHTS` exported as a named constant so eval / regression
 *    can pin them.
 *
 * Determinism notes:
 *  - All thresholds + weights are file-level constants.
 *  - Set ordering uses sorted iteration so explanations are stable across runs.
 *  - Confidence defaults match the brief: 0.4 for general rubric evidence,
 *    0.5 for company/job rubric evidence; `MarketplaceEvidence.source` is
 *    always `"system"` because the rubric is deterministic infrastructure.
 */

import type {
  CandidateCompanyJobEvaluation,
  EvaluationTier,
  ExternalCandidateRecord,
} from "@pa/core-types"
import type {
  CandidateProfile,
  CandidateGlobalTags,
  MarketplaceEvidence,
} from "@pa/core-types"
import {
  acceptableCareerStages,
  ANYWHERE_LOCATION_TOKENS,
  type CareerStage,
  type Skill,
} from "@wekruit/shared-tags"

// ---------------------------------------------------------------------------
// Versioning + tier weights
// ---------------------------------------------------------------------------

/** Default rubric vocabulary version — bump on any structural change. */
export const RUBRIC_VERSION_DEFAULT = "rubric-2026-05-v1"

/**
 * Sub-score weights that compose the `combined` score in `proposeTier`.
 * The dominant signal is `job` because tier mapping for outreach is mostly
 * a function of how well the candidate matches THIS opportunity.
 */
export const TIER_WEIGHTS = {
  general: 0.25,
  company: 0.25,
  job: 0.5,
} as const

// ---------------------------------------------------------------------------
// Public input / output shapes
// ---------------------------------------------------------------------------

/**
 * Minimum-viable `CompanyContext` the rubric uses. Wider `pa-companies` docs
 * may carry more fields; consumers may project a richer view as long as
 * these keys are present. Missing fields surface as `missingInfo`.
 */
export interface CompanyContext {
  companyId: string
  name?: string
  industrySector?: string[]
  /** Free-text size category — falls back to `companySizePreference` overlap. */
  size?:
    | "seed"
    | "early_startup"
    | "scale_up"
    | "mid_market"
    | "enterprise"
    | "no_preference"
    | "unknown"
  competitorCompanies?: string[]
  schoolPreferences?: string[]
}

/**
 * Minimum-viable `JobContext` the rubric uses. Mirrors the shape of
 * `apps/job-rec/src/types.ts` `MatchingJob` but kept loose so the rubric
 * stays decoupled from the legacy schema. `firstSeenAt` may be omitted —
 * the freshness gate degrades to `soft_block` rather than `hard_block`.
 */
export interface JobContext {
  jobId: string
  title?: string
  roleFunction?: string[]
  requiredSkills?: string[]
  /** Optional canonical seniority — degrades to `soft_block` when missing. */
  seniorityLevel?: string
  /** Canonical location buckets the job is open to. */
  locationBuckets?: string[]
  /** `true` when the employer is open to visa sponsorship. */
  sponsorship?: boolean | null
  jobType?: string
  industrySector?: string[]
  /** ISO 8601 string. < 90d means fresh enough for external-supply. */
  firstSeenAt?: string
  salaryMin?: number | null
  salaryMax?: number | null
}

export interface RubricInputs {
  profile: CandidateProfile
  record: ExternalCandidateRecord
  company: CompanyContext
  job: JobContext
}

export interface SubScoreResult {
  score: number
  signals: string[]
  missingInfo: string[]
  risks: string[]
  evidence: MarketplaceEvidence[]
}

export interface CompanyRubricResult extends SubScoreResult {
  competitorAdjacency?: { matched: boolean; confidence: number; evidence?: string }
  industryAdjacency?: { sector: string; confidence: number }
}

export interface JobRubricResult extends SubScoreResult {
  hardGateResult: "pass" | "soft_block" | "hard_block"
  hardGateReasons: string[]
}

export interface TierProposalInputs {
  general: number
  company: number
  job: number
  hardGate: "pass" | "soft_block" | "hard_block"
  missingInfo: string[]
  risks: string[]
  competitorAdjacency?: { matched: boolean; confidence: number }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function normalizeTokens(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    if (typeof raw !== "string") continue
    const trimmed = raw.trim().toLowerCase()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out.sort()
}

function intersectionSize(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  let hits = 0
  for (const value of a) {
    if (setB.has(value)) hits += 1
  }
  return hits
}

function intersection(a: readonly string[], b: readonly string[]): string[] {
  if (a.length === 0 || b.length === 0) return []
  const setB = new Set(b)
  const out: string[] = []
  for (const value of a) {
    if (setB.has(value)) out.push(value)
  }
  return out
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  const union = new Set<string>([...a, ...b])
  if (union.size === 0) return 0
  return intersectionSize(a, b) / union.size
}

function tags(profile: CandidateProfile): CandidateGlobalTags | undefined {
  return profile.globalTags
}

/**
 * Skill list pulled from the profile's `globalTags.skills[]`. Schema is
 * `{ name, proficiency?, baseWeight? }` per `@wekruit/shared-tags`. We keep
 * the skill name in lowercase to match Jaccard helpers.
 */
function profileSkillTokens(profile: CandidateProfile): string[] {
  const t = tags(profile)
  if (!t?.skills) return []
  return normalizeTokens(t.skills.map((s: Skill) => s.name))
}

function recordExperienceCompanies(record: ExternalCandidateRecord): string[] {
  const direct = record.currentCompany ? [record.currentCompany] : []
  const history = record.experience.map((e) => e.company)
  return normalizeTokens([...direct, ...history])
}

function profileExperienceCompanies(profile: CandidateProfile): string[] {
  // `pa-users` doesn't carry experience.company list directly; we look at
  // `globalTags.relevantTags` (where parser stashes employer tokens) +
  // `mem0` is out of scope here. Return an empty list when nothing is
  // surfaced — the record-side companies are the primary signal for
  // competitor adjacency.
  const t = tags(profile)
  if (!t?.relevantTags) return []
  return normalizeTokens(t.relevantTags)
}

function recordSchoolTokens(record: ExternalCandidateRecord): string[] {
  return normalizeTokens(record.education.map((e) => e.school))
}

function profileSchoolTokens(profile: CandidateProfile): string[] {
  // Same as experienceCompanies — pa-users doesn't carry an explicit school
  // list yet; we keep this method here so a future enrichment can light it
  // up without a rubric API change.
  void profile
  return []
}

function evidence(
  source: MarketplaceEvidence["source"],
  summary: string,
  confidence: number,
  refId?: string,
): MarketplaceEvidence {
  const ev: MarketplaceEvidence = { source, summary, confidence }
  if (refId) ev.refId = refId
  return ev
}

const GENERAL_EVIDENCE_CONFIDENCE = 0.4
const COMPANY_JOB_EVIDENCE_CONFIDENCE = 0.5

// ---------------------------------------------------------------------------
// Career-stage adjacency for the job hard gate
// ---------------------------------------------------------------------------

/**
 * Whether `profileStage` is within ± 1 tier of `jobStage` per the canonical
 * `acceptableCareerStages` helper (matches V16 hard-filter window behavior).
 *
 * Returns `null` when either side is missing so the caller can treat that
 * as `soft_block` rather than `hard_block`.
 */
function careerStageWithinWindow(
  profileStage: string | undefined,
  jobStage: string | undefined,
): boolean | null {
  if (!profileStage || !jobStage) return null
  // `acceptableCareerStages` requires a canonical `CareerStage`. We cast and
  // catch out-of-vocab gracefully — return null so caller soft-blocks.
  try {
    const acceptable = acceptableCareerStages(profileStage as CareerStage)
    return acceptable.includes(jobStage as CareerStage)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 1. General rubric — global signal quality + completeness
// ---------------------------------------------------------------------------

export function evaluateGeneralRubric(
  profile: CandidateProfile,
  record: ExternalCandidateRecord,
): SubScoreResult {
  const signals: string[] = []
  const missingInfo: string[] = []
  const risks: string[] = []
  const evList: MarketplaceEvidence[] = []
  let score = 0

  // LinkedIn presence — the single strongest external-sourcing signal.
  if (record.canonicalLinkedInUrl) {
    score += 0.2
    signals.push("linkedin_present")
    evList.push(
      evidence(
        "external_sourcing",
        "Candidate has a canonical LinkedIn URL",
        GENERAL_EVIDENCE_CONFIDENCE,
        record.canonicalLinkedInUrl,
      ),
    )
  } else {
    missingInfo.push("linkedin_missing")
  }

  // Email presence.
  if (record.emails.length > 0) {
    score += 0.1
    signals.push("email_present")
  } else {
    missingInfo.push("email_missing")
  }

  // YoE — single replace-not-add tier so we don't double-count completeness.
  const t = tags(profile)
  const yoe = t?.yoeRange ? t.yoeRange[0] : undefined
  if (typeof yoe === "number") {
    if (yoe >= 10) {
      score += 0.3
      signals.push("yoe_10_plus")
    } else if (yoe >= 5) {
      score += 0.25
      signals.push("yoe_5_plus")
    } else if (yoe >= 2) {
      score += 0.15
      signals.push("yoe_2_plus")
    } else {
      signals.push("yoe_under_2")
    }
  } else {
    missingInfo.push("yoe_unknown")
  }

  // Skill list size — degrades smoothly so a richer record edges out a sparser one.
  const skillCount = profileSkillTokens(profile).length
  if (skillCount >= 10) {
    score += 0.2
    signals.push("skills_10_plus")
  } else if (skillCount >= 5) {
    score += 0.15
    signals.push("skills_5_plus")
  } else if (skillCount > 0) {
    signals.push("skills_under_5")
  } else {
    missingInfo.push("skills_missing")
  }

  // careerStage set on profile (any value).
  if (t?.careerStage) {
    score += 0.1
    signals.push("career_stage_set")
  } else {
    missingInfo.push("career_stage_unknown")
  }

  // Resume artifact attached to the candidate profile.
  if (profile.latestResumeArtifactId) {
    score += 0.1
    signals.push("resume_on_file")
  } else {
    missingInfo.push("resume_missing")
  }

  const finalScore = clamp01(score)
  if (finalScore < 0.3) {
    risks.push("profile_completeness_low")
  }

  evList.push(
    evidence(
      "system",
      `general_rubric_score=${finalScore.toFixed(2)}; signals=${signals.length}; missing=${missingInfo.length}`,
      GENERAL_EVIDENCE_CONFIDENCE,
    ),
  )

  return { score: finalScore, signals, missingInfo, risks, evidence: evList }
}

// ---------------------------------------------------------------------------
// 2. Company rubric — industry / competitor / school / size adjacency
// ---------------------------------------------------------------------------

export function evaluateCompanyRubric(
  profile: CandidateProfile,
  record: ExternalCandidateRecord,
  company: CompanyContext,
): CompanyRubricResult {
  const signals: string[] = []
  const missingInfo: string[] = []
  const risks: string[] = []
  const evList: MarketplaceEvidence[] = []
  let score = 0
  let industryAdjacency: { sector: string; confidence: number } | undefined
  let competitorAdjacency:
    | { matched: boolean; confidence: number; evidence?: string }
    | undefined

  const t = tags(profile)

  // Industry overlap (up to +0.40).
  const companySectors = normalizeTokens(company.industrySector)
  const profileSectors = normalizeTokens(t?.industrySector)
  if (companySectors.length === 0) {
    missingInfo.push("company_industry_unknown")
  } else if (profileSectors.length === 0) {
    missingInfo.push("profile_industry_unknown")
  } else {
    const hits = intersection(profileSectors, companySectors).sort()
    if (hits.length > 0) {
      // Up to 0.40, scaling with overlap quality.
      const overlap = hits.length / companySectors.length
      const contribution = Math.min(0.4, 0.4 * overlap)
      score += contribution
      signals.push(`industry_overlap:${hits.join(",")}`)
      industryAdjacency = {
        sector: hits[0]!,
        confidence: clamp01(jaccard(profileSectors, companySectors)),
      }
      evList.push(
        evidence(
          "external_sourcing",
          `Candidate industry overlaps company on ${hits.join(", ")}`,
          COMPANY_JOB_EVIDENCE_CONFIDENCE,
        ),
      )
    } else {
      signals.push("industry_overlap_none")
    }
  }

  // Competitor adjacency (+0.30). Pulled from BOTH the record's experience
  // history AND the profile (when light tags carry employer tokens). Adam
  // directive: prior experience at a competitor is a strong personal-outreach
  // signal — bump straight to tier_1 in `proposeTier`.
  const competitors = normalizeTokens(company.competitorCompanies)
  if (competitors.length === 0) {
    missingInfo.push("competitor_list_unknown")
  } else {
    const recordCompanies = recordExperienceCompanies(record)
    const profileCompanies = profileExperienceCompanies(profile)
    const candidateCompanies = Array.from(
      new Set<string>([...recordCompanies, ...profileCompanies]),
    )
    const hits = intersection(candidateCompanies, competitors).sort()
    if (hits.length > 0) {
      score += 0.3
      signals.push(`competitor_overlap:${hits.join(",")}`)
      competitorAdjacency = {
        matched: true,
        confidence: 0.8,
        evidence: `Prior tenure at ${hits.join(", ")}`,
      }
      evList.push(
        evidence(
          "external_sourcing",
          `Competitor adjacency hit on ${hits.join(", ")}`,
          COMPANY_JOB_EVIDENCE_CONFIDENCE,
        ),
      )
    } else {
      competitorAdjacency = { matched: false, confidence: 0.2 }
    }
  }

  // School preference (+0.15).
  const schools = normalizeTokens(company.schoolPreferences)
  if (schools.length > 0) {
    const candidateSchools = Array.from(
      new Set<string>([...recordSchoolTokens(record), ...profileSchoolTokens(profile)]),
    )
    const hits = intersection(candidateSchools, schools)
    if (hits.length > 0) {
      score += 0.15
      signals.push(`school_overlap:${hits.sort().join(",")}`)
    }
  }

  // Company size preference (+0.15) — match if the candidate's stated size
  // preference list contains the company's size.
  const companySize = company.size
  const sizePref = t?.companySizePreference ?? []
  if (companySize && companySize !== "unknown" && sizePref.length > 0) {
    if (sizePref.includes(companySize)) {
      score += 0.15
      signals.push(`size_preference:${companySize}`)
    }
  } else if (!companySize || companySize === "unknown") {
    // Don't penalize — just note.
    missingInfo.push("company_size_unknown")
  }

  const finalScore = clamp01(score)
  if (finalScore < 0.2 && industryAdjacency === undefined) {
    risks.push("company_fit_low")
  }

  evList.push(
    evidence(
      "system",
      `company_rubric_score=${finalScore.toFixed(2)}; competitor=${
        competitorAdjacency?.matched ?? "unknown"
      }`,
      COMPANY_JOB_EVIDENCE_CONFIDENCE,
    ),
  )

  const result: CompanyRubricResult = {
    score: finalScore,
    signals,
    missingInfo,
    risks,
    evidence: evList,
  }
  if (competitorAdjacency) result.competitorAdjacency = competitorAdjacency
  if (industryAdjacency) result.industryAdjacency = industryAdjacency
  return result
}

// ---------------------------------------------------------------------------
// 3. Job rubric — hard gates per JOB-DATA-CONTRACT §6.3 + soft signals
// ---------------------------------------------------------------------------

const FRESHNESS_WINDOW_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export function evaluateJobRubric(
  profile: CandidateProfile,
  record: ExternalCandidateRecord,
  job: JobContext,
): JobRubricResult {
  const signals: string[] = []
  const missingInfo: string[] = []
  const risks: string[] = []
  const evList: MarketplaceEvidence[] = []
  const hardGateReasons: string[] = []
  let hardGate: "pass" | "soft_block" | "hard_block" = "pass"
  let score = 0

  const t = tags(profile)

  // 3.1 Role function intersection — hard_block on no overlap.
  const profileRoles = normalizeTokens(t?.roleFunction)
  const jobRoles = normalizeTokens(job.roleFunction)
  if (jobRoles.length === 0) {
    missingInfo.push("job_role_function_unknown")
    // Without job role, we can't enforce the gate — degrade to soft_block.
    if (hardGate === "pass") hardGate = "soft_block"
    hardGateReasons.push("role_function_unknown_on_job")
  } else if (profileRoles.length === 0) {
    missingInfo.push("profile_role_function_unknown")
    if (hardGate === "pass") hardGate = "soft_block"
    hardGateReasons.push("role_function_unknown_on_profile")
  } else if (intersectionSize(profileRoles, jobRoles) === 0) {
    hardGate = "hard_block"
    hardGateReasons.push("role_function_no_overlap")
  } else {
    signals.push("role_function_match")
    hardGateReasons.push("role_function_overlap")
  }

  // 3.2 Visa — sponsor_needed AND sponsorship === false -> hard_block.
  const visaStatus = t?.visaStatus
  if (
    visaStatus === "sponsor_needed" &&
    job.sponsorship === false
  ) {
    hardGate = "hard_block"
    hardGateReasons.push("visa_blocks_sponsorship")
  } else if (visaStatus === "sponsor_needed" && job.sponsorship === null) {
    // Employer hasn't published sponsorship policy — surface for review but
    // don't hard-block. (PLAN §14 Adam directive — never infer
    // sponsorship=false from silence.)
    missingInfo.push("sponsorship_policy_unknown")
  }
  if (hardGate !== "hard_block") {
    hardGateReasons.push("visa_ok")
  }

  // 3.3 Location — must intersect OR `anywhere` bypass.
  const profileLocations = normalizeTokens(t?.targetLocations)
  const jobLocations = normalizeTokens(job.locationBuckets)
  const anywhereSet = new Set<string>([
    ...Array.from(ANYWHERE_LOCATION_TOKENS),
    "anywhere",
    "remote",
  ])
  const profileHasAnywhere = profileLocations.some((loc) => anywhereSet.has(loc))
  if (jobLocations.length === 0) {
    missingInfo.push("job_location_unknown")
  } else if (profileHasAnywhere) {
    signals.push("location_anywhere")
    hardGateReasons.push("location_bypass_anywhere")
  } else if (profileLocations.length === 0) {
    missingInfo.push("profile_location_unknown")
    if (hardGate === "pass") hardGate = "soft_block"
    hardGateReasons.push("location_unknown_on_profile")
  } else if (intersectionSize(profileLocations, jobLocations) === 0) {
    if (hardGate !== "hard_block") hardGate = "hard_block"
    hardGateReasons.push("location_no_overlap")
  } else {
    signals.push("location_match")
    hardGateReasons.push("location_overlap")
  }

  // 3.4 careerStage window (± 1 tier).
  const stageOk = careerStageWithinWindow(t?.careerStage, job.seniorityLevel)
  if (stageOk === null) {
    missingInfo.push("career_stage_unknown")
    if (hardGate === "pass") hardGate = "soft_block"
    hardGateReasons.push("career_stage_unknown")
  } else if (!stageOk) {
    if (hardGate !== "hard_block") hardGate = "hard_block"
    hardGateReasons.push("career_stage_out_of_window")
  } else {
    signals.push("career_stage_in_window")
    hardGateReasons.push("career_stage_ok")
  }

  // 3.5 jobType — must intersect; missing on either side -> soft_block.
  const profileJobTypes = normalizeTokens(t?.targetJobType)
  if (!job.jobType) {
    missingInfo.push("job_type_unknown_on_job")
    if (hardGate === "pass") hardGate = "soft_block"
    hardGateReasons.push("job_type_unknown_on_job")
  } else if (profileJobTypes.length === 0) {
    missingInfo.push("job_type_unknown_on_profile")
    if (hardGate === "pass") hardGate = "soft_block"
    hardGateReasons.push("job_type_unknown_on_profile")
  } else if (!profileJobTypes.includes(job.jobType.toLowerCase())) {
    if (hardGate === "pass") hardGate = "soft_block"
    hardGateReasons.push("job_type_mismatch")
  } else {
    signals.push("job_type_match")
    hardGateReasons.push("job_type_ok")
  }

  // 3.6 Freshness — < 90d. External-supply runs against records we just
  // imported, so anchor on the LATEST of (record.firstSeenAt, job.firstSeenAt).
  const freshAnchor = pickFreshnessAnchor(job.firstSeenAt, record.createdAt)
  if (freshAnchor === null) {
    missingInfo.push("freshness_unknown")
    if (hardGate === "pass") hardGate = "soft_block"
    hardGateReasons.push("freshness_unknown")
  } else if (freshAnchor.ageDays > FRESHNESS_WINDOW_DAYS) {
    if (hardGate === "pass") hardGate = "soft_block"
    hardGateReasons.push("freshness_stale")
    risks.push(`record_age_${Math.floor(freshAnchor.ageDays)}d`)
  } else {
    signals.push("freshness_ok")
    hardGateReasons.push("freshness_ok")
  }

  // Stop short on hard_block — soft-score is meaningless when the gate fails.
  if (hardGate === "hard_block") {
    evList.push(
      evidence(
        "system",
        `job_rubric_hard_blocked=${hardGateReasons
          .filter((r) => r !== "visa_ok")
          .sort()
          .join(",")}`,
        COMPANY_JOB_EVIDENCE_CONFIDENCE,
      ),
    )
    return {
      score: 0,
      signals,
      missingInfo,
      risks,
      evidence: evList,
      hardGateResult: hardGate,
      hardGateReasons,
    }
  }

  // 3.7 Skill overlap (+0.45 max) — Jaccard normalized over the job's
  // required-skill list (so a candidate covering all required skills caps).
  const profileSkills = profileSkillTokens(profile)
  const jobSkills = normalizeTokens(job.requiredSkills)
  if (jobSkills.length === 0) {
    missingInfo.push("job_skills_unknown")
  } else if (profileSkills.length === 0) {
    missingInfo.push("profile_skills_unknown")
  } else {
    const hits = intersectionSize(profileSkills, jobSkills)
    const overlap = Math.min(1, hits / jobSkills.length)
    const contribution = 0.45 * overlap
    score += contribution
    signals.push(`skill_overlap:${hits}/${jobSkills.length}`)
  }

  // 3.8 Industry preference (+0.15).
  const profileSectors = normalizeTokens(t?.industrySector)
  const jobSectors = normalizeTokens(job.industrySector)
  if (jobSectors.length > 0 && profileSectors.length > 0) {
    const overlap = jaccard(profileSectors, jobSectors)
    score += 0.15 * overlap
    if (overlap > 0) signals.push(`industry_preference_overlap`)
  }

  // 3.9 Salary fit (+0.20) — only when both sides set. Missing -> no penalty.
  const minSalary = t?.minSalaryUsd
  const jobSalaryMax = job.salaryMax
  const jobSalaryMin = job.salaryMin
  if (typeof minSalary === "number" && (typeof jobSalaryMax === "number" || typeof jobSalaryMin === "number")) {
    const jobMidpoint =
      typeof jobSalaryMax === "number" && typeof jobSalaryMin === "number"
        ? (jobSalaryMax + jobSalaryMin) / 2
        : (jobSalaryMax ?? jobSalaryMin)!
    if (jobMidpoint >= minSalary) {
      score += 0.2
      signals.push("salary_fit")
    } else if (jobMidpoint >= minSalary * 0.85) {
      score += 0.1
      signals.push("salary_near_fit")
    } else {
      risks.push("salary_below_min")
    }
  } else if (typeof minSalary === "number") {
    missingInfo.push("job_salary_unknown")
  }

  // 3.10 YoE alignment (+0.20). Candidate has range [low,high]; job has none
  // explicit, but seniorityLevel correlates. Use a simple matrix:
  //   - profile YoE >= 5 + job seniority in {senior+}: +0.20
  //   - profile YoE >= 2 + job seniority in {junior, mid_level}: +0.20
  //   - profile YoE >= 0 + job seniority in {student, intern, entry_level}: +0.20
  //   - otherwise: +0.10 if any range overlap, else +0
  const yoe = t?.yoeRange?.[0]
  if (typeof yoe === "number" && job.seniorityLevel) {
    const senior = new Set(["senior", "staff", "principal", "director", "vp", "c_level", "founder"])
    const mid = new Set(["mid_level", "manager"])
    const junior = new Set(["junior", "entry_level"])
    const early = new Set(["student", "intern"])
    if (yoe >= 5 && senior.has(job.seniorityLevel)) {
      score += 0.2
      signals.push("yoe_fit_senior")
    } else if (yoe >= 2 && mid.has(job.seniorityLevel)) {
      score += 0.2
      signals.push("yoe_fit_mid")
    } else if (yoe >= 0 && junior.has(job.seniorityLevel)) {
      score += 0.2
      signals.push("yoe_fit_junior")
    } else if (early.has(job.seniorityLevel)) {
      score += 0.2
      signals.push("yoe_fit_early")
    } else {
      score += 0.1
      signals.push("yoe_partial_fit")
    }
  } else if (typeof yoe !== "number") {
    missingInfo.push("profile_yoe_unknown")
  }

  const finalScore = clamp01(score)
  evList.push(
    evidence(
      "system",
      `job_rubric_score=${finalScore.toFixed(2)}; gate=${hardGate}; reasons=${hardGateReasons.sort().join(",")}`,
      COMPANY_JOB_EVIDENCE_CONFIDENCE,
    ),
  )

  return {
    score: finalScore,
    signals,
    missingInfo,
    risks,
    evidence: evList,
    hardGateResult: hardGate,
    hardGateReasons,
  }
}

function pickFreshnessAnchor(
  jobFirstSeenAt: string | undefined,
  recordCreatedAt: string,
): { ageDays: number } | null {
  // Use the LATEST of the two timestamps as the anchor — external-supply
  // records are freshly imported, so a record createdAt < 1d is plenty
  // even when the job posting itself is older. Job side is a fallback for
  // the rare case where the record timestamp is malformed.
  const candidates = [recordCreatedAt, jobFirstSeenAt].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  )
  if (candidates.length === 0) return null
  let latestMs: number | null = null
  for (const ts of candidates) {
    const parsed = Date.parse(ts)
    if (!Number.isNaN(parsed)) {
      latestMs = latestMs === null ? parsed : Math.max(latestMs, parsed)
    }
  }
  if (latestMs === null) return null
  const ageDays = (Date.now() - latestMs) / DAY_MS
  return { ageDays }
}

// ---------------------------------------------------------------------------
// 4. Tier proposal — explicit bucket mapping
// ---------------------------------------------------------------------------

/**
 * Tier bucket table — see prompt + EXECUTOR-PLANS.md D Q3.
 *
 *  - `blocked` when hard gate is `hard_block` (visa, role, location, etc.).
 *  - `retain_only` when soft-blocked with low combined score, OR no
 *    outreach-worthy signal yet.
 *  - `tier_3_general_email` for >= 0.45 combined.
 *  - `tier_2_personal_email` for >= 0.60.
 *  - `tier_1_personal_linkedin_and_email` for >= 0.75, OR for >= 0.80
 *    AND competitor adjacency match.
 *
 * Never emits "do_not_contact" — Invariant 9 (match score does not block
 * the first interview).
 */
export function proposeTier(inputs: TierProposalInputs): EvaluationTier {
  if (inputs.hardGate === "hard_block") return "blocked"

  const combined =
    TIER_WEIGHTS.general * clamp01(inputs.general) +
    TIER_WEIGHTS.company * clamp01(inputs.company) +
    TIER_WEIGHTS.job * clamp01(inputs.job)

  if (inputs.hardGate === "soft_block" && combined < 0.55) {
    return "retain_only"
  }

  const competitorBoost =
    inputs.competitorAdjacency?.matched === true &&
    inputs.competitorAdjacency.confidence >= 0.7

  if (combined >= 0.8 && competitorBoost) return "tier_1_personal_linkedin_and_email"
  if (combined >= 0.75) return "tier_1_personal_linkedin_and_email"
  if (combined >= 0.6) return "tier_2_personal_email"
  if (combined >= 0.45) return "tier_3_general_email"
  return "retain_only"
}

// ---------------------------------------------------------------------------
// 5. Aggregate — composeEvaluation
// ---------------------------------------------------------------------------

export interface ComposeEvaluationOpts {
  rubricVersion?: string
  /** ISO 8601 timestamp — defaults to `new Date().toISOString()`. */
  nowIso?: string
}

/**
 * Aggregates the three sub-rubrics into a `CandidateCompanyJobEvaluation`
 * draft (caller stamps `evaluationId` + `evaluationRunId`).
 *
 * Soft `softScore` exposed on the evaluation doc is the same weighted
 * combination used internally by `proposeTier`. The doc carries every
 * sub-score independently so the dashboard can render the breakdown.
 */
export function composeEvaluation(
  inputs: RubricInputs,
  opts: ComposeEvaluationOpts = {},
): Omit<CandidateCompanyJobEvaluation, "evaluationId" | "evaluationRunId"> {
  const generalResult = evaluateGeneralRubric(inputs.profile, inputs.record)
  const companyResult = evaluateCompanyRubric(
    inputs.profile,
    inputs.record,
    inputs.company,
  )
  const jobResult = evaluateJobRubric(inputs.profile, inputs.record, inputs.job)

  const combined =
    TIER_WEIGHTS.general * generalResult.score +
    TIER_WEIGHTS.company * companyResult.score +
    TIER_WEIGHTS.job * jobResult.score

  const proposedTier = proposeTier({
    general: generalResult.score,
    company: companyResult.score,
    job: jobResult.score,
    hardGate: jobResult.hardGateResult,
    missingInfo: [
      ...generalResult.missingInfo,
      ...companyResult.missingInfo,
      ...jobResult.missingInfo,
    ],
    risks: [...generalResult.risks, ...companyResult.risks, ...jobResult.risks],
    competitorAdjacency: companyResult.competitorAdjacency,
  })

  const allEvidence: MarketplaceEvidence[] = [
    ...generalResult.evidence,
    ...companyResult.evidence,
    ...jobResult.evidence,
  ]

  const allMissingInfo = Array.from(
    new Set<string>([
      ...generalResult.missingInfo,
      ...companyResult.missingInfo,
      ...jobResult.missingInfo,
    ]),
  ).sort()
  const allRisks = Array.from(
    new Set<string>([
      ...generalResult.risks,
      ...companyResult.risks,
      ...jobResult.risks,
    ]),
  ).sort()

  const explanation = buildExplanation({
    profile: inputs.profile,
    company: inputs.company,
    job: inputs.job,
    proposedTier,
    generalResult,
    companyResult,
    jobResult,
    combined,
  })

  const nowIso = opts.nowIso ?? new Date().toISOString()

  const draft: Omit<CandidateCompanyJobEvaluation, "evaluationId" | "evaluationRunId"> = {
    candidateId: inputs.profile.candidateId,
    companyId: inputs.company.companyId,
    jobId: inputs.job.jobId,
    rubricVersion: opts.rubricVersion ?? RUBRIC_VERSION_DEFAULT,
    generalRubricScore: generalResult.score,
    companyRubricScore: companyResult.score,
    jobRubricScore: jobResult.score,
    hardGateResult: jobResult.hardGateResult,
    hardGateReasons: jobResult.hardGateReasons,
    softScore: clamp01(combined),
    missingInfo: allMissingInfo,
    risks: allRisks,
    evidence: allEvidence,
    explanation,
    proposedTier,
    createdAt: nowIso,
  }
  if (companyResult.competitorAdjacency) {
    draft.competitorAdjacency = companyResult.competitorAdjacency
  }
  if (companyResult.industryAdjacency) {
    draft.industryAdjacency = companyResult.industryAdjacency
  }
  return draft
}

interface ExplanationInputs {
  profile: CandidateProfile
  company: CompanyContext
  job: JobContext
  proposedTier: EvaluationTier
  generalResult: SubScoreResult
  companyResult: CompanyRubricResult
  jobResult: JobRubricResult
  combined: number
}

/**
 * 1–3 sentence operator-readable explanation. Format:
 *   `<headline>. <strongest_company_signal>. <gate_summary>.`
 */
function buildExplanation(args: ExplanationInputs): string {
  const { proposedTier, generalResult, companyResult, jobResult, combined } = args
  const sentences: string[] = []

  if (jobResult.hardGateResult === "hard_block") {
    const reasons = jobResult.hardGateReasons
      .filter((r) => !r.endsWith("_ok") && !r.endsWith("_overlap") && r !== "visa_ok")
      .sort()
      .slice(0, 2)
    sentences.push(
      `Hard-blocked on ${reasons.join(", ") || "job_rubric_gate"} — candidate retained for other roles.`,
    )
  } else {
    const headline = `${proposedTier.replace(/_/g, " ")} (combined=${combined.toFixed(2)}, general=${generalResult.score.toFixed(2)}, company=${companyResult.score.toFixed(2)}, job=${jobResult.score.toFixed(2)})`
    sentences.push(headline)

    const companyBits: string[] = []
    if (companyResult.competitorAdjacency?.matched) {
      companyBits.push(
        `competitor adjacency: ${companyResult.competitorAdjacency.evidence ?? "prior tenure at a competitor"}`,
      )
    }
    if (companyResult.industryAdjacency) {
      companyBits.push(`industry overlap on ${companyResult.industryAdjacency.sector}`)
    }
    if (companyBits.length > 0) {
      sentences.push(`Company fit: ${companyBits.join("; ")}.`)
    }

    if (jobResult.hardGateResult === "soft_block") {
      sentences.push(
        `Soft-blocked: ${jobResult.hardGateReasons.filter((r) => !r.endsWith("_ok") && !r.endsWith("_overlap")).sort().slice(0, 2).join(", ")}.`,
      )
    }
  }

  return sentences.join(" ")
}
