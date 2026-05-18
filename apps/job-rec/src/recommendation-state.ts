import type { Firestore } from "firebase-admin/firestore"

export const USER_JOB_RECOMMENDATIONS_COLLECTION = "pa-user-job-recommendations"

export type UserJobRecommendationState = {
  userId: string
  jobId: string
  recommendationCount: number
  lastRecommendedAt?: string
  lastRecommendedSource?: string
}

export type RecordRecommendedJobsArgs = {
  userId: string
  jobs: Array<{ id?: unknown }>
  source: string
  nowIso?: string
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0
}

function stateDoc(db: Firestore, userId: string, jobId: string) {
  return db
    .collection(USER_JOB_RECOMMENDATIONS_COLLECTION)
    .doc(userId)
    .collection("jobs")
    .doc(jobId)
}

export async function loadRecommendedJobStates(
  db: Firestore,
  userId: string,
  jobIds: string[],
  log?: (event: string, payload?: Record<string, unknown>) => void,
): Promise<Map<string, UserJobRecommendationState>> {
  const cleanUserId = cleanId(userId)
  const out = new Map<string, UserJobRecommendationState>()
  if (!cleanUserId) return out
  const uniqueJobIds = [...new Set(jobIds.map(cleanId).filter((id): id is string => !!id))]
  await Promise.all(
    uniqueJobIds.map(async (jobId) => {
      try {
        const snap = await stateDoc(db, cleanUserId, jobId).get()
        if (!snap.exists) return
        const data = snap.data() as Record<string, unknown> | undefined
        const recommendationCount = positiveInt(data?.recommendationCount)
        if (recommendationCount <= 0) return
        out.set(jobId, {
          userId: cleanUserId,
          jobId,
          recommendationCount,
          ...(typeof data?.lastRecommendedAt === "string" ? { lastRecommendedAt: data.lastRecommendedAt } : {}),
          ...(typeof data?.lastRecommendedSource === "string"
            ? { lastRecommendedSource: data.lastRecommendedSource }
            : {}),
        })
      } catch (err) {
        log?.("pa.job_rec.recommendation_state_read_failed", {
          userId: cleanUserId,
          jobId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }),
  )
  return out
}

export async function recordRecommendedJobs(
  db: Firestore,
  args: RecordRecommendedJobsArgs,
  log?: (event: string, payload?: Record<string, unknown>) => void,
): Promise<void> {
  const userId = cleanId(args.userId)
  if (!userId) return
  const jobIds = [...new Set(args.jobs.map((job) => cleanId(job.id)).filter((id): id is string => !!id))]
  if (jobIds.length === 0) return
  const nowIso = args.nowIso ?? new Date().toISOString()
  await Promise.all(
    jobIds.map(async (jobId) => {
      const ref = stateDoc(db, userId, jobId)
      try {
        const snap = await ref.get()
        const existing = snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined
        const previousCount = positiveInt(existing?.recommendationCount)
        await ref.set(
          {
            userId,
            jobId,
            recommendationCount: previousCount + 1,
            lastRecommendedAt: nowIso,
            lastRecommendedSource: args.source,
            updatedAt: nowIso,
            ...(previousCount === 0 ? { firstRecommendedAt: nowIso } : {}),
          },
          { merge: true },
        )
      } catch (err) {
        log?.("pa.job_rec.recommendation_state_write_failed", {
          userId,
          jobId,
          source: args.source,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }),
  )
}
