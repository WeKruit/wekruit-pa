/**
 * Tool: queryMatchingJobs
 *
 * Filter + rank `matching-jobs` (40,374 docs) for the RecruiterAgent and
 * the daily cron. The Firestore corpus is wider than what we surface to
 * the LLM (embeddings, raw search tokens, etc.); we narrow to a small,
 * stable shape via `projectMatchingJobRow`.
 *
 * Query strategy:
 *   - When `industry` is concrete (NOT "any"), compound-where on
 *     `industryKey` + `status` + `firstSeenAt desc`. Existing composite
 *     index `status,industryKey,firstSeenAt` is used.
 *   - When `industry === "any"` or omitted, drop the industryKey filter
 *     (single-field `firstSeenAt desc` index suffices).
 *   - Sponsorship: post-filter in memory (only ~50 candidates after the
 *     primary where), since `sponsorship` is bool and Firestore inequality
 *     filters on multiple fields don't compose cheaply.
 *
 * Ranking: a deterministic in-memory score = skill-overlap (Jaccard,
 * 0..1) + sponsorship bonus + location match. Embedding cosine is
 * deferred (would require an extra embedding service call) — the brief
 * notes ranking is "TBD: keyword overlap with user's skills", which we
 * implement here.
 */

import type { Firestore } from "firebase-admin/firestore"
import { tool } from "@openai/agents"
import { getFlag } from "@pa/pa-persistence"
import {
  MatchingJobSchema,
  QueryMatchingJobsInputSchema,
  type MatchingJob,
  type QueryMatchingJobsFilters,
  type QueryMatchingJobsOutput,
} from "../types.js"

const MATCHING_JOBS_COLLECTION = "matching-jobs"
const ACTIVE_STATUS = "active"
const QUERY_FETCH_CAP = 50 // pre-rank window

// ---------------------------------------------------------------------------
// Stream H6 — industryTag → industryKey mapping
// ---------------------------------------------------------------------------
//
// Background. The matching-jobs corpus stores a flat string `industryKey`
// per row. The token-set is wider than our 10 canonical user-facing
// `industryTags` and mixes industry-domain tokens (`fintech`, `healthcare`,
// `enterprise_saas`) with job-function tokens (`engineering`, `sales`,
// `customer_service`, `data_analytics`, `cybersecurity`). We deliberately
// over-include here: each canonical tag expands to MULTIPLE corpus keys so
// the resulting `where industryKey in [...]` filter returns a fat candidate
// pool that the cosine-rerank can then sort by user resume similarity.
//
// The H6 brief gave a base mapping (enterprise_saas, engineering, etc.) — but
// an active-corpus sample of 8000 docs (2026-05-01) shows top keys are
// {tech, hardware, accounting_finance, ai_ml, marketing, education, ...} and
// the brief's expected high-volume keys (`enterprise_saas`, `engineering`,
// `customer_service`) appear 0 times in active. We therefore UNION the
// brief's table with the actually-present keys so the mapping is robust to
// either snapshot. Forward-compat: when the F2 enrichment lands and
// industryEnum/wider keys repopulate, this table covers both shapes.
//
// Cap: Firestore `where field in [...]` accepts up to 30 values. We cap to
// MAX_INDUSTRY_KEY_VALUES below for safety; the longest deduplicated list
// is currently 8.
// ---------------------------------------------------------------------------

import type { JobIndustry } from "../types.js"

const MAX_INDUSTRY_KEY_VALUES = 10

const TAG_TO_INDUSTRY_KEY: Record<string, string[]> = {
  // Brief-base + active-corpus union. Best-effort coverage; daily-batch
  // post-filters by skills/location/sponsorship anyway.
  tech_software: [
    "enterprise_saas",
    "tech",
    "engineering",
    "ai_ml",
    "data_analytics",
    "cybersecurity",
    "product",
    "technology",
  ],
  tech_hardware: ["hardware", "tech", "semiconductor", "semiconductors", "consumer_electronics"],
  fintech_finance: ["fintech", "accounting_finance", "banking", "insurance"],
  // No canonical "ai_ml" industryKey in the original schema; the corpus
  // does carry an `ai_ml` token in 77/8000 active rows, so we include it.
  ai_ml: ["ai_ml", "ai_infrastructure", "enterprise_saas", "tech", "data_analytics"],
  healthcare_biotech: ["healthtech", "healthcare"],
  consumer_retail: ["ecommerce", "retail", "consumer_electronics"],
  media_entertainment: ["media", "arts_entertainment", "gaming", "social_media"],
  manufacturing_industrial: [
    "manufacturing",
    "aerospace_defense",
    "automotive",
    "energy",
    "transportation",
  ],
  education: ["education"],
  other: ["other"],
}

