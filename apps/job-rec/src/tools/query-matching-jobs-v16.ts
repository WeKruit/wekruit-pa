/**
 * v1.6 Phase 56 — `queryMatchingJobsV16`: single-source canonical match cascade.
 *
 * Spec: REQ-IDs MATCH-01, MATCH-03..MATCH-08. Adam-locked decisions D8/D9/D10
 * (CLAUDE.md v1.6 design lock). Replaces the legacy fragmented read pipeline
 * (`statedPreferences` + `parsedCandidateResumes.industryTags` +
 * `parsedCandidateResumes.topSkills`) with a single read against
 * `pa-users/{userId}.tags`.
 *
 * Pipeline:
 *
 *   1. loadUserTags(db, userId)                                MATCH-01 / D8
 *      → null when no tags doc → return empty result + log
 *
 *   2. Firestore query (push role to query layer)              MATCH-03
 *      .where('status', '==', 'active')
 *      .where('roleFunction', 'array-contains-any', user.targetRoleFunction)
 *      .orderBy('firstSeenAt', 'desc')                         MATCH-08 / D10
 *      .limit(500)                                             raised from 50
 *
 *   3. applyV16HardFilters: visa → location → careerStage →    MATCH-04
 *      jobType → firstSeenAt < 20d → atsApplyUrl → dead
 *
 *   4. scoreV16Job: weighted blend per V16_SCORE_WEIGHTS       MATCH-05/06
 *      llm_match 0.40 + skill_jaccard 0.20 + relevant_tags 0.15 +
 *      industry_sector 0.10 + cv_emb_cosine 0.10 + salary_fit 0.05
 *
 *   5. composeReason: top-2 weighted matched skills, lang-aware MATCH-07
 *
 * Legacy `queryMatchingJobs` in `query-matching-jobs.ts` remains for
 * back-compat (daily-batch.ts consumer) until Phase 60 cuts over.
 *
 * @module query-matching-jobs-v16
 */

import type { Firestore } from "firebase-admin/firestore"
import { createRequire } from "node:module"
import type { UserTags } from "@pa/pa-orchestrator"
import {
  acceptableCareerStages,
  earlyCareerRelaxWindow,
  type CareerStage,
  CAREER_STAGE_VOCAB,
  CAREER_STAGE_INDEX,
  type RoleFunction,
  type CompanyStage,
  DEFAULT_HARDNESS,
  type HardnessAxis,
  type PreferenceHardnessEntry,
  DEFAULT_SALARY_BUFFER_PCT,
  DEFAULT_ORDINAL_BUFFER_STEPS,
} from "@wekruit/shared-tags"
import { z } from "zod"
import {
  MatchingJobSchema,
  type MatchingJob,
  type V16ScoreBreakdown,
  type V16HardFilterCounters,
  type V16QueryResult,
  type MatchedSkillContribution,
} from "../types.js"
import {
  V16_SCORE_WEIGHTS,
  V16_COMPANY_STAGE_WEIGHT,
  V16_SOFT_MISS_DEMERIT,
} from "../match-weights.js"
import { projectMatchingJobRow } from "./query-matching-jobs.js"
import { normalizeCompanyName } from "@pa/core-types"
import { getFlag, type FlagContext, type FlagValue } from "@pa/pa-persistence"
import { loadCompaniesByName, type LoadedCompanyInfo } from "../lib/load-companies.js"
import { loadRecommendedJobStates, type UserJobRecommendationState } from "../recommendation-state.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Source-of-truth Firestore collection for the v1.6 single-source read. */
const PA_USERS_COLLECTION = "pa-users"
const MATCHING_JOBS_COLLECTION = "matching-jobs"
const PA_JOBS_COLLECTION = "pa-jobs"
const ACTIVE_STATUS = "active"

/**
 * v1.6 fetch cap. 50 → 500 (D9) → 3000 (2026-05-28).
 *
 * The query pushes ONLY `roleFunction` to Firestore (array-contains-any) plus
 * `orderBy(firstSeenAt desc)`; location / visa / careerStage / jobType are
 * hard-filtered IN MEMORY over the fetched page (see applyV16HardFilters).
 * Firestore allows just one array-contains-any per query, so location can't
 * also be pushed down. That means the cap must be large enough that a role
 * bucket's freshest slice still contains a niche-location candidate's matches.
 *
 * The active pool grew ~6x (≈4k → ≈26k) after the 2026-05-28 enrichment-
 * backlog unlock. At 500 a location/visa-constrained candidate could see only
 * the 500 newest role-matching docs — a recency window that may exclude every
 * job in their city → recall collapse (the spec's own "filter-then-rank-low-
 * limit" anti-pattern, CLAUDE.md). 3000 keeps the in-memory location filter
 * fed across realistic role-bucket sizes at 26k. Read cost is negligible on
 * the low-QPS rec path; in-memory scoring still runs only over post-hard-
 * filter survivors. Robust follow-up (true fix for huge buckets): paginate
 * firstSeenAt-desc until enough post-filter survivors accumulate.
 */
const V16_FETCH_CAP = 3000

/**
 * Lean Firestore field projection for the bulk candidate scan (2026-05-30).
 *
 * The bulk fetch pulls up to V16_FETCH_CAP docs; the only field that's heavy is the 1536-float
 * `embedding` (~12KB/doc) — and the JD/quals/searchTokens text. Hard filters (location, careerStage,
 * freshness, …) + the cheap soft-score (skill jaccard, industry, tags, salary) need NONE of those.
 * `.select()`-ing only these light fields drops the scan from ~67MB to ~5MB (measured 3.9x faster,
 * and the difference between a 512MiB OOM and ~20MB). The embedding cosine still runs — but only on
 * the handful of HARD-FILTER SURVIVORS, whose embeddings are loaded afterward via a fieldMask getAll
 * (loadSurvivorEmbeddings). Every field below is read by projectMatchingJobRow / the v1.6 augment /
 * a hard filter / a cheap score component; missing one would silently change scoring, so the
 * select-vs-full comparison test (query-matching-jobs-v16.lean-fetch.test.ts) pins the list.
 */
const MATCH_LEAN_FIELDS = [
  "status", "roleFunction", "firstSeenAt", "lastSeenAt", "dead", "deadCheckedAt", "deadReason",
  "roleTitle", "jobTitle", "title", "companyName", "companySize",
  "salaryMax", "salaryMin", "locationRaw", "locationBuckets", "primaryUrl", "atsApplyUrl",
  "sponsorship", "jobType", "seniorityLevel",
  "requiredSkills", "industry", "industryKey", "industryEnum", "industrySector", "relevantTags",
] as const

/**
 * D10 freshness window: drop jobs whose `firstSeenAt` is more than this old.
 * `lastSeenAt` is intentionally NOT consulted — jobright re-scrape pattern
 * makes that field noise; the daily liveness sweep handles real death.
 */
const FRESHNESS_WINDOW_MS = 20 * 24 * 3600 * 1000

/**
 * Firestore `array-contains-any` cap. We cap user.targetRoleFunction to 10
 * even though the Firestore limit is 30 — most users have ≤3 role functions.
 */
const ROLE_FUNCTION_QUERY_CAP = 10

/**
 * `pa-user-rerank-cache/{userId}` stale window — when the cache was written
 * more than this long ago, treat as missing (llmMatch defaults to 0).
 * Phase 58 nightly batch refreshes daily.
 */
const LLM_RERANK_CACHE_STALE_MS = 36 * 3600 * 1000

const RERANK_CACHE_COLLECTION = "pa-user-rerank-cache"
const SKILL_JDREL_CACHE_COLLECTION = "pa-user-skill-jdrel-cache"
const require = createRequire(import.meta.url)

/**
 * SOFT-vs-HARD preference model (2026-05-28) — per-user feature flag.
 * Default OFF (perUser). When OFF the matcher is byte-identical to the
 * pre-2026-05-28 V16: `resolveHardness` is never consulted in a
 * behaviour-changing way, the company-stage component stays out of the
 * formula, and no soft-miss demerits or new hard gates run.
 */
export const PREFERENCE_HARDNESS_FLAG_KEY = "paPreferenceHardnessEnabled"

/** Signature of the injectable flag reader (mirrors `@pa/pa-persistence#getFlag`). */
export type V16FlagChecker = (
  key: string,
  ctx?: FlagContext,
  defaultValue?: FlagValue,
) => Promise<FlagValue>

// ---------------------------------------------------------------------------
// Helpers — title fallback (2026-05-19 hotfix)
// ---------------------------------------------------------------------------

/**
 * Schema drift: macmini scraper writes `roleTitle`; legacy / hand-seeded rows
 * carry `jobTitle`. `projectMatchingJobRow` already normalizes
 * `roleTitle → jobTitle` so V16's projected `MatchingJob` shape carries
 * `jobTitle`. This helper exists as defense-in-depth for any consumer that
 * bypasses the projector (admin debug paths, direct Firestore reads) or
 * regressions in the projection layer.
 *
 * Returns the displayable title, preferring the trimmed `jobTitle`, falling
 * back to the trimmed `roleTitle`, then to "". Treats null / undefined / ""
 * as missing — `??` alone would surface `""` and skip the fallback.
 */
export const getMatchingJobTitle = (
  j: { jobTitle?: string | null; roleTitle?: string | null }
): string => {
  const a = typeof j.jobTitle === "string" ? j.jobTitle.trim() : ""
  if (a.length > 0) return a
  const b = typeof j.roleTitle === "string" ? j.roleTitle.trim() : ""
  return b
}

function inferCareerStageFromTitle(title: string): CareerStage | null {
  const t = title.trim().toLowerCase()
  if (!t) return null
  if (/\bfounder\b/.test(t)) return "founder"
  if (/\b(c[-\s]?level|chief|cto|ceo|cfo|coo|cmo)\b/.test(t)) return "c_level"
  if (/\bvp|vice\s+president\b/.test(t)) return "vp"
  if (/\bdirector\b/.test(t)) return "director"
  if (/\bprincipal\b/.test(t)) return "principal"
  if (/\bstaff\b/.test(t)) return "staff"
  if (/\b(senior|sr\.?|lead|head\s+of)\b/.test(t)) return "senior"
  if (/\bmanager\b/.test(t)) return "manager"
  if (/\b(mid[-\s]?level|midlevel)\b/.test(t)) return "mid_level"
  if (/\b(junior|jr\.?)\b/.test(t)) return "junior"
  if (/\b(entry[-\s]?level|new\s+grad|graduate)\b/.test(t)) return "entry_level"
  if (/\bintern(ship)?\b/.test(t)) return "intern"
  if (/\bstudent\b/.test(t)) return "student"
  return null
}

function normalizeCareerStageToken(value: unknown): CareerStage | undefined {
  if (typeof value !== "string") return undefined
  const t = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if ((CAREER_STAGE_VOCAB as readonly string[]).includes(t)) return t as CareerStage
  switch (t) {
    case "entry":
    case "entrylevel":
    case "entry_level":
    case "newgrad":
    case "new_grad":
      return "entry_level"
    case "mid":
    case "midlevel":
    case "mid_level":
      return "mid_level"
    case "senior_level":
    case "sr":
      return "senior"
    case "c_level":
    case "clevel":
    case "executive":
      return "c_level"
    default:
      return undefined
  }
}

function firstWorkHistoryTitle(summary: unknown): string | undefined {
  if (typeof summary !== "string") return undefined
  const first = summary.split(";")[0]?.trim()
  return first && first.length > 0 ? first : undefined
}

function matchingCareerStageWindow(stage: CareerStage): CareerStage[] {
  if (stage !== "founder") return acceptableCareerStages(stage)
  return ["senior", "staff", "principal", "manager", "director", "vp", "c_level", "founder"]
}

/**
 * SOFT-vs-HARD (2026-05-28) — careerStage window widened by `bufferSteps`
 * extra ordinal tiers each side of the default ±1 window. `bufferSteps=0`
 * reduces to the default `matchingCareerStageWindow`. Used only when the
 * careerStage axis is SOFT under `paPreferenceHardnessEnabled`.
 */
function widenCareerStageWindow(stage: CareerStage, bufferSteps: number): CareerStage[] {
  const extra = Math.max(0, Math.floor(bufferSteps))
  if (extra === 0) return matchingCareerStageWindow(stage)
  // founder is a parallel senior+ band — widen from its base window by ordinal.
  const baseWindow = matchingCareerStageWindow(stage)
  if (stage === "founder") return baseWindow // already a wide executive band
  const userIdx = CAREER_STAGE_INDEX[stage]
  const widened = new Set<CareerStage>(baseWindow)
  for (const s of CAREER_STAGE_VOCAB) {
    if (Math.abs(CAREER_STAGE_INDEX[s] - userIdx) <= 1 + extra) widened.add(s)
  }
  return [...widened]
}

function workHistoryTitleSignals(summary: unknown): string[] {
  if (typeof summary !== "string") return []
  return summary
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.split("@")[0]?.trim() ?? "")
    .filter((item) => item.length > 0)
}

function dedupeRoleFunctions(values: ReadonlyArray<string>): RoleFunction[] {
  const seen = new Set<RoleFunction>()
  const out: RoleFunction[] = []
  for (const value of values) {
    if (typeof value !== "string") continue
    const token = value.trim().toLowerCase()
    if (
      token === "software_engineering" ||
      token === "engineering_and_development" ||
      token === "data_analysis" ||
      token === "product_management" ||
      token === "business_analyst" ||
      token === "creatives_and_design" ||
      token === "consultant" ||
      token === "accounting_and_finance" ||
      token === "marketing" ||
      token === "management_and_executive" ||
      token === "sales" ||
      token === "human_resources" ||
      token === "legal_and_compliance" ||
      token === "arts_and_entertainment" ||
      token === "education_and_training" ||
      token === "public_sector_and_government" ||
      token === "customer_service_and_support"
    ) {
      const role = token as RoleFunction
      if (!seen.has(role)) {
        seen.add(role)
        out.push(role)
      }
    }
  }
  return out
}

const PROFILE_ROLE_KEYWORDS: ReadonlyArray<{ pattern: RegExp; role: RoleFunction }> = [
  { pattern: /(data\s+(scientist|analyst|analytics|engineer|science)|analytics?\b|insights?\b|retention\s+analyst|funnel\s+analysis|cohort\s+analysis|research\s+(assistant|analyst|associate)|graduate\s+research|ml\s+engineer|machine\s+learning|ai\s+engineer|llm)/i, role: "data_analysis" },
  { pattern: /(\bpm\b|product\s+manager|product\s+management|tpm\b)/i, role: "product_management" },
  { pattern: /(business\s+(analyst|analysis)|\bba\b|executive\s+assistant|administrative\s+assistant|admin\s+assistant|office\s+manager|project\s+coordinator|operations?\s+(coordinator|assistant|analyst)|operations?[\w\s&/-]{0,40}\banalyst\b|program\s+(coordinator|operations))/i, role: "business_analyst" },
  { pattern: /(designer|design\b|\bux\b|\bui\b|product\s+designer|creative|illustrator)/i, role: "creatives_and_design" },
  { pattern: /(marketing|growth|brand|content\s+marketing|seo)/i, role: "marketing" },
  { pattern: /(human\s+resources|\bhr\b|recruiter|recruiting|talent\b)/i, role: "human_resources" },
  { pattern: /(teacher|teaching\s+assistant|professor|educator|tutor|tutoring|trainer\b)/i, role: "education_and_training" },
  { pattern: /(customer\s+(service|support|success)|support\s+engineer|it\s+support|retail|store\s+manager|restaurant|food\s+beverage|server\b|bakery)/i, role: "customer_service_and_support" },
  { pattern: /(sales|account\s+(manager|exec|executive)|client\s+account|retail|store\s+manager|\bae\b|\bbd\b|business\s+development)/i, role: "sales" },
  { pattern: /(store\s+manager|assistant\s+store\s+manager|team\s+lead|general\s+manager)/i, role: "management_and_executive" },
  { pattern: /(swe|software\s+engineer|software\s+dev|software\s+development|frontend|backend|fullstack|developer|web\s+developer|mobile\s+developer)/i, role: "software_engineering" },
]

function mapProfileTextToRoleFunctions(text: string): RoleFunction[] {
  const out: RoleFunction[] = []
  for (const { pattern, role } of PROFILE_ROLE_KEYWORDS) {
    if (pattern.test(text) && !out.includes(role)) out.push(role)
  }
  return out
}

const STRONG_DATA_ROLE_TITLE_RE =
  /\b(data\s+(scientist|analyst|analytics|engineer|science)|analytics?\s+(analyst|engineer|manager)|retention\s+analyst|funnel\s+analysis|cohort\s+analysis|research\s+(assistant|analyst|associate)|graduate\s+research|ml\s+engineer|machine\s+learning|ai\s+engineer|llm)\b/i

function currentTitleNarrowsHistoricalDataInference(currentRoles: RoleFunction[]): boolean {
  const narrowCurrentRole =
    currentRoles.includes("sales") ||
    currentRoles.includes("customer_service_and_support") ||
    currentRoles.includes("management_and_executive")
  return narrowCurrentRole && !currentRoles.includes("data_analysis") && !currentRoles.includes("business_analyst")
}

function inferTargetRoleFunctionsFromProfile(tags: UserTags): RoleFunction[] {
  const currentTitle = typeof tags.recentRoleTitle === "string" ? tags.recentRoleTitle : undefined
  const currentRoles = currentTitle ? mapProfileTextToRoleFunctions(currentTitle) : []
  const historicalTitles = workHistoryTitleSignals(tags.workHistorySummary)
    .filter((title) => title !== currentTitle)
  const historicalRoles = historicalTitles.flatMap((title) => mapProfileTextToRoleFunctions(title))
  const mapped = [...currentRoles, ...historicalRoles]
  if (
    currentTitleNarrowsHistoricalDataInference(currentRoles) &&
    !historicalTitles.some((title) => STRONG_DATA_ROLE_TITLE_RE.test(title))
  ) {
    return dedupeRoleFunctions(mapped.filter((role) => role !== "data_analysis"))
  }
  return dedupeRoleFunctions(mapped)
}

function profileTitleText(tags: UserTags): string {
  return [
    typeof tags.recentRoleTitle === "string" ? tags.recentRoleTitle : undefined,
    ...workHistoryTitleSignals(tags.workHistorySummary),
  ].filter((part): part is string => Boolean(part)).join(" ")
}

function profileLooksOperationsAnalyst(tags: UserTags): boolean {
  return /\b(operations?[\w\s&/-]{0,50}\banalyst\b|growth\s+operations|retention\s+analyst)\b/i.test(profileTitleText(tags))
}

function explicitEngineeringIntentText(tags: UserTags): string {
  const targetRole = (tags as unknown as { targetRole?: unknown }).targetRole
  const parts = Array.isArray(targetRole) ? targetRole : [targetRole]
  return parts.map((part) => (typeof part === "string" ? part : "")).join(" ")
}

