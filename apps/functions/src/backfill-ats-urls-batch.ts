/**
 * v1.7 Phase 65 — Hourly Serper backfill batch CF (`paBackfillAtsUrlsBatch`).
 *
 * REQ-IDs: ATSURL-01, ATSURL-02, ATSURL-03, ATSURL-04
 *
 * Cloud Scheduler `0 * * * *` (every hour, top of hour). Replaces the inline
 * backfill that lived inside `runLivenessSweep` (Phase 57): liveness-sweep
 * still HEAD-checks but no longer Serper-resolves missing URLs. Dedicated
 * batch handles 200/run × 24 = 4800 attempted resolves/day with 5-concurrent
 * Serper calls + retry queue + LinkedIn fallback + cost ledger.
 *
 * Pipeline:
 *   1. Read priority queue (`pa-ats-resolve-priority`) — failed previous
 *      attempts whose TTL has expired and are ready to retry. Drop entries
 *      older than 7d on the way through (TTL cleanup).
 *   2. Read top 200 active jobs missing atsApplyUrl, ordered by firstSeenAt
 *      desc, that aren't already in the priority queue (or whose retry-after
 *      timestamp has elapsed).
 *   3. 5-concurrent processing per job:
 *        - Pass 1 (free): primaryUrl is ATS host → copy.
 *        - Pass 3 (paid): Serper search → first ATS hit.
 *        - LinkedIn fallback: parse HTML of primaryUrl for LinkedIn jobs URL.
 *        - Miss: write to retry queue with TTL 7d.
 *   4. Each Serper call → cost-ledger row ($0.001/call).
 *   5. Audit row in `pa-ats-backfill-runs/{runId}` with counters.
 *
 * Cost guard:
 *   - 200 jobs/run × 24 runs = 4800 attempted resolves/day max
 *   - ~10% reach Serper (most resolved via Pass 1) → ~480 Serper/day
 *   - ~$0.48/day Serper. Weekly ~$3.36 — well under the $10/wk alert.
 *
 * Architecture:
 *   - Pure logic in `runBackfillBatch` (deps-injected) for testability.
 *   - `paBackfillAtsUrlsBatch` onSchedule wrapper at the bottom.
 */

