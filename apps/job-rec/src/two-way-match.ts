import type { CandidateJobMatch, CandidateLifecycleState } from "@pa/core-types"
import { createCandidateJobMatchId } from "@pa/core-types"
import { acceptableCareerStages, CAREER_STAGE_VOCAB, type CareerStage } from "@wekruit/shared-tags"
import { V16_SCORE_WEIGHTS } from "./match-weights.js"
import type { MatchingJob } from "./types.js"
import {
  computeOverlap,
  computeSalaryFit,
  computeWeightedSkillJaccard,
  cosineSim,
} from "./tools/query-matching-jobs-v16.js"

export type RecommendedMatchAction = "auto_outbound" | "hitl_review" | "do_not_contact"
export type S5HardFilterResult = "pass" | "soft_block" | "hard_block" | "unknown"

export type MatchingCandidateTags = {
  skills?: unknown[]
  relevantTags?: string[]
  industrySector?: string[]
  relevantIndustry?: string[]
  visaStatus?: string
  targetRoleFunction?: string[]
  targetLocations?: string[]
  careerStage?: string
  targetJobType?: string[]
  targetJobTypes?: string[]
  minSalary?: number
  embedding?: number[]
  schemaVersion?: number
}

export type MatchingCandidateRow = {
  userId: string
  displayName?: string
  lifecycle?: CandidateLifecycleState
  outreach?: {
    paused?: boolean
    doNotContact?: boolean
    reachable?: boolean
  }
  tagsUpdatedAt?: string
  tags: MatchingCandidateTags
  cvEmbedding?: number[] | null
  llmMatch?: number | null
}

export type MatchScoreComponent = {
  score: number
  weight?: number
  summary?: string
}

export type CandidateForJobMatchResult = {
  candidateId: string
  displayName?: string
  candidateLifecycleState: CandidateLifecycleState
  jobId: string
  hardFilterResult: S5HardFilterResult
  scoreBreakdown: Record<string, MatchScoreComponent>
  matchedSignals: string[]
  blockedSignals: string[]
  reasons: string[]
  risks: string[]
  missingInfo: string[]
  recommendedAction: RecommendedMatchAction
  softScore: number
  llmScore?: number
  embeddingScore?: number
  finalScore: number
  finalRank?: number
  candidateTagsUpdatedAt?: string
}

export type ScoreCandidateForJobOptions = {
  nowMs?: number
  freshnessWindowMs?: number
  autoOutboundThreshold?: number
  hitlThreshold?: number
}

const DEFAULT_NOW_MS = Date.parse("2026-05-13T00:00:00.000Z")
const DEFAULT_FRESHNESS_WINDOW_MS = 20 * 24 * 3600 * 1000
const AUTO_OUTBOUND_THRESHOLD = 0.82
const HITL_THRESHOLD = 0.45
const ANYWHERE_LOCATION_TOKENS = new Set(["remote_anywhere", "remote_global", "anywhere", "any"])

function clamp01(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(1, value))
}

function list(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizedSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))
}

function overlaps(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = normalizedSet(a)
  if (aa.size === 0) return false
  for (const item of normalizedSet(b)) {
    if (aa.has(item)) return true
  }
  return false
}

function timestampToMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function needsSponsorship(visaStatus: string | undefined): boolean {
  return visaStatus === "sponsor_needed" || visaStatus === "sponsorship_needed"
}

function locationPasses(candidateLocations: string[] | undefined, jobLocations: string[] | undefined): boolean {
  const candidate = list(candidateLocations)
  if (candidate.length === 0) return false
  if (candidate.some((location) => ANYWHERE_LOCATION_TOKENS.has(location.toLowerCase()))) return true
  return overlaps(candidate, jobLocations)
}

function careerStagePasses(candidateStage: string | undefined, jobStage: string | undefined): boolean {
  if (!candidateStage || !jobStage) return false
  if (!(CAREER_STAGE_VOCAB as readonly string[]).includes(candidateStage)) return false
  return acceptableCareerStages(candidateStage as CareerStage).includes(jobStage as CareerStage)
}

function component(score: number, weight: number, summary?: string): MatchScoreComponent {
  return {
    score: Math.max(0, Math.min(1, score)),
    weight,
    ...(summary ? { summary } : {}),
  }
}

function resolveLifecycle(candidate: MatchingCandidateRow): CandidateLifecycleState {
  return candidate.lifecycle ?? "profile_ready"
}

