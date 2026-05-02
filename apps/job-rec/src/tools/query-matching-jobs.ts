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

// Type-only import guard — JobIndustry is referenced in the table type only
// for runtime documentation; the table key is a string union of
// JobIndustryTag values. JobIndustry import retained for forward-compat.
void ((): JobIndustry | undefined => undefined)

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
    const f = filters.location.toLowerCase()
    const l = job.locationRaw.toLowerCase()
    if (l.includes(f)) locationScore = 1.0
    else if (f === "remote" && l.includes("remote")) locationScore = 1.0
    else if (f === "anywhere" || f === "any") locationScore = 0.7
    else locationScore = 0.2
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
  // Stream H6 — prefer industryTags expansion (in-clause over real corpus
  // industryKey value-set) when caller provides it (daily-batch); fall back
  // to the legacy single-equality compound-where for tool-path callers.
  const expandedKeys = expandIndustryTags(parsed.filters.industryTags ?? [])
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