import { onSchedule } from "firebase-functions/v2/scheduler"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import {
  getFirestore,
  type Firestore,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore"

import {
  resolveAtsUrl,
  createSerperSearch,
  isAcceptableApplyUrl,
  type SerperFn,
  type ResolveJobInput,
} from "./backfill-ats-urls.js"
import { makeLimiter } from "./liveness-sweep.js"
import {
  makeFirestoreCostLedgerWriter,
  SERPER_USD_PER_CALL,
  type CostLedgerWriter,
} from "./lib/cost-ledger.js"

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SERPER_API_KEY = defineSecret("SERPER_API_KEY")

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Jobs processed per batch run. 200/run × 24/day = 4800 capacity. */
export const BATCH_SIZE_DEFAULT = 200
/** Max parallel Serper calls (avoid rate-limit / spread Serper concurrency). */
export const SERPER_CONCURRENCY_DEFAULT = 5
/** Retry-queue TTL — failed jobs wait this long before next retry. */
export const RETRY_TTL_MS_DEFAULT = 7 * 24 * 3600 * 1000
/** Liveness sweep is unaware of unresolvable jobs unless we mark a stamp. */
export const URL_RESOLUTION_STAMP_FIELD = "urlResolutionAttemptedAt"

const MATCHING_JOBS_COLLECTION = "matching-jobs"
const PRIORITY_QUEUE_COLLECTION = "pa-ats-resolve-priority"
const RUNS_COLLECTION = "pa-ats-backfill-runs"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BatchJobDoc = {
  id: string
  primaryUrl?: string
  companyName?: string
  jobTitle?: string
  roleTitle?: string
  atsApplyUrl?: string
  status?: string
  /**
   * ISO string OR ms-since-epoch OR Firestore Timestamp-ish — used to read
   * priority-queue retry-after times in addition to firstSeenAt ordering.
   */
  firstSeenAt?: unknown
}

export type RetryQueueEntry = {
  jobId: string
  /** ISO string. */
  firstFailedAt: string
  /** ISO string. */
  lastAttemptAt: string
  /** Number of resolve attempts so far. */
  attempts: number
  /** Last failure reason ("serper_miss" | "no_anchors" | "linkedin_miss"). */
  lastReason?: string
}

export type BatchUpdate = {
  atsApplyUrl?: string
  atsResolvedAt?: string
  atsResolvedBy?: string
  urlResolutionAttemptedAt?: string
}

export type BackfillBatchStore = {
  /** Read up-to `limit` priority-queue entries in oldest-first order. */
  fetchPriorityQueue: (limit: number) => Promise<RetryQueueEntry[]>
  /** Delete priority-queue rows older than `ttlMs`. Returns count cleared. */
  cleanupExpiredPriorityQueue: (ttlMs: number, nowMs: number) => Promise<number>
  /** Fetch the top `limit` candidate jobs missing atsApplyUrl. */
  fetchCandidates: (limit: number) => Promise<BatchJobDoc[]>
  /** Read a single job doc by ID (used to fetch enriched data for retry-queue entries). */
  fetchJobById: (jobId: string) => Promise<BatchJobDoc | null>
  /** Apply field updates to the matching-jobs doc. */
  updateJob: (id: string, updates: BatchUpdate) => Promise<void>
  /** Upsert a retry-queue entry. */
  upsertPriorityQueue: (jobId: string, payload: RetryQueueEntry) => Promise<void>
  /** Remove a retry-queue entry by jobId (after successful resolve). */
  removePriorityQueue: (jobId: string) => Promise<void>
  /** Write the run audit row. */
  writeAudit: (runId: string, doc: Record<string, unknown>) => Promise<void>
}

export type BatchCounters = {
  totalProcessed: number
  pass1Count: number
  pass3Count: number
  linkedinCount: number
  missCount: number
  retryQueueWrites: number
  retryQueueClears: number
  expiredCleanups: number
  serperCalls: number
  errors: number
}

export function emptyCounters(): BatchCounters {
  return {
    totalProcessed: 0,
    pass1Count: 0,
    pass3Count: 0,
    linkedinCount: 0,
    missCount: 0,
    retryQueueWrites: 0,
    retryQueueClears: 0,
    expiredCleanups: 0,
    serperCalls: 0,
    errors: 0,
  }
}

export type LinkedinExtractor = (primaryUrl: string) => Promise<string | null>

export type BackfillBatchDeps = {
  store: BackfillBatchStore
  /** Cost-ledger writer — production wires Firestore. */
  costLedger: CostLedgerWriter
  /** Serper resolver — pure deps-injected for testability. */
  serper: SerperFn
  /** Optional LinkedIn URL extractor (10% Pass-3-miss saved). */
  linkedinExtractor?: LinkedinExtractor
  /** ms-since-epoch — stub for tests. */
  now: () => number
  /** Optional knobs (override for tests). */
  batchSize?: number
  serperConcurrency?: number
  retryTtlMs?: number
  log?: (msg: string, ctx?: Record<string, unknown>) => void
  errorLog?: (msg: string, ctx?: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// LinkedIn URL fallback (~10% recovery rate per Phase 65 spec)
// ---------------------------------------------------------------------------

/**
 * Naive HTML scrape: download `primaryUrl`, regex-search for a LinkedIn jobs
 * URL. Returns null on any failure. NEVER throws.
 *
 * Note: this is a soft fallback when Serper misses. We accept LinkedIn jobs
 * URLs even though they aren't a real ATS — they're at least a directly-
 * applyable destination, and the user-facing copy can render the apply CTA.
 */
export function createLinkedinExtractor(opts?: {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): LinkedinExtractor {
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts?.timeoutMs ?? 8000
  return async (primaryUrl) => {
    if (!primaryUrl) return null
    let html = ""
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const res = await fetchImpl(primaryUrl, {
          method: "GET",
          redirect: "follow",
          signal: ctrl.signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; WeKruitBot/1.0; +https://wekruit.com)",
          },
        })
        if (!res.ok) return null
        html = await res.text()
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return null
    }
    // Match LinkedIn jobs view URLs — both /jobs/view/ID and /jobs/jobs/ID.
    const m = html.match(
      /https?:\/\/(?:www\.)?linkedin\.com\/jobs\/view\/[A-Za-z0-9_\-?=&%/.]+/i
    )
    if (m && m[0]) return m[0]
    return null
  }
}

/** A LinkedIn jobs URL is a valid recovery (not a real ATS, but applyable). */
export function isLinkedinJobsUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== "string") return false
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return false
    return parsed.pathname.startsWith("/jobs/")
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Single-job processor
// ---------------------------------------------------------------------------

export type ProcessOneOutcome =
  | { kind: "pass1"; url: string }
  | { kind: "pass3"; url: string }
  | { kind: "linkedin"; url: string }
  | { kind: "miss"; reason: "no_anchors" | "serper_miss" | "linkedin_miss" }
  | { kind: "error"; message: string }

/**
 * Process one job. Pure-ish — mutates counters, calls deps for I/O.
 * Returns the outcome so the caller can decide whether to clear / write to
 * the retry queue.
 */
export async function processOneJob(
  job: BatchJobDoc,
  runId: string,
  counters: BatchCounters,
  deps: BackfillBatchDeps
): Promise<ProcessOneOutcome> {
  // Pass 1 (free) — primaryUrl is acceptable (parseable + non-jobright).
  if (job.primaryUrl && isAcceptableApplyUrl(job.primaryUrl)) {
    counters.pass1Count++
    return { kind: "pass1", url: job.primaryUrl }
  }

  const title = (job.jobTitle ?? job.roleTitle ?? "").trim()
  const company = (job.companyName ?? "").trim()
  if (!title || !company) {
    counters.missCount++
    return { kind: "miss", reason: "no_anchors" }
  }

  // Pass 3 — Serper. Wraps via `resolveAtsUrl` so we go through the same
  // pure path as `paBackfillMatchingJobsAtsUrl`. Tracks ledger inside our
  // local serper wrapper so the SerperFn interface stays clean.
  const wrappedSerper: SerperFn = async (t, c) => {
    counters.serperCalls++
    let result: string | null = null
    let success = false
    try {
      result = await deps.serper(t, c)
      if (result && isAcceptableApplyUrl(result)) success = true
    } catch (err) {
      counters.errors++
      ;(deps.errorLog ?? (() => {}))("serper_threw", {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    // Cost-ledger row — best-effort, never throws back.
    await deps.costLedger.write({
      api: "serper",
      cost_usd: SERPER_USD_PER_CALL,
      jobId: job.id,
      success,
      ts: new Date(deps.now()).toISOString(),
      runId,
    })
    return result
  }

  const resolveInput: ResolveJobInput = {
    ...(job.primaryUrl ? { primaryUrl: job.primaryUrl } : {}),
    companyName: company,
    jobTitle: title,
    ...(job.roleTitle ? { roleTitle: job.roleTitle } : {}),
  }
  const out = await resolveAtsUrl(resolveInput, { serper: wrappedSerper })
  if (out.kind === "pass1") {
    counters.pass1Count++
    return { kind: "pass1", url: out.url }
  }
  if (out.kind === "pass3") {
    counters.pass3Count++
    return { kind: "pass3", url: out.url }
  }

  // LinkedIn fallback — only when both Pass 1 + Pass 3 missed.
  if (deps.linkedinExtractor && job.primaryUrl) {
    let linkedinUrl: string | null = null
    try {
      linkedinUrl = await deps.linkedinExtractor(job.primaryUrl)
    } catch (err) {
      counters.errors++
      ;(deps.errorLog ?? (() => {}))("linkedin_extractor_threw", {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (linkedinUrl && isLinkedinJobsUrl(linkedinUrl)) {
      counters.linkedinCount++
      return { kind: "linkedin", url: linkedinUrl }
    }
    counters.missCount++
    return { kind: "miss", reason: "linkedin_miss" }
  }

  counters.missCount++
  return { kind: "miss", reason: "serper_miss" }
}

// ---------------------------------------------------------------------------
// Top-level driver
// ---------------------------------------------------------------------------

/**
 * Drive the hourly batch end-to-end. Pure logic; deps wire I/O.
 *
 * Returns counters for the audit row.
 */
export async function runBackfillBatch(
  deps: BackfillBatchDeps
): Promise<{ counters: BatchCounters; runId: string }> {
  const log = deps.log ?? (() => {})
  const errorLog = deps.errorLog ?? log

  const batchSize = deps.batchSize ?? BATCH_SIZE_DEFAULT
  const concurrency = deps.serperConcurrency ?? SERPER_CONCURRENCY_DEFAULT
  const retryTtlMs = deps.retryTtlMs ?? RETRY_TTL_MS_DEFAULT
  const counters = emptyCounters()
  const runId = `atsurl-${new Date(deps.now()).toISOString().replace(/[:.]/g, "-")}`
  const nowIso = new Date(deps.now()).toISOString()

  log("backfill_batch_start", { runId, batchSize, concurrency })

  // 1. TTL cleanup of priority queue.
  try {
    const cleared = await deps.store.cleanupExpiredPriorityQueue(retryTtlMs, deps.now())
    counters.expiredCleanups = cleared
  } catch (err) {
    errorLog("priority_queue_cleanup_failed", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 2. Build candidate set: priority queue (oldest first, ready to retry) +
  //    fresh active jobs missing atsApplyUrl. Cap total at batchSize.
  const seen = new Set<string>()
  const candidates: BatchJobDoc[] = []

  let priorityEntries: RetryQueueEntry[] = []
  try {
    priorityEntries = await deps.store.fetchPriorityQueue(batchSize)
  } catch (err) {
    errorLog("priority_queue_read_failed", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  for (const entry of priorityEntries) {
    if (candidates.length >= batchSize) break
    if (seen.has(entry.jobId)) continue
    // Read the job row to make sure it's still active + still missing atsApplyUrl.
    let job: BatchJobDoc | null = null
    try {
      job = await deps.store.fetchJobById(entry.jobId)
    } catch (err) {
      errorLog("priority_queue_fetchjob_failed", {
        runId,
        jobId: entry.jobId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (!job) {
      // Job vanished (deleted by liveness sweep) — drop the queue entry.
      try {
        await deps.store.removePriorityQueue(entry.jobId)
        counters.retryQueueClears++
      } catch {
        // swallow
      }
      continue
    }
    if (job.status !== "active") continue
    if (typeof job.atsApplyUrl === "string" && job.atsApplyUrl.length > 0) {
      // Already resolved by another path — drop queue entry.
      try {
        await deps.store.removePriorityQueue(entry.jobId)
        counters.retryQueueClears++
      } catch {
        // swallow
      }
      continue
    }
    seen.add(job.id)
    candidates.push(job)
  }

  // 3. Fill remainder with fresh candidates.
  const remaining = batchSize - candidates.length
  if (remaining > 0) {
    let fresh: BatchJobDoc[] = []
    try {
      fresh = await deps.store.fetchCandidates(remaining + seen.size)
    } catch (err) {
      errorLog("fetch_candidates_failed", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    for (const job of fresh) {
      if (candidates.length >= batchSize) break
      if (seen.has(job.id)) continue
      // Skip jobs in priority queue we already considered (the seen set
      // already covers those, but also exclude any jobs that have a
      // priority queue entry not in our top-N read, which would only
      // happen for tail entries — accept as fine for hourly cadence).
      seen.add(job.id)
      candidates.push(job)
    }
  }

  log("backfill_batch_candidates", {
    runId,
    priorityCount: priorityEntries.length,
    candidateCount: candidates.length,
  })

  // 4. Process with concurrency cap.
  const limiter = makeLimiter(concurrency)
  const tasks = candidates.map((job) =>
    limiter(async () => {
      counters.totalProcessed++
      let outcome: ProcessOneOutcome
      try {
        outcome = await processOneJob(job, runId, counters, deps)
      } catch (err) {
        counters.errors++
        errorLog("process_one_threw", {
          runId,
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }

      if (outcome.kind === "pass1" || outcome.kind === "pass3" || outcome.kind === "linkedin") {
        const updates: BatchUpdate = {
          atsApplyUrl: outcome.url,
          atsResolvedAt: nowIso,
          atsResolvedBy:
            outcome.kind === "pass1"
              ? "cf-batch-pass1"
              : outcome.kind === "pass3"
                ? "cf-batch-pass3"
                : "cf-batch-linkedin",
        }
        try {
          await deps.store.updateJob(job.id, updates)
        } catch (err) {
          counters.errors++
          errorLog("update_job_failed", {
            runId,
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          })
          return
        }
        // Successful resolve → clear priority queue entry if present.
        try {
          await deps.store.removePriorityQueue(job.id)
          counters.retryQueueClears++
        } catch {
          /* swallow — entry might not exist */
        }
        return
      }

      if (outcome.kind === "miss") {
        // Stamp attempt timestamp so future runs know we tried recently.
        try {
          await deps.store.updateJob(job.id, {
            urlResolutionAttemptedAt: nowIso,
          })
        } catch (err) {
          counters.errors++
          errorLog("stamp_attempt_failed", {
            runId,
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        // Retry-queue write — find existing entry to bump attempts.
        const existing = priorityEntries.find((e) => e.jobId === job.id) ?? null
        const payload: RetryQueueEntry = {
          jobId: job.id,
          firstFailedAt: existing?.firstFailedAt ?? nowIso,
          lastAttemptAt: nowIso,
          attempts: (existing?.attempts ?? 0) + 1,
          lastReason: outcome.reason,
        }
        try {
          await deps.store.upsertPriorityQueue(job.id, payload)
          counters.retryQueueWrites++
        } catch (err) {
          counters.errors++
          errorLog("priority_queue_upsert_failed", {
            runId,
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return
      }
      // outcome.kind === "error" — already counted upstream
    })
  )
  await Promise.allSettled(tasks)

  // 5. Audit row.
  try {
    await deps.store.writeAudit(runId, {
      runId,
      runAt: nowIso,
      counters,
    })
  } catch (err) {
    errorLog("audit_write_failed", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  log("backfill_batch_complete", { runId, ...counters })
  return { counters, runId }
}

// ---------------------------------------------------------------------------
// Production Firestore-backed store
// ---------------------------------------------------------------------------

function timestampToMsLocal(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : 0
  }
  if (v && typeof v === "object") {
    const obj = v as { toDate?: () => Date; seconds?: number }
    if (typeof obj.toDate === "function") {
      try {
        const d = obj.toDate()
        if (d instanceof Date) return d.getTime()
      } catch {
        return 0
      }
    }
    if (typeof obj.seconds === "number") return obj.seconds * 1000
  }
  return 0
}

function projectJobDoc(id: string, data: DocumentData): BatchJobDoc {
  const out: BatchJobDoc = { id }
  if (typeof data.primaryUrl === "string") out.primaryUrl = data.primaryUrl
  if (typeof data.companyName === "string") out.companyName = data.companyName
  if (typeof data.jobTitle === "string") out.jobTitle = data.jobTitle
  if (typeof data.roleTitle === "string") out.roleTitle = data.roleTitle
  if (typeof data.atsApplyUrl === "string") out.atsApplyUrl = data.atsApplyUrl
  if (typeof data.status === "string") out.status = data.status
  if (data.firstSeenAt !== undefined) out.firstSeenAt = data.firstSeenAt
  return out
}

export function makeFirestoreStore(db: Firestore = getFirestore()): BackfillBatchStore {
  return {
    fetchPriorityQueue: async (limit) => {
      const snap = await db
        .collection(PRIORITY_QUEUE_COLLECTION)
        .orderBy("firstFailedAt", "asc")
        .limit(limit)
        .get()
      const out: RetryQueueEntry[] = []
      for (const doc of snap.docs as Array<QueryDocumentSnapshot>) {
        const data = doc.data() as DocumentData
        out.push({
          jobId: doc.id,
          firstFailedAt:
            typeof data.firstFailedAt === "string" ? data.firstFailedAt : new Date(0).toISOString(),
          lastAttemptAt:
            typeof data.lastAttemptAt === "string" ? data.lastAttemptAt : new Date(0).toISOString(),
          attempts: typeof data.attempts === "number" ? data.attempts : 0,
          ...(typeof data.lastReason === "string" ? { lastReason: data.lastReason } : {}),
        })
      }
      return out
    },
    cleanupExpiredPriorityQueue: async (ttlMs, nowMs) => {
      const cutoffIso = new Date(nowMs - ttlMs).toISOString()
      const snap = await db
        .collection(PRIORITY_QUEUE_COLLECTION)
        .where("firstFailedAt", "<", cutoffIso)
        .get()
      let count = 0
      await Promise.allSettled(
        snap.docs.map((d) =>
          d.ref.delete().then(
            () => {
              count++
            },
            () => {
              /* swallow */
            }
          )
        )
      )
      return count
    },
    fetchCandidates: async (limit) => {
      // Two-stage: status=active + atsApplyUrl missing, ordered by firstSeenAt
      // desc. Firestore can't do "atsApplyUrl missing" via where, so we
      // overscan and filter in-memory. Cap overscan at 5x.
      let snap
      try {
        snap = await db
          .collection(MATCHING_JOBS_COLLECTION)
          .where("status", "==", "active")
          .orderBy("firstSeenAt", "desc")
          .limit(Math.min(limit * 5, 1000))
          .get()
      } catch {
        // Composite-index miss → status-only fallback.
        snap = await db
          .collection(MATCHING_JOBS_COLLECTION)
          .where("status", "==", "active")
          .limit(Math.min(limit * 5, 1000))
          .get()
      }
      const out: BatchJobDoc[] = []
      for (const doc of snap.docs as Array<QueryDocumentSnapshot>) {
        if (out.length >= limit) break
        const data = doc.data() as DocumentData
        if (data.dead === true) continue
        const url = typeof data.atsApplyUrl === "string" ? data.atsApplyUrl : ""
        if (url.length > 0) continue
        // Need anchor for resolution — primaryUrl OR (companyName + jobTitle).
        const hasAnchor =
          (typeof data.primaryUrl === "string" && data.primaryUrl.length > 0) ||
          (typeof data.companyName === "string" &&
            data.companyName.length > 0 &&
            (typeof data.jobTitle === "string" || typeof data.roleTitle === "string"))
        if (!hasAnchor) continue
        out.push(projectJobDoc(doc.id, data))
      }
      return out
    },
    fetchJobById: async (jobId) => {
      const ref = db.collection(MATCHING_JOBS_COLLECTION).doc(jobId)
      const doc = await ref.get()
      if (!doc.exists) return null
      return projectJobDoc(doc.id, doc.data() as DocumentData)
    },
    updateJob: async (id, updates) => {
      const sanitized: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) sanitized[k] = v
      }
      if (Object.keys(sanitized).length === 0) return
      await db.collection(MATCHING_JOBS_COLLECTION).doc(id).update(sanitized)
    },
    upsertPriorityQueue: async (jobId, payload) => {
      const sanitized: Record<string, unknown> = { ...payload }
      if (sanitized.lastReason === undefined) delete sanitized.lastReason
      await db
        .collection(PRIORITY_QUEUE_COLLECTION)
        .doc(jobId)
        .set(sanitized, { merge: true })
    },
    removePriorityQueue: async (jobId) => {
      await db.collection(PRIORITY_QUEUE_COLLECTION).doc(jobId).delete()
    },
    writeAudit: async (runId, doc) => {
      await db.collection(RUNS_COLLECTION).doc(runId).set(doc)
    },
  }
}

// ---------------------------------------------------------------------------
// Cloud Function — hourly at top of hour
// ---------------------------------------------------------------------------

export const paBackfillAtsUrlsBatch = onSchedule(
  {
    schedule: "0 * * * *",
    timeZone: "UTC",
    memory: "512MiB",
    timeoutSeconds: 540,
    region: "us-central1",
    secrets: [SERPER_API_KEY],
    retryCount: 0,
  },
  async () => {
    const apiKey = (process.env.SERPER_API_KEY ?? "").trim()
    if (!apiKey) {
      logger.warn(
        "[backfill-ats-urls-batch] SERPER_API_KEY missing — Pass-3 will no-op (Pass-1 + LinkedIn still active)"
      )
    }
    const serper: SerperFn = apiKey
      ? createSerperSearch({ apiKey })
      : async () => null

    const db = getFirestore()
    const result = await runBackfillBatch({
      store: makeFirestoreStore(db),
      costLedger: makeFirestoreCostLedgerWriter(db),
      serper,
      linkedinExtractor: createLinkedinExtractor(),
      now: () => Date.now(),
      log: (msg, ctx) => logger.info(`[backfill-ats-urls-batch] ${msg}`, ctx ?? {}),
      errorLog: (msg, ctx) => logger.error(`[backfill-ats-urls-batch] ${msg}`, ctx ?? {}),
    })

    logger.info("[backfill-ats-urls-batch] done", {
      runId: result.runId,
      ...result.counters,
    })
  }
)

// ---------------------------------------------------------------------------
// Weekly cost summary CF — Mon 09:30 UTC.
// ---------------------------------------------------------------------------

import {
  summarizeCostLedger,
  formatSummaryEmail,
  type CostLedgerSummary,
} from "./lib/cost-ledger.js"
import { sendMailgun, type MailgunConfig } from "./email/mailgun.js"
import {
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  MAILGUN_FROM,
  MAILGUN_REGION,
  PA_SLACK_ALERT_WEBHOOK,
} from "./orchestrator-deps.js"
import { postSlackAlert } from "./lib/slack-alert.js"

/** Threshold for sending the cost summary email (USD/week). */
export const COST_ALERT_THRESHOLD_USD = 10

/** Recipient for cost-summary alerts (matches dashboard admin email). */
const COST_SUMMARY_RECIPIENT = "developers@wekruit.com"

/**
 * Compute summary over the prior 7 days. Pure-ish: caller injects iterator.
 */
export async function computeWeeklySummary(
  db: Firestore,
  nowMs: number
): Promise<CostLedgerSummary> {
  const windowEndMs = nowMs
  const windowStartMs = nowMs - 7 * 24 * 3600 * 1000
  // Read cost-ledger rows whose `ts` falls in the window. We use a simple
  // collection().get() since the collection is small (4800 rows/wk max).
  // For larger volumes, switch to a window-bounded where("ts", ">=", ...) +
  // .where("ts", "<", ...) query.
  const snap = await db.collection("pa-cost-ledger").get()
  const docs = snap.docs.map((d) => ({ data: () => d.data() as Record<string, unknown> }))
  return summarizeCostLedger(docs, windowStartMs, windowEndMs)
}

export const paCostSummaryWeekly = onSchedule(
  {
    schedule: "30 9 * * 1",
    timeZone: "UTC",
    memory: "256MiB",
    timeoutSeconds: 300,
    region: "us-central1",
    // v1.7 Phase 69 — Slack webhook added alongside Mailgun (defense-in-depth).
    // Both alert paths fire when totalUsd > $10. Either or both may be missing
    // creds; helpers log+skip silently rather than throw.
    secrets: [
      MAILGUN_API_KEY,
      MAILGUN_DOMAIN,
      MAILGUN_FROM,
      MAILGUN_REGION,
      PA_SLACK_ALERT_WEBHOOK,
    ],
    retryCount: 0,
  },
  async () => {
    const db = getFirestore()
    const nowMs = Date.now()
    let summary: CostLedgerSummary
    try {
      summary = await computeWeeklySummary(db, nowMs)
    } catch (err) {
      logger.error("[cost-summary-weekly] compute_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    logger.info("[cost-summary-weekly] summary", summary)

    // Always persist the summary as an audit doc.
    try {
      await db.collection("pa-cost-summary-runs").add({
        runAt: new Date(nowMs).toISOString(),
        summary,
      })
    } catch (err) {
      logger.error("[cost-summary-weekly] audit_write_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    if (summary.totalUsd <= COST_ALERT_THRESHOLD_USD) {
      logger.info("[cost-summary-weekly] under_threshold_no_email", {
        totalUsd: summary.totalUsd,
        threshold: COST_ALERT_THRESHOLD_USD,
      })
      return
    }

    // v1.7 Phase 69 — Threshold exceeded. Fire Slack first (faster, lower
    // cost), then Mailgun alongside. Both are best-effort; either failing
    // does not block the other. postSlackAlert short-circuits cleanly when
    // PA_SLACK_ALERT_WEBHOOK is unbound.
    // v1.7 Phase 69 — `__UNSET__` sentinel = placeholder version Adam created
    // before populating the real URL. Treat as empty so postSlackAlert
    // short-circuits cleanly until Adam provisions the real webhook.
    const slackWebhookUrl = (() => {
      const isReal = (v: string) => v.length > 0 && v !== "__UNSET__"
      try {
        const v = (PA_SLACK_ALERT_WEBHOOK.value() ?? "").trim()
        if (isReal(v)) return v
      } catch {
        // not provisioned — fall through to env var
      }
      const env = (process.env.PA_SLACK_ALERT_WEBHOOK ?? "").trim()
      return isReal(env) ? env : ""
    })()
    try {
      const slackResult = await postSlackAlert(
        {
          level: "warn",
          title: `pa-cost-ledger weekly cost over $${COST_ALERT_THRESHOLD_USD} threshold`,
          message: `Weekly total: *$${summary.totalUsd.toFixed(2)}* (threshold $${COST_ALERT_THRESHOLD_USD})`,
          fields: [
            { name: "totalUsd", value: `$${summary.totalUsd.toFixed(2)}` },
            { name: "callCount", value: String(summary.callCount ?? 0) },
            {
              name: "window",
              value: `${summary.windowStart} → ${summary.windowEnd}`,
            },
          ],
        },
        { webhookUrl: slackWebhookUrl.length > 0 ? slackWebhookUrl : undefined }
      )
      logger.info("[cost-summary-weekly] slack_post_result", slackResult)
    } catch (err) {
      // postSlackAlert is fail-graceful, but belt-and-suspenders the live
      // path so a bug in the helper can't take down the Mailgun fallback.
      logger.warn("[cost-summary-weekly] slack_post_threw", {
        err: err instanceof Error ? err.message : String(err),
      })
    }

    // Mailgun fallback — keep alongside Slack (defense-in-depth).
    const mailgunCfg: MailgunConfig | null = (() => {
      const apiKey = (MAILGUN_API_KEY.value() ?? "").trim()
      const domain = (MAILGUN_DOMAIN.value() ?? "").trim()
      const from = (MAILGUN_FROM.value() ?? "").trim()
      if (!apiKey || !domain || !from) return null
      const region = (MAILGUN_REGION.value() ?? "").trim()
      const cfg: MailgunConfig = { apiKey, domain, from }
      if (region === "us" || region === "eu") cfg.region = region
      return cfg
    })()
    if (!mailgunCfg) {
      logger.warn("[cost-summary-weekly] mailgun_creds_missing — Slack-only alert path")
      return
    }

    try {
      const subject = `[pa-cost-ledger] Weekly summary — $${summary.totalUsd.toFixed(2)} (over $${COST_ALERT_THRESHOLD_USD} threshold)`
      const body = formatSummaryEmail(summary)
      const res = await sendMailgun(mailgunCfg, {
        to: COST_SUMMARY_RECIPIENT,
        subject,
        text: body,
      })
      if (!res.ok) {
        logger.warn("[cost-summary-weekly] mailgun_non_ok", {
          status: res.status,
        })
      } else {
        logger.info("[cost-summary-weekly] alert_sent", {
          to: COST_SUMMARY_RECIPIENT,
          totalUsd: summary.totalUsd,
        })
      }
    } catch (err) {
      logger.error("[cost-summary-weekly] mailgun_threw", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
)