function buildAction(args: {
  hardFilterResult: S5HardFilterResult
  finalScore: number
  missingInfo: string[]
  risks: string[]
  options: ScoreCandidateForJobOptions
}): RecommendedMatchAction {
  if (args.hardFilterResult === "hard_block") return "do_not_contact"
  const hitlThreshold = args.options.hitlThreshold ?? HITL_THRESHOLD
  const autoThreshold = args.options.autoOutboundThreshold ?? AUTO_OUTBOUND_THRESHOLD
  if (args.finalScore < hitlThreshold) return "do_not_contact"
  if (args.hardFilterResult === "soft_block") return "hitl_review"
  if (args.missingInfo.length > 0 || args.risks.length > 0) return "hitl_review"
  return args.finalScore >= autoThreshold ? "auto_outbound" : "hitl_review"
}

export function scoreCandidateForJob(
  job: MatchingJob & { embedding?: number[] | null },
  candidate: MatchingCandidateRow,
  options: ScoreCandidateForJobOptions = {}
): CandidateForJobMatchResult {
  const nowMs = options.nowMs ?? DEFAULT_NOW_MS
  const freshnessWindowMs = options.freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS
  const tags = candidate.tags ?? {}
  const blockedSignals: string[] = []
  const missingInfo: string[] = []
  const risks: string[] = []
  const matchedSignals: string[] = []

  if (candidate.outreach?.doNotContact) blockedSignals.push("candidate_do_not_contact")
  if (candidate.outreach?.paused) blockedSignals.push("candidate_outreach_paused")

  const roleFunction = list(job.roleFunction)
  const candidateRoles = list(tags.targetRoleFunction)
  if (roleFunction.length > 0 && candidateRoles.length > 0 && !overlaps(candidateRoles, roleFunction)) {
    blockedSignals.push("role_mismatch")
  }

  if (needsSponsorship(tags.visaStatus) && job.sponsorship === false) {
    blockedSignals.push("visa_sponsorship_unavailable")
  }
  if (needsSponsorship(tags.visaStatus) && job.sponsorship == null) {
    missingInfo.push("job_sponsorship")
    risks.push("sponsorship_unknown")
  }

  const candidateLocations = list(tags.targetLocations)
  if (candidateLocations.length === 0) {
    missingInfo.push("candidate_location")
  } else if (list(job.locationBuckets).length > 0 && !locationPasses(candidateLocations, job.locationBuckets)) {
    blockedSignals.push("location_mismatch")
  }

  if (!tags.careerStage) {
    missingInfo.push("candidate_career_stage")
  } else if (job.seniorityLevel && !careerStagePasses(tags.careerStage, job.seniorityLevel)) {
    blockedSignals.push("career_stage_mismatch")
  }

  const targetJobTypes = list(tags.targetJobType ?? tags.targetJobTypes)
  if (targetJobTypes.length > 0 && job.jobType && !targetJobTypes.includes(job.jobType)) {
    blockedSignals.push("job_type_mismatch")
  }

  const firstSeenMs = timestampToMs(job.firstSeenAt)
  if (firstSeenMs === 0 || nowMs - firstSeenMs > freshnessWindowMs) {
    blockedSignals.push("job_stale")
  }
  if (!job.atsApplyUrl || /jobright\.ai/i.test(job.atsApplyUrl)) {
    blockedSignals.push("ats_apply_url_missing")
  }
  if (job.dead === true) {
    blockedSignals.push("job_dead")
  }

  const skill = computeWeightedSkillJaccard(tags.skills as never, job.requiredSkills)
  for (const hit of skill.matched.slice(0, 4)) {
    matchedSignals.push(hit.name)
  }
  const relevantTags = computeOverlap(tags.relevantTags, job.relevantTags)
  const industrySector = computeOverlap([...(tags.industrySector ?? []), ...(tags.relevantIndustry ?? [])], job.industrySector)
  const llmScore = clamp01(candidate.llmMatch) ?? 0
  const embedding = cosineSim(candidate.cvEmbedding ?? tags.embedding, job.embedding ?? undefined)
  const salaryFit = computeSalaryFit(tags.minSalary, job.salaryMin)
  const finalScore =
    llmScore * V16_SCORE_WEIGHTS.llmMatch +
    skill.score * V16_SCORE_WEIGHTS.skillJaccard +
    relevantTags * V16_SCORE_WEIGHTS.relevantTags +
    industrySector * V16_SCORE_WEIGHTS.industrySector +
    embedding * V16_SCORE_WEIGHTS.cvEmbCosine +
    salaryFit * V16_SCORE_WEIGHTS.salaryFit

  if (relevantTags > 0) matchedSignals.push("relevant_tags")
  if (industrySector > 0) matchedSignals.push("industry_sector")
  if (clamp01(candidate.llmMatch) === undefined) risks.push("llm_score_unavailable")

  const hardFilterResult: S5HardFilterResult =
    blockedSignals.length > 0 ? "hard_block" : missingInfo.length > 0 ? "soft_block" : "pass"
  const recommendedAction = buildAction({ hardFilterResult, finalScore, missingInfo, risks, options })
  const scoreBreakdown = {
    llmMatch: component(llmScore, V16_SCORE_WEIGHTS.llmMatch),
    skillJaccard: component(skill.score, V16_SCORE_WEIGHTS.skillJaccard, skill.matched.map((hit) => hit.name).join(", ")),
    relevantTags: component(relevantTags, V16_SCORE_WEIGHTS.relevantTags),
    industrySector: component(industrySector, V16_SCORE_WEIGHTS.industrySector),
    cvEmbCosine: component(embedding, V16_SCORE_WEIGHTS.cvEmbCosine),
    salaryFit: component(salaryFit, V16_SCORE_WEIGHTS.salaryFit),
  }

  const reasons =
    skill.matched.length > 0
      ? [`Matched skills: ${skill.matched.slice(0, 3).map((hit) => hit.name).join(", ")}`]
      : relevantTags > 0 || industrySector > 0
        ? ["Role context and industry tags align"]
        : []

  return {
    candidateId: candidate.userId,
    ...(candidate.displayName ? { displayName: candidate.displayName } : {}),
    candidateLifecycleState: resolveLifecycle(candidate),
    jobId: job.id,
    hardFilterResult,
    scoreBreakdown,
    matchedSignals: [...new Set(matchedSignals)],
    blockedSignals,
    reasons,
    risks,
    missingInfo,
    recommendedAction,
    softScore: finalScore,
    llmScore,
    embeddingScore: embedding,
    finalScore: hardFilterResult === "hard_block" ? 0 : finalScore,
    ...(candidate.tagsUpdatedAt ? { candidateTagsUpdatedAt: candidate.tagsUpdatedAt } : {}),
  }
}