function shouldPruneStaleEngineeringAxis(
  tags: UserTags,
  existing: RoleFunction[],
  inferred: RoleFunction[],
): boolean {
  const hasEngineeringAxis =
    existing.includes("software_engineering") || existing.includes("engineering_and_development")
  if (!hasEngineeringAxis || existing.length <= 1) return false
  if (inferred.every((role) => role === "software_engineering" || role === "engineering_and_development")) return false
  if (titleLooksEngineering(profileTitleText(tags))) return false
  if (titleLooksEngineering(explicitEngineeringIntentText(tags))) return false
  return true
}

const TITLE_AUTHORITATIVE_ROLE_REPAIRS = new Set<RoleFunction>([
  "human_resources",
  "education_and_training",
  "creatives_and_design",
  "customer_service_and_support",
])

function repairMisalignedTargetRoleFunctions(
  tags: UserTags,
): UserTags["targetRoleFunction"] | undefined {
  const inferred = inferTargetRoleFunctionsFromProfile(tags)
  if (inferred.length === 0) return undefined
  const existing = dedupeRoleFunctions(Array.isArray(tags.targetRoleFunction) ? tags.targetRoleFunction : [])
  if (existing.length === 0) return inferred
  if (inferred.some((role) => existing.includes(role))) {
    if (shouldPruneStaleEngineeringAxis(tags, existing, inferred)) {
      return existing.filter((role) => role !== "software_engineering" && role !== "engineering_and_development")
    }
    if (profileLooksOperationsAnalyst(tags)) {
      const missingOperationalRoles = inferred.filter((role) =>
        (role === "business_analyst" || role === "data_analysis") && !existing.includes(role)
      )
      if (missingOperationalRoles.length > 0) return dedupeRoleFunctions([...existing, ...missingOperationalRoles])
    }
    return undefined
  }

  // Preserve explicit career-change intent into engineering. A PM/HR/designer
  // resume can still target SWE when the conversation says so; only repair
  // stale non-engineering role axes that conflict with a high-confidence title.
  if (existing.includes("software_engineering") || existing.includes("engineering_and_development")) {
    return undefined
  }
  const authoritative = inferred.filter((role) => TITLE_AUTHORITATIVE_ROLE_REPAIRS.has(role))
  return authoritative.length > 0 ? authoritative : undefined
}

function derivedSeniorityToCareerStage(value: unknown): CareerStage | undefined {
  switch (value) {
    case "intern":
      return "intern"
    case "new_grad":
    case "entry_level":
      return "entry_level"
    case "mid":
      return "mid_level"
    case "senior":
      return "senior"
    case "staff":
      return "staff"
    case "manager":
      return "manager"
    case "director":
      return "director"
    case "executive":
      return "c_level"
    default:
      return undefined
  }
}

function inferCareerStageFromYears(value: unknown): CareerStage | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  if (value <= 0.5) return "student"
  if (value <= 1.5) return "entry_level"
  if (value <= 3) return "junior"
  if (value <= 6) return "mid_level"
  return "senior"
}

function inferCandidateCareerStage(
  tags: UserTags,
  userDoc: Record<string, unknown> | undefined
): CareerStage | undefined {
  const titleSignals = [
    typeof tags.recentRoleTitle === "string" ? tags.recentRoleTitle : undefined,
    firstWorkHistoryTitle(tags.workHistorySummary),
  ].filter((title): title is string => Boolean(title))
  for (const title of titleSignals) {
    const stage = inferCareerStageFromTitle(title)
    if (stage) return stage
  }

  const derivedExperience =
    userDoc?.derivedExperience && typeof userDoc.derivedExperience === "object"
      ? (userDoc.derivedExperience as Record<string, unknown>)
      : undefined
  const derivedStage = derivedSeniorityToCareerStage(derivedExperience?.seniorityCurrent)
  if (derivedStage) return derivedStage
  return inferCareerStageFromYears(derivedExperience?.yearsTotal ?? userDoc?.totalYearsExperience)
}

/**
 * Live-bug fix (2026-05-29): a candidate's RÉSUMÉ saying "Software Engineer
 * Intern" must NOT set `targetJobType=['internship']`. Target job type is an
 * INTENT field (what you want next), not a HISTORY field (what you did). The
 * candidate who interned last summer is overwhelmingly targeting full-time
 * roles. Inferring `internship` from a résumé title (or a careerStage that was
 * itself title-inferred) drops every full-time job at the jobType hard gate →
 * recCount=0. This mirrors the merger-side Rule 1 fix so neither layer
 * re-injects a résumé-derived internship target.
 *
 * The narrow safe inference that survives: an `entry_level` candidate gets the
 * broad early-career target `['full_time', 'new_graduate']` (no `internship`,
 * which would hard-drop full-time inventory). Everything else → `undefined`
 * (no jobType constraint at all, which the hard gate no-ops on).
 */
function inferTargetJobTypeFromProfile(_tags: UserTags, careerStage: CareerStage | undefined): UserTags["targetJobType"] {
  if (careerStage === "entry_level") return ["full_time", "new_graduate"]
  return undefined
}

function inferMissingMatchingAxes(
  tags: UserTags,
  userDoc: Record<string, unknown> | undefined,
  log?: (event: string, payload?: Record<string, unknown>) => void,
  userId?: string,
): UserTags {
  const patch: Partial<UserTags> = {}
  const targetRoleFunction = repairMisalignedTargetRoleFunctions(tags)
  if (targetRoleFunction?.length) patch.targetRoleFunction = targetRoleFunction
  const careerStage =
    typeof tags.careerStage === "string" && (CAREER_STAGE_VOCAB as readonly string[]).includes(tags.careerStage)
      ? tags.careerStage
      : inferCandidateCareerStage(tags, userDoc)
  if (!tags.careerStage && careerStage) patch.careerStage = careerStage
  if (!tags.targetJobType?.length) {
    const targetJobType = inferTargetJobTypeFromProfile(tags, careerStage)
    if (targetJobType?.length) patch.targetJobType = targetJobType
  }
  if (Object.keys(patch).length === 0) return tags
  log?.("pa.match.user_tags_inferred_missing_axes", { userId, inferred: patch })
  return { ...tags, ...patch }
}

function targetRoleFunctionSet(userTags: UserTags): Set<string> {
  const roles: unknown[] = Array.isArray(userTags.targetRoleFunction) ? userTags.targetRoleFunction : []
  return new Set(
    roles
      .map((role) => (typeof role === "string" ? role.trim().toLowerCase() : ""))
      .filter(Boolean)
  )
}

function titleLooksEngineering(title: string): boolean {
  const t = title.trim().toLowerCase()
  if (!t) return false
  return (
    /\b(swe|sde|software\s+engineer|software\s+developer|full[\s-]?stack|frontend|front[\s-]?end|backend|back[\s-]?end)\b/.test(t) ||
    /\b(engineer|engineers|engineering|developer|developers|devops|sre|site\s+reliability|platform\s+engineer|infrastructure\s+engineer)\b/.test(t)
  )
}

function profileRoleIntentText(userTags: UserTags): string {
  return `${profileTitleText(userTags)} ${explicitEngineeringIntentText(userTags)}`.toLowerCase()
}

function titleAllowedByExplicitNonSoftwareTarget(title: string, targetRoles: Set<string>, userTags: UserTags): boolean {
  const t = title.trim().toLowerCase()
  const intent = profileRoleIntentText(userTags)
  if (targetRoles.has("data_analysis") && /\b(data|analytics?|ml|machine\s+learning|ai)\s+engineer(s)?\b/.test(t)) {
    return /\b(data|analytics?|ml|machine\s+learning|ai)\s+engineer\b/.test(intent)
  }
  if (targetRoles.has("sales") && /\b(sales|solutions?|solution|pre[-\s]?sales)\s+engineer(s)?\b/.test(t)) {
    return /\b(sales|solutions?|solution|pre[-\s]?sales)\s+engineer\b/.test(intent)
  }
  if (targetRoles.has("customer_service_and_support") && /\b(success|support)\s+engineer(s)?\b/.test(t)) {
    return /\b(it\s+support|technical\s+support|support\s+(engineer|consultant|specialist|analyst))\b/.test(intent)
  }
  if (targetRoles.has("customer_service_and_support") && /\bit\s+systems?\s+administrator\b/.test(t)) {
    return true
  }
  return false
}

function titleLooksLegal(title: string): boolean {
  const t = title.trim().toLowerCase()
  return /\b(counsel|attorney|lawyer|paralegal)\b/.test(t)
}

function titleLooksClinical(title: string): boolean {
  const t = title.trim().toLowerCase()
  return /\b(medical\s+fellow|clinical\s+fellow|physician|doctor|nurse|surgeon|medical\s+director)\b/.test(t)
}

function userHasHealthcareSignal(userTags: UserTags): boolean {
  const values = [
    userTags.industryEnum,
    userTags.relevantIndustry,
    userTags.relevantSpecialization,
    userTags.recentRoleTitle,
    userTags.workHistorySummary,
  ]
  return values.some((value) => {
    const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
    return list.some((item) => /health|medical|clinical|biotech|pharma|life\s*sciences/i.test(String(item)))
  })
}

function isRoleTitleMismatch(userTags: UserTags, job: MatchingJob): boolean {
  const targetRoles = targetRoleFunctionSet(userTags)
  if (targetRoles.size === 0) return false
  const title = getMatchingJobTitle(job)
  if (titleLooksLegal(title) && !targetRoles.has("legal_and_compliance")) return true
  if (titleLooksClinical(title) && !userHasHealthcareSignal(userTags)) return true
  if (!titleLooksEngineering(title)) return false
  if (targetRoles.has("software_engineering") || targetRoles.has("engineering_and_development")) return false
  return !titleAllowedByExplicitNonSoftwareTarget(title, targetRoles, userTags)
}

/**
 * Compute the onboarding gaps that must block matching.
 *
 * Product directive (2026-05-28, Adam — "如果没写就不做 match 标准"): a field the
 * candidate never provided must NOT become a matching criterion and must NOT
 * flag the user as incomplete. Empirically ~99% of résumé-having users have no
 * `visaStatus` (résumés don't state work authorization) and many lack an
 * explicit `targetLocations`; flagging those as `needsOnboarding` wrongly
 * diverted nearly every user away from receiving recommendations.
 *
 * Therefore `targetRoleFunction` is the ONLY true-required axis: without it the
 * role hard filter has nothing to match against and matching is meaningless
 * (V16 early-returns empty when it is absent). Every other axis is optional —
 * its hard filter already no-ops when the user signal is absent
 * (`isSponsorshipNeeded` only fires on `sponsor_needed`; the location intersect
 * only fires when `targetLocations.length > 0`; careerStage/jobType only fire
 * when present). Optional gaps therefore neither block nor set `needsOnboarding`.
 */
function buildMissingAxes(userTags: UserTags): V16QueryResult["missingAxes"] {
  const missingAxes: V16QueryResult["missingAxes"] = []
  if (!userTags.targetRoleFunction?.length) missingAxes!.push("targetRoleFunction")
  return missingAxes
}

// ---------------------------------------------------------------------------
// loadUserTags — single-source read (MATCH-01 / D8)
// ---------------------------------------------------------------------------

/**
 * Read `pa-users/{userId}.tags` — the unified canonical projection (Phase
 * 54 single-source contract). Returns `null` when the doc is missing OR
 * `tags` field is empty (caller should short-circuit to empty result).
 *
 * NO reads from legacy fragmented sources:
 *   - `pa-users.statedPreferences` (DEPRECATED — covered by tags.targetRole + visaStatus)
 *   - `parsedCandidateResumes.industryTags` (DEPRECATED — covered by tags.industrySector)
 *   - `parsedCandidateResumes.topSkills` (DEPRECATED — covered by tags.skills)
 *
 * Pure I/O wrapper — failure-tolerant: on Firestore error returns `null`
 * (caller surfaces as `noUserTags: true`). Errors bubble up to Cloud Logging
 * via the optional `log` arg.
 */