/**
 * Map a single canonical 10-tag industry token to the corpus' industryKey
 * value-set. Returns the input wrapped in [tag] when the tag isn't in our
 * table (fail-open: still attempts a literal match rather than empty-set).
 *
 * Pure / deterministic — exposed for unit tests in
 * apps/job-rec/src/__tests__/tools/query-matching-jobs.test.ts.
 */
export function mapTagToIndustryKeys(tag: string): string[] {
  const t = String(tag ?? "").trim()
  if (!t) return []
  return TAG_TO_INDUSTRY_KEY[t] ?? [t]
}

/**
 * Expand a list of canonical industry tags to a deduplicated, capped
 * industryKey value-set suitable for `where industryKey in [...]`.
 * Returns up to MAX_INDUSTRY_KEY_VALUES values. Returns [] when the
 * input is empty or every tag is unknown — caller should treat empty as
 * "no industry filter".
 */
export function expandIndustryTags(tags: readonly string[]): string[] {
  if (!Array.isArray(tags) || tags.length === 0) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    for (const key of mapTagToIndustryKeys(tag)) {
      if (!seen.has(key)) {
        seen.add(key)
        out.push(key)
        if (out.length >= MAX_INDUSTRY_KEY_VALUES) return out
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Stream H7 — Location fallback ladder for under-represented preferences.
//
// The matching-jobs corpus has near-zero coverage of some metro areas (e.g.
// Baltimore,MD: 0/8000 active rows on 2026-05-01). Without a ladder, the
// scoreJob location component collapses to the 0.2 floor for every job, so
// the location signal degenerates to noise.
//
// Ladder semantics:
//   - Primary substring match           → 1.0 (already handled in scoreJob)
//   - "remote" preference + remote job  → 1.0 (already handled)
//   - Neighbor city substring match     → 0.6 (clearly secondary signal)
//   - Neighbor=remote + remote job      → 0.7 (remote satisfies remote-OK candidates better)
//   - No match in primary or ladder     → 0.2 floor
//
// Keys are lower-cased, whitespace-trimmed forms of `filters.location`. We
// intentionally include both the long form ("baltimore,md") and the short
// form ("baltimore"), because `normalizeJobProfile` passes
// `locationPreference` verbatim and users have written either.
// ---------------------------------------------------------------------------

export const LOCATION_NEIGHBORS: Record<string, string[]> = {
  // Neighbors are loose substring tokens designed to hit real
  // `locationRaw` values (e.g. "Washington, DC" → "washington"; "Remote"
  // → "remote"). All entries are case-insensitive (we lowercase the job
  // location before substring-testing). Each preference key includes the
  // common spelling variants users actually type.
  //
  // Baltimore / DMV
  "baltimore,md": ["washington", "annapolis", "philadelphia", "remote"],
  "baltimore, md": ["washington", "annapolis", "philadelphia", "remote"],
  "baltimore": ["washington", "annapolis", "philadelphia", "remote"],
  // NYC
  "nyc": ["jersey city", "newark", "brooklyn", "long island", "remote"],
  "new york,ny": ["jersey city", "newark", "brooklyn", "remote"],
  "new york, ny": ["jersey city", "newark", "brooklyn", "remote"],
  "new york": ["jersey city", "newark", "brooklyn", "remote"],
  // Bay Area / SF
  "san francisco,ca": ["oakland", "san jose", "palo alto", "berkeley", "remote"],
  "san francisco, ca": ["oakland", "san jose", "palo alto", "berkeley", "remote"],
  "san francisco": ["oakland", "san jose", "palo alto", "berkeley", "remote"],
  "sf": ["oakland", "san jose", "palo alto", "berkeley", "remote"],
  // LA
  "los angeles,ca": ["santa monica", "pasadena", "irvine", "burbank", "remote"],
  "los angeles, ca": ["santa monica", "pasadena", "irvine", "burbank", "remote"],
  "los angeles": ["santa monica", "pasadena", "irvine", "burbank", "remote"],
  "la": ["santa monica", "pasadena", "irvine", "burbank", "remote"],
  // Seattle
  "seattle,wa": ["bellevue", "redmond", "kirkland", "tacoma", "remote"],
  "seattle, wa": ["bellevue", "redmond", "kirkland", "tacoma", "remote"],
  "seattle": ["bellevue", "redmond", "kirkland", "tacoma", "remote"],
  // Boston
  "boston,ma": ["cambridge", "somerville", "waltham", "burlington", "remote"],
  "boston, ma": ["cambridge", "somerville", "waltham", "burlington", "remote"],
  "boston": ["cambridge", "somerville", "waltham", "burlington", "remote"],
  // Austin
  "austin,tx": ["round rock", "san antonio", "dallas", "houston", "remote"],
  "austin, tx": ["round rock", "san antonio", "dallas", "houston", "remote"],
  "austin": ["round rock", "san antonio", "dallas", "houston", "remote"],
  // Chicago
  "chicago,il": ["evanston", "naperville", "schaumburg", "milwaukee", "remote"],
  "chicago, il": ["evanston", "naperville", "schaumburg", "milwaukee", "remote"],
  "chicago": ["evanston", "naperville", "schaumburg", "milwaukee", "remote"],
  // Atlanta
  "atlanta,ga": ["alpharetta", "sandy springs", "marietta", "remote"],
  "atlanta, ga": ["alpharetta", "sandy springs", "marietta", "remote"],
  "atlanta": ["alpharetta", "sandy springs", "marietta", "remote"],
  // Denver
  "denver,co": ["boulder", "aurora", "colorado springs", "remote"],
  "denver, co": ["boulder", "aurora", "colorado springs", "remote"],
  "denver": ["boulder", "aurora", "colorado springs", "remote"],
  // DC (Washington, DC)
  "washington,dc": ["arlington", "alexandria", "bethesda", "baltimore", "remote"],
  "washington, dc": ["arlington", "alexandria", "bethesda", "baltimore", "remote"],
  "washington dc": ["arlington", "alexandria", "bethesda", "baltimore", "remote"],
  "dc": ["arlington", "alexandria", "bethesda", "baltimore", "remote"],
}

// ---------------------------------------------------------------------------
// Stream H7 — Title anti-bias rerank for QA/QC/manufacturing false-friends.
//
// The H6 industryKey-in expansion includes `engineering` for the canonical
// `tech_software` tag, but in the corpus `engineering` is a job-FUNCTION
// bucket that mixes SWE / QA / QC / manufacturing-engineering rows. Cosine
// then false-friends "QC Analyst" with a Data Analyst CV by sharing the
// "Analyst" token. We surface this as a deterministic title-pattern penalty
// applied AFTER cosine rerank, gated on the user's industry intent.
//
// Decision: multiply by 0.3 (don't zero) — corner cases like "QA Engineer
// at Stripe" can still be valid for some users; we degrade signal but don't
// kill it. Combined with the input-order initial rank, a heavily-penalized
// row sinks to the bottom of top-N but isn't removed from the candidate set.
// ---------------------------------------------------------------------------

export const QA_QC_TITLE_REGEX =
  /\b(quality\s+(assurance|control|engineer|technician|specialist|analyst)|qa\s+(specialist|analyst|engineer|technician)|qc\s+(analyst|inspector|specialist)|manufacturing\s+engineer|process\s+engineer|technician|inspector)\b/i

const TECH_USER_TAGS_FOR_ANTIBIAS = new Set([
  "tech_software",
  "ai_ml",
  "fintech_finance",
])

const TITLE_PENALTY_MULTIPLIER = 0.3

/**
 * Apply title-pattern anti-bias to an already-ranked job list. Pure /
 * deterministic.
 *
 * Inputs:
 *   - jobs: list pre-sorted by upstream rank (cosine or Jaccard). Input
 *           order encodes initial rank.
 *   - industryTags: user's canonical 10-tag list. When it contains any of
 *           {tech_software, ai_ml, fintech_finance}, anti-bias is active.
 *   - limit: number of jobs to return. When omitted, returns the full list.
 *
 * Algorithm:
 *   1. Map each job to a synthetic score N..1 by input-index (preserves the
 *      upstream cosine ordering as the prior).
 *   2. If anti-bias is active AND title matches QA_QC_TITLE_REGEX, multiply
 *      the synthetic score by 0.3.
 *   3. Stable-sort by score desc, ties broken by input index (older index
 *      = higher original rank wins).
 *   4. Take first `limit`.
 *
 * The 0.3x is chosen so a top-1 cosine match (synthetic score N) penalized
 * to 0.3*N still ranks above the 0.31*N-th-placed clean job — i.e. a hit
 * needs to be ~3x worse than the next clean job to fully sink it. With
 * candidate pools of 20 and limit 3, this means the top QC false-friend
 * still loses to the #4-#7 clean job, which is the desired behavior.
 */
export function applyTitleAntiBias<T extends { jobTitle?: string }>(
  jobs: readonly T[],
  industryTags: readonly string[] | undefined,
  limit?: number
): T[] {
  const N = jobs.length
  if (N === 0) return []
  const active =
    Array.isArray(industryTags) &&
    industryTags.some((t) => TECH_USER_TAGS_FOR_ANTIBIAS.has(t))

  const scored = jobs.map((j, i) => {
    const initial = N - i // N..1
    const title = typeof j.jobTitle === "string" ? j.jobTitle : ""
    const penalized = active && QA_QC_TITLE_REGEX.test(title)
    const score = penalized ? initial * TITLE_PENALTY_MULTIPLIER : initial
    return { j, i, score }
  })
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.i - b.i
  })
  const out = scored.map((x) => x.j)
  return typeof limit === "number" ? out.slice(0, limit) : out
}

// Type-only import guard — JobIndustry is referenced in the table type only
// for runtime documentation; the table key is a string union of
// JobIndustryTag values. JobIndustry import retained for forward-compat.
void ((): JobIndustry | undefined => undefined)

// ---------------------------------------------------------------------------
// Stream H8 — industryEnum-primary query path (flag-gated).
//
// After H8 enrichment writes `industryEnum: [tag]` (1-element array) to the
// matching-jobs corpus, the query can hit the canonical 10-tag bucket
// directly via `where industryEnum array-contains-any [...userTags]` instead
// of the H6 expansion-to-corpus-keys workaround.
//
// Switch is gated by `pa-feature-flags/matchingIndustryEnumPopulated` so we
// can flip it ON only AFTER the LIVE enrichment run completes successfully.
// Default OFF — falls through to H6 path. Read happens once per query (the
// pa-persistence SDK has a 30s in-process cache, so the per-query overhead
// is amortized to ~zero).
// ---------------------------------------------------------------------------

const FLAG_INDUSTRY_ENUM_POPULATED = "matchingIndustryEnumPopulated"
const MAX_INDUSTRY_ENUM_VALUES = 10 // Firestore array-contains-any cap

/**
 * Cap a list of canonical 10-tag values to the array-contains-any limit.
 * Pure / deterministic — exported for unit tests.
 */
export function capIndustryEnumValues(tags: readonly string[]): string[] {
  if (!Array.isArray(tags) || tags.length === 0) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tags) {
    const s = typeof t === "string" ? t.trim() : ""
    if (!s) continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= MAX_INDUSTRY_ENUM_VALUES) break
  }
  return out
}


