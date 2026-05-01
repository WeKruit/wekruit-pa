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
import { queryMatchingJobs } from "./tools/query-matching-jobs.js"
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
    const profileDoc = doc.data() as JobProfileDoc
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

      const queryRes = await queryMatchingJobs(
        {
          filters: {
            industry: profileDoc.profile.industry,
            location: profileDoc.profile.location,
            sponsorship: profileDoc.profile.sponsorship,
            sizePreference: profileDoc.profile.sizePreference,
            ...(profileDoc.profile.salaryMin !== undefined
              ? { salaryMin: profileDoc.profile.salaryMin }
              : {}),
          },
          limit: jobsPerUser,
        },
        { db: deps.db, log }
      )

      if (queryRes.jobs.length === 0) {
        skippedNoJobs += 1
        continue
      }

      const body = formatBatchMessage(queryRes.jobs)
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