export async function loadUserTags(
  db: Firestore,
  userId: string,
  log?: (event: string, payload?: Record<string, unknown>) => void
): Promise<UserTags | null> {
  if (!userId || typeof userId !== "string") {
    log?.("pa.match.invalid_user_id", { userId })
    return null
  }
  try {
    const doc = await db.collection(PA_USERS_COLLECTION).doc(userId).get()
    if (!doc.exists) {
      log?.("pa.match.user_no_tags", { userId, reason: "doc_missing" })
      return null
    }
    const data = doc.data()
    const tags = data?.tags
    if (!tags || typeof tags !== "object" || Object.keys(tags).length === 0) {
      log?.("pa.match.user_no_tags", { userId, reason: "tags_empty" })
      return null
    }
    return inferMissingMatchingAxes(tags as UserTags, data, log, userId)
  } catch (err) {
    log?.("pa.match.user_tags_read_error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// ---------------------------------------------------------------------------
// Cache readers (graceful degradation, MATCH-06)
// ---------------------------------------------------------------------------

/**
 * Read `pa-user-skill-jdrel-cache/{userId}/jobs/*` — Phase 58 nightly batch
 * writes per-job JD-relative skill weights. Missing → empty Map (skill
 * Jaccard degrades to base × 1.0 = plain weighted Jaccard).
 *
 * Map key: jobId. Map value: `Record<skillKey, jdRelativeWeight>` where
 * skillKey is the skill `name` lowercased + spaces→underscores.
 */
export async function loadJdRelCache(
  db: Firestore,
  userId: string,
  log?: (event: string, payload?: Record<string, unknown>) => void
): Promise<Map<string, Record<string, number>>> {
  const m = new Map<string, Record<string, number>>()
  if (!userId) return m
  try {
    // Subcollection layout: pa-user-skill-jdrel-cache/{userId}/jobs/{jobId}
    const snap = await db
      .collection(SKILL_JDREL_CACHE_COLLECTION)
      .doc(userId)
      .collection("jobs")
      .limit(V16_FETCH_CAP)
      .get()
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>
      const w = data?.jdRelativeWeights
      if (w && typeof w === "object" && !Array.isArray(w)) {
        // Sanitize: keep only numeric values
        const clean: Record<string, number> = {}
        for (const [k, v] of Object.entries(w as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isFinite(v)) clean[k] = v
        }
        if (Object.keys(clean).length > 0) m.set(doc.id, clean)
      }
    }
  } catch (err) {
    log?.("pa.match.jdrel_cache_miss", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return m
}

/**
 * Read `pa-user-rerank-cache/{userId}` — Phase 58 nightly LLM rerank cache.
 * Returns `{map, stale}` where:
 *   - `map`: jobId → llmScore (∈ [0, 1])
 *   - `stale`: true when cache `computedAt` is older than 36h
 *
 * On stale: empty map returned (llmMatch component contributes 0); flag
 * surfaced to dashboards via `V16QueryResult.llmCacheStale`.
 */
export async function loadLlmRerankCache(
  db: Firestore,
  userId: string,
  log?: (event: string, payload?: Record<string, unknown>) => void
): Promise<{ map: Map<string, number>; stale: boolean }> {
  const m = new Map<string, number>()
  if (!userId) return { map: m, stale: false }
  try {
    const doc = await db.collection(RERANK_CACHE_COLLECTION).doc(userId).get()
    if (!doc.exists) {
      return { map: m, stale: false }
    }
    const data = doc.data() as Record<string, unknown>
    const computedAtRaw = data?.computedAt
    let computedAtMs = 0
    if (typeof computedAtRaw === "string") {
      const t = Date.parse(computedAtRaw)
      if (Number.isFinite(t)) computedAtMs = t
    } else if (
      computedAtRaw &&
      typeof computedAtRaw === "object" &&
      typeof (computedAtRaw as { toDate?: () => Date }).toDate === "function"
    ) {
      try {
        const d = (computedAtRaw as { toDate: () => Date }).toDate()
        if (d instanceof Date) computedAtMs = d.getTime()
      } catch {
        // ignore — treat as 0 → stale
      }
    }
    const age = Date.now() - computedAtMs
    if (computedAtMs === 0 || age > LLM_RERANK_CACHE_STALE_MS) {
      log?.("pa.match.llm_cache_stale", { userId, ageMs: age })
      return { map: m, stale: true }
    }
    const ranked = Array.isArray(data?.ranked) ? (data.ranked as Array<unknown>) : []
    for (const item of ranked) {
      if (!item || typeof item !== "object") continue
      const r = item as Record<string, unknown>
      if (typeof r.jobId === "string" && typeof r.llmScore === "number" && Number.isFinite(r.llmScore)) {
        m.set(r.jobId, Math.max(0, Math.min(1, r.llmScore)))
      }
    }
    return { map: m, stale: false }
  } catch (err) {
    log?.("pa.match.llm_cache_miss", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { map: m, stale: false }
  }
}

// ---------------------------------------------------------------------------
// Hard post-filter chain (MATCH-04)
// ---------------------------------------------------------------------------

/**
 * Normalize a skill name to a canonical key for lookup against
 * `jdRelativeWeights` (which uses lowercased + underscored keys). Mirrors
 * the Phase 58 cache writer normalization.
 */
function skillKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_")
}

/**
 * Coerce a Firestore timestamp-ish value to ms-since-epoch. Accepts ISO
 * strings, Firestore Timestamp objects (`.toDate()` or `{seconds,nanos}`),
 * or numeric ms. Returns `0` when unparseable.
 */
function timestampToMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : 0
  }
  if (v && typeof v === "object") {
    const obj = v as { toDate?: () => Date; seconds?: number; nanoseconds?: number }
    if (typeof obj.toDate === "function") {
      try {
        const d = obj.toDate()
        if (d instanceof Date) return d.getTime()
      } catch {
        return 0
      }
    }
    if (typeof obj.seconds === "number" && Number.isFinite(obj.seconds)) {
      const ns = typeof obj.nanoseconds === "number" ? obj.nanoseconds : 0
      return obj.seconds * 1000 + Math.floor(ns / 1_000_000)
    }
  }
  return 0
}

/**
 * Map a `tags.visaStatus` token to v1.6 canonical (TAG-04, D4). The merger
 * stores `sponsor_needed` already; this pass handles legacy migration shapes.
 */
function isSponsorshipNeeded(visaStatus: string | undefined): boolean {
  if (!visaStatus) return false
  return visaStatus === "sponsor_needed" || visaStatus === "sponsorship_needed"
}

/**
 * Anywhere bypass tokens (location intersect skipped when present in user).
 *
 * Recall fix (2026-05-29): `remote` is added so a user who said "open to
 * remote" (captured as `targetLocations=['remote']`) bypasses the metro
 * intersect the same way an explicit `anywhere` token does. `remote_anywhere`
 * was already present (job-side anywhere bypass). The US-only platform gate
 * (`jobIsForeignNonUs`) still runs even when a token here matches, so a
 * region-locked non-US role is never leaked regardless of the user's tokens.
 */
const ANYWHERE_LOCATION_TOKENS = new Set([
  "remote_anywhere",
  "remote_global",
  "remote",
  "anywhere",
  "any",
])

/**
 * Country-level US tokens. US-only is the universal platform default (Adam 2026-05-30), so a target
 * made up ONLY of these (e.g. a candidate who said "anywhere in the US" → captured `["united_states"]`,
 * or a capture that overwrote cities with a country token) carries NO metro sub-constraint — it must
 * NOT zero a candidate via the metro intersect. Treated as anywhere-within-US in `isAnywhereLocation`.
 * These are USER-side only (a JOB tagged "us" is still a concrete US location, not global-remote).
 */
const US_COUNTRY_LOCATION_TOKENS = new Set([
  "us", "usa", "u.s.", "u.s", "united_states", "united states", "united_states_of_america",
  "america", "remote_us", "remote_united_states",
])

/**
 * True when the user has NO location constraint that would block roles: an
 * empty `targetLocations` ("open to anything") OR an explicit anywhere/remote
 * token. Mirrors the `isAnywhere` computation inside `applyV16HardFilters` so
 * the careerStage relax ladder only fires for candidates whose location isn't
 * the real blocker.
 */
function isAnywhereLocation(tags: UserTags): boolean {
  const targetLocations = Array.isArray(tags.targetLocations)
    ? tags.targetLocations.filter((l): l is string => typeof l === "string")
    : []
  if (targetLocations.length === 0) return true
  if (targetLocations.some((l) => ANYWHERE_LOCATION_TOKENS.has(l.trim().toLowerCase()))) return true
  // US-only platform: a target composed ONLY of country-level US / anywhere tokens carries no metro
  // sub-constraint → anywhere-within-US (don't run the metro intersect). A specific metro mixed in
  // (e.g. "new_york_metro") is a real constraint and is respected.
  return targetLocations.every(
    (l) =>
      US_COUNTRY_LOCATION_TOKENS.has(l.trim().toLowerCase()) ||
      ANYWHERE_LOCATION_TOKENS.has(l.trim().toLowerCase()),
  )
}

/**
 * UNAMBIGUOUS non-US 2-letter country codes (the form scraped `locationRaw` uses, e.g. spate:
 * "RS / RO / MD / BY / PL / CZ / HU / BG / SK / Remote"). Deliberately EXCLUDES codes that collide
 * with US state abbreviations — CA (California≠Canada), MD (Maryland), DE (Delaware), IN (Indiana),
 * GA, LA, MA, MO, OR, OK, etc. — so a US locationRaw is never mis-read as foreign. Canada/those
 * countries are still caught by the full-name hints in isJobRegionLockedNonUs.
 */
const NON_US_COUNTRY_CODES_2 = new Set([
  "rs", "ro", "by", "pl", "cz", "hu", "bg", "sk", "ua", "gb", "uk", "fr", "es", "it", "nl", "ie",
  "cn", "jp", "kr", "sg", "au", "br", "mx", "ar", "hk", "pt", "gr", "lt", "lv", "ee", "si", "hr",
  "ng", "ke", "za", "ae", "il", "tr", "ph", "vn", "th", "my", "rs", "cl", "co", "pe", "uy",
])

/**
 * A job tagged remote_anywhere whose `locationRaw` clearly names a specific NON-US region (and no US
 * signal) is region-LOCKED, not globally remote — its anywhere-bypass must be revoked so a US/city
 * candidate doesn't match it (locked 2026-05-30: "matcher cross-checks locationRaw"; spate is
 * remote_anywhere but RS/RO/MD/BY/PL/CZ/HU/BG/SK = Eastern Europe only). Conservative: fires only
 * when a non-US signal is present AND no US signal — a generic "Remote"/"Worldwide" raw stays global.
 */
function isJobRegionLockedNonUs(job: MatchingJob): boolean {
  const raw = (job.locationRaw ?? "").toLowerCase()
  if (!raw) return false
  const tokens = raw.split(/[/,;|]+/).map((t) => t.trim()).filter(Boolean)
  let nonUs = false
  let us = false
  const US_NAME_HINTS = ["united states", "u.s.", "usa", "u.s.a"]
  const US_REGION_HINTS = ["san francisco", "new york", "seattle", "los angeles", "boston", "chicago", "austin", "denver", "remote us", "remote united states"]
  const NON_US_NAME_HINTS = [
    "bulgaria", "serbia", "romania", "moldova", "belarus", "poland", "czech", "hungary", "slovakia",
    "ukraine", "london", "united kingdom", "england", "ireland", "germany", "france", "spain", "india",
    "china", "singapore", "japan", "korea", "australia", "brazil", "mexico", "argentina", "canada",
    "netherlands", "amsterdam", "hong kong", "philippines", "vietnam", "thailand", "turkey", "israel",
  ]
  for (const tok of tokens) {
    if (tok === "us" || tok === "usa" || US_NAME_HINTS.some((h) => tok.includes(h))) us = true
    if (US_REGION_HINTS.some((h) => tok.includes(h))) us = true
    if (NON_US_COUNTRY_CODES_2.has(tok)) nonUs = true
    if (NON_US_NAME_HINTS.some((h) => tok.includes(h))) nonUs = true
  }
  return nonUs && !us
}

/**
 * US-ONLY PLATFORM (Adam 2026-05-30): "by default it will always be US only … any scope outside of US
 * we don't consider right now … Remote anywhere is considered as within US too." WeKruit serves US
 * roles only, so a job region-locked to a NON-US country is dropped for EVERY candidate — US-only is
 * the universal default, no `targetCountry` signal required. `remote_anywhere` / global-remote COUNTS
 * AS US-accessible and is NEVER dropped for being remote; only a job whose location clearly names a
 * specific foreign region with no US presence is foreign (e.g. spate = remote_anywhere tagged but
 * locationRaw "RS/RO/MD/BY/PL/CZ/HU/BG/SK" = Eastern Europe). Returns true ⇒ drop this job.
 */
const US_BUCKET_METROS = [
  "san_francisco_bay_area", "new_york_metro", "new_york_city_metro",
  "seattle_metro", "los_angeles_metro", "boston_metro", "chicago_metro",
  "austin_metro", "denver_metro",
] as const
const US_BUCKET_EXACT = new Set(["us", "usa", "united_states", "remote_united_states", "remote_us"])
const NON_US_BUCKET_HINTS = [
  "bulgaria", "sofia", "london", "uk", "united_kingdom", "england", "ireland", "dublin",
  "germany", "berlin", "munich", "france", "paris", "spain", "madrid",
  "india", "bangalore", "hyderabad", "mumbai", "delhi", "pune",
  "china", "beijing", "shanghai", "singapore", "japan", "tokyo", "korea", "seoul",
  "australia", "sydney", "melbourne", "brazil", "mexico", "argentina",
  "canada", "toronto", "vancouver", "montreal",
  "ukraine", "poland", "warsaw", "netherlands", "amsterdam", "hong_kong",
]
function jobIsForeignNonUs(job: MatchingJob): boolean {
  const buckets = Array.isArray(job.locationBuckets)
    ? job.locationBuckets.map((b) => String(b).toLowerCase())
    : []
  const hasAnywhere = buckets.some((b) => ANYWHERE_LOCATION_TOKENS.has(b))
  const hasUsBucket =
    buckets.some((b) => US_BUCKET_EXACT.has(b) || US_BUCKET_METROS.some((u) => b.includes(u)))
  const hasForeignBucket = buckets.some((b) => NON_US_BUCKET_HINTS.some((c) => b.includes(c)))
  // Foreign-only bucket set (a non-US city/country, no US bucket, no global-remote escape) → foreign.
  // remote_anywhere alone is NOT a foreign hint, so a globally-remote role survives (= US-accessible).
  if (hasForeignBucket && !hasUsBucket && !hasAnywhere) return true
  // remote_anywhere / US-looking buckets but a locationRaw region-locked to a specific foreign region.
  if (isJobRegionLockedNonUs(job)) return true
  return false
}

// ---------------------------------------------------------------------------
// SOFT-vs-HARD preference model (2026-05-28)
//
// `resolveHardness` is the single pure reader: it returns the per-axis
// hardness entry from `tags.preferenceHardness[axis]`, falling back to
// `DEFAULT_HARDNESS` (which encodes CURRENT ranking). All hard/soft branching
// in the filter + scorer flows through it. The whole subsystem is gated by
// `paPreferenceHardnessEnabled` at the call site — when the flag is OFF the
// matcher never calls these helpers in a behaviour-changing way (the company-
// stage component stays out of the formula, the soft-miss demerits are never
// computed, and every existing hard gate runs exactly as before).
// ---------------------------------------------------------------------------

/**
 * Pure reader — resolve the effective hardness entry for an axis. Reads
 * `tags.preferenceHardness[axis]`; falls back to `DEFAULT_HARDNESS[axis]`
 * when unset. Backfills the spec-locked default buffers when the entry omits
 * them (salary→0.10, ordinal→1) so downstream math always has a number.
 */
export function resolveHardness(
  tags: UserTags,
  axis: HardnessAxis,
): { hardness: "hard" | "soft"; bufferPct: number; bufferSteps: number } {
  const fallback = DEFAULT_HARDNESS[axis]
  const ph = (tags as { preferenceHardness?: Record<string, PreferenceHardnessEntry | undefined> })
    .preferenceHardness
  const entry: PreferenceHardnessEntry = ph?.[axis] ?? fallback
  const bufferPct =
    typeof entry.bufferPct === "number" && Number.isFinite(entry.bufferPct)
      ? entry.bufferPct
      : (typeof fallback.bufferPct === "number" ? fallback.bufferPct : DEFAULT_SALARY_BUFFER_PCT)
  const bufferSteps =
    typeof entry.bufferSteps === "number" && Number.isFinite(entry.bufferSteps)
      ? entry.bufferSteps
      : (typeof fallback.bufferSteps === "number" ? fallback.bufferSteps : DEFAULT_ORDINAL_BUFFER_STEPS)
  return { hardness: entry.hardness, bufferPct, bufferSteps }
}

/**
 * §3.3 — ordinal company-stage scale (fundable stages only). Non-fundable
 * stages (`bootstrapped`, `non_profit`, `unknown`) are intentionally absent
 * → they have no ordinal position → treated as "no signal" (fit 0.5, never a
 * hard drop). Order: pre_seed < seed < series_a < ... < private_mature.
 */
const COMPANY_STAGE_ORDINAL: ReadonlyArray<CompanyStage> = [
  "pre_seed",
  "seed",
  "series_a",
  "series_b",
  "series_c",
  "series_d_plus",
  "ipo_public",
  "private_mature",
]

function companyStageIndex(stage: CompanyStage | undefined | null): number | null {
  if (!stage) return null
  const i = COMPANY_STAGE_ORDINAL.indexOf(stage)
  return i >= 0 ? i : null
}

/**
 * §3.3 — map the user's company-size / startup preference into a target band
 * of ordinal stage indices. Returns `null` when the user has no usable
 * preference (→ companyStageFit = 0.5 neutral, never a drop). Mirrors the
 * existing `companyMatchesStrictPreference` stage→preference mapping, but
 * expressed as an index band so the buffer-steps tolerance is uniform.
 */
/** Company-size tokens that mean "no constraint" (not a real band). */
const COMPANY_SIZE_NO_CONSTRAINT = new Set(["open", "no_preference", "any", "unknown"])

/**
 * Normalize `tags.companySize` (scalar OR array — OR logic, Adam 2026-05-30) to a clean list of
 * real size tokens. "small team or big tech" → ["early_startup","enterprise"]. Drops the
 * no-constraint tokens (open/any). Back-compat: a legacy scalar companySize → single-element list.
 */
function companySizeList(tags: UserTags): string[] {
  const cs = (tags as { companySize?: unknown }).companySize
  const arr = Array.isArray(cs) ? cs : typeof cs === "string" ? [cs] : []
  return arr
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && !COMPANY_SIZE_NO_CONSTRAINT.has(s))
}

function bandForSize(size: string, idx: (s: CompanyStage) => number): { min: number; max: number } | null {
  switch (size) {
    case "seed":
      return { min: idx("pre_seed"), max: idx("seed") }
    case "early_startup":
      return { min: idx("pre_seed"), max: idx("series_a") }
    case "scale_up":
      return { min: idx("series_b"), max: idx("series_d_plus") }
    case "mid_market":
      return { min: idx("series_c"), max: idx("private_mature") }
    case "enterprise":
      return { min: idx("ipo_public"), max: idx("private_mature") }
    default:
      return null
  }
}

/**
 * §3.3 — the user's company-size preference as a SET of ordinal bands (OR logic). A candidate who
 * said "small team or big tech" has two disjoint bands; a job's stage matches if it falls in ANY of
 * them (never a single spanning band, which would wrongly include the gap). Empty → no preference
 * (companyStageFit = 0.5 neutral, never a drop). Falls back to the boolean startup/bigtech pref.
 */
function userCompanyStageBands(tags: UserTags): Array<{ min: number; max: number }> {
  const idx = (s: CompanyStage): number => COMPANY_STAGE_ORDINAL.indexOf(s)
  const bands = companySizeList(tags)
    .map((s) => bandForSize(s, idx))
    .filter((b): b is { min: number; max: number } => b !== null)
  if (bands.length > 0) return bands
  if (tags.prefersStartup === "startup") return [{ min: idx("pre_seed"), max: idx("series_b") }]
  if (tags.prefersStartup === "bigtech") return [{ min: idx("ipo_public"), max: idx("private_mature") }]
  return []
}

/**
 * §3.3 — companyStageFit ∈ {1.0, 0.6, 0.2, 0.5}.
 *   - in-band               → 1.0
 *   - within `bufferSteps`  → 0.6
 *   - outside band+buffer   → 0.2
 *   - no preference / stage unknown / non-ordinal stage → 0.5 (neutral)
 */
export function computeCompanyStageFit(
  tags: UserTags,
  companyStage: CompanyStage | undefined | null,
  bufferSteps: number,
): number {
  const bands = userCompanyStageBands(tags)
  if (bands.length === 0) return 0.5
  const stageIdx = companyStageIndex(companyStage)
  if (stageIdx === null) return 0.5 // unknown / non-fundable stage → neutral
  // OR over the user's size bands — take the BEST fit (a job in ANY preferred band scores 1.0).
  let best = 0.2
  for (const band of bands) {
    if (stageIdx >= band.min && stageIdx <= band.max) return 1.0
    const dist = stageIdx < band.min ? band.min - stageIdx : stageIdx - band.max
    if (dist <= Math.max(0, bufferSteps)) best = Math.max(best, 0.6)
  }
  return best
}

// ---------------------------------------------------------------------------
// SOFT-vs-HARD soft-miss predicates (2026-05-28)
//
// Each returns true iff the axis is SOFT *and* the job misses the user's
// constraint — i.e. a HARD policy would have dropped it. Mirrors the
// corresponding `applyV16HardFilters` gate so the scorer's demerit lines up
// 1:1 with what the filter would have dropped. Only ever called from inside
// `scoreV16Job`'s `phEnabled` branch.
// ---------------------------------------------------------------------------

/** Does the job satisfy the user's location intersect? (mirrors filter §2 core). */
function jobLocationHits(tags: UserTags, job: MatchingJob): boolean {
  const targetLocations = Array.isArray(tags.targetLocations)
    ? tags.targetLocations.filter((l): l is string => typeof l === "string")
    : []
  if (targetLocations.length === 0) return true // no constraint → always hits
  if (targetLocations.some((l) => ANYWHERE_LOCATION_TOKENS.has(l.trim().toLowerCase()))) return true
  // US-only platform: country-level US tokens carry no metro sub-constraint → anywhere-within-US.
  if (
    targetLocations.every(
      (l) =>
        US_COUNTRY_LOCATION_TOKENS.has(l.trim().toLowerCase()) ||
        ANYWHERE_LOCATION_TOKENS.has(l.trim().toLowerCase()),
    )
  )
    return true
  const jobLocs = Array.isArray(job.locationBuckets) ? job.locationBuckets : []
  // Job-side anywhere bypass — REVOKED when the job is region-locked non-US (locationRaw names a
  // specific foreign region). A mis-tagged "remote_anywhere" Eastern-Europe role must not hit a
  // ny/sf candidate (locked 2026-05-30).
  if (
    jobLocs.some((l) => ANYWHERE_LOCATION_TOKENS.has(String(l).trim().toLowerCase())) &&
    !isJobRegionLockedNonUs(job)
  )
    return true
  const targetSet = new Set(targetLocations.map((l) => l.trim().toLowerCase()))
  for (const l of jobLocs) if (targetSet.has(String(l).trim().toLowerCase())) return true
  if (jobLocs.length === 0 || !job.locationBuckets) {
    const raw = (job.locationRaw ?? "").toLowerCase()
    for (const l of targetLocations) {
      const key = l.trim().toLowerCase()
      if (key.length >= 3 && raw.includes(key)) return true
      if (key.startsWith("remote") && raw.includes("remote")) return true
    }
  }
  return false
}

function jobMissesSoftLocation(tags: UserTags, job: MatchingJob): boolean {
  if (resolveHardness(tags, "location").hardness !== "soft") return false
  const targetLocations = Array.isArray(tags.targetLocations)
    ? tags.targetLocations.filter((l): l is string => typeof l === "string")
    : []
  if (targetLocations.length === 0) return false
  return !jobLocationHits(tags, job)
}

function jobMissesSoftJobType(tags: UserTags, job: MatchingJob): boolean {
  if (resolveHardness(tags, "jobType").hardness !== "soft") return false
  const targetJobType = Array.isArray(tags.targetJobType) ? tags.targetJobType : []
  const legacy = (tags as { targetJobTypes?: string[] }).targetJobTypes
  const raw = targetJobType.length > 0 ? targetJobType : Array.isArray(legacy) ? legacy : []
  const set = new Set(raw.filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase()))
  if (set.size === 0 || !job.jobType) return false
  return !set.has(job.jobType.trim().toLowerCase())
}

function jobMissesSoftCareerStage(tags: UserTags, job: MatchingJob): boolean {
  const h = resolveHardness(tags, "careerStage")
  if (h.hardness !== "soft") return false
  const stage = tags.careerStage
  if (typeof stage !== "string" || !(CAREER_STAGE_VOCAB as readonly string[]).includes(stage)) return false
  const jobStage = normalizeCareerStageToken(job.seniorityLevel)
  if (!jobStage) return false
  // Demerit only when the job is OUTSIDE the widened window (within-buffer →
  // no demerit; the soft axis "widens window by bufferSteps").
  const widened = new Set(widenCareerStageWindow(stage as CareerStage, h.bufferSteps))
  return !widened.has(jobStage)
}

