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

export type QueryMatchingJobsDeps = {
  db: Firestore
  log?: (...args: unknown[]) => void
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
  if (parsed.filters.industry && parsed.filters.industry !== "any") {
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

  const projected: MatchingJob[] = []
  for (const doc of snap.docs) {
    try {
      const m = projectMatchingJobRow(doc.id, doc.data() as Record<string, unknown>)
      // Validate via Zod so we catch malformed corpus rows loudly in tests.
      projected.push(MatchingJobSchema.parse(m))
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