export type QueryMatchingJobsDeps = {
  db: Firestore
  log?: (...args: unknown[]) => void
  /**
   * Stream F5 — when true, the projected MatchingJob includes the
   * `embedding` field (1536-d float[]). Used by the daily-batch
   * embedding rerank path. Default false to avoid bloating LLM payloads
   * for the recruiter-agent / LLM tool path.
   */
  includeEmbedding?: boolean
}

function defaultLog(..._args: unknown[]): void {
  /* swallow */
}

/**
 * Map a raw `matching-jobs` doc to the trimmed `MatchingJob` shape the
 * recruiter surfaces. Defensive about absent / mistyped fields — corpus
 * was scraped from multiple sources and not every row is uniform.
 */
export function projectMatchingJobRow(id: string, raw: Record<string, unknown>): MatchingJob {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null
  const str = (v: unknown): string => (typeof v === "string" ? v : "")
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null)

  // The corpus uses `roleTitle` (per the live sample) — fall back to
  // common alternates so a future schema migration doesn't silently break.
  const jobTitle =
    str(raw.roleTitle) || str(raw.jobTitle) || str(raw.title) || ""

  const requiredSkills = Array.isArray(raw.requiredSkills)
    ? (raw.requiredSkills.filter((s) => typeof s === "string") as string[])
    : []

  return {
    id,
    companyName: str(raw.companyName),
    jobTitle,
    salaryMax: num(raw.salaryMax),
    salaryMin: num(raw.salaryMin),
    locationRaw: str(raw.locationRaw),
    primaryUrl: str(raw.primaryUrl),
    industry: str(raw.industry),
    industryKey: typeof raw.industryKey === "string" ? raw.industryKey : undefined,
    sponsorship: bool(raw.sponsorship),
    jobType: typeof raw.jobType === "string" ? raw.jobType : undefined,
    requiredSkills: requiredSkills.length > 0 ? requiredSkills : undefined,
    firstSeenAt: typeof raw.firstSeenAt === "string" ? raw.firstSeenAt : undefined,
  }
}