function jobMissesSoftIndustry(tags: UserTags, job: MatchingJob): boolean {
  if (resolveHardness(tags, "industrySector").hardness !== "soft") return false
  const userSectors = Array.isArray(tags.industrySector)
    ? tags.industrySector.map((s) => String(s)).filter((s) => s.length > 0)
    : []
  const jobSectors = Array.isArray(job.industrySector)
    ? job.industrySector.map((s) => String(s)).filter((s) => s.length > 0)
    : []
  if (userSectors.length === 0 || jobSectors.length === 0) return false // unenriched → no demerit
  const jobSet = new Set(jobSectors.map((s) => s.trim().toLowerCase()))
  return !userSectors.some((s) => jobSet.has(s.trim().toLowerCase()))
}

function jobMissesSoftSalary(tags: UserTags, job: MatchingJob): boolean {
  if (resolveHardness(tags, "salary").hardness !== "soft") return false
  const userMin = tags.minSalary
  const jobMin = job.salaryMin
  if (typeof userMin !== "number" || userMin <= 0) return false
  if (typeof jobMin !== "number" || jobMin <= 0) return false // unknown → no demerit (kept)
  return jobMin < userMin
}

/**
 * Apply the v1.6 hard filter chain (MATCH-04). Returns survivors + per-gate
 * drop counters. Each gate fails-closed only when the user signal is present
 * — missing user signal → gate is no-op (graceful for partially-filled users).
 *
 * Order of gates (from CLAUDE.md match flow):
 *   1. visa intersect
 *   2. location intersect (anywhere bypass)
 *   3. careerStage window (Phase 52 acceptableCareerStages helper)
 *   4. jobType exact intersect
 *   5. firstSeenAt < 20d (D10)
 *   6. atsApplyUrl present + not jobright.ai
 *   7. dead !== true
 *
 * Pure / deterministic. `nowMs` defaulted from `Date.now()` (override for tests).
 *
 * SOFT-vs-HARD (2026-05-28): when `options.preferenceHardnessEnabled` is true
 * the location / jobType / careerStage gates become CONDITIONAL on
 * `resolveHardness(...)`: a soft axis SKIPS its drop (the job is kept and a
 * demerit is applied later in `scoreV16Job`), while a hard axis drops exactly
 * as before. Two NEW hard gates also activate ONLY when the flag is on AND the
 * axis is hard: salary (drop iff job has a known floor below the user min —
 * null/unknown kept) and industrySector (drop iff user+job both non-empty with
 * empty intersection — unenriched jobs kept). When the option is absent/false
 * (the default, and the flag-OFF path) every branch is byte-identical to the
 * pre-2026-05-28 behaviour.
 */
export function applyV16HardFilters(
  jobs: MatchingJob[],
  userTags: UserTags,
  nowMs: number = Date.now(),
  freshnessWindowMs: number = FRESHNESS_WINDOW_MS,
  options: {
    relaxSpecificLocation?: boolean
    preferenceHardnessEnabled?: boolean
    /**
     * Recall fix (2026-05-29) — careerStage relax ladder rung:
     *   - `undefined` / `"strict"` → default ±1 `matchingCareerStageWindow`.
     *   - `"early_down"` → early-career window widened ONE tier DOWN
     *     (`earlyCareerRelaxWindow`) so a junior/entry candidate matches legit
     *     intern-tagged roles; never widens UP (no senior leakage).
     *   - `"all"` → last-resort: skip the careerStage gate entirely.
     * The caller (`queryMatchingJobsV16`) only escalates this when
     * `counters.careerStage` is the dominant zero-blocker AND the candidate is
     * early-career with no/anywhere location. The SOFT-vs-HARD widened window
     * (flag ON) takes precedence over this when active.
     */
    careerStageRelax?: "strict" | "early_down" | "all"
  } = {},
): { kept: MatchingJob[]; counters: V16HardFilterCounters } {
  const counters: V16HardFilterCounters = {
    visa: 0,
    location: 0,
    careerStage: 0,
    jobType: 0,
    freshness: 0,
    atsApplyUrl: 0,
    dead: 0,
    negativeListDrop: 0,
    roleTitleMismatch: 0,
    salary: 0,
    industrySector: 0,
    companyStage: 0,
  }
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { kept: [], counters }
  }

  // SOFT-vs-HARD: resolve per-axis hardness ONCE (cheap). Only consulted when
  // the flag is on; otherwise `phEnabled` short-circuits every new branch so
  // the legacy gates run unchanged.
  const phEnabled = options.preferenceHardnessEnabled === true
  const hLocation = phEnabled ? resolveHardness(userTags, "location") : null
  const hJobType = phEnabled ? resolveHardness(userTags, "jobType") : null
  const hCareerStage = phEnabled ? resolveHardness(userTags, "careerStage") : null
  const hSalary = phEnabled ? resolveHardness(userTags, "salary") : null
  const hIndustry = phEnabled ? resolveHardness(userTags, "industrySector") : null

  // Pre-compute user-side once.
  const sponsorshipNeeded = isSponsorshipNeeded(userTags.visaStatus)
  const targetLocations = Array.isArray(userTags.targetLocations)
    ? userTags.targetLocations.filter((l): l is string => typeof l === "string")
    : []
  // Recall fix (2026-05-29): an EMPTY targetLocations set ("open to anything"
  // that captured nothing) is treated as anywhere — the candidate has no
  // location constraint, so the metro intersect must not zero them out. This
  // mirrors an explicit `anywhere`/`remote` token. The US-only platform gate
  // (`jobIsForeignNonUs`) is NOT bypassed by this (a region-locked non-US role
  // is always dropped); only the metro intersect + the careerStage relax ladder
  // consult `isAnywhere`.
  const isAnywhere =
    targetLocations.length === 0 ||
    targetLocations.some((l) => ANYWHERE_LOCATION_TOKENS.has(l.trim().toLowerCase())) ||
    // US-only platform: a target of only country-level US / anywhere tokens carries no metro
    // sub-constraint → anywhere-within-US (skip the metro intersect). A specific metro is respected.
    targetLocations.every(
      (l) =>
        US_COUNTRY_LOCATION_TOKENS.has(l.trim().toLowerCase()) ||
        ANYWHERE_LOCATION_TOKENS.has(l.trim().toLowerCase()),
    )
  const targetLocationSet = new Set(targetLocations.map((l) => l.trim().toLowerCase()))
  // careerStage window — only enforce when both user + job sides present.
  // W5 — `careerStage`, `targetJobType`, `targetRoleFunction`, `relevantTags`,
  // `targetCountry`, `minSalary`, and `companyNegativeList` are typed on
  // `UserTagsSchema` (W3 #117 + earlier B1/B4 promotions), wired into the
  // canonical registry by W4 #121. Read them directly. The legacy plural
  // `targetJobTypes` alias is intentionally NOT promoted to the schema (see
  // `targetJobType` doc comment in `user-tags-merger.ts`); cast narrowly when
  // reading it for back-compat with pre-Phase-54 Firestore docs.
  // Phase B4 — pre-build hard-filter negative-name lookup once.
  const negativeSet = new Set<string>(
    Array.isArray(userTags.companyNegativeList)
      ? userTags.companyNegativeList.filter((s): s is string => typeof s === "string")
      : []
  )
  // Candidate-rejected role functions. `negativeRoleFunction` is the SINGLE
  // canonical SUBTRACT field (mirrors `negativeIndustrySector`) written by BOTH
  // the live conversation extractor ("avoid pure SWE, product only") and the
  // agentic match-connector. The legacy `roleFunctionNegativeList` name is
  // still read for back-compat with docs written before the 2026-05-28 rename
  // (same legacy-fallback pattern as targetJobType ← targetJobTypes below).
  const negativeRoleFunctionRaw = Array.isArray(
    (userTags as { negativeRoleFunction?: unknown }).negativeRoleFunction,
  )
    ? ((userTags as { negativeRoleFunction?: unknown[] }).negativeRoleFunction as unknown[])
    : Array.isArray((userTags as { roleFunctionNegativeList?: unknown }).roleFunctionNegativeList)
      ? ((userTags as { roleFunctionNegativeList?: unknown[] }).roleFunctionNegativeList as unknown[])
      : []
  const negativeRoleFunctionSet = new Set<string>(
    negativeRoleFunctionRaw
      .map((s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
      .filter(Boolean),
  )
  // lock #5 (negative axis) — candidate-rejected industry sectors. Built from
  // `userTags.negativeIndustrySector` (canonical INDUSTRY_SECTOR_VOCAB). The
  // drop is FLAG-GATED behind env `PA_NEGATIVE_INDUSTRY_FILTER === "1"`
  // (default OFF) so ranking is unchanged until Adam flips it. Mirrors the
  // `negativeRoleFunctionSet` precedent above.
  const negativeIndustryFilterEnabled =
    (typeof process !== "undefined" ? process.env?.PA_NEGATIVE_INDUSTRY_FILTER : undefined) === "1"
  const negativeIndustrySet = new Set<string>(
    negativeIndustryFilterEnabled &&
    Array.isArray((userTags as { negativeIndustrySector?: unknown }).negativeIndustrySector)
      ? ((userTags as { negativeIndustrySector?: unknown[] }).negativeIndustrySector as unknown[])
          .map((s) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
          .filter(Boolean)
      : []
  )
  const careerStage = userTags.careerStage
  const careerStageValid =
    typeof careerStage === "string" && (CAREER_STAGE_VOCAB as readonly string[]).includes(careerStage)
  // SOFT-vs-HARD: when careerStage is SOFT, widen the acceptable window by
  // `bufferSteps` extra ordinal tiers each side (the default hard window stays
  // exactly `matchingCareerStageWindow`). Flag OFF → `hCareerStage` is null →
  // the original window is used unchanged.
  // Recall fix (2026-05-29) — careerStage relax ladder. Precedence:
  //   1. SOFT-vs-HARD widened window (flag ON + axis soft) wins.
  //   2. else the explicit `careerStageRelax` rung:
  //        "all"        → no window (gate skipped via null below)
  //        "early_down" → early-career one-tier-down window
  //        strict/undef → default ±1 window
  const careerStageRelax = options.careerStageRelax ?? "strict"
  const careerStageWindow = (s: CareerStage): CareerStage[] => {
    if (hCareerStage && hCareerStage.hardness === "soft") {
      return widenCareerStageWindow(s, hCareerStage.bufferSteps)
    }
    if (careerStageRelax === "early_down") return earlyCareerRelaxWindow(s)
    return matchingCareerStageWindow(s)
  }
  const acceptableStages =
    careerStageValid && careerStageRelax !== "all"
      ? new Set(careerStageWindow(careerStage as CareerStage))
      : null
  const targetJobType = userTags.targetJobType
  const legacyTargetJobTypes = (userTags as unknown as { targetJobTypes?: string[] }).targetJobTypes
  const targetJobTypesRaw = Array.isArray(targetJobType)
    ? targetJobType
    : Array.isArray(legacyTargetJobTypes)
      ? legacyTargetJobTypes
      : []
  const targetJobTypes = targetJobTypesRaw.filter((t): t is string => typeof t === "string")
  const targetJobTypeSet = new Set(
    targetJobTypes.map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
  )

  // 2026-05-07 Adam directive: country must be hard filter when user
  // selected US-specific OR has US-only work auth. He saw rec for
  // "Product Engineer @ speakeasy" with locations Sofia, Bulgaria — Adam:
  // "如果我要在 north america (USA), 就别给我推荐别的国家". Surgical fix:
  // when sponsorshipNeeded=true (OPT/CPT/H1B all need US-side employer),
  // OR targetLocations contains US-specific tokens, treat as US-only.
  // Drop jobs whose locationBuckets contain ONLY non-US country tokens
  // (no US bucket present). Job with both "remote_anywhere" AND
  // "san_francisco_bay_area" → keep. Job with only "sofia,bulgaria" or
  // "london,uk" → drop.
  const kept: MatchingJob[] = []
  for (const job of jobs) {
    // 1. visa intersect — candidate-visible sponsor-needed recommendations
    // require explicit sponsorship=true. Unknown is not safe for H1B/OPT users.
    if (sponsorshipNeeded && job.sponsorship !== true) {
      counters.visa++
      continue
    }

    // 1b. US-only platform gate (Adam 2026-05-30 "by default it will always be US only") — drop a job
    // region-locked to a NON-US country for EVERY candidate. US-only is the universal default (no
    // targetCountry signal needed). remote_anywhere counts as US-accessible and is kept. See
    // jobIsForeignNonUs. Counted under `location` (the country axis shares the location drop counter).
    if (jobIsForeignNonUs(job)) {
      counters.location++
      continue
    }

    // 2. location intersect (anywhere bypass — user side OR job side).
    // A job tagged remote_anywhere/anywhere is accessible from any location;
    // bypass the intersect check so SF-only users still receive global remote roles.
    // SOFT-vs-HARD: when location is SOFT (flag ON), skip the drop entirely —
    // the scorer applies a soft-miss demerit instead so off-location jobs still
    // surface, ranked lower. Default (flag OFF / hard) → drop as before.
    const locationSoft = phEnabled && hLocation?.hardness === "soft"
    if (!locationSoft && !options.relaxSpecificLocation && !isAnywhere && targetLocations.length > 0) {
      const jobLocs = Array.isArray(job.locationBuckets) ? job.locationBuckets : []
      // Region-locked non-US jobs (locationRaw cross-check) DON'T get the anywhere bypass — a
      // mis-tagged remote_anywhere Eastern-Europe role must intersect the user's real locations,
      // so a ny/sf candidate doesn't match it (locked 2026-05-30).
      const jobIsAnywhere =
        jobLocs.some((l) => ANYWHERE_LOCATION_TOKENS.has(String(l).trim().toLowerCase())) &&
        !isJobRegionLockedNonUs(job)
      if (!jobIsAnywhere) {
        let hit = false
        for (const l of jobLocs) {
          if (targetLocationSet.has(String(l).trim().toLowerCase())) {
            hit = true
            break
          }
        }
        // Fallback: substring match on locationRaw when locationBuckets missing
        // (legacy / unmigrated jobs). Conservative — only "remote" ≈ "remote".
        if (!hit && (jobLocs.length === 0 || !job.locationBuckets)) {
          const raw = (job.locationRaw ?? "").toLowerCase()
          for (const l of targetLocations) {
            const key = l.trim().toLowerCase()
            if (key.length >= 3 && raw.includes(key)) {
              hit = true
              break
            }
            // remote variants tolerate raw "remote" / "anywhere"
            if (key.startsWith("remote") && raw.includes("remote")) {
              hit = true
              break
            }
          }
        }
        if (!hit) {
          counters.location++
          continue
        }
      }
    }

    // 3. careerStage window — hard-gate only on explicit job.seniorityLevel.
    // Title inference (senior/manager/lead) is too noisy for a hard drop and
    // causes recall collapse for marketing/BA users where the corpus skews
    // heavily toward senior titles. Explicit field is trustworthy; inferred
    // title stage feeds soft scoring only.
    // SOFT-vs-HARD: when careerStage is SOFT (flag ON), `acceptableStages` is
    // already the WIDENED window (±1 + bufferSteps); we additionally skip the
    // drop entirely so even out-of-window jobs survive (the scorer demerits
    // those outside the widened window). Default (flag OFF / hard) → drop on
    // the standard ±1 window as before.
    const careerStageSoft = phEnabled && hCareerStage?.hardness === "soft"
    if (!careerStageSoft && acceptableStages) {
      const jobStage = normalizeCareerStageToken(job.seniorityLevel)
      if (jobStage && !acceptableStages.has(jobStage)) {
        counters.careerStage++
        continue
      }
    }

    // 4. jobType exact intersect — when user has targets AND job has type.
    // SOFT-vs-HARD: when jobType is SOFT (flag ON), skip the drop; scorer
    // demerits the mismatch instead. Default (flag OFF / hard) → drop.
    const jobTypeSoft = phEnabled && hJobType?.hardness === "soft"
    if (!jobTypeSoft && targetJobTypeSet.size > 0 && job.jobType) {
      const jt = job.jobType.trim().toLowerCase()
      if (!targetJobTypeSet.has(jt)) {
        counters.jobType++
        continue
      }
    }

    // 4b. Role-title sanity gate — job corpus tags can be noisy. If a user
    // explicitly targets non-engineering functions, drop clear engineering
    // titles unless that target function has a known technical-title exception.
    if (isRoleTitleMismatch(userTags, job)) {
      counters.roleTitleMismatch++
      continue
    }

    // 5. firstSeenAt < freshness window (D10 default 20d, adaptive relaxation
    //    handled by caller — see `queryMatchingJobsV16`).
    const firstSeenMs = timestampToMs(job.firstSeenAt)
    if (firstSeenMs === 0 || nowMs - firstSeenMs > freshnessWindowMs) {
      counters.freshness++
      continue
    }

    // 6. atsApplyUrl present + not jobright.ai.
    const url = job.atsApplyUrl ?? ""
    if (!url || /jobright\.ai/i.test(url)) {
      counters.atsApplyUrl++
      continue
    }

    // 7. dead !== true.
    if (job.dead === true) {
      counters.dead++
      continue
    }

    // 8. Candidate rejection hard-drops. Last in the chain so we don't waste
    //    score-time on jobs that pass other gates but are user-rejected.
    if (negativeSet.size > 0) {
      const norm = normalizeCompanyName(job.companyName ?? "")
      if (norm.length > 0 && negativeSet.has(norm)) {
        counters.negativeListDrop++
        continue
      }
    }
    if (negativeRoleFunctionSet.size > 0) {
      const roleFunctions = Array.isArray(job.roleFunction) ? job.roleFunction : []
      if (
        roleFunctions.some((role) =>
          typeof role === "string" && negativeRoleFunctionSet.has(role.trim().toLowerCase())
        )
      ) {
        counters.negativeListDrop++
        continue
      }
    }
    // lock #5 — negative-industry subtract (flag-gated; set is empty unless
    // PA_NEGATIVE_INDUSTRY_FILTER === "1", so this is a no-op by default).
    if (negativeIndustrySet.size > 0) {
      const jobSectors = Array.isArray(job.industrySector) ? job.industrySector : []
      if (
        jobSectors.some((sector) =>
          typeof sector === "string" && negativeIndustrySet.has(sector.trim().toLowerCase())
        )
      ) {
        counters.negativeListDrop++
        continue
      }
    }

    // 9. SOFT-vs-HARD (2026-05-28) — NEW hard gates. Active ONLY when the flag
    //    is ON AND the user explicitly marked the axis HARD. Default
    //    (flag OFF, or axis soft per DEFAULT_HARDNESS) → never runs → today's
    //    behaviour (salary + industry are soft score signals, not gates).

    // 9a. salary HARD: drop iff job has a KNOWN floor below the user min.
    //     `null`/`undefined`/0 salaryMin (unknown) is KEPT — dropping unpriced
    //     jobs would erase inventory (spec §3.1).
    if (phEnabled && hSalary?.hardness === "hard") {
      const userMin = userTags.minSalary
      if (typeof userMin === "number" && userMin > 0) {
        const jobMin = job.salaryMin
        if (typeof jobMin === "number" && jobMin > 0 && jobMin < userMin) {
          counters.salary++
          continue
        }
      }
    }

    // 9b. industrySector HARD: drop iff user+job sectors are BOTH non-empty
    //     AND the intersection is empty. Jobs with empty `industrySector`
    //     (unenriched) are KEPT — don't punish missing enrichment (spec §3.2).
    if (phEnabled && hIndustry?.hardness === "hard") {
      const userSectors = Array.isArray(userTags.industrySector)
        ? userTags.industrySector.map((s) => String(s)).filter((s) => s.length > 0)
        : []
      const jobSectors = Array.isArray(job.industrySector)
        ? job.industrySector.map((s) => String(s)).filter((s) => s.length > 0)
        : []
      if (userSectors.length > 0 && jobSectors.length > 0) {
        const jobSet = new Set(jobSectors.map((s) => s.trim().toLowerCase()))
        const intersects = userSectors.some((s) => jobSet.has(s.trim().toLowerCase()))
        if (!intersects) {
          counters.industrySector++
          continue
        }
      }
    }

    kept.push(job)
  }
  return { kept, counters }
}

/**
 * Market fallback (req #5, 2026-05-29) — relaxed hard-filter chain used ONLY
 * when the strict cascade (+ location relax + careerStage relax) yields zero
 * jobs. Keeps the SAFETY gates that must never be bypassed:
 *   - visa intersect (sponsor_needed → require sponsorship=true)
 *   - US-only country gate (sponsor_needed / US-target → drop non-US-only)
 *   - freshness window (firstSeenAt within window)
 *   - atsApplyUrl present + not jobright.ai
 *   - dead !== true
 *   - negative company / role-function / industry subtracts
 * but SKIPS the preference gates that over-filter to zero:
 *   - location intersect
 *   - careerStage window
 *   - jobType intersect
 * so Claire ALWAYS has something real to offer rather than dead-silence. The
 * survivors are scored normally; matchSourceLabel on fallback jobs stays
 * 'general match'. Pure / deterministic. Mirrors the relevant gates in
 * `applyV16HardFilters` 1:1 (any future gate change there must mirror here).
 */
export function applyFallbackHardFilters(
  jobs: MatchingJob[],
  userTags: UserTags,
  nowMs: number = Date.now(),
  freshnessWindowMs: number = FRESHNESS_WINDOW_MS,
): { kept: MatchingJob[]; counters: V16HardFilterCounters } {
  const counters = zeroV16Counters()
  if (!Array.isArray(jobs) || jobs.length === 0) return { kept: [], counters }

  const sponsorshipNeeded = isSponsorshipNeeded(userTags.visaStatus)

  const negativeSet = new Set<string>(
    Array.isArray(userTags.companyNegativeList)
      ? userTags.companyNegativeList.filter((s): s is string => typeof s === "string")
      : []
  )
  const negativeRoleFunctionRaw = Array.isArray(
    (userTags as { negativeRoleFunction?: unknown }).negativeRoleFunction,
  )
    ? ((userTags as { negativeRoleFunction?: unknown[] }).negativeRoleFunction as unknown[])
    : Array.isArray((userTags as { roleFunctionNegativeList?: unknown }).roleFunctionNegativeList)
      ? ((userTags as { roleFunctionNegativeList?: unknown[] }).roleFunctionNegativeList as unknown[])
      : []
  const negativeRoleFunctionSet = new Set<string>(
    negativeRoleFunctionRaw
      .map((s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
      .filter(Boolean),
  )

  const kept: MatchingJob[] = []
  for (const job of jobs) {
    // visa intersect
    if (sponsorshipNeeded && job.sponsorship !== true) {
      counters.visa++
      continue
    }
    // US-only platform gate — drop region-locked foreign jobs for EVERY candidate (US-only is the
    // universal default; remote_anywhere counts as US-accessible). Same gate as the strict path.
    if (jobIsForeignNonUs(job)) {
      counters.location++
      continue
    }
    // SKIP location intersect / careerStage window / jobType intersect.

    // role-title sanity gate — kept (cheap, prevents obvious cross-function leakage)
    if (isRoleTitleMismatch(userTags, job)) {
      counters.roleTitleMismatch++
      continue
    }
    // freshness
    const firstSeenMs = timestampToMs(job.firstSeenAt)
    if (firstSeenMs === 0 || nowMs - firstSeenMs > freshnessWindowMs) {
      counters.freshness++
      continue
    }
    // atsApplyUrl present + not jobright.ai
    const url = job.atsApplyUrl ?? ""
    if (!url || /jobright\.ai/i.test(url)) {
      counters.atsApplyUrl++
      continue
    }
    // dead !== true
    if (job.dead === true) {
      counters.dead++
      continue
    }
    // negative company subtract
    if (negativeSet.size > 0) {
      const norm = normalizeCompanyName(job.companyName ?? "")
      if (norm.length > 0 && negativeSet.has(norm)) {
        counters.negativeListDrop++
        continue
      }
    }
    // negative role-function subtract
    if (negativeRoleFunctionSet.size > 0) {
      const roleFunctions = Array.isArray(job.roleFunction) ? job.roleFunction : []
      if (
        roleFunctions.some((role) =>
          typeof role === "string" && negativeRoleFunctionSet.has(role.trim().toLowerCase())
        )
      ) {
        counters.negativeListDrop++
        continue
      }
    }
    kept.push(job)
  }
  return { kept, counters }
}

// ---------------------------------------------------------------------------
// Soft score (MATCH-05/06)
// ---------------------------------------------------------------------------

/**
 * Per-skill weighted Jaccard. Returns [0, 1].
 *
 *   matchedWeight = Σ over user-skills∈job-skills (base × jdRelative)
 *   totalWeight   = Σ over all user-skills        (base × jdRelative)
 *   score = matchedWeight / totalWeight  (0 when totalWeight == 0)
 *
 * Also returns the matched-skill list for the reasoning composer.
 *
 * Without `jdRelativeWeights` (Phase 58 cache absent), each skill's
 * jd-rel defaults to 1.0 → degrades gracefully to plain weighted Jaccard.
 */
export function computeWeightedSkillJaccard(
  // Phase 61: tolerate BOTH legacy `string[]` AND canonical SkillEntry[] for
  // backwards-compat with un-migrated pa-users.tags.skills (the migration
  // script `migrate-skills-to-objects.mjs` upgrades them but unmigrated
  // users still flow through this function via daily-batch / live recs).
  userSkills:
    | UserTags["skills"]
    | ReadonlyArray<string>
    | ReadonlyArray<{ name: string; proficiency?: string; baseWeight?: number }>
    | undefined,
  jobSkills: string[] | undefined,
  jdRelative?: Record<string, number>
): { score: number; matched: MatchedSkillContribution[] } {
  if (!Array.isArray(userSkills) || userSkills.length === 0) {
    return { score: 0, matched: [] }
  }
  if (!Array.isArray(jobSkills) || jobSkills.length === 0) {
    return { score: 0, matched: [] }
  }
  // Normalize job skills to a Set of canonical keys.
  const jobSet = new Set<string>()
  for (const j of jobSkills) {
    if (typeof j === "string") jobSet.add(skillKey(j))
  }
  let matchedWeight = 0
  let totalWeight = 0
  const matched: MatchedSkillContribution[] = []
  for (const s of userSkills as ReadonlyArray<unknown>) {
    if (s == null) continue
    // Phase 53 schema: `tags.skills[]` is bucketed objects with `name`,
    // `proficiency`, `baseWeight`. But the user-tags-merger v1 currently
    // stores `tags.skills: string[]` (legacy bag). Tolerate BOTH shapes:
    //   - string skill: name=skill, proficiency="intermediate", baseWeight=0.5
    //   - object skill: { name, proficiency, baseWeight }
    let name: string
    let proficiency: string
    let baseWeight: number
    if (typeof s === "string") {
      const trimmed = s.trim()
      if (trimmed.length === 0) continue
      name = trimmed
      proficiency = "intermediate"
      baseWeight = 0.5
    } else if (typeof s === "object") {
      const so = s as { name?: unknown; proficiency?: unknown; baseWeight?: unknown }
      if (typeof so.name !== "string" || so.name.length === 0) continue
      name = so.name
      proficiency = typeof so.proficiency === "string" ? so.proficiency : "intermediate"
      baseWeight =
        typeof so.baseWeight === "number" && Number.isFinite(so.baseWeight)
          ? Math.max(0, Math.min(1, so.baseWeight))
          : 0.5
    } else {
      continue
    }
    const key = skillKey(name)
    const jdRel = jdRelative?.[key] ?? 1.0
    const w = baseWeight * jdRel
    if (w <= 0) continue
    totalWeight += w
    if (jobSet.has(key)) {
      matchedWeight += w
      matched.push({ name, proficiency, weight: w })
    }
  }
  const score = totalWeight > 0 ? matchedWeight / totalWeight : 0
  // Sort matched by weight desc — composer picks top-2.
  matched.sort((a, b) => b.weight - a.weight)
  return { score: Math.max(0, Math.min(1, score)), matched }
}

/**
 * Phase B4 — set Jaccard intersection / union ∈ [0, 1]. Returns 0 when either
 * side is empty/missing. Case-insensitive (tags are open-vocab — guard drift).
 */
export function jaccard(a: string[] | undefined, b: string[] | undefined): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0
  const A = new Set(a.map((s) => String(s).trim().toLowerCase()).filter(Boolean))
  const B = new Set(b.map((s) => String(s).trim().toLowerCase()).filter(Boolean))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  const union = A.size + B.size - inter
  return union > 0 ? inter / union : 0
}

/**
 * Phase B4 — case-insensitive intersection that returns original-case tokens
 * from `a`. Used by `composeReason` to surface matched chips.
 */
function intersectTokens(a: string[] | undefined, b: string[] | undefined): string[] {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return []
  const B = new Set(b.map((s) => String(s).trim().toLowerCase()))
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of a) {
    const k = String(x).trim().toLowerCase()
    if (!k || seen.has(k)) continue
    if (B.has(k)) {
      out.push(x)
      seen.add(k)
    }
  }
  return out
}

/** Set-overlap ratio — shared(a, b) / max(|a|, |b|) ∈ [0, 1]. */
export function computeOverlap(a: string[] | undefined, b: string[] | undefined): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0
  const aSet = new Set(a.map((s) => String(s).trim().toLowerCase()).filter(Boolean))
  const bSet = new Set(b.map((s) => String(s).trim().toLowerCase()).filter(Boolean))
  if (aSet.size === 0 || bSet.size === 0) return 0
  let hits = 0
  for (const x of aSet) if (bSet.has(x)) hits++
  return hits / Math.max(aSet.size, bSet.size)
}

/** Cosine similarity for equal-length vectors. Returns [0, 1]. */
export function cosineSim(a: number[] | undefined, b: number[] | undefined): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  if (na === 0 || nb === 0) return 0
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb))
  if (!Number.isFinite(sim)) return 0
  if (sim < 0) return 0
  if (sim > 1) return 1
  return sim
}

