/**
 * Phase 49 (v1.5 / Stream-H / D9) — Reverse-match domain logic.
 *
 * The forward path (daily-batch.ts) ranks JOBS for a given USER. Reverse
 * does the symmetric operation: given a JD + tags + industry, rank USERS
 * against the JD. Used by the operator dashboard at /dashboard/match-
 * candidates to surface candidates worth pinging when a "proper job" lands.
 *
 * Pipeline (parallel to daily-batch but pivot-flipped):
 *   1. caller embeds JD via OpenAI text-embedding-3-small (1536-d) once
 *   2. load active candidate pool from `pa-job-profiles` where status=active
 *      (industry filter on profile.industry to scope; cap 1000 for latency)
 *   3. fetch each user's CV embedding from parsedCandidateResumes via
 *      defaultUserEmbedFetcher; cosine vs JD; keep top 50
 *   4. cross-encoder rerank (rerankWithCrossEncoder) on JD vs userCv text
 *      — same SiliconFlow BAAI/bge-reranker-v2-m3 endpoint as forward path
 *   5. apply hard filters in REVERSE: synthesize a single MatchingJob from
 *      the JD inputs and call applyHardFilters(userProfile, [synthJob]) per
 *      user. If the survivor list is empty, that user is dropped (e.g. they
 *      need visa sponsorship but the synth job carries `sponsorship: false`).
 *   6. take topK
 *
 * Failure-mode philosophy mirrors daily-batch: fail-open the rerank stage
 * (cosine order survives), fail-closed the hard-filter stage (preference
 * mismatches MUST drop candidates — Stream-C contract).
 *
 * Cost ceiling per JD lookup: 1 embedding (~$0.0001 at 1536-d × 8k tokens
 * cap) + 1 rerank API call (free tier). Latency budget: < 3s end-to-end
 * for 1k user pool → top 20.
 *
 * Pure logic only. CF wrapper (apps/functions/src/paReverseMatch.ts) owns
 * Firestore + OpenAI client + admin auth. Tests inject fakes via the deps
 * object so the file is fully unit-testable without touching Firestore.
 */

import type { Firestore } from "firebase-admin/firestore"
import { cosineSimilarity } from "./daily-batch.js"
import {
  applyHardFilters,
  type HardFilterUserProfile,
} from "./tools/query-matching-jobs.js"
import type { MatchingJob } from "./types.js"
import {
  rerankWithCrossEncoder,
  type RerankCandidate,
  type RerankerDeps,
  type RerankedItem,
} from "./cross-encoder-rerank.js"

/** Feature flag key; CF gates on this with default OFF. */
export const REVERSE_MATCH_FLAG_KEY = "paReverseMatchEnabled"

/** Hard cap on candidate pool size pulled from pa-job-profiles. */
export const REVERSE_MATCH_POOL_CAP = 1000
/** Cosine top-N before cross-encoder rerank. Matches forward path. */
export const REVERSE_MATCH_COSINE_TOP_N = 50
/** Default topK returned to operator. Brief: 20. */
export const REVERSE_MATCH_DEFAULT_TOP_K = 20
/** Rate-limit ceiling per JD per day per the DELIVERY runbook. */
export const REVERSE_MATCH_DAILY_CAP_PER_JD = 50
/** Bulk-notify ceiling — keeps abuse blast-radius minimal. */
export const REVERSE_MATCH_BULK_NOTIFY_CAP = 5

/** Operator-facing input contract. */
export type ReverseMatchInput = {
  /** Free-text JD, used for embedding + rerank. Trimmed; cap 8000 chars. */
  jobDescription: string
  /** User-supplied tags (skills/keywords). Used for hard-filter synth job + reasons. */
  tags: string[]
  /**
   * 6-enum industry — matches `pa-job-profiles.profile.industry` so we can
   * scope the candidate pool with a single Firestore where-equals.
   */
  industry: "tech" | "fintech" | "healthtech" | "consumer" | "b2b" | "any"
  /** Optional location string, used for synth-job locationRaw + reasons. */
  location?: string
  /** Top K to return. Default 20. Cap REVERSE_MATCH_POOL_CAP. */
  topK?: number
  /** Optional company name for the notify template. */
  companyName?: string
  /** Optional job title for the notify template + synth job. */
  jobTitle?: string
}

/** Per-user output row surfaced to dashboard. */
export type ReverseMatchCandidate = {
  userId: string
  displayName: string
  /** Cross-encoder score (0..1) when API succeeded; cosine score otherwise. */
  matchScore: number
  /**
   * Up to 3 string reasons explaining the match. Heuristic — skill overlap
   * + industry hit + recent-company hit. Empty when no signal.
   */
  topMatchedReasons: string[]
  /** True iff user has phone + paJobRecEnabled flag = true. */
  hasOptedIn: boolean
  /** Surface for dashboard column; not used by notify path. */
  preferredLanguage: "zh" | "en"
}