export function rankCandidatesForJob(
  job: MatchingJob & { embedding?: number[] | null },
  candidates: MatchingCandidateRow[],
  options: ScoreCandidateForJobOptions = {}
): CandidateForJobMatchResult[] {
  const actionPriority: Record<RecommendedMatchAction, number> = {
    auto_outbound: 3,
    hitl_review: 2,
    do_not_contact: 1,
  }
  return candidates
    .map((candidate) => scoreCandidateForJob(job, candidate, options))
    .sort((a, b) => {
      const actionDelta = actionPriority[b.recommendedAction] - actionPriority[a.recommendedAction]
      if (actionDelta !== 0) return actionDelta
      return b.finalScore - a.finalScore
    })
    .map((row, index) => ({ ...row, finalRank: index + 1 }))
}

export function candidateMatchToMarketplaceMatch(
  result: CandidateForJobMatchResult,
  meta: {
    matchVersion: string
    jobEnrichmentVersion: string
    computedAt: string
    createdAt: string
    updatedAt?: string
  }
): CandidateJobMatch {
  const matchId = createCandidateJobMatchId(result.candidateId, result.jobId)
  return {
    matchId,
    candidateId: result.candidateId,
    jobId: result.jobId,
    direction: "job_to_candidate",
    matchVersion: meta.matchVersion,
    jobEnrichmentVersion: meta.jobEnrichmentVersion,
    computedAt: meta.computedAt,
    scoreBreakdown: result.scoreBreakdown,
    matchedSignals: result.matchedSignals,
    blockedSignals: result.blockedSignals,
    candidateLifecycleStateAtMatch: result.candidateLifecycleState,
    candidateTagsUpdatedAt: result.candidateTagsUpdatedAt ?? meta.computedAt,
    hardFilterResult: result.hardFilterResult,
    softScore: result.softScore,
    llmScore: result.llmScore,
    finalScore: result.finalScore,
    finalRank: result.finalRank,
    reasons: result.reasons,
    risks: result.risks,
    missingInfo: result.missingInfo,
    recommendedAction: result.recommendedAction,
    evidence: [{ source: "job_match", summary: result.reasons[0] ?? "S5 two-way match" }],
    createdAt: meta.createdAt,
    ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
  }
}