/**
 * Salary fit. Linear degrade once job.salaryMin falls below user.minSalary.
 *   user>0, job>0, job >= user → 1.0
 *   user>0, job>0, job < user  → max(0, 1 - (user - job) / 50000)  (-$50K → 0)
 *   either side missing → 0.5  (neutral)
 *
 * SOFT-vs-HARD (2026-05-28): when `bufferPct` is supplied (> 0), use the
 * buffer-aware soft decay from spec §3.1 instead of the legacy linear curve:
 *   - jobMin >= userMin                          → 1.0
 *   - floor <= jobMin < userMin                  → 0.7..1.0 linear
 *                                                  (floor = userMin × (1-bufferPct))
 *   - jobMin < floor                             → max(0, 0.7 × (1 - (floor-jobMin)/50000))
 *   - either side missing                        → 0.5 (neutral)
 * `bufferPct` undefined → legacy curve (byte-identical to pre-2026-05-28).
 */
export function computeSalaryFit(
  userMin: number | undefined,
  jobMin: number | null | undefined,
  bufferPct?: number,
): number {
  if (typeof userMin !== "number" || userMin <= 0) return 0.5
  if (typeof jobMin !== "number" || jobMin <= 0) return 0.5
  if (jobMin >= userMin) return 1.0
  // Buffer-aware soft decay (only when an explicit bufferPct is provided).
  if (typeof bufferPct === "number" && Number.isFinite(bufferPct) && bufferPct > 0) {
    const floor = userMin * (1 - Math.max(0, Math.min(1, bufferPct)))
    if (jobMin >= floor) {
      // Within the buffer band: linear 0.7 (at floor) → 1.0 (at userMin).
      const span = userMin - floor
      const frac = span > 0 ? (jobMin - floor) / span : 1
      return 0.7 + 0.3 * Math.max(0, Math.min(1, frac))
    }
    return Math.max(0, 0.7 * (1 - (floor - jobMin) / 50_000))
  }
  const gap = userMin - jobMin
  return Math.max(0, 1 - gap / 50_000)
}

/**
 * Phase 70 — admin debug surface accepts partial weight overrides via
 * `paAdminMatchDebug` (sandbox sliders 0..1 each). When provided, these
 * replace the corresponding V16_SCORE_WEIGHTS entries; missing keys fall
 * back to the canonical values. Default behaviour (overrides=undefined) is
 * byte-identical to pre-Phase-70 V16.
 *
 * Each key is `number` (not the V16_SCORE_WEIGHTS literal) so callers can
 * pass arbitrary slider values. `scoreV16Job` clamps each to [0, 1].
 */
export type V16ScoreWeightOverrides = {
  [K in keyof typeof V16_SCORE_WEIGHTS]?: number
}

/**
 * Compute the v1.6 weighted score for one (user, job) pair. Pure /
 * deterministic; pass-through behaviour when caches are missing (jdRel=1.0,
 * llmRerank=0).
 *
 * @param weightOverrides Phase 70 admin sandbox — partial overrides (0..1
 *   each, clamped). Missing keys fall back to canonical V16_SCORE_WEIGHTS.
 *   Default (undefined) preserves canonical behaviour byte-identically.
 */
/** Phase B4 — additive boost constants (do NOT redistribute V16_SCORE_WEIGHTS). */
export const V16_TAG_OVERLAP_WEIGHT = 0.15
export const V16_POSITIVE_HIT_WEIGHT = 0.15
export const V16_URGENCY_BOOST_FRESH_FT = 0.20
export const V16_URGENCY_BOOST_OFF_TARGET = -0.10
export const V16_URGENCY_FRESH_WINDOW_MS = 14 * 24 * 3600 * 1000
const URGENCY_OFF_TARGET_JOB_TYPES = new Set(["internship", "new_graduate", "contract"])

/**
 * Phase B5 (Adam 2026-05-19) — default-on freshness boost.
 *
 * Why: V16 hard filter caps age at 20 d, query orders by `firstSeenAt desc`,
 * but the soft-score blend itself carries no recency signal. Default
 * (non-urgent) users therefore see today's freshly-scraped jobs and 19-day-
 * old jobs at parity once skill/industry/embedding match — sub-decimal LLM
 * noise can flip ordering. Adam directive: "job match should also prefer
 * latest recent jobs.. like today's new parsed & matched jobs".
 *
 * Shape: exponential half-life decay — industry standard (LinkedIn newness
 * signal, RecSys time-decay baseline). One parameter (τ), smooth, no step
 * discontinuities in /admin/match-debug:
 *
 *     freshnessBoost = V16_FRESHNESS_BOOST_MAX × 0.5^(ageMs / τ)
 *
 * Adam-locked params (2026-05-19):
 *   B_max = 0.10  (smaller than positiveHit 0.15 and urgencyBoost 0.20)
 *   τ     = 3 d   ("today" beats 3-d-old 2×, beats 7-d-old 5×)
 *
 * Decay table (B_max=0.10, τ=3d):
 *
 *   age     boost
 *   ----    -----
 *   0 h     0.100
 *   1 d     0.079
 *   3 d     0.050   ← half-life
 *   7 d     0.020
 *   14 d    0.004
 *   20 d    0.001   ← hard-filter edge; effectively 0, no manual floor
 *
 * Caveat: stacks with urgencyBoost (0.20 fresh full_time) for
 * `urgentlySeeking=true` users — that's intentional; urgency dominates.
 */
export const V16_FRESHNESS_BOOST_MAX = 0.10
export const V16_FRESHNESS_HALF_LIFE_MS = 3 * 24 * 3600 * 1000  // τ = 3 days

/**
 * Phase B5.1 (Adam 2026-05-19) — cohort-relevance damping on freshness.
 *
 * Why: pure additive `freshnessBoost` could let a brand-new but irrelevant
 * job (e.g. sales role for a SWE-tagged user with empty `targetRoleFunction`,
 * which skips the query-layer role filter) beat a stale-but-relevant SWE
 * job. Adam catch 2026-05-19:
 *   "aging 应该是 filter 完所有 industry/skill 等, 同一个领域里面的 filter ...
 *    要不然可能这个 sales 岗位开的很早, 然后 somehow prioritize it over a swe job"
 *
 * Fix: scale the freshness boost by `min(1, baseRelevance / THRESHOLD)` so
 * a job with zero relevance receives zero freshness lift, and only jobs
 * with reasonable base relevance enjoy the full age-decay curve.
 *
 *     baseRelevance  = baseScore + tagOverlapScore + positiveHitBoost
 *                      (excludes urgencyBoost — that's intent signal,
 *                       not relevance signal — and the new freshness term
 *                       itself, to avoid circularity)
 *     freshFactor    = min(1, baseRelevance / V16_FRESHNESS_RELEVANCE_THRESHOLD)
 *     freshnessBoost = V16_FRESHNESS_BOOST_MAX × 0.5^(age/τ) × freshFactor
 *
 * Threshold = 0.20: matches the magnitude of a single strong soft-score
 * component (e.g. skillJaccard=1.0 × W.skillJaccard=0.20 = 0.20). A job
 * with at least one strong signal therefore enjoys the full freshness lift.
 *
 * Effect table (B_max=0.10, τ=3d):
 *
 *   baseRelevance   freshFactor   today boost   7d boost
 *   -----------     -----------   -----------   --------
 *   0.00 (none)         0           0.000         0.000
 *   0.05 (weak)         0.25        0.025         0.005
 *   0.10 (mid)          0.50        0.050         0.010
 *   0.20+ (strong)      1.0         0.100         0.020
 */
export const V16_FRESHNESS_RELEVANCE_THRESHOLD = 0.20

/**
 * Collab priority (req #3, 2026-05-29) — additive boost for WeKruit
 * collaboration jobs (`pa-jobs/{jobId}.wekruitCollaborationStatus ===
 * "collaborated"`). These are curated demand events WeKruit owns the
 * relationship for; they should rank above the general scraped market when
 * relevance is comparable. 0.08 is sized between `freshnessBoost` (0.10 max)
 * and `companyStageBoost`, large enough to break ties in favour of collab but
 * small enough that a clearly stronger general-market match still wins.
 */
export const V16_COLLAB_BOOST_WEIGHT = 0.08