/** Output envelope. */
export type ReverseMatchOutput = {
  candidates: ReverseMatchCandidate[]
  poolSize: number
  cosineCandidates: number
  rerankCandidates: number
  hardFilterDropped: number
}

/** Lightweight user-side profile for ranking + filtering. */
export type ReverseMatchUserProfile = {
  userId: string
  displayName: string
  /** 6-enum industry from pa-job-profiles.profile. Used for pool scoping. */
  profileIndustry: string
  /** Hard-filter shape (statedPreferences + experiences). */
  hardFilterProfile: HardFilterUserProfile
  /** 1536-d CV embedding when present. */
  cvEmbedding: number[] | null
  /** Compact CV text for cross-encoder rerank. */
  cvText: string
  /** Skills extracted from candidateProfile (lower-cased). */
  topSkills: string[]
  /** Most-recent experience company (for reason building). */
  recentCompany: string
  /** preferredLanguage from pa-users. Defaults to "zh". */
  preferredLanguage: "zh" | "en"
  /** True iff phoneE164 present + flag check OK (set by deps.checkOptIn). */
  hasOptedIn: boolean
}

/**
 * Dependency surface — every external side effect is here so unit tests
 * can inject fakes. Mirrors daily-batch.ts DailyBatchDeps shape.
 */
export type ReverseMatchDeps = {
  db: Firestore
  /**
   * Embed a JD via OpenAI text-embedding-3-small (1536-d). Returns null on
   * any error → caller falls back to "no rerank, return empty candidates"
   * (intentional; without an embedding we cannot meaningfully rank).
   */
  embedJd: (text: string) => Promise<number[] | null>
  /**
   * Load user pool. Filters on industry when not "any". Cap REVERSE_MATCH_
   * POOL_CAP. Each row carries the lightweight projection above; CV
   * embeddings/text are loaded lazily (loadUserSignals).
   */
  loadCandidatePool: (
    db: Firestore,
    industry: ReverseMatchInput["industry"],
  ) => Promise<Array<{
    userId: string
    profileIndustry: string
  }>>
  /**
   * Lazy-load per-user signals (CV embedding, CV text, statedPreferences,
   * experiences, displayName, language, opt-in). Returns null when user
   * has no parsed CV at all → caller drops them.
   */
  loadUserSignals: (
    db: Firestore,
    userId: string,
  ) => Promise<ReverseMatchUserProfile | null>
  /** Cross-encoder reranker. Default = rerankWithCrossEncoder; tests inject. */
  rerank?: (
    query: string,
    candidates: RerankCandidate[],
    deps?: RerankerDeps,
  ) => Promise<RerankedItem[]>
  log?: (event: string, payload?: Record<string, unknown>) => void
}

/**
 * Synthesize a MatchingJob from operator input. Used as the SINGLE
 * job-side input to applyHardFilters when reverse-filtering each user.
 *
 * Why pass through applyHardFilters with [synthJob]? Same logic, no
 * duplication. The hard-filter rules (yoe / research / visa / location)
 * already operate per (profile, job) pair — feeding 1 job per user just
 * reverses the iteration order.
 */
export function synthesizeJobFromJd(input: ReverseMatchInput): MatchingJob {
  return {
    id: "reverse-match-synth",
    companyName: input.companyName ?? "",
    jobTitle: input.jobTitle ?? "",
    salaryMax: null,
    salaryMin: null,
    locationRaw: input.location ?? "",
    primaryUrl: "",
    // iter34 sprint A.2 — synthetic JD has no real ATS link. Leave
    // undefined so formatters fall through to primaryUrl ("" here).
    atsApplyUrl: undefined,
    industry: input.industry,
    industryKey: input.industry,
    sponsorship: null, // Operator can't easily express; conservative default
    requiredSkills: input.tags.filter((t) => typeof t === "string" && t.length > 0),
  }
}

/**
 * Compose a compact user-CV text for the cross-encoder. Mirrors the
 * forward-path text shape (daily-batch's loadResumeTextForEmbed) so the
 * model's relevance signal is comparable across forward+reverse calls.
 */
export function buildUserCandidateText(p: ReverseMatchUserProfile): string {
  const skills = p.topSkills.slice(0, 8).join(", ")
  const co = p.recentCompany ? ` recently at ${p.recentCompany}` : ""
  const text = `${p.displayName}${co}; skills: ${skills}`
  return text.slice(0, 480)
}

