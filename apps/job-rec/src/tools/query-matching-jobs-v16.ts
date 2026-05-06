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
import type { UserTags } from "@pa/pa-orchestrator"
import { acceptableCareerStages, type CareerStage, CAREER_STAGE_VOCAB } from "@wekruit/shared-tags"
import {
  MatchingJobSchema,
  type MatchingJob,
  type V16ScoreBreakdown,
  type V16HardFilterCounters,
  type V16QueryResult,
  type MatchedSkillContribution,
} from "../types.js"
import { V16_SCORE_WEIGHTS } from "../match-weights.js"
import { projectMatchingJobRow } from "./query-matching-jobs.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Source-of-truth Firestore collection for the v1.6 single-source read. */
const PA_USERS_COLLECTION = "pa-users"
const MATCHING_JOBS_COLLECTION = "matching-jobs"
const ACTIVE_STATUS = "active"

/**
 * v1.6 fetch cap. Raised from legacy 50 to 500 (D9) so role-filtered top-50
 * doesn't accidentally fall back to all-sales rows when the role bucket has
 * a sales-heavy 50-item batch at the top.
 */
const V16_FETCH_CAP = 500

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
    return tags as UserTags
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

/** Anywhere bypass tokens (location intersect skipped when present in user). */
const ANYWHERE_LOCATION_TOKENS = new Set(["remote_anywhere", "remote_global", "anywhere", "any"])

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
 */