export function scoreV16Job(
  user: UserTags,
  job: MatchingJob & { embedding?: number[] | null },
  jdRelative?: Record<string, number>,
  llmRerankScore?: number,
  weightOverrides?: V16ScoreWeightOverrides,
  /**
   * Phase B4 — optional company info from `loadCompaniesByName`. Drives
   * `tagOverlap` Jaccard. Stage is informational only (not in score).
   */
  companyInfo?: LoadedCompanyInfo | undefined,
  /** Phase B4 — pinned `now` for deterministic urgency age compute. */
  nowMs?: number,
  /**
   * SOFT-vs-HARD (2026-05-28) — when `preferenceHardnessEnabled` is true the
   * scorer (a) uses the buffer-aware salary curve for a SOFT salary axis, (b)
   * activates the additive `companyStageBoost` from `companyInfo.stage`, and
   * (c) computes `softMissDemerit` for SOFT axes whose constraint the job
   * misses (location / jobType / careerStage / industrySector / salary).
   * Default (undefined / false) → none of this runs and the `companyStageBoost`
   * + `softMissDemerit` breakdown keys are omitted → byte-identical to today.
   */
  preferenceHardness?: { enabled?: boolean },
  /**
   * Collab priority (req #3, 2026-05-29) — when true the job is a WeKruit
   * collaboration job (`pa-jobs.wekruitCollaborationStatus === "collaborated"`)
   * and gets an additive `+V16_COLLAB_BOOST_WEIGHT` (0.08) in `total`, surfaced
   * in the breakdown as `collabBoost`. Default (false/undefined) → `collabBoost`
   * is 0 and `total` is byte-identical to the pre-collab blend. The collab set
   * is resolved once by the caller via `loadMatchSourceLabels` (no extra read).
   */
  isCollaborationJob?: boolean,
): { breakdown: V16ScoreBreakdown; matched: MatchedSkillContribution[] } {
  const phEnabled = preferenceHardness?.enabled === true
  const llm = typeof llmRerankScore === "number" && Number.isFinite(llmRerankScore)
    ? Math.max(0, Math.min(1, llmRerankScore))
    : 0
  // W5 — `relevantTags` is typed on UserTagsSchema (W3 #117); `minSalary` was
  // already typed on UserTags. Read directly, no cast needed.
  const skill = computeWeightedSkillJaccard(user.skills, job.requiredSkills, jdRelative)
  // user.relevantTags (Phase 54 partial-write field) is the primary source.
  // Fall back to relevantSpecialization / proposedTags so legacy users still
  // contribute to relevantTags axis until Phase 54 hooks fully populate it.
  const userRelTags =
    (Array.isArray(user.relevantTags) && user.relevantTags.length > 0
      ? user.relevantTags
      : (user.relevantSpecialization ?? user.proposedTags ?? []))
  const relTags = computeOverlap(userRelTags, job.relevantTags)
  // user.industrySector OR user.relevantIndustry (CV-derived) intersect with
  // job.industrySector. Phase 55 migration ensures both sides have the
  // canonical 42-token vocab. relevantTags ≠ industrySector — we keep
  // them separate (D2 vs TAG-08).
  const userIndustryUnion = [
    ...(user.industrySector ?? []),
    ...(user.relevantIndustry ?? []),
  ]
  const indSector = computeOverlap(userIndustryUnion, job.industrySector)
  const cvEmb = cosineSim(user.embedding, job.embedding ?? undefined)
  // SOFT-vs-HARD: a SOFT salary axis uses the buffer-aware decay (accept down
  // to `floor` at reduced score). HARD salary already dropped sub-floor jobs in
  // the filter, so survivors score on the legacy curve. Flag OFF → legacy curve.
  const salaryHardness = phEnabled ? resolveHardness(user, "salary") : null
  const salaryBufferPct =
    salaryHardness && salaryHardness.hardness === "soft" ? salaryHardness.bufferPct : undefined
  const salary = computeSalaryFit(user.minSalary, job.salaryMin, salaryBufferPct)

  // Phase 70: resolve effective weights — overrides shadow canonical, missing
  // keys fall back. Each override clamped to [0, 1] for safety.
  const clamp01 = (n: unknown, fallback: number): number =>
    typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback
  const W = weightOverrides
    ? {
        llmMatch: clamp01(weightOverrides.llmMatch, V16_SCORE_WEIGHTS.llmMatch),
        skillJaccard: clamp01(weightOverrides.skillJaccard, V16_SCORE_WEIGHTS.skillJaccard),
        relevantTags: clamp01(weightOverrides.relevantTags, V16_SCORE_WEIGHTS.relevantTags),
        industrySector: clamp01(weightOverrides.industrySector, V16_SCORE_WEIGHTS.industrySector),
        cvEmbCosine: clamp01(weightOverrides.cvEmbCosine, V16_SCORE_WEIGHTS.cvEmbCosine),
        salaryFit: clamp01(weightOverrides.salaryFit, V16_SCORE_WEIGHTS.salaryFit),
      }
    : V16_SCORE_WEIGHTS

  const baseScore =
    llm * W.llmMatch +
    skill.score * W.skillJaccard +
    relTags * W.relevantTags +
    indSector * W.industrySector +
    cvEmb * W.cvEmbCosine +
    salary * W.salaryFit

  // ---- Phase B4 — additive boosts on top of the unit-score blend ---------
  // W5 — `targetCompanyTags`, `companyPositiveList`, `urgentlySeeking` are
  // typed on UserTagsSchema (Phase B1 promotion). Read directly.
  const tagOverlapScore = jaccard(user.targetCompanyTags, companyInfo?.tags) * V16_TAG_OVERLAP_WEIGHT
  const normCompany = normalizeCompanyName(job.companyName ?? "")
  const positiveHitBoost =
    normCompany.length > 0 &&
    Array.isArray(user.companyPositiveList) &&
    user.companyPositiveList.includes(normCompany)
      ? V16_POSITIVE_HIT_WEIGHT
      : 0
  let urgencyBoost = 0
  if (user.urgentlySeeking === true) {
    const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now()
    const firstSeenMs = timestampToMs(job.firstSeenAt)
    const ageMs = firstSeenMs > 0 ? now - firstSeenMs : Number.POSITIVE_INFINITY
    const jt = typeof job.jobType === "string" ? job.jobType.trim().toLowerCase() : ""
    if (jt === "full_time" && ageMs < V16_URGENCY_FRESH_WINDOW_MS) {
      urgencyBoost = V16_URGENCY_BOOST_FRESH_FT
    } else if (jt && URGENCY_OFF_TARGET_JOB_TYPES.has(jt)) {
      urgencyBoost = V16_URGENCY_BOOST_OFF_TARGET
    }
  }
  // Phase B5 — default-on freshness boost (exponential half-life decay)
  // scaled by cohort relevance (B5.1, Adam 2026-05-19): a zero-relevance
  // job gets zero freshness lift, so a brand-new sales role can't outrank
  // a stale-but-relevant SWE role when the query layer didn't filter role
  // (under-tagged user).
  let freshnessBoost = 0
  const firstSeenForBoost = timestampToMs(job.firstSeenAt)
  if (firstSeenForBoost > 0) {
    const nowForBoost =
      typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now()
    const ageMs = Math.max(0, nowForBoost - firstSeenForBoost)
    const decay =
      V16_FRESHNESS_BOOST_MAX * Math.pow(0.5, ageMs / V16_FRESHNESS_HALF_LIFE_MS)
    // baseRelevance excludes urgencyBoost (intent signal) and freshnessBoost
    // (circularity). Strong jobs (≥0.20 base) get full decay; weaker jobs
    // get linearly scaled lift; zero-base gets zero.
    const baseRelevance = baseScore + tagOverlapScore + positiveHitBoost
    const freshFactor = Math.min(
      1,
      Math.max(0, baseRelevance / V16_FRESHNESS_RELEVANCE_THRESHOLD),
    )
    freshnessBoost = decay * freshFactor
  }

  // ---- SOFT-vs-HARD (2026-05-28) — additive company-stage boost + soft-miss
  //      demerits. Computed ONLY when the flag is on; otherwise the keys are
  //      omitted and `total` is byte-identical to the pre-2026-05-28 blend.
  let companyStageBoost: number | undefined
  let softMissDemerit: number | undefined
  if (phEnabled) {
    // §3.3 — company-stage fit boost, centered on 0.5 (no signal / unknown → 0).
    const stageHardness = resolveHardness(user, "companyStage")
    const fit = computeCompanyStageFit(user, companyInfo?.stage, stageHardness.bufferSteps)
    companyStageBoost = (fit - 0.5) * V16_COMPANY_STAGE_WEIGHT

    // §3.4 — soft-miss demerits. For each SOFT axis whose constraint the job
    // misses (i.e. a HARD policy would have dropped it), subtract a small
    // demerit so the surfaced-but-worse job ranks below clean matches.
    let demerit = 0
    if (jobMissesSoftLocation(user, job)) demerit -= V16_SOFT_MISS_DEMERIT
    if (jobMissesSoftJobType(user, job)) demerit -= V16_SOFT_MISS_DEMERIT
    if (jobMissesSoftCareerStage(user, job)) demerit -= V16_SOFT_MISS_DEMERIT
    if (jobMissesSoftIndustry(user, job)) demerit -= V16_SOFT_MISS_DEMERIT
    if (jobMissesSoftSalary(user, job)) demerit -= V16_SOFT_MISS_DEMERIT
    softMissDemerit = demerit
  }

  // Collab priority (req #3) — additive boost for WeKruit collaboration jobs.
  const collabBoost = isCollaborationJob === true ? V16_COLLAB_BOOST_WEIGHT : 0

  const total =
    baseScore +
    tagOverlapScore +
    positiveHitBoost +
    urgencyBoost +
    freshnessBoost +
    collabBoost +
    (companyStageBoost ?? 0) +
    (softMissDemerit ?? 0)
  return {
    breakdown: {
      llmMatch: llm,
      skillJaccard: skill.score,
      relevantTags: relTags,
      industrySector: indSector,
      cvEmbCosine: cvEmb,
      salaryFit: salary,
      tagOverlap: tagOverlapScore,
      positiveHit: positiveHitBoost,
      urgencyBoost,
      freshnessBoost,
      collabBoost,
      ...(companyStageBoost !== undefined ? { companyStageBoost } : {}),
      ...(softMissDemerit !== undefined ? { softMissDemerit } : {}),
      total,
    },
    matched: skill.matched,
  }
}

// ---------------------------------------------------------------------------
// Per-job reasoning (MATCH-07)
// ---------------------------------------------------------------------------

/**
 * Compose a 1-sentence "为啥推" / "Why match" reason citing the top-2
 * weighted matched skills. Lang-aware (zh/en) per `tags.preferredLang`.
 *
 * Falls back to "industry + experience match" when no skill-level overlap;
 * if both sides empty → returns a neutral message.
 */