/**
 * Build up to 3 string reasons explaining why a user matches the JD.
 * Pure / deterministic; no LLM. Signal hierarchy:
 *   1. exact case-insensitive skill overlap (tags ∩ topSkills) → "skill X 命中"
 *   2. industry match → "前公司 [Co] 同赛道 ([industry])"
 *   3. location hit when user CV has location field — out-of-scope here
 *      since we don't load CV.location in reverse-match (added cost,
 *      minor signal). Skipped intentionally.
 *
 * Bilingual: zh by default; en when user.preferredLanguage === "en".
 */
export function buildMatchedReasons(
  p: ReverseMatchUserProfile,
  input: ReverseMatchInput,
): string[] {
  const reasons: string[] = []
  const tagsLower = input.tags
    .filter((t) => typeof t === "string")
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t.length > 0)
  const skillsLower = new Set(p.topSkills.map((s) => s.toLowerCase().trim()))
  const lang = p.preferredLanguage
  const hits: string[] = []
  for (const t of tagsLower) {
    if (skillsLower.has(t)) hits.push(t)
    if (hits.length >= 3) break
  }
  for (const h of hits) {
    reasons.push(lang === "zh" ? `${h} 命中` : `${h} match`)
  }
  if (reasons.length < 3 && p.profileIndustry === input.industry && input.industry !== "any") {
    reasons.push(
      lang === "zh"
        ? `行业对齐 (${input.industry}${p.recentCompany ? ` · 前 ${p.recentCompany}` : ""})`
        : `industry aligned (${input.industry}${p.recentCompany ? ` · ex-${p.recentCompany}` : ""})`,
    )
  }
  return reasons.slice(0, 3)
}

/**
 * Bilingual notify-message template. Used by CF action="notify". Returns
 * a single string body (Sendblue 600-char ceiling honored — synth template
 * fits well under).
 *
 * zh template (per Adam directive verbatim):
 *   "嘿，看到你简历觉得这个职位跟你挺对得上：[JOB TITLE] @ [COMPANY]。如果有兴趣回个'看看'我把详情发你。"
 * en template (symmetric):
 *   "Hey — saw your resume and this role looks like a match: [JOB TITLE] @ [COMPANY]. If interested, reply 'show me' and I'll send details."
 */
export function buildNotifyMessage(args: {
  jobTitle: string
  companyName: string
  preferredLanguage: "zh" | "en"
}): string {
  const title = args.jobTitle.trim() || (args.preferredLanguage === "zh" ? "新机会" : "a new role")
  const co = args.companyName.trim() || (args.preferredLanguage === "zh" ? "（公司未填）" : "(company TBD)")
  if (args.preferredLanguage === "en") {
    return `Hey — saw your resume and this role looks like a match: ${title} @ ${co}. If interested, reply "show me" and I'll send details.`
  }
  return `嘿，看到你简历觉得这个职位跟你挺对得上：${title} @ ${co}。如果有兴趣回个"看看"我把详情发你。`
}

/**
 * Single-user-vs-job hard-filter check. Returns true when the synth job
 * survives `applyHardFilters([synthJob])` for this profile (= user passes
 * the reverse filter). False when the user is dropped (e.g. visa needed
 * but synth job has sponsorship false; location mismatch; senior-only
 * title vs. yoeRange:[0,0] user).
 */
export function passesReverseHardFilter(
  profile: HardFilterUserProfile,
  synthJob: MatchingJob,
  now: Date = new Date(),
): boolean {
  const survivors = applyHardFilters(profile, [synthJob], undefined, now)
  return survivors.length > 0
}

function defaultLog(): void { /* swallow */ }

/**
 * Core driver. Pure / dep-injected. CF wrapper instantiates deps with
 * real Firestore + OpenAI; tests inject fakes.
 *
 * Returns ReverseMatchOutput with empty candidates on any of the
 * fail-closed conditions (empty pool, embedding failure, all-filtered).
 * NEVER throws — caller presents user-facing error messages from the
 * delta between input and output (e.g. poolSize=0 → "no candidates in
 * this industry").
 */
