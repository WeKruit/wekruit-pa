/**
 * Daily batch driver — invoked by `paJobRecDaily` Cloud Function (lives
 * in apps/functions because Firebase Functions can only be exported from
 * there). Pure logic; the CF wires Firestore + the feature-flag dep.
 *
 * Per-user flow:
 *   1. Read pa-job-profiles/{userId} → status === "active"
 *   2. Honor `paJobRecEnabled` perUser flag (allowlist gate)
 *   3. queryMatchingJobs(profile.filters, limit=5)
 *   4. Format a roommate-style 3-line message + bare URL on its own line
 *      (Bible v7.5.2 hard rule). NO LLM call — keeps the cron path cheap
 *      and deterministic.
 *   5. sendImessage with idempotency key `${userId}-${YYYYMMDD}-batch`
 *   6. Update lastJobBatchSentAt
 *
 * The cron processes profiles in pages (CF 60s budget). Per-user errors
 * are logged + skipped, never thrown — one user's bad data must not stop
 * the rest of the batch.
 */

import type { Firestore } from "firebase-admin/firestore"
import {
  queryMatchingJobs,
  applyTitleAntiBias,
  applyHardFiltersWithFallback,
  HARD_FILTERS_FLAG_KEY,
  projectMatchingJobRow,
  type HardFilterUserProfile,
} from "./tools/query-matching-jobs.js"
// Phase 60 — V16 single-source cascade. Replaces legacy queryMatchingJobs
// for users with `pa-users.tags`; falls back to legacy when the user has
// not yet been merged into the v1.6 single-source contract.
import { queryMatchingJobsV16 } from "./tools/query-matching-jobs-v16.js"
import { sendImessage } from "./tools/send-imessage.js"
import {
  buildJobCandidateText,
  buildRerankQuery,
  applyStartupBoost,
  userPreferStartup,
  type BoostExplanation,
  type CvExperience,
  type UserStartupSignal,
} from "./cross-encoder-rerank.js"
import {
  explainMatch,
  MATCH_EXPLAINER_FLAG_KEY,
  type ExplainMatchDeps,
  type ExplainerCv,
} from "./match-explainer.js"
import {
  JOB_PROFILES_COLLECTION,
  JOB_REC_FLAG_KEY,
  type JobProfileDoc,
  type MatchingJob,
} from "./types.js"
import {
  PA_TAG_CLUSTER_REC_FLAG_KEY,
} from "./tag-cluster-rec.js"
// v1.5 / Phase 53.5 — weighted skill match scoring (Adam 2026-05-02 spec).
import {
  AI_AGENT_SKILL_WEIGHTS,
  WEIGHTED_MATCH_FLAG_KEY,
  applyWeightedMatchBoost,
  type WeightedMatchExplanation,
} from "./match-weights.js"
// iter30/WS8 — Firestore-backed weight tables (dual-read behind flag).
import {
  BoostCalculator,
  WEIGHTS_FROM_FIRESTORE_FLAG_KEY,
} from "./boost-calculator.js"

export type FlagChecker = (
  db: Firestore,
  key: string,
  ctx: { userId?: string; env?: NodeJS.ProcessEnv },
  defaultValue: boolean
) => Promise<unknown>

export type DailyBatchDeps = {
  db: Firestore
  /** Production: pass `getFlag` from `@pa/pa-persistence`. Tests inject a stub. */
  getFlag: FlagChecker
  /** Override the date stamp used for idempotency keys (tests). */
  todayYmd?: () => string
  /** Cap users per invocation (CF timeout safety). Default 100. */
  userCap?: number
  /** Per-user job count. Default 3. */
  jobsPerUser?: number
  log?: (...args: unknown[]) => void
  /**
   * Stream F5 — optional embedding rerank. When provided + the user has
   * an embedding on file, candidates are re-sorted by cosine similarity
   * before formatting. Falls back to legacy keyword-overlap when absent.
   */
  userEmbedFetcher?: UserEmbedFetcher
  /**
   * Stream G1 — optional lazy compute + cache when fetcher returns null.
   * Receives (db, userId, resumeId, resumeText) and is expected to:
   *   1. Call OpenAI text-embedding-3-small (1536-d) on resumeText
   *   2. Write back to parsedCandidateResumes/{resumeId}.embedding
   *   3. Return the new embedding
   * Errors are caught; cascade falls back to legacy ranking.
   */
  userEmbedComputer?: UserEmbedComputer
  /**
   * Pre-rank candidate pool size. After Firestore filter + Jaccard rank
   * trims to this many, we cosine-rerank to jobsPerUser. Default 50.
   */
  candidatePoolSize?: number
  /**
   * Stream H10 — optional cross-encoder reranker. When provided, runs AFTER
   * cosine rerank (which trims pool to `crossEncoderPoolSize`). Cross-encoder
   * reorders by joint (query, doc) relevance — much sharper signal than
   * cosine for distinguishing role-titles like "QC Analyst" vs "Data
   * Analyst" that share token overlap but differ semantically.
   * Returns NEW order with relevance_score; null score means fail-open.
   */
  crossEncoderReranker?: CrossEncoderReranker
  /** Pool size handed to the cross-encoder. Default 10. */
  crossEncoderPoolSize?: number
  /**
   * Stream F (Phase 42) — optional injected ChatImpl + budget for the
   * async match-explainer. When omitted but the feature flag is ON,
   * runDailyJobRecBatch falls back to defaultChatImpl() (real fetch).
   * Tests inject a stubbed chatImpl to keep tests offline + deterministic.
   */
  matchExplainerChatImpl?: ExplainMatchDeps["chatImpl"]
  matchExplainerDailyBudgetUsd?: number
  /**
   * Phase 51 (v1.5 / Stream-G.2) — optional cluster-cache fetcher. When
   * provided AND paTagClusterRecEnabled flag is ON, replaces queryMatchingJobs
   * with cluster lookup. Empty result triggers fallback to queryMatchingJobs
   * (zero-regression). See tag-cluster-rec.ts for the production fetcher.
   */
  tagClusterFetcher?: TagClusterFetcher
}

export type BatchOutcome = {
  total: number
  delivered: number
  skippedFlag: number
  skippedNoJobs: number
  errors: number
}

const DEFAULT_USER_CAP = 100
const DEFAULT_JOBS_PER_USER = 3


// ---------------------------------------------------------------------------
// Stream F5 — Dual-shape profile normalizer + embedding-based reranker.
//
// Background: prior to Stream F, profiles were written by the deprecated
// RecruiterAgent in a 6-enum industry shape:
//
//   { industry: "tech"|"fintech"|..., sponsorship, location, sizePreference }
//
// Stream F's saveJobProfile connector writes a 10-tag shape:
//
//   { industryTags: ["tech_software", ...], sponsorshipNeeded: "H1B"|"GC"|"none",
//     locationPreference: "湾区"|..., sizePreference: "big"|"startup"|"mid"|"any",
//     salaryMin: number|null }
//
// daily-batch must accept BOTH shapes during the cutover. We normalize both
// to a stable internal type and feed query-matching-jobs the legacy filters
// it expects (industry: 6-enum, sponsorship, location, sizePreference,
// salaryMin?). When the new shape is detected, we map industryTags[0] to
// the 6-enum (best-effort) so the existing query path still hits its
// composite index, and surface industryTags via the rerank layer.
// ---------------------------------------------------------------------------

import type { JobIndustry, JobSizePreference, JobSponsorshipNeed } from "./types.js"

type NewShapeProfile = {
  industryTags: string[]
  sponsorshipNeeded: "H1B" | "GC" | "none"
  locationPreference: string
  sizePreference: "big" | "startup" | "mid" | "any"
  salaryMin: number | null
}

type LegacyProfile = {
  industry: JobIndustry
  sponsorship: JobSponsorshipNeed
  location: string
  sizePreference: JobSizePreference
  salaryMin?: number
}

export type NormalizedProfile = {
  industry: JobIndustry
  /** Stream F5 — full canonical 10-tag list, kept for embedding rerank + future where-in. */
  industryTags: string[]
  sponsorship: JobSponsorshipNeed
  location: string
  sizePreference: JobSizePreference
  salaryMin?: number
}

/**
 * Map a 10-tag canonical industry to the 6-enum legacy bucket the existing
 * query-matching-jobs composite index expects. Best-effort: anything that
 * doesn't have an obvious legacy bucket maps to "any".
 */
function ten10To6(tag: string): JobIndustry {
  switch (tag) {
    case "tech_software":
    case "tech_hardware":
    case "ai_ml":
      return "tech"
    case "fintech_finance":
      return "fintech"
    case "healthcare_biotech":
      return "healthtech"
    case "consumer_retail":
    case "media_entertainment":
      return "consumer"
    case "manufacturing_industrial":
    case "education":
    case "other":
    default:
      return "any"
  }
}