/** Lower-case Jaccard overlap between two string sets. Returns 0..1. */
export function jaccardOverlap(a: string[], b: string[]): number {
  const lower = (s: string) => s.toLowerCase().trim()
  const sa = new Set(a.map(lower).filter(Boolean))
  const sb = new Set(b.map(lower).filter(Boolean))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Score a candidate job against user filters. Pure / deterministic so
 * tests can lock the ordering down to specific tie-break behaviour.
 *
 * Components (each 0..1, summed):
 *   - skill overlap (weight 0.5)
 *   - sponsorship match (weight 0.2)
 *   - location match (weight 0.2)
 *   - salary floor met (weight 0.1)
 */
export function scoreJob(job: MatchingJob, filters: QueryMatchingJobsFilters): number {
  const userSkills = filters.userSkills ?? []
  const skillScore = job.requiredSkills ? jaccardOverlap(userSkills, job.requiredSkills) : 0

  let sponsorshipScore = 0.5
  if (filters.sponsorship === "none") {
    // user does NOT want sponsorship; sponsorship=true is a soft demerit
    sponsorshipScore = job.sponsorship === true ? 0.0 : 1.0
  } else if (filters.sponsorship === "h1b" || filters.sponsorship === "gc") {
    // user wants sponsorship; sponsorship=true preferred
    sponsorshipScore = job.sponsorship === true ? 1.0 : 0.2
  }

  let locationScore = 0.5
  if (filters.location && job.locationRaw) {
    const f = filters.location.toLowerCase().trim()
    const l = job.locationRaw.toLowerCase()
    // Stream H7 — primary city-token also tested as substring. User
    // preferences like "Baltimore,MD" don't substring-match real
    // `locationRaw` like "Baltimore, MD" (the comma-space difference
    // breaks the literal match), so we also derive a primary city token
    // from the first comma-segment and substring-test that.
    const primaryCity = f.split(",")[0]?.trim() ?? ""
    if (l.includes(f)) locationScore = 1.0
    else if (primaryCity && primaryCity.length >= 3 && l.includes(primaryCity)) locationScore = 1.0
    else if (f === "remote" && l.includes("remote")) locationScore = 1.0
    else if (f === "anywhere" || f === "any") locationScore = 0.7
    else {
      // Stream H7 — fallback ladder for under-represented preferences.
      // When the primary city is sparse in corpus (e.g. Baltimore,MD has
      // 0/8000 active rows), fall through to deterministic neighbor list.
      // Match precedence: remote-neighbor (0.7, since "remote" satisfies
      // a Baltimore-based candidate well) > city-neighbor (0.6) > 0.2 floor.
      const neighbors = LOCATION_NEIGHBORS[f] ?? []
      let ladderScore = 0.2
      for (const n of neighbors) {
        if (n === "remote" && l.includes("remote")) {
          ladderScore = Math.max(ladderScore, 0.7)
          continue
        }
        if (n && l.includes(n)) {
          ladderScore = Math.max(ladderScore, 0.6)
        }
      }
      locationScore = ladderScore
    }
  }

  let salaryScore = 0.5
  if (typeof filters.salaryMin === "number" && filters.salaryMin > 0) {
    if (typeof job.salaryMax === "number" && job.salaryMax >= filters.salaryMin) salaryScore = 1.0
    else if (typeof job.salaryMax === "number") salaryScore = 0.0
  }

  return 0.5 * skillScore + 0.2 * sponsorshipScore + 0.2 * locationScore + 0.1 * salaryScore
}

/** Pure ranking helper — exposed for direct unit testing. */
export function rankJobs(
  jobs: MatchingJob[],
  filters: QueryMatchingJobsFilters,
  limit: number
): MatchingJob[] {
  const scored = jobs.map((j) => ({ j, s: scoreJob(j, filters) }))
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s
    // tie-break: newer firstSeenAt wins
    return (b.j.firstSeenAt ?? "").localeCompare(a.j.firstSeenAt ?? "")
  })
  return scored.slice(0, limit).map((x) => x.j)
}