export async function runReverseMatch(
  input: ReverseMatchInput,
  deps: ReverseMatchDeps,
): Promise<ReverseMatchOutput> {
  const log = deps.log ?? defaultLog
  const topK = Math.max(1, Math.min(input.topK ?? REVERSE_MATCH_DEFAULT_TOP_K, REVERSE_MATCH_POOL_CAP))
  const synthJob = synthesizeJobFromJd(input)

  // 1. Embed JD.
  const jdText = (input.jobDescription ?? "").slice(0, 8000).trim()
  if (jdText.length === 0) {
    log("[reverse-match] empty_jd_short_circuit")
    return { candidates: [], poolSize: 0, cosineCandidates: 0, rerankCandidates: 0, hardFilterDropped: 0 }
  }
  const jdEmbedding = await deps.embedJd(jdText)
  if (!jdEmbedding) {
    log("[reverse-match] jd_embed_failed_short_circuit")
    return { candidates: [], poolSize: 0, cosineCandidates: 0, rerankCandidates: 0, hardFilterDropped: 0 }
  }

  // 2. Load candidate pool.
  const pool = await deps.loadCandidatePool(deps.db, input.industry)
  log("[reverse-match] pool_loaded", { poolSize: pool.length, industry: input.industry })
  if (pool.length === 0) {
    return { candidates: [], poolSize: 0, cosineCandidates: 0, rerankCandidates: 0, hardFilterDropped: 0 }
  }

  // 3. Lazy-load per-user signals + cosine score.
  type Scored = { profile: ReverseMatchUserProfile; cosine: number }
  const scored: Scored[] = []
  for (const row of pool) {
    const sig = await deps.loadUserSignals(deps.db, row.userId)
    if (!sig) continue
    const c = sig.cvEmbedding && sig.cvEmbedding.length === jdEmbedding.length
      ? cosineSimilarity(jdEmbedding, sig.cvEmbedding)
      : 0
    scored.push({ profile: sig, cosine: c })
  }
  scored.sort((a, b) => b.cosine - a.cosine)
  const cosineTop = scored.slice(0, REVERSE_MATCH_COSINE_TOP_N)
  log("[reverse-match] cosine_filtered", { count: cosineTop.length })

  if (cosineTop.length === 0) {
    return { candidates: [], poolSize: pool.length, cosineCandidates: 0, rerankCandidates: 0, hardFilterDropped: 0 }
  }

  // 4. Cross-encoder rerank. Fail-open (preserves cosine order).
  const rerankImpl = deps.rerank ?? rerankWithCrossEncoder
  const rerankInput: RerankCandidate[] = cosineTop.map((s) => ({
    id: s.profile.userId,
    text: buildUserCandidateText(s.profile),
  }))
  const reranked = await rerankImpl(jdText.slice(0, 512), rerankInput, { topN: cosineTop.length })
  // Build score map; null score → fall back to cosine.
  const cosineMap = new Map<string, number>()
  for (const s of cosineTop) cosineMap.set(s.profile.userId, s.cosine)
  const profileMap = new Map<string, ReverseMatchUserProfile>()
  for (const s of cosineTop) profileMap.set(s.profile.userId, s.profile)
  const reorderedScored: Array<{ profile: ReverseMatchUserProfile; score: number }> = []
  for (const r of reranked) {
    const p = profileMap.get(r.id)
    if (!p) continue
    const score = typeof r.score === "number" && Number.isFinite(r.score) ? r.score : (cosineMap.get(r.id) ?? 0)
    reorderedScored.push({ profile: p, score })
  }
  // If rerank returned strict subset (shouldn't, but defensive), append the rest by cosine order.
  if (reorderedScored.length < cosineTop.length) {
    const seen = new Set(reorderedScored.map((r) => r.profile.userId))
    for (const s of cosineTop) {
      if (!seen.has(s.profile.userId)) reorderedScored.push({ profile: s.profile, score: s.cosine })
    }
  }

  // 5. Apply hard filter (reverse). Drop users whose synth job doesn't survive.
  const now = new Date()
  let hardFilterDropped = 0
  const filtered: typeof reorderedScored = []
  for (const r of reorderedScored) {
    if (passesReverseHardFilter(r.profile.hardFilterProfile, synthJob, now)) {
      filtered.push(r)
    } else {
      hardFilterDropped += 1
    }
  }
  log("[reverse-match] hard_filter_applied", {
    survivors: filtered.length,
    dropped: hardFilterDropped,
  })

  // 6. Take topK + build output rows.
  const taken = filtered.slice(0, topK)
  const candidates: ReverseMatchCandidate[] = taken.map((r) => ({
    userId: r.profile.userId,
    displayName: r.profile.displayName,
    matchScore: Number.isFinite(r.score) ? r.score : 0,
    topMatchedReasons: buildMatchedReasons(r.profile, input),
    hasOptedIn: r.profile.hasOptedIn,
    preferredLanguage: r.profile.preferredLanguage,
  }))

  return {
    candidates,
    poolSize: pool.length,
    cosineCandidates: cosineTop.length,
    rerankCandidates: reorderedScored.length,
    hardFilterDropped,
  }
}