function map10To6Sponsorship(s: "H1B" | "GC" | "none"): JobSponsorshipNeed {
  if (s === "H1B") return "h1b"
  if (s === "GC") return "gc"
  return "none"
}

function map10To6Size(s: "big" | "startup" | "mid" | "any"): JobSizePreference {
  if (s === "big") return "bigtech"
  if (s === "startup") return "startup"
  // mid + any both fall into legacy "either" bucket
  return "either"
}

/**
 * Normalize either shape to a stable internal profile. Returns null when
 * the input is neither shape (corrupt doc).
 */
export function normalizeJobProfile(raw: unknown): NormalizedProfile | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  // New shape detection — industryTags array AND sponsorshipNeeded enum.
  if (Array.isArray(r.industryTags) && typeof r.sponsorshipNeeded === "string") {
    const p = r as unknown as NewShapeProfile
    const tags = p.industryTags.filter((t) => typeof t === "string")
    if (tags.length === 0) return null
    return {
      industry: ten10To6(tags[0]!),
      industryTags: tags,
      sponsorship: map10To6Sponsorship(p.sponsorshipNeeded),
      location: typeof p.locationPreference === "string" ? p.locationPreference : "",
      sizePreference: map10To6Size(p.sizePreference),
      ...(typeof p.salaryMin === "number" && p.salaryMin > 0 ? { salaryMin: p.salaryMin } : {}),
    }
  }
  // Legacy shape — industry string + sponsorship enum
  if (typeof r.industry === "string" && typeof r.sponsorship === "string") {
    const p = r as unknown as LegacyProfile
    return {
      industry: p.industry,
      industryTags: [p.industry],
      sponsorship: p.sponsorship,
      location: typeof p.location === "string" ? p.location : "",
      sizePreference: p.sizePreference,
      ...(typeof p.salaryMin === "number" && p.salaryMin > 0 ? { salaryMin: p.salaryMin } : {}),
    }
  }
  return null
}

/**
 * Compute cosine similarity between two embedding vectors. Returns 0 when
 * dimensions differ, either is empty, or magnitudes are zero. Pure / no
 * external state — exposed for unit tests.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!
    const bv = b[i]!
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function defaultLog(..._args: unknown[]): void {
  /* swallow */
}

function defaultTodayYmd(): string {
  const d = new Date()
  const y = d.getUTCFullYear().toString().padStart(4, "0")
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0")
  const day = d.getUTCDate().toString().padStart(2, "0")
  return `${y}${m}${day}`
}

/**
 * Format a single job into a roommate-style 3-line preview block.
 * Bible v7.5.2: bare URL on its own line, no markdown.
 */
export function formatJobLine(job: MatchingJob): string {
  const titleCo = `${job.jobTitle || "Role"} @ ${job.companyName || "Company"}`
  const loc = job.locationRaw ? ` (${job.locationRaw})` : ""
  const sal =
    typeof job.salaryMax === "number" && job.salaryMax > 0
      ? ` ~$${Math.round(job.salaryMax / 1000)}k`
      : ""
  // iter34 sprint A.2 — prefer real ATS apply URL; fall back to
  // primaryUrl (jobright.ai mirror) when ATS field is missing.
  return `- ${titleCo}${loc}${sal}\n${job.atsApplyUrl ?? job.primaryUrl}`
}

/** Compose the full daily-rec message body for a user. */
export function formatBatchMessage(jobs: MatchingJob[]): string {
  if (jobs.length === 0) return ""
  // Roommate tone, 3-sentence cap on the lead-in, then the job list with
  // bare URLs on their own lines (Bible v7.5.2).
  const lead =
    jobs.length === 1
      ? "今日给你挑了 1 个看上去对路的"
      : `今日给你挑了 ${jobs.length} 个看上去对路的`
  const blocks = jobs.map(formatJobLine).join("\n\n")
  return `${lead}:\n\n${blocks}`
}

// ---------------------------------------------------------------------------
// Stream H13 — friend-tone CV-aware daily-push opener.
//
// Replaces the robotic "今日给你挑了 3 个" lead-in with one of three variants
// based on (CV-known? × prefs-stated?) signals:
//
//   A. recentCompany + hasUserStatedPreferences → "看到这 3 个跟你之前说想找的
//      [targetRole] 对得上" + per-job concrete reason
//   B. recentCompany + !hasUserStatedPreferences → "嘿没问过你具体想找啥，看
//      你简历那段 [Company] 的 [Skill] 挺硬，今天发现这 3 个对得上：" + per-job reason
//   C. !recentCompany → keep current "今日给你挑了 X 个" + append gentle CV
//      nudge "(顺便发我看看简历不？我帮你过一遍)"
//
// ZERO new LLM calls in this path — per-job reasons are token-overlap
// heuristic only. (Full LLM-grounded match-explainer is D2/Phase 42, separate.)
//
// Bilingual zh/en symmetric. Bible v7.5.2 hard rule preserved (bare URL on
// its own line). 250-char cap applies to the LEAD-IN ONLY (not URLs/lines).
// ---------------------------------------------------------------------------

export type DailyPushContext = {
  candidateName?: string
  recentRoleTitle?: string
  recentCompany?: string
  /** First 3 from candidateProfile.skills. */
  topSkills?: string[]
  industryTags?: string[]
  hasUserStatedPreferences: boolean
  statedPreferences?: {
    targetRole?: string[]
    prefersStartup?: boolean
    visaStatus?: string
  }
  language: "zh" | "en"
  /**
   * Stream F (Phase 42) — pre-computed LLM-grounded reasons keyed by jobId.
   * When present and a key matches a job, formatJobLineWithReason prefers
   * this over the H13 buildJobReason heuristic. Absent / undefined map →
   * H13 heuristic path runs unchanged (zero regression off-flag).
   */
  reasons?: ReadonlyMap<string, string>
  /**
   * Phase 43 (v1.5 / Stream-C / D5) — true when applyHardFiltersWithFallback
   * landed on the prev-7-day fallback tier (no fresh survivors today). When
   * set, formatDailyPushBody picks the Variant D opener
   *   "我看你简历目前还没找到完美的 fit，但这 X 个之前推过的方向你可以再考虑下："
   * which bypasses the A/B/C CV-known × prefs-known routing.
   */
  fallbackMode?: boolean
  /**
   * Stream I (v1.5 / Phase 43.5) — per-job startup-vs-corp boost explanations.
   * Surfaced from applyStartupBoost; forward-compatible — current H13 formatter
   * ignores; future D2/H13.next can render "你的 startup 背景对得上 这家在 series A".
   * Empty/absent = no boost applied (off-flag, neutral user, or unknown jobs).
   */
  boostExplanations?: BoostExplanation[]
}

/**
 * Stream H13 — synthesize a 1-sentence concrete reason citing a CV fact.
 * Pure / deterministic, no LLM. Returns empty string when no clean signal
 * (we'd rather show a clean line than a forced "this matches because..." line).
 *
 * Signal hierarchy (first hit wins):
 *   1. exact case-insensitive skill overlap (job.requiredSkills ∩ topSkills) →
 *      "你 [Skill] 经验直接对得上"
 *   2. industry match (job.industryKey ∈ ctx.industryTags) → "和你之前 [Company]
 *      一个赛道"
 *   3. nothing — return ""
 */
export function buildJobReason(
  job: MatchingJob,
  ctx: DailyPushContext
): string {
  const lang = ctx.language
  const required = Array.isArray(job.requiredSkills) ? job.requiredSkills : []
  const requiredLower = new Set(required.map((s) => s.toLowerCase().trim()))
  const skills = Array.isArray(ctx.topSkills) ? ctx.topSkills : []
  for (const s of skills) {
    if (typeof s !== "string" || s.length === 0) continue
    if (requiredLower.has(s.toLowerCase().trim())) {
      return lang === "zh"
        ? `你 ${s} 经验直接对得上`
        : `your ${s} experience lines up directly`
    }
  }
  // Industry match — coarser signal, only fire when we have a recentCompany
  // to anchor the reason to.
  const industryTags = Array.isArray(ctx.industryTags) ? ctx.industryTags : []
  const jobIndustryKey = (job.industryKey ?? "").toLowerCase().trim()
  if (jobIndustryKey && industryTags.some((t) => t.toLowerCase().trim() === jobIndustryKey) && ctx.recentCompany) {
    return lang === "zh"
      ? `和你之前 ${ctx.recentCompany} 一个赛道`
      : `same lane as your ${ctx.recentCompany} stint`
  }
  return ""
}

/**
 * Stream H13 — format a job line with optional inline reason.
 * Bare URL on its own line stays (Bible v7.5.2). Reason (if any) is
 * appended to the title-line with " — <reason>" so the URL line is
 * unchanged for downstream parsers.
 */