export type QueryMatchingJobsArgs = {
  filters: QueryMatchingJobsFilters
  limit?: number
}

export async function queryMatchingJobs(
  args: QueryMatchingJobsArgs,
  deps: QueryMatchingJobsDeps
): Promise<QueryMatchingJobsOutput> {
  const parsed = QueryMatchingJobsInputSchema.parse({
    filters: args.filters,
    limit: args.limit ?? 5,
  })
  const log = deps.log ?? defaultLog

  let q = deps.db.collection(MATCHING_JOBS_COLLECTION).where("status", "==", ACTIVE_STATUS)
  // Stream H8 — read the flag once per query. SDK has a 30s in-process cache
  // so cost is amortized. Default false → fall through to H6 path.
  const enumPopulated =
    (await getFlag(deps.db, FLAG_INDUSTRY_ENUM_POPULATED, {}, false)) === true
  const userTags = parsed.filters.industryTags ?? []

  if (enumPopulated && userTags.length > 0) {
    // H8 primary path — canonical industryEnum array-contains-any.
    const enumValues = capIndustryEnumValues(userTags)
    if (enumValues.length > 0) {
      log("[queryMatchingJobs] industryEnum_array_contains_any", {
        tags: userTags,
        enumValues,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q = (q as any).where("industryEnum", "array-contains-any", enumValues)
    } else if (parsed.filters.industry && parsed.filters.industry !== "any") {
      q = q.where("industryKey", "==", parsed.filters.industry)
    }
  } else {
    // H6 fallback path — expand 10-tag → corpus industryKey value-set.
    const expandedKeys = expandIndustryTags(userTags)
    if (expandedKeys.length > 0) {
      log("[queryMatchingJobs] industry_keys_expanded", {
        tags: parsed.filters.industryTags,
        keys: expandedKeys,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q = (q as any).where("industryKey", "in", expandedKeys)
    } else if (parsed.filters.industry && parsed.filters.industry !== "any") {
      q = q.where("industryKey", "==", parsed.filters.industry)
    }
  }
  // The composite indexes brief-cited support `status,industryKey,firstSeenAt`
  // (and the longer one with jobType+sponsorship). Order by firstSeenAt desc
  // and pull a window to rank in memory.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  q = (q as any).orderBy("firstSeenAt", "desc").limit(QUERY_FETCH_CAP)

  let snap
  try {
    snap = await q.get()
  } catch (err) {
    // Composite-index failures (FAILED_PRECONDITION) — fall back to
    // simpler query so the cron path isn't bricked by a missing index.
    log("[queryMatchingJobs] compound_query_failed_falling_back", {
      error: err instanceof Error ? err.message : String(err),
    })
    snap = await deps.db
      .collection(MATCHING_JOBS_COLLECTION)
      .where("status", "==", ACTIVE_STATUS)
      .limit(QUERY_FETCH_CAP)
      .get()
  }

  const projected: Array<MatchingJob & { embedding?: number[] | null }> = []
  for (const doc of snap.docs) {
    try {
      const raw = doc.data() as Record<string, unknown>
      const m = projectMatchingJobRow(doc.id, raw)
      // Validate via Zod so we catch malformed corpus rows loudly in tests.
      const validated = MatchingJobSchema.parse(m) as MatchingJob & {
        embedding?: number[] | null
      }
      if (deps.includeEmbedding === true) {
        const e = raw.embedding
        if (Array.isArray(e) && e.every((n) => typeof n === "number")) {
          validated.embedding = e as number[]
        } else {
          validated.embedding = null
        }
      }
      projected.push(validated)
    } catch (err) {
      log("[queryMatchingJobs] dropping_malformed_row", {
        id: doc.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Optional sponsorship hard filter — only apply if the user explicitly
  // does NOT want sponsorship; otherwise we keep the score-based soft pref.
  const filtered =
    parsed.filters.sponsorship === "none"
      ? projected.filter((j) => j.sponsorship !== true)
      : projected

  const ranked = rankJobs(filtered, parsed.filters, parsed.limit)
  return { jobs: ranked }
}

export function createQueryMatchingJobsTool(deps: QueryMatchingJobsDeps) {
  return tool({
    name: "queryMatchingJobs",
    description:
      "Search the WeKruit matching-jobs corpus by industry / location / sponsorship / salary " +
      "and return the top N (default 5) ranked by skill overlap + recency. " +
      "Use this to surface a sample job to the candidate.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: QueryMatchingJobsInputSchema as any,
    execute: async (raw: unknown) => {
      const args = QueryMatchingJobsInputSchema.parse(raw)
      const out = await queryMatchingJobs(args, deps)
      return JSON.stringify(out)
    },
  })
}
