import type { Firestore } from "firebase-admin/firestore"

export const USER_JOB_RECOMMENDATIONS_COLLECTION = "pa-user-job-recommendations"

/**
 * Rec tracking (req #4, 2026-05-29) — a single attribution row appended to the
 * per-(user,job) ledger every time the job is recommended. Lets the flywheel
 * distinguish WHY/HOW a job was surfaced (collab vs general_market vs the
 * claire_agent tool path) across repeated recommendations.
 */
export type RecommendationSourceEntry = {
  /** ISO timestamp of the recommendation. */
  timestamp: string
  /** Attribution source, e.g. "wekruit_collab" | "general_market" | "claire_agent". */
  source: string
  /** Optional match/intent confidence ∈ [0, 1] when the caller has one. */
  confidence?: number
}

export type UserJobRecommendationState = {
  userId: string
  jobId: string
  recommendationCount: number
  lastRecommendedAt?: string
  lastRecommendedSource?: string
  /**
   * Rec tracking (req #4) — append-only attribution ledger. One row per
   * recommendation event. Optional for back-compat with pre-2026-05-29 docs
   * that only carry the scalar `recommendationCount` / `lastRecommendedSource`.
   */
  recommendationSources?: RecommendationSourceEntry[]
}

export type RecordRecommendedJobsArgs = {
  userId: string
  jobs: Array<{ id?: unknown }>
  source: string
  nowIso?: string
  /**
   * Rec tracking (req #4) — optional richer attribution for the appended
   * `recommendationSources` row. `reason` overrides `source` as the row's
   * source label when present (so callers can pass a coarse `source` for the
   * scalar fields and a precise `reason` for the ledger, e.g.
   * reason="wekruit_collab"). `confidence` is the per-event match confidence.
   */
  reason?: string
  confidence?: number
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

/** Sanitize a raw `recommendationSources` array read from Firestore. */
function normalizeSourceEntries(raw: unknown): RecommendationSourceEntry[] {
  if (!Array.isArray(raw)) return []
  const out: RecommendationSourceEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    const timestamp = typeof r.timestamp === "string" ? r.timestamp : undefined
    const source = typeof r.source === "string" ? r.source : undefined
    if (!timestamp || !source) continue
    out.push({
      timestamp,
      source,
      ...(typeof r.confidence === "number" && Number.isFinite(r.confidence)
        ? { confidence: r.confidence }
        : {}),
    })
  }
  return out
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
          ...(Array.isArray(data?.recommendationSources)
            ? { recommendationSources: normalizeSourceEntries(data.recommendationSources) }
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
        // Rec tracking (req #4) — append one attribution row to the ledger.
        // `reason` (precise) wins over `source` (coarse) as the row's label.
        const rowSource = args.reason ?? args.source
        const newRow: RecommendationSourceEntry = {
          timestamp: nowIso,
          source: rowSource,
          ...(typeof args.confidence === "number" && Number.isFinite(args.confidence)
            ? { confidence: args.confidence }
            : {}),
        }
        const recommendationSources = [
          ...normalizeSourceEntries(existing?.recommendationSources),
          newRow,
        ]
        await ref.set(
          {
            userId,
            jobId,
            recommendationCount: previousCount + 1,
            lastRecommendedAt: nowIso,
            lastRecommendedSource: args.source,
            recommendationSources,
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
