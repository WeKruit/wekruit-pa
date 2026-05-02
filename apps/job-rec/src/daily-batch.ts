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
import { queryMatchingJobs, applyTitleAntiBias } from "./tools/query-matching-jobs.js"
import { sendImessage } from "./tools/send-imessage.js"
import {
  JOB_PROFILES_COLLECTION,
  JOB_REC_FLAG_KEY,
  type JobProfileDoc,
  type MatchingJob,
} from "./types.js"

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
  return `- ${titleCo}${loc}${sal}\n${job.primaryUrl}`
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
      const queryRes = await queryMatchingJobs(
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

      if (queryRes.jobs.length === 0) {
        skippedNoJobs += 1
        continue
      }

      // Stream F5 — embedding rerank when configured + user has embedding.
      // Stream G1 — cascade: fetcher → computer (lazy compute + cache) → fallback.
      let rankedJobs: MatchingJob[] = queryRes.jobs
      if (deps.userEmbedFetcher) {
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
            rankedJobs = rerankByCosine(
              queryRes.jobs as Array<MatchingJob & { embedding?: number[] | null }>,
              embedding,
              jobsPerUser
            )
            log("[job-rec-daily] rerank_applied", { userId, poolSize: queryRes.jobs.length, took: jobsPerUser })
          } else {
            // No embedding on file AND compute path didn't succeed — slice.
            rankedJobs = queryRes.jobs.slice(0, jobsPerUser)
          }
        } catch (err) {
          log("[job-rec-daily] rerank_failed_fallback", {
            userId,
            error: err instanceof Error ? err.message : String(err),
          })
          rankedJobs = queryRes.jobs.slice(0, jobsPerUser)
        }
      } else {
        rankedJobs = queryRes.jobs.slice(0, jobsPerUser)
      }

      // Stream H7 — title anti-bias rerank for tech-track users. When the
      // user is in {tech_software, ai_ml, fintech_finance}, multiply
      // QA/QC/manufacturing-engineer titles by 0.3 so cosine false-friends
      // (e.g. "QC Analyst" matching a Data Analyst CV via shared "Analyst")
      // sink. Pure / deterministic; no-op when industryTags absent or user
      // is non-tech. Re-clamps to jobsPerUser as a safety belt.
      rankedJobs = applyTitleAntiBias(rankedJobs, normalized.industryTags, jobsPerUser)

      const body = formatBatchMessage(rankedJobs)
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