export function applyV16HardFilters(
  jobs: MatchingJob[],
  userTags: UserTags,
  nowMs: number = Date.now()
): { kept: MatchingJob[]; counters: V16HardFilterCounters } {
  const counters: V16HardFilterCounters = {
    visa: 0,
    location: 0,
    careerStage: 0,
    jobType: 0,
    freshness: 0,
    atsApplyUrl: 0,
    dead: 0,
  }
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { kept: [], counters }
  }

  // Pre-compute user-side once.
  const sponsorshipNeeded = isSponsorshipNeeded(userTags.visaStatus)
  const targetLocations = Array.isArray(userTags.targetLocations) ? userTags.targetLocations : []
  const isAnywhere = targetLocations.some((l) =>
    ANYWHERE_LOCATION_TOKENS.has(l.trim().toLowerCase())
  )
  const targetLocationSet = new Set(targetLocations.map((l) => l.trim().toLowerCase()))
  // careerStage window — only enforce when both user + job sides present.
  // careerStage / targetJobType are stamped via Phase 54 partial-update mappers
  // (typed `Record<string, unknown>` at write time), so they're not in the
  // narrow `UserTags` schema yet. Cast through `unknown` to a structural shape
  // for read-side access.
  const tagsExt = userTags as unknown as {
    careerStage?: string
    targetJobType?: string[]
    targetJobTypes?: string[]
    targetRoleFunction?: string[]
    relevantTags?: string[]
    minSalary?: number
  }
  const careerStage = tagsExt.careerStage
  const careerStageValid =
    typeof careerStage === "string" && (CAREER_STAGE_VOCAB as readonly string[]).includes(careerStage)
  const acceptableStages = careerStageValid ? new Set(acceptableCareerStages(careerStage as CareerStage)) : null
  const targetJobTypes = tagsExt.targetJobType ?? tagsExt.targetJobTypes ?? []
  const targetJobTypeSet = new Set(
    targetJobTypes.map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
  )

  const kept: MatchingJob[] = []
  for (const job of jobs) {
    // 1. visa intersect — only drop when user explicitly needs sponsorship
    //    AND job carries an explicit `sponsorship: false` signal.
    if (sponsorshipNeeded && job.sponsorship === false) {
      counters.visa++
      continue
    }

    // 2. location intersect (anywhere bypass).
    if (!isAnywhere && targetLocations.length > 0) {
      const jobLocs = Array.isArray(job.locationBuckets) ? job.locationBuckets : []
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

    // 3. careerStage window — enforce only when both sides present.
    if (acceptableStages && job.seniorityLevel) {
      if (!acceptableStages.has(job.seniorityLevel as CareerStage)) {
        counters.careerStage++
        continue
      }
    }

    // 4. jobType exact intersect — when user has targets AND job has type.
    if (targetJobTypeSet.size > 0 && job.jobType) {
      const jt = job.jobType.trim().toLowerCase()
      if (!targetJobTypeSet.has(jt)) {
        counters.jobType++
        continue
      }
    }

    // 5. firstSeenAt < 20d (D10).
    const firstSeenMs = timestampToMs(job.firstSeenAt)
    if (firstSeenMs === 0 || nowMs - firstSeenMs > FRESHNESS_WINDOW_MS) {
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
  userSkills: UserTags["skills"] | undefined,
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
 */
export function computeSalaryFit(userMin: number | undefined, jobMin: number | null | undefined): number {
  if (typeof userMin !== "number" || userMin <= 0) return 0.5
  if (typeof jobMin !== "number" || jobMin <= 0) return 0.5
  if (jobMin >= userMin) return 1.0
  const gap = userMin - jobMin
  return Math.max(0, 1 - gap / 50_000)
}

/**
 * Compute the v1.6 weighted score for one (user, job) pair. Pure /
 * deterministic; pass-through behaviour when caches are missing (jdRel=1.0,
 * llmRerank=0).
 */
export function scoreV16Job(
  user: UserTags,
  job: MatchingJob & { embedding?: number[] | null },
  jdRelative?: Record<string, number>,
  llmRerankScore?: number
): { breakdown: V16ScoreBreakdown; matched: MatchedSkillContribution[] } {
  const llm = typeof llmRerankScore === "number" && Number.isFinite(llmRerankScore)
    ? Math.max(0, Math.min(1, llmRerankScore))
    : 0
  const userExt = user as unknown as { relevantTags?: string[]; minSalary?: number }
  const skill = computeWeightedSkillJaccard(user.skills, job.requiredSkills, jdRelative)
  // user.relevantTags (Phase 54 partial-write field) is the primary source.
  // Fall back to relevantSpecialization / proposedTags so legacy users still
  // contribute to relevantTags axis until Phase 54 hooks fully populate it.
  const userRelTags =
    (Array.isArray(userExt.relevantTags) && userExt.relevantTags.length > 0
      ? userExt.relevantTags
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
  const salary = computeSalaryFit(userExt.minSalary, job.salaryMin)
  const total =
    llm * V16_SCORE_WEIGHTS.llmMatch +
    skill.score * V16_SCORE_WEIGHTS.skillJaccard +
    relTags * V16_SCORE_WEIGHTS.relevantTags +
    indSector * V16_SCORE_WEIGHTS.industrySector +
    cvEmb * V16_SCORE_WEIGHTS.cvEmbCosine +
    salary * V16_SCORE_WEIGHTS.salaryFit
  return {
    breakdown: {
      llmMatch: llm,
      skillJaccard: skill.score,
      relevantTags: relTags,
      industrySector: indSector,
      cvEmbCosine: cvEmb,
      salaryFit: salary,
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
  breakdown: V16ScoreBreakdown
): string {
  const lang = user.preferredLang === "en" ? "en" : "zh"
  const top = matched.slice(0, 2)

  if (top.length > 0) {
    const segs = top.map((m) => `${m.name}(${m.proficiency})`).join(" + ")
    if (lang === "zh") {
      return `为啥推: 你的 ${segs} 跟 JD 核心技能对得上`
    }
    return `Why match: your ${segs} aligns with JD core skills`
  }

  // Skill miss but industry / cv-emb covers — fall back to softer reason.
  if (breakdown.industrySector >= 0.4 || breakdown.cvEmbCosine >= 0.5) {
    if (lang === "zh") {
      return `为啥推: 行业方向 + 经历跟你简历对得上`
    }
    return `Why match: industry + experience align with your resume`
  }

  // Last resort.
  void job
  return lang === "zh" ? "为啥推: 行业大方向匹配" : "Why match: industry direction matches"
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export type QueryMatchingJobsV16Args = {
  userId: string
  /** Top-N jobs to return after sort. Default 10. */
  limit?: number
  /** Pinned `now` for deterministic tests. Default `Date.now()`. */
  nowMs?: number
}

export type QueryMatchingJobsV16Deps = {
  db: Firestore
  log?: (event: string, payload?: Record<string, unknown>) => void
  /**
   * Whether to attach `embedding` field to projected jobs (used by cvEmbCosine
   * component). Default true; set false in tests where embeddings are absent.
   */
  includeEmbedding?: boolean
}

const DEFAULT_LIMIT = 10

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
  const tagsExt = userTags as unknown as { targetRoleFunction?: string[] }
  const targetRoleFunction = Array.isArray(tagsExt.targetRoleFunction)
    ? tagsExt.targetRoleFunction.slice(0, ROLE_FUNCTION_QUERY_CAP)
    : []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = db.collection(MATCHING_JOBS_COLLECTION).where("status", "==", ACTIVE_STATUS)

  if (targetRoleFunction.length > 0) {
    q = q.where("roleFunction", "array-contains-any", targetRoleFunction)
    log("pa.match.role_function_filter", { targetRoleFunction })
  } else {
    log("pa.match.role_function_filter_skipped", { reason: "empty_target_role_function" })
  }

  q = q.orderBy("firstSeenAt", "desc").limit(V16_FETCH_CAP)

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
      const seniorityLevel = typeof raw.seniorityLevel === "string" ? raw.seniorityLevel : undefined
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

  // 1. loadUserTags — single source.
  const userTags = await loadUserTags(deps.db, args.userId, log)
  if (!userTags) {
    return {
      jobs: [],
      total: 0,
      dropped: 0,
      hardFilter: { visa: 0, location: 0, careerStage: 0, jobType: 0, freshness: 0, atsApplyUrl: 0, dead: 0 },
      noUserTags: true,
    }
  }

  // 2. Run query (push role to query layer).
  const { jobs: rawJobs } = await runV16Query(deps.db, userTags, log)

  // 3. Hard-filter chain.
  const { kept: filteredJobs, counters } = applyV16HardFilters(rawJobs, userTags, nowMs)
  const dropped = rawJobs.length - filteredJobs.length
  log("pa.match.hard_filter_applied", {
    input: rawJobs.length,
    output: filteredJobs.length,
    dropped,
    counters,
  })

  // Cache reads run in parallel — both fail-graceful.
  const [jdRelCache, rerankCache] = await Promise.all([
    loadJdRelCache(deps.db, args.userId, log),
    loadLlmRerankCache(deps.db, args.userId, log),
  ])

  // 4. Soft score.
  const scored = filteredJobs.map((job) => {
    const jdRel = jdRelCache.get(job.id)
    const llmScore = rerankCache.map.get(job.id)
    const { breakdown, matched } = scoreV16Job(userTags, job, jdRel, llmScore)
    return { job, breakdown, matched }
  })

  // Sort by total score desc; tie-break by firstSeenAt newer first.
  scored.sort((a, b) => {
    if (b.breakdown.total !== a.breakdown.total) return b.breakdown.total - a.breakdown.total
    const af = timestampToMs(a.job.firstSeenAt)
    const bf = timestampToMs(b.job.firstSeenAt)
    return bf - af
  })

  // 5. Compose reasons for top-N.
  const top = scored.slice(0, limit).map(({ job, breakdown, matched }) => {
    const reason = composeReason(userTags, job, matched, breakdown)
    return {
      ...job,
      v16Score: breakdown,
      matchedSkills: matched.slice(0, 2),
      reason,
    }
  })

  return {
    jobs: top,
    total: filteredJobs.length,
    dropped,
    hardFilter: counters,
    ...(rerankCache.stale ? { llmCacheStale: true as const } : {}),
  }
}