export function formatJobLineWithReason(
  job: MatchingJob,
  ctx: DailyPushContext
): string {
  const titleCo = `${job.jobTitle || "Role"} @ ${job.companyName || "Company"}`
  const loc = job.locationRaw ? ` (${job.locationRaw})` : ""
  const sal =
    typeof job.salaryMax === "number" && job.salaryMax > 0
      ? ` ~$${Math.round(job.salaryMax / 1000)}k`
      : ""
  // Stream F (Phase 42) — prefer LLM reason from ctx.reasons[jobId]; fall
  // back to the H13 token-overlap heuristic. Empty string from either path
  // renders cleanly (no " — " suffix), matching pre-Phase-42 output.
  const llmReason = ctx.reasons?.get(job.id) ?? ""
  const reason = llmReason || buildJobReason(job, ctx)
  const reasonSuffix = reason ? ` — ${reason}` : ""
  // iter34 sprint A.2 — same atsApplyUrl-preferred fallback as formatJobLine.
  return `- ${titleCo}${loc}${sal}${reasonSuffix}\n${job.atsApplyUrl ?? job.primaryUrl}`
}

/** Lead-in length cap (chars). Bible v7.5 3-sentence ceiling. */
const LEAD_IN_CHAR_CAP = 250

/**
 * Stream H13 — friend-tone CV-aware body composer. Routes to one of three
 * variants based on ctx.recentCompany × ctx.hasUserStatedPreferences and
 * synthesizes the lead-in. Per-job lines call formatJobLineWithReason.
 *
 * Returns "" when jobs is empty (matches formatBatchMessage contract).
 */
export function formatDailyPushBody(
  jobs: MatchingJob[],
  ctx: DailyPushContext
): string {
  if (jobs.length === 0) return ""
  const n = jobs.length
  const zh = ctx.language === "zh"

  let lead: string
  if (ctx.fallbackMode) {
    // Phase 43 / D2 / D5 — Variant D: prev-7-day fallback opener. Honest
    // friend tone — admit we didn't land a perfect fit today, point at the
    // recycled set as a re-consideration nudge. Bypasses the A/B/C router
    // because fallback state is meta-information that dominates.
    lead = zh
      ? `我看你简历目前还没找到完美的 fit，但这 ${n} 个之前推过的方向你可以再考虑下：`
      : `Couldn't land a perfect fit today, but here are ${n} previously-shared angles worth a second look:`
  } else if (ctx.recentCompany && ctx.hasUserStatedPreferences) {
    // Variant A — both CV + stated prefs.
    const targetRole = ctx.statedPreferences?.targetRole?.[0]
    if (zh) {
      lead = targetRole
        ? `今天看到这 ${n} 个跟你之前说想找的${targetRole}方向对得上：`
        : `今天看到这 ${n} 个跟你之前说的方向对得上：`
    } else {
      lead = targetRole
        ? `Spotted ${n} that line up with the ${targetRole} angle you mentioned:`
        : `Spotted ${n} that fit the direction you mentioned:`
    }
  } else if (ctx.recentCompany) {
    // Variant B — CV-known, prefs-unknown. Names recentCompany + topSkills[0].
    const skill0 = ctx.topSkills?.[0]
    if (zh) {
      lead = skill0
        ? `嘿，没具体问过你想找啥，看你简历那段 ${ctx.recentCompany} 的 ${skill0} 挺硬，今天发现这 ${n} 个对得上：`
        : `嘿，没具体问过你想找啥，看你简历 ${ctx.recentCompany} 那段挺有料，今天发现这 ${n} 个对得上：`
    } else {
      lead = skill0
        ? `Hey — haven't asked what you're after exactly, but your ${skill0} stretch at ${ctx.recentCompany} looked solid; here are ${n} that line up:`
        : `Hey — haven't asked what you're after exactly, but your ${ctx.recentCompany} stint looked solid; here are ${n} that line up:`
    }
  } else {
    // Variant C — no CV signal. Keep legacy lead, append gentle nudge.
    const base = zh
      ? n === 1
        ? "今日给你挑了 1 个看上去对路的"
        : `今日给你挑了 ${n} 个看上去对路的`
      : n === 1
        ? "Picked 1 that looks on point today"
        : `Picked ${n} that look on point today`
    const nudge = zh
      ? "（顺便发我看看简历不？我帮你过一遍）"
      : " (btw — wanna send me your CV? happy to give it a once-over)"
    lead = zh ? `${base}${nudge}：` : `${base}.${nudge}:`
  }

  // Defensive cap on lead-in only (URLs/job lines untouched).
  if (lead.length > LEAD_IN_CHAR_CAP) {
    lead = lead.slice(0, LEAD_IN_CHAR_CAP - 1) + "…"
  }

  const blocks = jobs.map((j) => formatJobLineWithReason(j, ctx)).join("\n\n")
  return `${lead}\n\n${blocks}`
}

/**
 * Stream H13 — load DailyPushContext from Firestore. Best-effort: any
 * lookup error silently produces a context with hasUserStatedPreferences=false
 * and language="zh". Pulls:
 *   - parsedCandidateResumes (latest by userId,createdAt) → recentRoleTitle,
 *     recentCompany, topSkills, candidateName, industryTags
 *   - pa-users/{userId} → preferredLanguage, statedPreferences (D5/D13;
 *     when absent we set hasUserStatedPreferences=false)
 *
 * Note on D5/D13: pa-users.statedPreferences is the v1.5 onboarding-probe
 * landing zone (Phase 44). Until that lands, hasUserStatedPreferences will
 * read false for everyone → Variant B is the de-facto path for CV-known
 * users, which is exactly what Adam asked for in the H13 brief.
 */