export function composeReason(
  user: UserTags,
  job: MatchingJob,
  matched: MatchedSkillContribution[],
  breakdown: V16ScoreBreakdown,
  /** Phase B4 — optional company info for chip composition. */
  companyInfo?: LoadedCompanyInfo | undefined,
): string {
  const lang = user.preferredLang === "en" ? "en" : "zh"
  const top = matched.slice(0, 2)

  // Build the primary reason first; B4 chips appended.
  let primary: string
  if (top.length > 0) {
    const segs = top.map((m) => `${m.name}(${m.proficiency})`).join(" + ")
    primary = lang === "zh"
      ? `为啥推: 你的 ${segs} 跟 JD 核心技能对得上`
      : `Why match: your ${segs} aligns with JD core skills`
  } else if (breakdown.industrySector >= 0.4 || breakdown.cvEmbCosine >= 0.5) {
    primary = lang === "zh"
      ? `为啥推: 行业方向 + 经历跟你简历对得上`
      : `Why match: industry + experience align with your resume`
  } else {
    primary = lang === "zh" ? "为啥推: 行业大方向匹配" : "Why match: industry direction matches"
  }

  // ---- Phase B4 — chips for company-pref + urgency signals ---------------
  // W5 — `targetCompanyTags` is typed on UserTagsSchema (Phase B1).
  const chips: string[] = []
  if (breakdown.tagOverlap > 0) {
    const hits = intersectTokens(user.targetCompanyTags, companyInfo?.tags)
    const segs = hits.join(", ")
    if (segs.length > 0) {
      chips.push(
        lang === "zh"
          ? `公司类型对得上：${segs}`
          : `Matches your company-type preference: ${segs}`,
      )
    }
  }
  if (breakdown.positiveHit > 0) {
    const display = job.companyName ?? ""
    if (display.length > 0) {
      chips.push(lang === "zh" ? `你关注的公司：${display}` : `Saved company: ${display}`)
    }
  }
  if (breakdown.urgencyBoost > 0) {
    chips.push(lang === "zh" ? "新发布的全职机会" : "Fresh full-time fit")
  }
  // Negative urgency NOT surfaced to user (spec — don't show negative signals).

  if (chips.length === 0) return primary
  return `${primary} · ${chips.join(" · ")}`
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export type QueryMatchingJobsV16Args = {
  userId: string
  /** Top-N jobs to return after sort. Default 10. */
  limit?: number
  /** Runtime message language override for generated user-facing reasons. */
  lang?: "zh" | "en"
  /** Pinned `now` for deterministic tests. Default `Date.now()`. */
  nowMs?: number
  /**
   * Phase 70 admin debug surface — partial overrides for V16_SCORE_WEIGHTS.
   * Missing keys fall back to canonical weights. Each value clamped to [0, 1]
   * by `scoreV16Job`. Default (undefined) preserves V16 default behaviour.
   */
  weightOverrides?: V16ScoreWeightOverrides
  /**
   * Broad candidate job-rec path only: when strict V16 produces zero jobs
   * and exact metro/location is the dominant blocker, relax only the exact
   * location intersection. Country, visa, dead, apply URL, and negative-list
   * gates remain hard.
   */
  allowBroadFallback?: boolean
  /**
   * Candidate-visible direct request focus, e.g. "frontend" or "fullstack".
   * This is a presentation eligibility gate, not a hard business gate:
   * it prevents "software engineering" requests from drifting into security,
   * SRE, data, or support roles when the user explicitly asks for a subtype.
   */
  presentationRoleFocus?: string[]
  /**
   * Collab funnel: keep only jobs where pa-jobs has
   * wekruitCollaborationStatus=collaborated and a non-empty prescreenConfig.
   */
  collabPrescreenOnly?: boolean
}

export type QueryMatchingJobsV16Deps = {
  db: Firestore
  log?: (event: string, payload?: Record<string, unknown>) => void
  /**
   * Whether to attach `embedding` field to projected jobs (used by cvEmbCosine
   * component). Default true; set false in tests where embeddings are absent.
   */
  includeEmbedding?: boolean
  /**
   * Phase B4 — optional override for the `pa-companies` lookup. Tests inject
   * a fake to avoid seeding the companies collection. Default: production
   * `loadCompaniesByName`.
   */
  loadCompaniesByNameImpl?: (
    db: Firestore,
    names: string[],
  ) => Promise<Map<string, LoadedCompanyInfo>>
  /**
   * SOFT-vs-HARD (2026-05-28) — injectable feature-flag reader for
   * `paPreferenceHardnessEnabled`. Production omits this and the default
   * binds to `@pa/pa-persistence#getFlag`; tests inject a stub. When the
   * resolved flag is not exactly `true`, the hardness subsystem stays OFF
   * (byte-identical to today). `db` is closed over from `deps.db`.
   */
  getFlag?: V16FlagChecker
}

const DEFAULT_LIMIT = 10

/** Fresh zeroed hard-filter counters (includes the SOFT-vs-HARD axes). */
function zeroV16Counters(): V16HardFilterCounters {
  return {
    visa: 0,
    location: 0,
    careerStage: 0,
    jobType: 0,
    freshness: 0,
    atsApplyUrl: 0,
    dead: 0,
    negativeListDrop: 0,
    roleTitleMismatch: 0,
    salary: 0,
    industrySector: 0,
    companyStage: 0,
  }
}
const PREVIOUS_RECOMMENDATION_BASE_PENALTY = 0.16
const PREVIOUS_RECOMMENDATION_REPEAT_PENALTY = 0.04
const PREVIOUS_RECOMMENDATION_MAX_PENALTY = 0.32

function hasConcreteRequirements(job: Pick<MatchingJob, "requiredSkills">): boolean {
  return Array.isArray(job.requiredSkills) &&
    job.requiredSkills.some((skill) => typeof skill === "string" && skill.trim().length > 0)
}

function normalizePresentationRoleFocus(values: string[] | undefined): Array<"frontend" | "fullstack" | "backend"> {
  const out: Array<"frontend" | "fullstack" | "backend"> = []
  for (const raw of values ?? []) {
    const value = raw.trim().toLowerCase()
    if ((value === "frontend" || value === "front-end" || value === "front end") && !out.includes("frontend")) {
      out.push("frontend")
    }
    if ((value === "fullstack" || value === "full-stack" || value === "full stack") && !out.includes("fullstack")) {
      out.push("fullstack")
    }
    if ((value === "backend" || value === "back-end" || value === "back end") && !out.includes("backend")) {
      out.push("backend")
    }
  }
  return out
}

function presentationRoleText(job: MatchingJob): string {
  const skills = Array.isArray(job.requiredSkills) ? job.requiredSkills.join(" ") : ""
  const industry = Array.isArray(job.industryEnum) ? job.industryEnum.join(" ") : ""
  // Use the title fallback helper — macmini scraper writes `roleTitle`,
  // legacy rows carry `jobTitle`. Without the chain the role-focus
  // keyword filter would silently degrade when the projector regressed.
  return `${getMatchingJobTitle(job)} ${skills} ${industry}`.toLowerCase()
}

function matchesPresentationRoleFocus(job: MatchingJob, focus: Array<"frontend" | "fullstack" | "backend">): boolean {
  if (focus.length === 0) return true
  const text = presentationRoleText(job)
  const hasFrontend =
    /\b(frontend|front-end|front end|ui engineer|web frontend|react|next\.?js|typescript|javascript|vue|angular)\b/i.test(text)
  const hasBackend =
    /\b(backend|back-end|back end|api|node\.?js|express|server-side|server side|postgres|postgresql|sql|database|java|go|python)\b/i.test(text)
  for (const item of focus) {
    if (item === "frontend" && hasFrontend) return true
    if (item === "backend" && hasBackend) return true
    if (item === "fullstack" && (/\b(fullstack|full-stack|full stack)\b/i.test(text) || (hasFrontend && hasBackend))) {
      return true
    }
  }
  return false
}

function previousRecommendationPenalty(state: UserJobRecommendationState | undefined): number {
  if (!state || state.recommendationCount <= 0) return 0
  return Math.min(
    PREVIOUS_RECOMMENDATION_MAX_PENALTY,
    PREVIOUS_RECOMMENDATION_BASE_PENALTY +
      Math.max(0, state.recommendationCount - 1) * PREVIOUS_RECOMMENDATION_REPEAT_PENALTY,
  )
}

type StrictCompanyPreference =
  | "startup"
  | "bigtech"
  | "seed"
  | "early_startup"
  | "scale_up"
  | "mid_market"
  | "enterprise"

/**
 * The user's company-size preferences as a SET (OR logic, Adam 2026-05-30) — normalizes the
 * scalar-or-array `companySize` + the boolean `prefersStartup`. Empty → no constraint.
 */
function strictCompanyPreferences(userTags: UserTags): StrictCompanyPreference[] {
  const out: StrictCompanyPreference[] = []
  for (const s of companySizeList(userTags)) {
    if (
      s === "seed" || s === "early_startup" || s === "scale_up" || s === "mid_market" || s === "enterprise"
    ) {
      out.push(s)
    }
  }
  // Explicit companySize wins (an OR set of real sizes); only fall back to the coarse boolean
  // prefersStartup when no real size was named — mirrors userCompanyStageBands' precedence.
  if (out.length > 0) return [...new Set(out)]
  if (userTags.prefersStartup === "startup") return ["startup"]
  if (userTags.prefersStartup === "bigtech") return ["bigtech"]
  return []
}

/** OR: keep a job if it matches ANY of the user's size prefs (companyMatchesStrictPreference already
 *  keeps not-in-corpus / unknown-stage companies, so this stays recall-safe). */
function companyMatchesAnyPreference(
  prefs: StrictCompanyPreference[],
  info: LoadedCompanyInfo | undefined,
): boolean {
  if (prefs.length === 0) return true
  return prefs.some((p) => companyMatchesStrictPreference(p, info))
}

function hasCompanyTag(info: LoadedCompanyInfo, tags: readonly string[]): boolean {
  const companyTags = new Set((info.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))
  return tags.some((tag) => companyTags.has(tag))
}

function companyMatchesStrictPreference(
  preference: StrictCompanyPreference,
  info: LoadedCompanyInfo | undefined
): boolean {
  // companySize is a SOFT preference (CLAUDE.md v1.6 locked match flow lists it under the additive
  // companyStageBoost, NOT the hard-filter chain; v2.0 rule "match score never blocks the first
  // interview"). This legacy HARD filter must therefore NEVER zero a candidate over company size:
  // KEEP any company we cannot confidently place OUTSIDE the preferred band — not in pa-companies
  // (`!info`) or unknown / un-staged. Only drop a company with a KNOWN, in-corpus stage that is
  // clearly outside the preference. (Recall fix 2026-05-30: user 8fE `early_startup` had ALL 114
  // hard-filter survivors dropped here because startups like Helium/VoiceCursor carry no stage →
  // read as unknown → false. The soft companyStageBoost still ranks true early-stage roles higher.)
  if (!info) return true
  const stage = info.stage
  // KEEP unknown / un-staged: can't confidently exclude → soft-keep (the yc_active/unicorn tag
  // signals folded here previously are now moot since unknown is always kept).
  if (!stage || stage === "unknown") return true
  switch (preference) {
    case "seed":
      return stage === "pre_seed" || stage === "seed"
    case "startup":
      return (
        stage === "pre_seed" ||
        stage === "seed" ||
        stage === "series_a" ||
        stage === "series_b"
      )
    case "early_startup":
      return (
        stage === "pre_seed" ||
        stage === "seed" ||
        stage === "series_a"
      )
    case "scale_up":
      return (
        stage === "series_b" ||
        stage === "series_c" ||
        stage === "series_d_plus"
      )
    case "bigtech":
    case "enterprise":
      return (
        stage === "ipo_public" ||
        stage === "private_mature" ||
        hasCompanyTag(info, ["big_tech", "mag_7"])
      )
    case "mid_market":
      return stage === "private_mature" || stage === "bootstrapped"
    default:
      return false
  }
}

/**
 * Internal: build the Firestore query from user tags + run it. Handles the
 * `targetRoleFunction`-empty case (admin / test users) by skipping the
 * array-contains-any filter (full-active scan, capped at 500).
 */
async function runV16Query(
  db: Firestore,
  userTags: UserTags,
  log: (event: string, payload?: Record<string, unknown>) => void
): Promise<{
  jobs: Array<MatchingJob & { embedding?: number[] | null }>
  rawCount: number
}> {
  // W5 — `targetRoleFunction` is typed on UserTagsSchema (W3 #117).
  const targetRoleFunction = Array.isArray(userTags.targetRoleFunction)
    ? userTags.targetRoleFunction.slice(0, ROLE_FUNCTION_QUERY_CAP)
    : []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = db.collection(MATCHING_JOBS_COLLECTION).where("status", "==", ACTIVE_STATUS)

  if (targetRoleFunction.length > 0) {
    q = q.where("roleFunction", "array-contains-any", targetRoleFunction)
    log("pa.match.role_function_filter", { targetRoleFunction })
  } else {
    log("pa.match.role_function_filter_skipped", { reason: "empty_target_role_function" })
  }

  // .select() the LEAN fields only — drops the 1536-float embedding + JD/quals text from the bulk
  // scan (~67MB → ~5MB). Embeddings for the few hard-filter survivors are loaded afterward
  // (loadSurvivorEmbeddings). See MATCH_LEAN_FIELDS.
  q = q.orderBy("firstSeenAt", "desc").limit(V16_FETCH_CAP).select(...MATCH_LEAN_FIELDS)

  let snap
  try {
    snap = await q.get()
  } catch (err) {
    // Composite-index failure — fall back to status-only + in-memory order.
    log("pa.match.query_compound_failed_fallback", {
      error: err instanceof Error ? err.message : String(err),
    })
    snap = await db
      .collection(MATCHING_JOBS_COLLECTION)
      .where("status", "==", ACTIVE_STATUS)
      .limit(V16_FETCH_CAP)
      .select(...MATCH_LEAN_FIELDS)
      .get()
  }

  const projected: Array<MatchingJob & { embedding?: number[] | null }> = []
  for (const doc of snap.docs) {
    try {
      const raw = doc.data() as Record<string, unknown>
      const m = projectMatchingJobRow(doc.id, raw)
      // Augment with v1.6 fields not yet in projectMatchingJobRow.
      const roleFunction = Array.isArray(raw.roleFunction)
        ? (raw.roleFunction.filter((s): s is string => typeof s === "string"))
        : undefined
      const industrySector = Array.isArray(raw.industrySector)
        ? (raw.industrySector.filter((s): s is string => typeof s === "string"))
        : undefined
      const relevantTags = Array.isArray(raw.relevantTags)
        ? (raw.relevantTags.filter((s): s is string => typeof s === "string"))
        : undefined
      const locationBuckets = Array.isArray(raw.locationBuckets)
        ? (raw.locationBuckets.filter((s): s is string => typeof s === "string"))
        : undefined
      const seniorityLevel =
        typeof raw.seniorityLevel === "string"
          ? (normalizeCareerStageToken(raw.seniorityLevel) ?? raw.seniorityLevel)
          : undefined
      const merged: MatchingJob & { embedding?: number[] | null } = {
        ...m,
        ...(roleFunction && roleFunction.length > 0 ? { roleFunction } : {}),
        ...(industrySector && industrySector.length > 0 ? { industrySector } : {}),
        ...(relevantTags && relevantTags.length > 0 ? { relevantTags } : {}),
        ...(locationBuckets && locationBuckets.length > 0 ? { locationBuckets } : {}),
        ...(seniorityLevel ? { seniorityLevel } : {}),
      }
      // Validate shape (Zod). Zod will tolerate the new optional fields per
      // the types.ts edits; bad rows still drop loudly.
      const validated = MatchingJobSchema.parse(merged) as MatchingJob & { embedding?: number[] | null }
      const e = raw.embedding
      if (Array.isArray(e) && e.every((n) => typeof n === "number")) {
        validated.embedding = e as number[]
      } else {
        validated.embedding = null
      }
      projected.push(validated)
    } catch (err) {
      log("pa.match.dropped_malformed_row", {
        id: doc.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { jobs: projected, rawCount: snap.docs.length }
}

/**
 * Load the `embedding` field for ONLY the hard-filter survivors (2026-05-30).
 *
 * The bulk scan is lean (no embeddings — MATCH_LEAN_FIELDS); the cvEmbCosine score component needs
 * the 1536-float vector, but only for the ≤N jobs that pass hard filters. `getAll` with a
 * `fieldMask` transfers ONLY the embedding field for those docs — so a 2-survivor turn loads ~24KB,
 * not the 67MB the old full scan hauled. Fail-graceful: any read error leaves embeddings null
 * (cvEmbCosine contributes 0, same as a job with no embedding on file) and never throws.
 */
async function loadSurvivorEmbeddings(
  db: Firestore,
  jobIds: string[],
  log: (event: string, payload?: Record<string, unknown>) => void
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>()
  const ids = [...new Set(jobIds.filter((id) => typeof id === "string" && id.length > 0))]
  if (ids.length === 0) return out
  try {
    const refs = ids.map((id) => db.collection(MATCHING_JOBS_COLLECTION).doc(id))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snaps = await (db as any).getAll(...refs, { fieldMask: ["embedding"] })
    for (const s of snaps) {
      const e = s.get?.("embedding") ?? s.data?.()?.embedding
      if (Array.isArray(e) && e.every((n: unknown) => typeof n === "number")) {
        out.set(s.id, e as number[])
      }
    }
  } catch (err) {
    log("pa.match.survivor_embedding_load_failed", {
      count: ids.length,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return out
}

function hasActivePrescreenConfig(data: Record<string, unknown> | undefined): boolean {
  const cfg = data?.prescreenConfig
  if (!cfg || typeof cfg !== "object") return false
  const questions = (cfg as { questions?: unknown }).questions
  return Array.isArray(questions) && questions.length > 0
}

async function loadCollabPrescreenEligibleJobIds(
  db: Firestore,
  jobIds: string[],
  log: (event: string, payload?: Record<string, unknown>) => void
): Promise<Set<string>> {
  const eligible = new Set<string>()
  const uniqueIds = [...new Set(jobIds.filter((id) => typeof id === "string" && id.trim().length > 0))]
  await Promise.all(
    uniqueIds.map(async (jobId) => {
      try {
        const snap = await db.collection(PA_JOBS_COLLECTION).doc(jobId).get()
        const data = snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined
        if (data?.wekruitCollaborationStatus === "collaborated" && hasActivePrescreenConfig(data)) {
          eligible.add(jobId)
        }
      } catch (err) {
        log("pa.match.collab_prescreen_read_failed", {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  )
  return eligible
}

/**
 * Collab priority (req #3, 2026-05-29) — read `pa-jobs/{jobId}` for the
 * surviving candidate set and return the set of jobIds whose
 * `wekruitCollaborationStatus === "collaborated"`. Used to drive the
 * `collabBoost` in scoring. Fail-graceful per job (a read error just means
 * that job is not treated as collab). Runs ONCE before the scoring loop; the
 * result is reused for `loadMatchSourceLabels` so we never read `pa-jobs`
 * twice.
 */
async function loadCollabJobIds(
  db: Firestore,
  jobIds: string[],
  log: (event: string, payload?: Record<string, unknown>) => void
): Promise<Set<string>> {
  const collab = new Set<string>()
  const uniqueIds = [...new Set(jobIds.filter((id) => typeof id === "string" && id.trim().length > 0))]
  await Promise.all(
    uniqueIds.map(async (jobId) => {
      try {
        const snap = await db.collection(PA_JOBS_COLLECTION).doc(jobId).get()
        const data = snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined
        if (data?.wekruitCollaborationStatus === "collaborated") collab.add(jobId)
      } catch (err) {
        log("pa.match.collab_status_read_failed", {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  )
  return collab
}

/**
 * Map jobIds → candidate-visible source label. When `collabJobIds` is supplied
 * (the set already resolved by `loadCollabJobIds` before scoring), the label
 * is derived from it WITHOUT a second `pa-jobs` read; otherwise it reads
 * `pa-jobs` per job (back-compat for callers that didn't pre-resolve).
 */
async function loadMatchSourceLabels(
  db: Firestore,
  jobIds: string[],
  log: (event: string, payload?: Record<string, unknown>) => void,
  collabJobIds?: Set<string>,
): Promise<Map<string, "WeKruit collaborated" | "general match">> {
  const labels = new Map<string, "WeKruit collaborated" | "general match">()
  const uniqueIds = [...new Set(jobIds.filter((id) => typeof id === "string" && id.trim().length > 0))]
  if (collabJobIds) {
    for (const jobId of uniqueIds) {
      labels.set(jobId, collabJobIds.has(jobId) ? "WeKruit collaborated" : "general match")
    }
    return labels
  }
  await Promise.all(
    uniqueIds.map(async (jobId) => {
      try {
        const snap = await db.collection(PA_JOBS_COLLECTION).doc(jobId).get()
        const data = snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined
        labels.set(
          jobId,
          data?.wekruitCollaborationStatus === "collaborated" ? "WeKruit collaborated" : "general match",
        )
      } catch (err) {
        log("pa.match.source_label_read_failed", {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        })
        labels.set(jobId, "general match")
      }
    })
  )
  return labels
}

/**
 * v1.6 entry point. Reads `pa-users/{userId}.tags` + executes the cascade.
 * Pure I/O orchestration on top of the deterministic helpers above.
 *
 * Behaviour contract:
 *   - User has no tags → `{ jobs: [], total: 0, dropped: 0, hardFilter: zeros, noUserTags: true }`
 *   - LLM cache stale → `llmCacheStale: true`, llmMatch component = 0
 *   - All caches missing → still produces ranked output via Jaccard + emb + salary
 *   - Composite-index failure → falls back to status-only query (logged)
 */
export async function queryMatchingJobsV16(
  args: QueryMatchingJobsV16Args,
  deps: QueryMatchingJobsV16Deps
): Promise<V16QueryResult> {
  const log = deps.log ?? (() => undefined)
  const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : DEFAULT_LIMIT
  const nowMs = typeof args.nowMs === "number" ? args.nowMs : Date.now()

  // SOFT-vs-HARD (2026-05-28) — resolve the per-user feature flag ONCE. When
  // not exactly `true` (default — no flag doc / no injected reader), the
  // hardness subsystem is entirely OFF and the matcher is byte-identical to
  // today. The reader is fail-open: any error → OFF.
  let preferenceHardnessEnabled = false
  try {
    const flagRead = deps.getFlag
      ? deps.getFlag(PREFERENCE_HARDNESS_FLAG_KEY, { userId: args.userId, env: process.env })
      : getFlag(deps.db, PREFERENCE_HARDNESS_FLAG_KEY, { userId: args.userId, env: process.env })
    preferenceHardnessEnabled = (await flagRead) === true
  } catch (err) {
    log("pa.match.preference_hardness_flag_error", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    preferenceHardnessEnabled = false
  }

  // 1. loadUserTags — single source.
  const loadedUserTags = await loadUserTags(deps.db, args.userId, log)
  if (!loadedUserTags) {
    return {
      jobs: [],
      total: 0,
      dropped: 0,
      hardFilter: zeroV16Counters(),
      noUserTags: true,
    }
  }
  const userTags = args.lang ? { ...loadedUserTags, preferredLang: args.lang } : loadedUserTags
  const initialMissingAxes = buildMissingAxes(userTags)
  if (!userTags.targetRoleFunction?.length) {
    log("pa.match.role_function_missing_return_empty", { userId: args.userId, missingAxes: initialMissingAxes })
    return {
      jobs: [],
      total: 0,
      dropped: 0,
      hardFilter: zeroV16Counters(),
      needsOnboarding: true,
      missingAxes: initialMissingAxes,
      userTags: userTags as unknown as Record<string, unknown>,
    }
  }

  // 2. Run query (push role to query layer).
  const { jobs: rawJobs } = await runV16Query(deps.db, userTags, log)

  // 3. Hard-filter chain — adaptive freshness cascade for thin corpora.
  // Try strict 20d (D10) first. When zero jobs survive AND freshness was the
  // killer, relax progressively (45d → 90d). Preserves D10 spec for happy path
  // while degrading gracefully when ingestion lags or seniorityLevel is sparse.
  const FRESHNESS_RELAX_LADDER = [
    FRESHNESS_WINDOW_MS,                                  // 20d (D10)
    45 * 24 * 3600 * 1000,                                // 45d
    90 * 24 * 3600 * 1000,                                // 90d
  ]
  let filteredJobs: MatchingJob[] = []
  let counters: V16HardFilterCounters = zeroV16Counters()
  let appliedFreshnessMs = FRESHNESS_RELAX_LADDER[0]!
  let relaxedHardFilters: string[] = []
  let fallbackApplied = false
  const runFreshnessLadder = (
    options: { relaxSpecificLocation?: boolean; careerStageRelax?: "strict" | "early_down" | "all" } = {},
  ) => {
    let kept: MatchingJob[] = []
    let lastCounters: V16HardFilterCounters = zeroV16Counters()
    let applied = FRESHNESS_RELAX_LADDER[0]!
    for (const win of FRESHNESS_RELAX_LADDER) {
      const result = applyV16HardFilters(rawJobs, userTags, nowMs, win, {
        ...options,
        preferenceHardnessEnabled,
      })
      kept = result.kept
      lastCounters = result.counters
      applied = win
      if (kept.length > 0) break
      // Relax only when freshness is the dominant blocker (counters.freshness >> 0).
      if (lastCounters.freshness === 0) break
      log("pa.match.freshness_relax", {
        attemptedWindowMs: win,
        droppedByFreshness: lastCounters.freshness,
        total: rawJobs.length,
        ...options,
      })
    }
    return { kept, counters: lastCounters, appliedFreshnessMs: applied }
  }

  const strictRun = runFreshnessLadder()
  filteredJobs = strictRun.kept
  counters = strictRun.counters
  appliedFreshnessMs = strictRun.appliedFreshnessMs

  const dominantLocationBlocker =
    counters.location > 0 &&
    counters.location >= counters.visa &&
    counters.location >= counters.careerStage &&
    counters.location >= counters.jobType &&
    counters.location >= counters.freshness &&
    counters.location >= counters.atsApplyUrl &&
    counters.location >= counters.dead &&
    counters.location >= counters.negativeListDrop

  if (filteredJobs.length === 0 && args.allowBroadFallback === true && dominantLocationBlocker) {
    const relaxedRun = runFreshnessLadder({ relaxSpecificLocation: true })
    if (relaxedRun.kept.length > 0) {
      filteredJobs = relaxedRun.kept
      counters = relaxedRun.counters
      appliedFreshnessMs = relaxedRun.appliedFreshnessMs
      relaxedHardFilters = ["specific_location"]
      log("pa.match.broad_fallback_location_relax", {
        total: rawJobs.length,
        output: filteredJobs.length,
        freshnessWindowDays: Math.round(appliedFreshnessMs / (24 * 3600 * 1000)),
      })
    }
  }

  // Recall fix (req #2, 2026-05-29) — careerStage relax ladder. The live bug:
  // a `junior`/`entry_level` candidate with no/anywhere location gets zeroed
  // because the corpus role-bucket skews intern-tagged (or noisy seniority).
  // Only escalate when careerStage is the DOMINANT zero-blocker AND the
  // candidate is early-career with no/anywhere location constraint (so we
  // never widen a senior/manager candidate's window, and we never widen when
  // location was actually the blocker — that's the location-relax path above).
  // Ladder rungs mirror the freshness ladder: early_down (one tier down to
  // include intern) → all (last-resort: skip the careerStage gate). The
  // upper window bound is never widened, so senior leakage is impossible.
  const userCareerStage = userTags.careerStage
  const userIsEarlyCareer =
    typeof userCareerStage === "string" &&
    (userCareerStage === "student" ||
      userCareerStage === "intern" ||
      userCareerStage === "entry_level" ||
      userCareerStage === "junior")
  const dominantCareerStageBlocker =
    counters.careerStage > 0 &&
    counters.careerStage >= counters.visa &&
    counters.careerStage >= counters.location &&
    counters.careerStage >= counters.jobType &&
    counters.careerStage >= counters.freshness &&
    counters.careerStage >= counters.atsApplyUrl &&
    counters.careerStage >= counters.dead &&
    counters.careerStage >= counters.negativeListDrop &&
    counters.careerStage >= counters.roleTitleMismatch
  if (
    filteredJobs.length === 0 &&
    userIsEarlyCareer &&
    isAnywhereLocation(userTags) &&
    dominantCareerStageBlocker
  ) {
    for (const rung of ["early_down", "all"] as const) {
      const relaxedRun = runFreshnessLadder({ careerStageRelax: rung })
      if (relaxedRun.kept.length > 0) {
        filteredJobs = relaxedRun.kept
        counters = relaxedRun.counters
        appliedFreshnessMs = relaxedRun.appliedFreshnessMs
        relaxedHardFilters = [...relaxedHardFilters, `career_stage_${rung}`]
        log("pa.match.career_stage_relax", {
          rung,
          total: rawJobs.length,
          output: filteredJobs.length,
          freshnessWindowDays: Math.round(appliedFreshnessMs / (24 * 3600 * 1000)),
        })
        break
      }
    }
  }

  // Market fallback (req #5, 2026-05-29) — last line of defense against
  // dead-silence. When the strict cascade + location relax + careerStage relax
  // ALL yield zero, run the relaxed fallback filter over the raw corpus
  // (keeps visa/country/freshness/atsApplyUrl/dead/negative gates, skips
  // location/careerStage/jobType). If it surfaces anything, use it so Claire
  // always has a real general-market role to offer. Self-contained inside the
  // matcher so `makeV16FindMatch` benefits with zero extra wiring. Runs the
  // freshness ladder too (20d → 45d → 90d) when freshness is the blocker.
  if (filteredJobs.length === 0) {
    let fbKept: MatchingJob[] = []
    let fbCounters = zeroV16Counters()
    let fbApplied = FRESHNESS_RELAX_LADDER[0]!
    for (const win of FRESHNESS_RELAX_LADDER) {
      const r = applyFallbackHardFilters(rawJobs, userTags, nowMs, win)
      fbKept = r.kept
      fbCounters = r.counters
      fbApplied = win
      if (fbKept.length > 0) break
      if (fbCounters.freshness === 0) break
    }
    if (fbKept.length > 0) {
      filteredJobs = fbKept
      counters = fbCounters
      appliedFreshnessMs = fbApplied
      fallbackApplied = true
      if (!relaxedHardFilters.includes("general_market_fallback")) {
        relaxedHardFilters = [...relaxedHardFilters, "general_market_fallback"]
      }
      log("pa.match.general_market_fallback", {
        total: rawJobs.length,
        output: filteredJobs.length,
        freshnessWindowDays: Math.round(appliedFreshnessMs / (24 * 3600 * 1000)),
      })
    }
  }
  const presentationRoleFocus = normalizePresentationRoleFocus(args.presentationRoleFocus)
  if (presentationRoleFocus.length > 0 && filteredJobs.length > 0) {
    const before = filteredJobs.length
    filteredJobs = filteredJobs.filter((job) => matchesPresentationRoleFocus(job, presentationRoleFocus))
    log("pa.match.presentation_role_focus_applied", {
      focus: presentationRoleFocus,
      before,
      after: filteredJobs.length,
      dropped: before - filteredJobs.length,
    })
  }

  // Phase B4 — one-shot pa-companies lookup for the surviving candidate set.
  // Missing/un-enriched companies are omitted from the Map; scoreV16Job
  // handles absent entries with neutral (0) tagOverlap.
  const loadCompaniesImpl = deps.loadCompaniesByNameImpl ?? loadCompaniesByName
  let companyInfoMap = new Map<string, LoadedCompanyInfo>()
  try {
    const names = filteredJobs.map((j) => j.companyName ?? "").filter((s) => s.length > 0)
    if (names.length > 0) companyInfoMap = await loadCompaniesImpl(deps.db, names)
  } catch (err) {
    log("pa.match.load_companies_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  // Company-stage / company-size preference. Two mutually-exclusive paths:
  //
  //   - Flag OFF (default): the legacy `companyMatchesStrictPreference` HARD
  //     filter runs exactly as before (drops jobs whose company stage is
  //     outside the preference, INCLUDING unknown / not-in-pa-companies). This
  //     is byte-identical to the pre-2026-05-28 behaviour.
  //
  //   - Flag ON: governed by `resolveHardness(companyStage)`. SOFT (default)
  //     → no drop here; the additive `companyStageBoost` in the scorer ranks
  //     adjacent stages lower instead. HARD → drop ONLY when the company has a
  //     REAL (non-unknown, in-pa-companies) stage outside band+buffer; unknown
  //     / not-in-pa-companies jobs are KEPT (spec §3.3).
  const companyPreferences = strictCompanyPreferences(userTags)
  if (!preferenceHardnessEnabled) {
    if (companyPreferences.length > 0 && filteredJobs.length > 0) {
      const before = filteredJobs.length
      filteredJobs = filteredJobs.filter((job) => {
        const companyInfo = companyInfoMap.get(normalizeCompanyName(job.companyName ?? ""))
        return companyMatchesAnyPreference(companyPreferences, companyInfo)
      })
      log("pa.match.company_preference_filter_applied", {
        preference: companyPreferences,
        before,
        after: filteredJobs.length,
        dropped: before - filteredJobs.length,
      })
    }
  } else {
    const companyStageHardness = resolveHardness(userTags, "companyStage")
    if (companyStageHardness.hardness === "hard" && filteredJobs.length > 0) {
      const bands = userCompanyStageBands(userTags)
      if (bands.length > 0) {
        const before = filteredJobs.length
        filteredJobs = filteredJobs.filter((job) => {
          const companyInfo = companyInfoMap.get(normalizeCompanyName(job.companyName ?? ""))
          const stageIdx = companyStageIndex(companyInfo?.stage)
          // KEEP unknown / not-in-pa-companies / non-fundable stage.
          if (stageIdx === null) return true
          // OR: keep if the stage is in ANY preferred band (+buffer).
          for (const band of bands) {
            if (stageIdx >= band.min && stageIdx <= band.max) return true
            const dist = stageIdx < band.min ? band.min - stageIdx : stageIdx - band.max
            if (dist <= Math.max(0, companyStageHardness.bufferSteps)) return true
          }
          counters.companyStage++
          return false
        })
        log("pa.match.company_stage_hard_filter_applied", {
          before,
          after: filteredJobs.length,
          dropped: before - filteredJobs.length,
          bufferSteps: companyStageHardness.bufferSteps,
        })
      }
    }
  }
  const dropped = rawJobs.length - filteredJobs.length
  log("pa.match.hard_filter_applied", {
    input: rawJobs.length,
    output: filteredJobs.length,
    dropped,
    counters,
    freshnessWindowDays: Math.round(appliedFreshnessMs / (24 * 3600 * 1000)),
  })

  // Cache reads run in parallel — all fail-graceful. The collab set (req #3)
  // is resolved ONCE here over the surviving candidate set and reused both for
  // the `collabBoost` in scoring and for `loadMatchSourceLabels` later (no
  // second pa-jobs read). On the general-market fallback path the survivors
  // are general market by selection — skip the read and treat the set as empty
  // so neither collabBoost nor a collab label can apply.
  const [jdRelCache, rerankCache, recommendationStates, collabJobIds, survivorEmbeddings] = await Promise.all([
    loadJdRelCache(deps.db, args.userId, log),
    loadLlmRerankCache(deps.db, args.userId, log),
    loadRecommendedJobStates(deps.db, args.userId, filteredJobs.map((job) => job.id), log),
    fallbackApplied
      ? Promise.resolve(new Set<string>())
      : loadCollabJobIds(deps.db, filteredJobs.map((job) => job.id), log),
    // The bulk scan was lean (no embeddings); load them ONLY for the hard-filter survivors so
    // cvEmbCosine still scores. includeEmbedding:false (tests w/o embeddings) skips it.
    deps.includeEmbedding === false
      ? Promise.resolve(new Map<string, number[]>())
      : loadSurvivorEmbeddings(deps.db, filteredJobs.map((job) => job.id), log),
  ])

  // Attach survivor embeddings so scoreV16Job's cvEmbCosine reads job.embedding (the bulk fetch
  // dropped it to keep the scan at ~5MB instead of ~67MB).
  for (const job of filteredJobs) {
    const e = survivorEmbeddings.get(job.id)
    if (e) (job as MatchingJob & { embedding?: number[] | null }).embedding = e
  }

  // 4. Soft score (Phase 70 weightOverrides + Phase B4 companyInfo/nowMs).
  let scored = filteredJobs.map((job) => {
    const jdRel = jdRelCache.get(job.id)
    const llmScore = rerankCache.map.get(job.id)
    const companyInfo = companyInfoMap.get(normalizeCompanyName(job.companyName ?? ""))
    const { breakdown, matched } = scoreV16Job(
      userTags,
      job,
      jdRel,
      llmScore,
      args.weightOverrides,
      companyInfo,
      nowMs,
      { enabled: preferenceHardnessEnabled },
      collabJobIds.has(job.id),
    )
    const recommendedState = recommendationStates.get(job.id)
    const repeatPenalty = previousRecommendationPenalty(recommendedState)
    const adjustedBreakdown: V16ScoreBreakdown = {
      ...breakdown,
      ...(repeatPenalty > 0 ? { previousRecommendationPenalty: repeatPenalty } : {}),
      total: breakdown.total - repeatPenalty,
    }
    return { job, breakdown: adjustedBreakdown, matched, companyInfo, recommendedState }
  })

  // Sort by total score desc; tie-break by firstSeenAt newer first.
  scored.sort((a, b) => {
    if (b.breakdown.total !== a.breakdown.total) return b.breakdown.total - a.breakdown.total
    const af = timestampToMs(a.job.firstSeenAt)
    const bf = timestampToMs(b.job.firstSeenAt)
    return bf - af
  })

  if (args.collabPrescreenOnly === true && scored.length > 0) {
    const eligible = await loadCollabPrescreenEligibleJobIds(
      deps.db,
      scored.map((s) => s.job.id),
      log
    )
    const before = scored.length
    scored = scored.filter((s) => eligible.has(s.job.id))
    log("pa.match.collab_prescreen_filter_applied", {
      before,
      after: scored.length,
      dropped: before - scored.length,
    })
  }

  // 5. Compose reasons for top-N. Dedup by (company,role-title) so the
  // same role posted twice (corpus duplicate) doesn't fill both rec slots
  // — Adam reported 2026-05-07 "Product Engineer - Gram @ speakeasy"
  // appearing twice in a single rec push.
  const seenDedupKeys = new Set<string>()
  const dedupedTop: typeof scored = []
  let missingRequirementsDrop = 0
  for (const s of scored) {
    if (!hasConcreteRequirements(s.job)) {
      missingRequirementsDrop++
      continue
    }
    // Title fallback (`jobTitle ?? roleTitle ?? ""`) — without it every
    // macmini-sourced job collapses to `company|` and the dedup set kills
    // all but the first job per company. See module header.
    const key = `${(s.job.companyName ?? "").toLowerCase()}|${getMatchingJobTitle(s.job).toLowerCase()}`
    if (seenDedupKeys.has(key)) continue
    seenDedupKeys.add(key)
    dedupedTop.push(s)
    if (dedupedTop.length >= limit) break
  }
  if (missingRequirementsDrop > 0) {
    log("pa.match.presentation_requirements_drop", {
      dropped: missingRequirementsDrop,
      reason: "missing_requiredSkills",
    })
  }
  // Reuse the `collabJobIds` set resolved before scoring — no second pa-jobs
  // read. On the fallback path `collabJobIds` is empty, so every fallback job
  // is labelled 'general match' (req #5: fallback jobs stay general match).
  const sourceLabels = await loadMatchSourceLabels(
    deps.db,
    dedupedTop.map((s) => s.job.id),
    log,
    collabJobIds,
  )
  const top = dedupedTop.map(({ job, breakdown, matched, companyInfo, recommendedState }) => {
    const reason = composeReason(userTags, job, matched, breakdown, companyInfo)
    const matchSourceLabel = sourceLabels.get(job.id) ?? "general match"
    return {
      ...job,
      matchSourceLabel,
      ...(recommendedState
        ? {
            previouslyRecommended: true,
            recommendationCount: recommendedState.recommendationCount,
            ...(recommendedState.lastRecommendedAt ? { lastRecommendedAt: recommendedState.lastRecommendedAt } : {}),
          }
        : {}),
      v16Score: breakdown,
      matchedSkills: matched.slice(0, 2),
      reason,
    }
  })

  // 2026-05-18 — `needsOnboarding` signal back to Claire. When the user has
  // not selected a `targetRoleFunction`, V16 silently falls back to firstSeenAt-
  // ordered retrieval, but Claire never knows to ask. Compute missingAxes
  // from the loaded tags so the orchestrator can inject "weave these questions
  // into your next 2-3 replies" into the system prompt.
  // 2026-05-28 — narrowed to the single true-required axis (`targetRoleFunction`).
  // Per Adam's "如果没写就不做 match 标准" directive, optional axes (location, visa,
  // careerStage, jobType) no longer flag `needsOnboarding`: a field the candidate
  // never provided must not block them or become a hard filter, and the hard
  // filters already no-op on absent optional signals. See `buildMissingAxes`.
  // When `targetRoleFunction` is present this list is empty, so a successfully-
  // matched user is never spuriously flagged as incomplete.
  const missingAxes = initialMissingAxes

  return {
    jobs: top,
    total: filteredJobs.length,
    dropped,
    hardFilter: counters,
    ...(rerankCache.stale ? { llmCacheStale: true as const } : {}),
    ...(relaxedHardFilters.length > 0 ? { relaxedHardFilters } : {}),
    ...(fallbackApplied ? { fallbackApplied: true as const } : {}),
    // Phase 70 — surface a snapshot of the user's tags so the admin
    // match-debug page can render the canonical profile alongside ranked
    // output. Cast through `unknown` so we can attach without leaking the
    // narrow UserTags type to non-orchestrator consumers.
    userTags: userTags as unknown as Record<string, unknown>,
    ...(missingAxes!.length > 0
      ? { needsOnboarding: true as const, missingAxes }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// LLM tool wrapper (Phase 68 — replaces legacy `createQueryMatchingJobsTool`).
//
// The recruiter agent (Claire) needs to call queryMatchingJobs as an
// LLM-bound tool to surface a sample job during onboarding. The legacy
// wrapper exposed `filters: {...}` to the LLM, but the v1.6 single-source
// design (D8) reads `pa-users.tags` and never accepts ad-hoc filters from
// the LLM. The V16 tool exposes only `limit` to the LLM; userId is
// injected from deps (the inbound CF knows who the candidate is).
// ---------------------------------------------------------------------------

export const QueryMatchingJobsV16ToolInputSchema = z.object({
  /** Top-N jobs to return. Default 1 (Claire previews a single sample). */
  limit: z.number().int().positive().max(20).default(1),
})
export type QueryMatchingJobsV16ToolInput = z.infer<typeof QueryMatchingJobsV16ToolInputSchema>

export type QueryMatchingJobsV16ToolDeps = {
  db: Firestore
  /** WeKruit user id — injected by the runtime caller, not the LLM. */
  userId: string
  log?: (event: string, payload?: Record<string, unknown>) => void
}

/**
 * Build an LLM tool whose name + description match the legacy
 * `queryMatchingJobs` contract (the prompt addendum still references it),
 * but whose execute path runs the v1.6 single-source cascade.
 *
 * Returns a JSON-serialized projection of the top-N jobs (id, title,
 * company, atsApplyUrl, salary, locationRaw, reason). Errors are returned
 * as `{ ok: false, reason }` so the LLM can surface a graceful fallback.
 */
export function createQueryMatchingJobsV16Tool(deps: QueryMatchingJobsV16ToolDeps) {
  const { tool } = require("@openai/agents") as typeof import("@openai/agents")
  return tool({
    name: "queryMatchingJobs",
    description:
      "Surface 1-3 ranked job matches for the candidate from WeKruit's matching-jobs corpus. " +
      "Reads the candidate's canonical tags (pa-users.tags) once and runs the v1.6 cascade " +
      "(roleFunction hard filter → visa/location/careerStage/jobType/freshness gates → " +
      "weighted score). Returns top-N jobs with title, company, ATS apply URL, and a one-line " +
      "reason explaining the match. Use this to preview a sample job during onboarding.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: QueryMatchingJobsV16ToolInputSchema as any,
    execute: async (raw: unknown) => {
      const args = QueryMatchingJobsV16ToolInputSchema.parse(raw)
      try {
        const out = await queryMatchingJobsV16(
          { userId: deps.userId, limit: args.limit, lang: "en", allowBroadFallback: true },
          { db: deps.db, ...(deps.log ? { log: deps.log } : {}) }
        )
        if (out.noUserTags) {
          return JSON.stringify({
            ok: false,
            reason: "no_user_tags",
            jobs: [],
          })
        }
        // Project a thin shape for the LLM (avoid leaking embeddings, raw
        // breakdowns). The LLM only needs to render a single sample line.
        const jobs = out.jobs.map((j) => ({
          id: j.id,
          // Title fallback — surface `roleTitle` when `jobTitle` is empty
          // so the LLM-facing payload never has a blank title.
          jobTitle: getMatchingJobTitle(j),
          companyName: j.companyName,
          atsApplyUrl: j.atsApplyUrl ?? null,
          locationRaw: j.locationRaw ?? "",
          salaryMin: j.salaryMin ?? null,
          salaryMax: j.salaryMax ?? null,
          reason: j.reason ?? "",
        }))
        return JSON.stringify({ ok: true, jobs, total: out.total })
      } catch (err) {
        return JSON.stringify({
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
          jobs: [],
        })
      }
    },
  })
}