export async function loadDailyPushContext(
  db: Firestore,
  userId: string,
  industryTags: string[],
  log?: (...args: unknown[]) => void
): Promise<DailyPushContext> {
  const ctx: DailyPushContext = {
    industryTags,
    hasUserStatedPreferences: false,
    language: "zh",
  }
  // 1. Resume — recentRole / recentCompany / topSkills / name.
  try {
    const snap = await db
      .collection("parsedCandidateResumes")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get()
    if (!snap.empty) {
      const rd = snap.docs[0]!.data() as Record<string, unknown>
      const exps = Array.isArray(rd.experiences) ? rd.experiences : []
      if (exps.length > 0) {
        const e0 = exps[0] as Record<string, unknown>
        if (typeof e0.title === "string" && e0.title.length > 0) {
          ctx.recentRoleTitle = e0.title
        }
        if (typeof e0.company === "string" && e0.company.length > 0) {
          ctx.recentCompany = e0.company
        }
      }
      const cp = (rd.candidateProfile ?? {}) as Record<string, unknown>
      if (typeof cp.name === "string" && cp.name.length > 0) {
        ctx.candidateName = cp.name
      }
      if (Array.isArray(cp.skills)) {
        const skills = (cp.skills as unknown[])
          .filter((x) => typeof x === "string" && (x as string).length > 0)
          .slice(0, 3) as string[]
        if (skills.length > 0) ctx.topSkills = skills
      }
    }
  } catch (err) {
    log?.("[job-rec-daily] daily_push_ctx_resume_lookup_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  // 2. pa-users — preferredLanguage + statedPreferences (D5/D13 forward).
  try {
    const userDoc = await db.collection("pa-users").doc(userId).get()
    if (userDoc.exists) {
      const ud = userDoc.data() as Record<string, unknown>
      if (ud.preferredLanguage === "en") ctx.language = "en"
      const sp = ud.statedPreferences
      if (sp && typeof sp === "object") {
        const sprec = sp as Record<string, unknown>
        const hasAny =
          (Array.isArray(sprec.targetRole) && sprec.targetRole.length > 0) ||
          typeof sprec.prefersStartup === "boolean" ||
          typeof sprec.visaStatus === "string"
        if (hasAny) {
          ctx.hasUserStatedPreferences = true
          ctx.statedPreferences = {
            ...(Array.isArray(sprec.targetRole)
              ? {
                  targetRole: (sprec.targetRole as unknown[]).filter(
                    (x) => typeof x === "string"
                  ) as string[],
                }
              : {}),
            ...(typeof sprec.prefersStartup === "boolean"
              ? { prefersStartup: sprec.prefersStartup }
              : {}),
            ...(typeof sprec.visaStatus === "string"
              ? { visaStatus: sprec.visaStatus }
              : {}),
          }
        }
      }
    }
  } catch (err) {
    log?.("[job-rec-daily] daily_push_ctx_user_lookup_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return ctx
}

/** Stream H13 — feature flag key for friend-tone opener. Default true. */
export const FRIEND_TONE_OPENER_FLAG_KEY = "paFriendToneOpenerEnabled"

/** Stream I (v1.5 / Phase 43.5) — startup-vs-corp boost flag. Default OFF;
 *  ramp 1% → 100% via Firestore feature-flags doc. Rollback = flag flip;
 *  weights live in BOOST_WEIGHTS CONST in cross-encoder-rerank.ts. */
export const STARTUP_BOOST_FLAG_KEY = "paStartupBoostEnabled"


/**
 * Stream F5 — Embedding rerank deps. All optional; when omitted the cron
 * silently falls back to the legacy keyword-overlap ranking from
 * queryMatchingJobs (no behavioral regression for users without an
 * embedding on file).
 *
 * The userEmbedFetcher reads the most-recent parsedCandidateResumes doc
 * for `userId`. If it has `embedding` (1536-d, OpenAI text-embedding-3-
 * small), we use it. If absent and `userEmbedComputer` is provided, we
 * compute on demand and cache back to the resume doc. If both miss, we
 * skip rerank for that user and use legacy ranking.
 */
export type UserEmbedFetcher = (
  db: Firestore,
  userId: string
) => Promise<{ embedding: number[] | null; resumeId: string | null }>

export type UserEmbedComputer = (
  db: Firestore,
  userId: string,
  resumeId: string,
  resumeText: string
) => Promise<number[] | null>

/**
 * Stream H10 — cross-encoder reranker dep. Pure function returning
 * relevance-sorted (id, score) pairs. score === null means fail-open from
 * the underlying API; daily-batch then preserves cosine order.
 */
export type CrossEncoderReranker = (
  query: string,
  candidates: Array<{ id: string; text: string }>
) => Promise<Array<{ id: string; score: number | null }>>


/**
 * Phase 51 (v1.5 / Stream-G.2) — tag cluster fetcher. Replaces the
 * per-user `queryMatchingJobs` Firestore-where scan with a cluster-cache
 * lookup. Returns [] when no cluster doc exists (or none match the user's
 * tags) → daily-batch falls back to legacy queryMatchingJobs path
 * (zero-regression contract).
 *
 * Flag-gated by paTagClusterRecEnabled. Wire production fetcher in
 * apps/functions/src/job-rec-daily.ts; tests inject a stub.
 */
export type TagClusterFetcher = (
  userTags: {
    industryTags: readonly string[]
    /**
     * Phase 51 alignment fix — JobProfile.sponsorship enum value
     * ("h1b" | "gc" | "none" | "either"). Drives which sponsorship
     * cluster buckets the user fans out into. Optional/null → fan out
     * across all 3 buckets (sponsor/no-sponsor/unknown).
     */
    sponsorship?: string | null
    skills: readonly string[]
    userEmbedding?: readonly number[] | null
  },
  k: number
) => Promise<Array<MatchingJob & { embedding?: number[] | null }>>


/**
 * Stream G1 — internal helper. Loads the parsed-resume doc by id and
 * returns a compact text suitable for OpenAI text-embedding-3-small.
 * Composes from candidateProfile + first 3 experiences. Returns null on
 * any error or when the doc is missing the required fields.
 */
async function loadResumeTextForEmbed(
  db: Firestore,
  resumeId: string
): Promise<string | null> {
  try {
    const snap = await db.collection("parsedCandidateResumes").doc(resumeId).get()
    if (!snap.exists) return null
    const d = snap.data() as Record<string, unknown> | undefined
    if (!d) return null
    const p = (d.candidateProfile ?? {}) as Record<string, unknown>
    const exps = Array.isArray(d.experiences) ? d.experiences.slice(0, 3) : []
    const skills = Array.isArray(p.skills) ? (p.skills as unknown[]).filter((x) => typeof x === "string").slice(0, 12) : []
    const expsText = exps
      .map((e) => {
        const x = e as Record<string, unknown>
        return `${String(x.title ?? "")} at ${String(x.company ?? "")} (${String(x.startDate ?? "")}-${String(x.endDate ?? "")}). ${String(x.description ?? "").slice(0, 240)}`
      })
      .join("\n")
    const text = [
      `Name: ${String(p.name ?? "")}`,
      `Location: ${String(p.location ?? "")}`,
      `Skills: ${skills.join(", ")}`,
      `Experiences:\n${expsText}`,
    ].join("\n").trim()
    return text.length >= 30 ? text : null
  } catch {
    return null
  }
}

/**
 * Default fetcher — Firestore lookup, no compute. Returns the most-recent
 * parsed resume's embedding when present.
 */
export async function defaultUserEmbedFetcher(
  db: Firestore,
  userId: string
): Promise<{ embedding: number[] | null; resumeId: string | null }> {
  try {
    const snap = await db
      .collection("parsedCandidateResumes")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get()
    if (snap.empty) return { embedding: null, resumeId: null }
    const doc = snap.docs[0]!
    const data = doc.data() as Record<string, unknown>
    const emb = Array.isArray(data.embedding) ? (data.embedding as unknown[]) : null
    if (emb && emb.every((n) => typeof n === "number")) {
      return { embedding: emb as number[], resumeId: doc.id }
    }
    return { embedding: null, resumeId: doc.id }
  } catch {
    return { embedding: null, resumeId: null }
  }
}

/**
 * Rerank a candidate set by cosine(user, job) and take the top N.
 * Pure / deterministic. Jobs without an embedding (or with a wrong-dim
 * one) are scored 0 — they sink to the back behind anything with a
 * matching-dim embedding.
 */
export function rerankByCosine(
  jobs: Array<MatchingJob & { embedding?: number[] | null }>,
  userEmbedding: readonly number[],
  limit: number
): MatchingJob[] {
  if (!Array.isArray(userEmbedding) || userEmbedding.length === 0) {
    return jobs.slice(0, limit)
  }
  const scored = jobs.map((j) => {
    const e = j.embedding
    const score =
      Array.isArray(e) && e.length === userEmbedding.length
        ? cosineSimilarity(userEmbedding, e)
        : 0
    return { j, s: score }
  })
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, limit).map((x) => x.j)
}

// ---------------------------------------------------------------------------
// Phase 43 (v1.5 / Stream-C) — daily-batch helpers for hard filters.
//
// loadHardFilterProfile: assembles a HardFilterUserProfile from
//   - pa-users/{userId}.statedPreferences (Phase 44 ship; may be absent)
//   - parsedCandidateResumes (latest by userId,createdAt) → experiences[]
// Best-effort: any lookup error returns a profile with both fields absent
// → applyHardFilters then operates as a no-op (pure conservative behavior).
//
// fetchPrevious7DayJobs: pulls active matching-jobs with firstSeenAt within
// the last 7 days, deduped against today's run via the firestore where
// clause. Used ONLY when the hard-filter relax ladder hits the prev7d tier
// (sparse — <1% of users on warm corpus). Re-uses the existing
// projectMatchingJobRow path so the shape is consistent with queryMatchingJobs.
// ---------------------------------------------------------------------------

async function loadHardFilterProfile(
  db: Firestore,
  userId: string,
  log: (...args: unknown[]) => void
): Promise<HardFilterUserProfile> {
  const profile: HardFilterUserProfile = {}
  try {
    const userDoc = await db.collection("pa-users").doc(userId).get()
    if (userDoc.exists) {
      const ud = userDoc.data() as Record<string, unknown>
      const sp = ud.statedPreferences
      if (sp && typeof sp === "object") {
        // Pass the raw map through — applyHardFilters only reads optional
        // fields and is defensive about types. Avoids re-importing the
        // StatedPreferences zod schema for runtime parsing in the hot path.
        profile.statedPreferences = sp as HardFilterUserProfile["statedPreferences"]
      }
    }
  } catch (err) {
    log("[job-rec-daily] hard_filter_profile_user_lookup_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  try {
    const snap = await db
      .collection("parsedCandidateResumes")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get()
    if (!snap.empty) {
      const rd = snap.docs[0]!.data() as Record<string, unknown>
      const exps = Array.isArray(rd.experiences) ? rd.experiences : []
      profile.experiences = exps
        .map((e) => {
          const x = (e ?? {}) as Record<string, unknown>
          return {
            startDate: typeof x.startDate === "string" ? x.startDate : undefined,
            endDate: typeof x.endDate === "string" ? x.endDate : undefined,
          }
        })
        .filter((e) => e.startDate !== undefined || e.endDate !== undefined)
    }
  } catch (err) {
    log("[job-rec-daily] hard_filter_profile_resume_lookup_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return profile
}

async function fetchPrevious7DayJobs(
  db: Firestore,
  industryTags: string[] | undefined,
  take: number,
  log: (...args: unknown[]) => void
): Promise<MatchingJob[]> {
  const cutoffMs = Date.now() - 7 * 24 * 3600 * 1000
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10) // YYYY-MM-DD
  try {
    // Reuse the same query shape as queryMatchingJobs but without the
    // top-N cap pressure — we already know hard-filter dropped everything
    // fresh. Skip industryEnum/Key gate for the fallback to keep recall
    // wide; the fallback opener acknowledges the recycled set.
    let q = db
      .collection("matching-jobs")
      .where("status", "==", "active")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q = (q as any)
      .orderBy("firstSeenAt", "desc")
      .limit(Math.max(take, 10))
    const snap = await q.get()
    const out: MatchingJob[] = []
    for (const doc of snap.docs) {
      try {
        const raw = doc.data() as Record<string, unknown>
        const fs = typeof raw.firstSeenAt === "string" ? raw.firstSeenAt : ""
        if (fs && fs < cutoff) continue
        const m = projectMatchingJobRow(doc.id, raw)
        out.push(m)
        if (out.length >= take) break
      } catch (err) {
        log("[job-rec-daily] prev7d_dropping_malformed_row", {
          id: doc.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    void industryTags // reserved for future tier-3 industry filter; unused today
    return out
  } catch (err) {
    log("[job-rec-daily] prev7d_query_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

/** Run one batch. Caller owns scheduling. */
export async function runDailyJobRecBatch(deps: DailyBatchDeps): Promise<BatchOutcome> {
  const log = deps.log ?? defaultLog
  const todayYmd = (deps.todayYmd ?? defaultTodayYmd)()
  const cap = deps.userCap ?? DEFAULT_USER_CAP
  const jobsPerUser = deps.jobsPerUser ?? DEFAULT_JOBS_PER_USER

  const snap = await deps.db
    .collection(JOB_PROFILES_COLLECTION)
    .where("status", "==", "active")
    .limit(cap)
    .get()

  log("[job-rec-daily] loaded_active_profiles", { count: snap.size })

  let delivered = 0
  let skippedFlag = 0
  let skippedNoJobs = 0
  let errors = 0

  for (const doc of snap.docs) {
    const profileDoc = doc.data() as JobProfileDoc & { profile?: unknown }
    const userId = profileDoc.userId
    try {
      const flagOn = Boolean(
        await deps.getFlag(
          deps.db,
          JOB_REC_FLAG_KEY,
          { userId, env: process.env },
          false
        )
      )
      if (!flagOn) {
        skippedFlag += 1
        continue
      }

      // Stream F5 — normalize legacy + new-shape profiles to one filter set.
      const normalized = normalizeJobProfile(profileDoc.profile)
      if (!normalized) {
        log("[job-rec-daily] skipping_corrupt_profile", { userId })
        errors += 1
        continue
      }

      // Stream F5 — pull a wider candidate pool when rerank is wired.
      // Capped at 20 to honor QueryMatchingJobsInputSchema's LLM-facing
      // .max(20) — daily-batch is internal but reuses the same query path.
      const poolSize = deps.userEmbedFetcher
        ? Math.min(20, Math.max(jobsPerUser, deps.candidatePoolSize ?? 20))
        : jobsPerUser

      // Phase 60 — V16 single-source cascade (CLAUDE.md D8). When the user
      // has `pa-users.tags`, the V16 entry reads it once and runs the
      // canonical role → hard-filter → weighted-score → reason pipeline.
      // V16 short-circuits the rest of the legacy ranking (cosine /
      // cross-encoder / startup-boost / weighted-skill-match / anti-bias)
      // because its scoring already incorporates those signals via
      // `V16_SCORE_WEIGHTS` (llmMatch + skillJaccard + relevantTags +
      // industrySector + cvEmbCosine + salaryFit).
      //
      // Fallback: when `noUserTags: true` is returned (user has not yet
      // been migrated into the v1.6 single source), drop through to the
      // legacy queryMatchingJobs path so the user still gets recs — zero
      // regression for the migration window.
      let v16Jobs: MatchingJob[] | null = null
      try {
        const v16Result = await queryMatchingJobsV16(
          { userId, limit: poolSize },
          {
            db: deps.db,
            log: (event, payload) =>
              log("[job-rec-daily][v16]", event, payload ?? {}),
          }
        )
        if (!v16Result.noUserTags && v16Result.jobs && v16Result.jobs.length > 0) {
          v16Jobs = v16Result.jobs as MatchingJob[]
          log("[job-rec-daily] v16_cascade_applied", {
            userId,
            jobs: v16Jobs.length,
            total: v16Result.total,
            dropped: v16Result.dropped,
            hardFilter: v16Result.hardFilter,
            llmCacheStale: v16Result.llmCacheStale ?? false,
          })
        } else {
          log("[job-rec-daily] v16_cascade_fallback", {
            userId,
            reason: v16Result.noUserTags ? "no_user_tags" : "no_matches",
          })
        }
      } catch (err) {
        log("[job-rec-daily] v16_cascade_threw_falling_back", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // Phase 51 (v1.5 / Stream-G.2) — flag-gated tag cluster path. When
      // paTagClusterRecEnabled is ON AND a fetcher is wired AND the cluster
      // returns ≥1 row, REPLACE queryMatchingJobs entirely. When the cluster
      // is cold/empty/missing, fall through to the legacy path so the user
      // still gets recs (zero-regression contract).
      let queryRes: { jobs: MatchingJob[] } | null = v16Jobs ? { jobs: v16Jobs } : null
      const tagClusterOn = deps.tagClusterFetcher
        ? Boolean(
            await deps.getFlag(
              deps.db,
              PA_TAG_CLUSTER_REC_FLAG_KEY,
              { userId, env: process.env },
              false
            )
          )
        : false
      if (tagClusterOn && deps.tagClusterFetcher) {
        try {
          // Pull user skills + embedding to feed the cluster scoring.
          let userSkills: string[] = []
          let userEmbedding: readonly number[] | null = null
          try {
            const resumeSnap = await deps.db
              .collection("parsedCandidateResumes")
              .where("userId", "==", userId)
              .orderBy("createdAt", "desc")
              .limit(1)
              .get()
            if (!resumeSnap.empty) {
              const rd = resumeSnap.docs[0]!.data() as Record<string, unknown>
              const cp = (rd.candidateProfile ?? {}) as Record<string, unknown>
              if (Array.isArray(cp.skills)) {
                userSkills = (cp.skills as unknown[])
                  .filter((x) => typeof x === "string")
                  .slice(0, 10) as string[]
              }
              const e = rd.embedding
              if (Array.isArray(e) && e.every((n) => typeof n === "number")) {
                userEmbedding = e as number[]
              }
            }
          } catch (rerr) {
            log("[job-rec-daily] tag_cluster_resume_lookup_failed", {
              userId,
              error: rerr instanceof Error ? rerr.message : String(rerr),
            })
          }
          const clusterJobs = await deps.tagClusterFetcher(
            {
              industryTags: normalized.industryTags,
              // Phase 51 alignment fix — sponsorship is the cluster key,
              // not skills. Skills still feed the in-cluster jaccard
              // fallback when user embedding is missing.
              sponsorship: normalized.sponsorship,
              skills: userSkills,
              userEmbedding,
            },
            poolSize
          )
          if (clusterJobs.length > 0) {
            queryRes = { jobs: clusterJobs as MatchingJob[] }
            log("[job-rec-daily] tag_cluster_fetch_applied", {
              userId,
              poolSize,
              returned: clusterJobs.length,
            })
          } else {
            log("[job-rec-daily] tag_cluster_empty_falling_back", { userId })
          }
        } catch (cerr) {
          log("[job-rec-daily] tag_cluster_threw_falling_back", {
            userId,
            error: cerr instanceof Error ? cerr.message : String(cerr),
          })
        }
      }
      if (!queryRes) {
        queryRes = await queryMatchingJobs(
          {
            filters: {
              industry: normalized.industry,
              // Stream H6 — pass canonical 10-tag list so query expands to
              // industryKey-in over the corpus' real token-set (instead of
              // collapsing all 3 user tags to a single 6-enum bucket and
              // matching ~191/40374 active rows).
              ...(normalized.industryTags.length > 0
                ? { industryTags: normalized.industryTags }
                : {}),
              location: normalized.location,
              sponsorship: normalized.sponsorship,
              sizePreference: normalized.sizePreference,
              ...(normalized.salaryMin !== undefined
                ? { salaryMin: normalized.salaryMin }
                : {}),
            },
            limit: poolSize,
          },
          { db: deps.db, log, includeEmbedding: true }
        )
      }

      if (queryRes.jobs.length === 0) {
        skippedNoJobs += 1
        continue
      }

      // Phase 43 (v1.5 / Stream-C) — hard filters using statedPreferences.
      // Position: AFTER queryMatchingJobs (post-Firestore-where + post-Jaccard),
      // BEFORE cosine + cross-encoder rerank. Flag-gated default OFF; ramp
      // 1%→100%. When OFF, hardFilteredJobs === queryRes.jobs and downstream
      // path is byte-identical to pre-43 behavior.
      //
      // Phase 60 — When V16 cascade returned jobs, those have already
      // passed the v1.6 hard-filter chain (visa / location / careerStage /
      // jobType / freshness / atsApplyUrl / dead) inside the V16 pipeline.
      // Skip the legacy hardFiltersOn pass to avoid double-filtering.
      let hardFilteredJobs: MatchingJob[] = queryRes.jobs
      let fallbackMode = false
      const hardFiltersOn =
        !v16Jobs &&
        Boolean(
          await deps.getFlag(
            deps.db,
            HARD_FILTERS_FLAG_KEY,
            { userId, env: process.env },
            false
          )
        )
      if (hardFiltersOn) {
        const hfProfile = await loadHardFilterProfile(deps.db, userId, log)
        // Pre-fetch prev-7-day jobs ONLY when we suspect a 0-survivor outcome
        // would land. Conservative: do a cheap dry-run with the full ruleset
        // first; only if zero survive AND no relaxation tier helps will we
        // need the prev7d set. Easiest implementation: run the dry-run
        // synchronously, check, and fetch+re-orchestrate when needed.
        const dry = applyHardFiltersWithFallback(
          hfProfile,
          queryRes.jobs as MatchingJob[],
          [],
          poolSize
        )
        if (dry.relaxLevel !== "prev7d") {
          hardFilteredJobs = dry.jobs
          log("[job-rec-daily] hard_filter_applied", {
            userId,
            before: queryRes.jobs.length,
            after: dry.jobs.length,
            relaxLevel: dry.relaxLevel,
          })
        } else {
          // 0-survival across all relax tiers — fetch prev-7-day jobs and
          // surface fallbackMode to the opener.
          const prev7d = await fetchPrevious7DayJobs(deps.db, normalized.industryTags, poolSize, log)
          hardFilteredJobs = prev7d
          fallbackMode = prev7d.length > 0
          log("[job-rec-daily] hard_filter_fallback_prev7d", {
            userId,
            prev7dCount: prev7d.length,
            fallbackMode,
          })
        }
        if (hardFilteredJobs.length === 0) {
          // True 0-result: no fresh survivors AND no prev7d. Skip user
          // gracefully — no ghost message.
          skippedNoJobs += 1
          continue
        }
      }

      // v1.5 fix — early dedupe BEFORE cosine narrows the pool. Duplicate
      // listings (same role × N cities for Mastercard / Deloitte / consulting
      // umbrellas) used to take ~80% of the post-cosine top-10 slots, then
      // H12 collapsed them at the end leaving 2 unique. Move the (title,
      // company) collapse upstream so cosine + cross-encoder operate on
      // unique candidates only. Job-rec dry-run agent (commit 05375d3) caught
      // this — Adam was getting 2 jobs (target 5-8). Pure / deterministic.
      if (hardFilteredJobs.length > 1) {
        const seen = new Set<string>()
        const earlyDeduped: MatchingJob[] = []
        for (const j of hardFilteredJobs) {
          const key = `${(j.jobTitle ?? "").toLowerCase().trim()}|${(j.companyName ?? "").toLowerCase().trim()}`
          if (seen.has(key)) continue
          seen.add(key)
          earlyDeduped.push(j)
        }
        if (earlyDeduped.length < hardFilteredJobs.length) {
          log("[job-rec-daily] early_dedupe_applied", {
            userId,
            before: hardFilteredJobs.length,
            after: earlyDeduped.length,
          })
          hardFilteredJobs = earlyDeduped
        }
      }
      // Stream F5 — embedding rerank when configured + user has embedding.
      // Stream G1 — cascade: fetcher → computer (lazy compute + cache) → fallback.
      //
      // Phase 60 — when V16 produced the candidates, V16's own scoring already
      // includes cv-embedding cosine + Jaccard + reasoning. Skip the legacy
      // rerank pipeline; just slice to jobsPerUser and proceed to formatter.
      let rankedJobs: MatchingJob[] = hardFilteredJobs
      if (v16Jobs) {
        rankedJobs = hardFilteredJobs.slice(0, jobsPerUser)
        log("[job-rec-daily] v16_skip_legacy_rerank", { userId, count: rankedJobs.length })
      } else if (deps.userEmbedFetcher) {
        try {
          const fetched = await deps.userEmbedFetcher(deps.db, userId)
          let embedding: readonly number[] | null = fetched.embedding
          // Cascade: if fetcher returned null embedding but a resumeId exists,
          // and a computer is wired, compute on demand + cache.
          if ((!embedding || embedding.length === 0) && fetched.resumeId && deps.userEmbedComputer) {
            try {
              const resumeText = await loadResumeTextForEmbed(deps.db, fetched.resumeId)
              if (resumeText) {
                const computed = await deps.userEmbedComputer(
                  deps.db,
                  userId,
                  fetched.resumeId,
                  resumeText
                )
                if (computed && computed.length > 0) {
                  embedding = computed
                  log("[job-rec-daily] embedding_computed_cached", {
                    userId,
                    resumeId: fetched.resumeId,
                    dim: computed.length,
                  })
                }
              }
            } catch (computeErr) {
              log("[job-rec-daily] embed_compute_failed_fallback", {
                userId,
                error: computeErr instanceof Error ? computeErr.message : String(computeErr),
              })
            }
          }
          if (embedding && embedding.length > 0) {
            // H10: when cross-encoder is wired, keep a wider cosine top-N
            // (default 25 post-v1.5 dry-run finding) so the cross-encoder
            // has room to reorder. Was 10 — too tight after early-dedupe
            // collapses duplicate listings (Adam got 2 jobs at default 10).
            const cosineKeep = deps.crossEncoderReranker
              ? Math.max(jobsPerUser, deps.crossEncoderPoolSize ?? 25)
              : jobsPerUser
            rankedJobs = rerankByCosine(
              hardFilteredJobs as Array<MatchingJob & { embedding?: number[] | null }>,
              embedding,
              cosineKeep
            )
            log("[job-rec-daily] rerank_applied", { userId, poolSize: hardFilteredJobs.length, took: cosineKeep })
          } else {
            // No embedding on file AND compute path didn't succeed — slice.
            rankedJobs = hardFilteredJobs.slice(0, jobsPerUser)
          }
        } catch (err) {
          log("[job-rec-daily] rerank_failed_fallback", {
            userId,
            error: err instanceof Error ? err.message : String(err),
          })
          rankedJobs = hardFilteredJobs.slice(0, jobsPerUser)
        }
      } else {
        rankedJobs = hardFilteredJobs.slice(0, jobsPerUser)
      }

      // Stream I (v1.5 / Phase 43.5) — cross-encoder scores carried over for
      // the startup boost downstream. null = fail-open / not run.
      let crossEncoderScores: Map<string, number | null> | null = null

      // Stream H10 — cross-encoder rerank. Runs AFTER cosine narrows to ~10
      // candidates. Synthesizes a query string from the user's profile
      // (recent role + skills + industries), encodes each remaining job as
      // (title at company; skills) and asks BAAI/bge-reranker-v2-m3 (via
      // SiliconFlow free tier) for joint-relevance scores. Fail-open: if
      // the dep returns score=null on every item we keep cosine order.
      //
      // Phase 60 — V16 path skips this; the v1.6 cascade already produces
      // a final ranked top-N via weighted score (no cross-encoder layer
      // because V16's llmMatch component is the LLM rerank cache equivalent).
      if (!v16Jobs && deps.crossEncoderReranker && rankedJobs.length > 1) {
        try {
          // Pull the most-recent resume for query synthesis. Best-effort —
          // null result falls back to industryTags-only query.
          let recentRoleTitle: string | null = null
          let topSkills: readonly string[] = []
          try {
            const resumeSnap = await deps.db
              .collection("parsedCandidateResumes")
              .where("userId", "==", userId)
              .orderBy("createdAt", "desc")
              .limit(1)
              .get()
            if (!resumeSnap.empty) {
              const rd = resumeSnap.docs[0]!.data() as Record<string, unknown>
              const exps = Array.isArray(rd.experiences) ? rd.experiences : []
              if (exps.length > 0) {
                const e0 = exps[0] as Record<string, unknown>
                if (typeof e0.title === "string") recentRoleTitle = e0.title
              }
              const cp = (rd.candidateProfile ?? {}) as Record<string, unknown>
              if (Array.isArray(cp.skills)) {
                topSkills = (cp.skills as unknown[]).filter((x) => typeof x === "string") as string[]
              }
            }
          } catch {
            // ignore — fall through to industryTags-only query
          }

          const query = buildRerankQuery({
            recentRoleTitle,
            topSkills,
            industryTags: normalized.industryTags,
          })
          const cands = rankedJobs.map((j) => ({
            id: j.id,
            text: buildJobCandidateText({
              jobTitle: j.jobTitle,
              companyName: j.companyName,
              requiredSkills: j.requiredSkills,
              industryKey: j.industryKey,
            }),
          }))
          const reranked = await deps.crossEncoderReranker(query, cands)
          // If at least one score is non-null the cross-encoder succeeded;
          // re-order rankedJobs by the new ranking. Otherwise keep cosine.
          const haveScores = reranked.some((r) => r.score !== null)
          if (haveScores) {
            const byId = new Map(rankedJobs.map((j) => [j.id, j]))
            const reordered: MatchingJob[] = []
            for (const r of reranked) {
              const j = byId.get(r.id)
              if (j) reordered.push(j)
            }
            // Append any cosine-pool jobs the cross-encoder didn't rank
            // (defensive: shouldn't happen since topN === pool size).
            for (const j of rankedJobs) {
              if (!reranked.find((r) => r.id === j.id)) reordered.push(j)
            }
            rankedJobs = reordered
            crossEncoderScores = new Map(reranked.map((r) => [r.id, r.score]))
            log("[job-rec-daily] cross_encoder_applied", {
              userId,
              poolSize: cands.length,
              topScore: reranked[0]?.score ?? null,
            })
          } else {
            log("[job-rec-daily] cross_encoder_fail_open", { userId })
          }
        } catch (xeErr) {
          log("[job-rec-daily] cross_encoder_threw", {
            userId,
            error: xeErr instanceof Error ? xeErr.message : String(xeErr),
          })
        }
      }

      // Stream I (v1.5 / Phase 43.5) — startup-vs-corp scoring boost.
      //
      // Pure heuristic, multiplicative boost on cross-encoder relevance.
      // Reads: user.statedPreferences.prefersStartup (Phase 44) + CV experiences
      // (lean-yes fallback). Job-side: FAANG allowlist + companyEmployeeCount
      // + bilingual startup-keyword bank. Default-OFF flag — when off, the
      // entire block short-circuits at the flag check (byte-identical behavior).
      //
      // Position: AFTER cross-encoder reorder, BEFORE H12 dedupe / H7 anti-bias
      // / H13 formatter (so the formatter sees the final order + can render
      // boost reasons via DailyPushContext.boostExplanations).
      let boostExplanations: BoostExplanation[] = []
      if (!v16Jobs && rankedJobs.length > 1) {
        const startupBoostOn = Boolean(
          await deps.getFlag(
            deps.db,
            STARTUP_BOOST_FLAG_KEY,
            { userId, env: process.env },
            false
          )
        )
        if (startupBoostOn) {
          try {
            // Pull statedPreferences + CV experiences. Best-effort — any
            // miss falls through to neutral signal (mult=1.0 = no-op).
            let prefersStartup: boolean | null = null
            let cvExperiences: CvExperience[] = []
            try {
              const userDoc = await deps.db.collection("pa-users").doc(userId).get()
              if (userDoc.exists) {
                const ud = userDoc.data() as Record<string, unknown>
                const sp = ud.statedPreferences as Record<string, unknown> | undefined
                if (sp && typeof sp.prefersStartup === "boolean") {
                  prefersStartup = sp.prefersStartup
                }
              }
            } catch {
              // ignore — neutral fallback
            }
            try {
              const resumeSnap = await deps.db
                .collection("parsedCandidateResumes")
                .where("userId", "==", userId)
                .orderBy("createdAt", "desc")
                .limit(1)
                .get()
              if (!resumeSnap.empty) {
                const rd = resumeSnap.docs[0]!.data() as Record<string, unknown>
                const exps = Array.isArray(rd.experiences) ? rd.experiences : []
                cvExperiences = exps.map((e) => {
                  const x = e as Record<string, unknown>
                  return {
                    company: typeof x.company === "string" ? x.company : null,
                    companyEmployeeCount:
                      typeof x.companyEmployeeCount === "number"
                        ? x.companyEmployeeCount
                        : null,
                  }
                })
              }
            } catch {
              // ignore — neutral fallback
            }

            const userSignal: UserStartupSignal = userPreferStartup({
              statedPreferences: { prefersStartup },
              cvExperiences,
            })
            const boosted = applyStartupBoost(
              rankedJobs,
              userSignal,
              crossEncoderScores ?? undefined
            )
            for (const expl of boosted.explanations) {
              log("[job-rec-daily] boost.applied", {
                userId,
                jobId: expl.jobId,
                boostMult: expl.boostMult,
                userSignal: expl.userSignal,
                jobSignal: expl.jobSignal,
              })
            }
            if (boosted.explanations.length > 0) {
              rankedJobs = boosted.jobs
              boostExplanations = boosted.explanations
            }
            // No explanations → identity ranking — leave rankedJobs unchanged.
          } catch (boostErr) {
            log("[job-rec-daily] startup_boost_threw_fallback", {
              userId,
              error: boostErr instanceof Error ? boostErr.message : String(boostErr),
            })
          }
        }
      }

      // v1.5 / Phase 53.5 — weighted skill match scoring (Adam 2026-05-02
      // spec). Multiplicative boost on top of cross-encoder + startup boost.
      // For AI agent users: jobs whose CORE keywords (RAG / tool calling /
      // workflow orchestration) are in the user's CV get STRONG mult (1.2);
      // jobs that match only on generic skills (Python alone) get WEAK (0.85).
      // Default-OFF flag — when off, byte-identical to pre-Phase-53.5 ranking.
      //
      // Position: AFTER startup boost (so most-recent semantic reorder wins),
      // BEFORE H12 dedupe + H7 anti-bias + H13 formatter (so explanations
      // can flow through to DailyPushContext for the reason explainer).
      //
      // Role detection: simple keyword scan over user's industryTags +
      // statedPreferences.targetRole. AI_AGENT_SKILL_WEIGHTS is the only
      // table wired today; PM/SWE tables are deferred to follow-up phases.
      let weightedMatchExplanations: WeightedMatchExplanation[] = []
      if (!v16Jobs && rankedJobs.length > 1) {
        const weightedMatchOn = Boolean(
          await deps.getFlag(
            deps.db,
            WEIGHTED_MATCH_FLAG_KEY,
            { userId, env: process.env },
            false
          )
        )
        if (weightedMatchOn) {
          try {
            // Pull user's CV skills + targetRole hint. Best-effort — missing
            // signals fall through to neutral (no boost).
            let userSkillsForWeighted: string[] = []
            let targetRoleSignal = ""
            try {
              const resumeSnap = await deps.db
                .collection("parsedCandidateResumes")
                .where("userId", "==", userId)
                .orderBy("createdAt", "desc")
                .limit(1)
                .get()
              if (!resumeSnap.empty) {
                const rd = resumeSnap.docs[0]!.data() as Record<string, unknown>
                const cp = (rd.candidateProfile ?? {}) as Record<string, unknown>
                if (Array.isArray(cp.skills)) {
                  userSkillsForWeighted = (cp.skills as unknown[])
                    .filter((x) => typeof x === "string") as string[]
                }
              }
            } catch {
              // ignore — neutral fallback
            }
            try {
              const userDoc = await deps.db.collection("pa-users").doc(userId).get()
              if (userDoc.exists) {
                const ud = userDoc.data() as Record<string, unknown>
                const sp = ud.statedPreferences as Record<string, unknown> | undefined
                if (sp && Array.isArray(sp.targetRole)) {
                  targetRoleSignal = (sp.targetRole as unknown[])
                    .filter((x) => typeof x === "string")
                    .join(" ")
                    .toLowerCase()
                }
              }
            } catch {
              // ignore — neutral fallback
            }
            // Role detection — only AI agent table wired today. Fire when
            // industryTags include ai_ml OR targetRole mentions AI agent
            // keywords. Conservative: false-negative friendly (matches
            // job-market-knowledge.detectJobMarketRole spirit).
            const isAiAgentUser =
              normalized.industryTags.includes("ai_ml") ||
              /ai\s*agent|llm|rag|langchain|agentic/.test(targetRoleSignal)
            if (isAiAgentUser && userSkillsForWeighted.length > 0) {
              // iter30/WS8 — dual-read: when paWeightsFromFirestore flag is ON,
              // load from Firestore via BoostCalculator (operator-editable
              // weights). Default OFF preserves byte-identical legacy ranking
              // (TS const path). Flag flips to ON in T6 / T21 ramp per detail-
              // plan §10.
              let wm: { jobs: MatchingJob[]; explanations: WeightedMatchExplanation[] } = {
                jobs: rankedJobs,
                explanations: [],
              }
              const useFirestore = Boolean(
                await deps.getFlag(
                  deps.db,
                  WEIGHTS_FROM_FIRESTORE_FLAG_KEY,
                  { userId, env: process.env },
                  false
                )
              )
              if (useFirestore) {
                try {
                  const bc = new BoostCalculator({ db: deps.db, log })
                  const { table, rows } = await bc.loadTable("ai-agent-2026")
                  const fsBoost = bc.applyBoost(
                    rankedJobs,
                    userSkillsForWeighted,
                    table,
                    rows,
                    crossEncoderScores ?? undefined
                  )
                  wm = { jobs: fsBoost.jobs, explanations: fsBoost.explanations }
                  log("[job-rec-daily] weighted_match.firestore_loaded", {
                    userId,
                    tableKey: table.tableKey,
                    tableVersion: table.version,
                    rowCount: rows.length,
                  })
                } catch (fsErr) {
                  log("[job-rec-daily] weighted_match.firestore_failed_fallback", {
                    userId,
                    error: fsErr instanceof Error ? fsErr.message : String(fsErr),
                  })
                  wm = applyWeightedMatchBoost(
                    rankedJobs,
                    userSkillsForWeighted,
                    AI_AGENT_SKILL_WEIGHTS,
                    crossEncoderScores ?? undefined
                  )
                }
              } else {
                wm = applyWeightedMatchBoost(
                  rankedJobs,
                  userSkillsForWeighted,
                  AI_AGENT_SKILL_WEIGHTS,
                  crossEncoderScores ?? undefined
                )
              }
              for (const expl of wm.explanations) {
                log("[job-rec-daily] weighted_match.applied", {
                  userId,
                  jobId: expl.jobId,
                  score: expl.score,
                  boostMult: expl.boostMult,
                  matchedCount: expl.matched.length,
                  coreMissingCount: expl.coreMissing.length,
                  coreMissing: expl.coreMissing.map((w) => w.skill),
                  matched: expl.matched.map((w) => w.skill),
                })
              }
              if (wm.explanations.length > 0) {
                rankedJobs = wm.jobs
                weightedMatchExplanations = wm.explanations
              }
            } else {
              log("[job-rec-daily] weighted_match.skipped_role", {
                userId,
                isAiAgentUser,
                userSkillsCount: userSkillsForWeighted.length,
              })
            }
          } catch (wmErr) {
            log("[job-rec-daily] weighted_match.threw_fallback", {
              userId,
              error: wmErr instanceof Error ? wmErr.message : String(wmErr),
            })
          }
        }
      }
      // Suppress unused-var warning — weightedMatchExplanations is captured
      // for forward-compat: future H13.next will surface coreMissing in reasons
      // ("core 缺 RAG"). Today the reasons go through the cross-encoder path.
      void weightedMatchExplanations

      // Stream H12 — dedupe near-identical JDs (same title+company across
      // cities) BEFORE final slice, so users don't get 3-job pushes that
      // collapse to 1 unique role × 3 cities. Keep the highest-ranked row
      // per (title|company) key. Pure / deterministic.
      if (rankedJobs.length > 1) {
        const seen = new Set<string>()
        const deduped: MatchingJob[] = []
        for (const j of rankedJobs) {
          const key = `${(j.jobTitle ?? "").toLowerCase().trim()}|${(j.companyName ?? "").toLowerCase().trim()}`
          if (seen.has(key)) continue
          seen.add(key)
          deduped.push(j)
        }
        if (deduped.length < rankedJobs.length) {
          log("[job-rec-daily] dedupe_applied", {
            userId,
            before: rankedJobs.length,
            after: deduped.length,
          })
          rankedJobs = deduped
        }
      }

      // Stream H7 — title anti-bias rerank for tech-track users. When the
      // user is in {tech_software, ai_ml, fintech_finance}, multiply
      // QA/QC/manufacturing-engineer titles by 0.3 so cosine false-friends
      // (e.g. "QC Analyst" matching a Data Analyst CV via shared "Analyst")
      // sink. Pure / deterministic; no-op when industryTags absent or user
      // is non-tech. Re-clamps to jobsPerUser as a safety belt.
      //
      // Phase 60 — V16 path skips this. The v1.6 cascade does role-level
      // hard filtering at the Firestore query layer (`array-contains-any`
      // on user.targetRoleFunction), so the QA/QC false-friend pattern
      // can't even reach the candidate pool for SWE users.
      if (!v16Jobs) {
        rankedJobs = applyTitleAntiBias(rankedJobs, normalized.industryTags, jobsPerUser)
      } else {
        rankedJobs = rankedJobs.slice(0, jobsPerUser)
      }

      // Stream H13 — friend-tone CV-aware opener. Default-on flag; falls back
      // to the legacy formatBatchMessage when explicitly disabled.
      let body: string
      const friendToneOn = Boolean(
        await deps.getFlag(
          deps.db,
          FRIEND_TONE_OPENER_FLAG_KEY,
          { userId, env: process.env },
          true
        )
      )
      if (friendToneOn) {
        const pushCtx = await loadDailyPushContext(
          deps.db,
          userId,
          normalized.industryTags,
          log
        )
        // Stream F (Phase 42) — async LLM match-explainer. Default OFF.
        // When ON, sequentially explain each ranked job (sequential keeps
        // budget check authoritative); inject results into pushCtx.reasons.
        // Each call is fail-open — empty reason = clean line per H13 design.
        const explainerOn = Boolean(
          await deps.getFlag(
            deps.db,
            MATCH_EXPLAINER_FLAG_KEY,
            { userId, env: process.env },
            false
          )
        )
        if (explainerOn) {
          const cv: ExplainerCv = {
            ...(pushCtx.recentRoleTitle ? { recentRoleTitle: pushCtx.recentRoleTitle } : {}),
            ...(pushCtx.recentCompany ? { recentCompany: pushCtx.recentCompany } : {}),
            ...(pushCtx.topSkills ? { topSkills: pushCtx.topSkills } : {}),
          }
          const reasonsMap = new Map<string, string>()
          for (const job of rankedJobs) {
            try {
              const reason = await explainMatch(
                {
                  db: deps.db,
                  ...(deps.matchExplainerChatImpl
                    ? { chatImpl: deps.matchExplainerChatImpl }
                    : {}),
                  ...(typeof deps.matchExplainerDailyBudgetUsd === "number"
                    ? { dailyBudgetUsd: deps.matchExplainerDailyBudgetUsd }
                    : {}),
                  // Forward batch's todayYmd so the cost-ledger doc id
                  // matches the batch date (matters for back-fills / tests
                  // and operational dashboards).
                  todayYmd: () => todayYmd,
                  log,
                },
                {
                  userId,
                  userCv: cv,
                  job,
                  language: pushCtx.language,
                }
              )
              if (reason) reasonsMap.set(job.id, reason)
            } catch (xeErr) {
              // Defensive: explainMatch is fail-open; this catch is a
              // belt-and-suspenders for unexpected throws.
              log("[job-rec-daily] match_explainer_threw", {
                userId,
                jobId: job.id,
                error: xeErr instanceof Error ? xeErr.message : String(xeErr),
              })
            }
          }
          if (reasonsMap.size > 0) {
            pushCtx.reasons = reasonsMap
            log("[job-rec-daily] match_explainer_applied", {
              userId,
              reasonsCount: reasonsMap.size,
              jobsCount: rankedJobs.length,
            })
          }
        }
        if (fallbackMode) {
          pushCtx.fallbackMode = true
        }
        // Stream I — surface boost reasons for forward-compat formatters.
        if (boostExplanations.length > 0) {
          pushCtx.boostExplanations = boostExplanations
        }
        body = formatDailyPushBody(rankedJobs, pushCtx)
        log("[job-rec-daily] friend_tone_opener_applied", {
          userId,
          variant: pushCtx.recentCompany
            ? pushCtx.hasUserStatedPreferences
              ? "A_cv_and_prefs"
              : "B_cv_only"
            : "C_no_cv",
          language: pushCtx.language,
        })
      } else {
        body = formatBatchMessage(rankedJobs)
      }
      const sendRes = await sendImessage(
        {
          userId,
          content: body,
          idempotencyKey: `${userId}-${todayYmd}-batch`,
        },
        { db: deps.db, log }
      )

      if (sendRes.ok) {
        delivered += 1
        await deps.db.collection(JOB_PROFILES_COLLECTION).doc(userId).set(
          { lastJobBatchSentAt: new Date().toISOString() },
          { merge: true }
        )
      }
    } catch (err) {
      errors += 1
      log("[job-rec-daily] user_failed", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    total: snap.size,
    delivered,
    skippedFlag,
    skippedNoJobs,
    errors,
  }
}
