/**
 * v1.6 Phase 57 — Daily liveness sweep for matching-jobs.
 *
 * Cloud Scheduler trigger at 03:00 UTC daily. HEAD-checks every active
 * matching-jobs.atsApplyUrl. Marks dead on 4xx/5xx/timeout. Re-checks dead
 * jobs after 7d. Hard-deletes dead jobs >30d after marking. Inline-wires
 * paBackfillMatchingJobsAtsUrl resolver for jobs missing atsApplyUrl
 * (capped 1000/run via Serper API cost guard).
 *
 * Concurrency 50, 5s HEAD timeout, ~100ms throttle every 500 docs.
 *
 * REQ-IDs: LIVE-01, LIVE-02, LIVE-03, LIVE-04
 *
 * Architecture: pure logic in `runLivenessSweep` (deps-injected) so unit
 * tests can drive it without booting firebase-admin or real fetch. The
 * `paLivenessSweepDaily` onSchedule wrapper at the bottom is a thin shim
 * that wires production deps (Firestore + real fetch + Serper resolver).
 */

import { onSchedule } from "firebase-functions/v2/scheduler"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"
import {
  resolveAtsUrl,
  createSerperSearch,
  type SerperFn,
} from "./backfill-ats-urls.js"

// SERPER_API_KEY — same key already used by paBackfillMatchingJobsAtsUrl.
const SERPER_API_KEY = defineSecret("SERPER_API_KEY")

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const HEAD_TIMEOUT_MS = 5000
export const CONCURRENCY = 50
export const BATCH_SIZE = 500
export const RECHECK_DEAD_AFTER_DAYS = 7
export const HARD_DELETE_AFTER_DAYS = 30
export const MAX_BACKFILL_PER_RUN = 1000
export const MAX_ACTIVE_DOCS = 30_000

const MS_PER_DAY = 24 * 3600 * 1000

// ---------------------------------------------------------------------------
// HEAD check verdict
// ---------------------------------------------------------------------------

export type LivenessVerdict =
  | { alive: true }
  | { alive: false; reason: string }

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/**
 * HEAD-check a URL with a 5s timeout. Treats 2xx and 3xx as alive, 4xx and
 * 5xx as dead. AbortError (timeout) → dead with reason `timeout`. Network
 * errors → dead with reason `network_error: <truncated message>`.
 *
 * Note: many ATS providers reject HEAD with 405 (method-not-allowed) but
 * the URL is alive — so this returns `alive: true` for any status under
 * 400. Status 405 only appears here if a provider quirk causes it; we
 * conservatively treat it as alive.
 */
export async function headCheck(
  url: string,
  opts?: { fetchImpl?: FetchFn; timeoutMs?: number }
): Promise<LivenessVerdict> {
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchFn)
  const timeoutMs = opts?.timeoutMs ?? HEAD_TIMEOUT_MS

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: "HEAD",
      signal: ctrl.signal,
      redirect: "follow",
    })
    if (res.status >= 200 && res.status < 400) return { alive: true }
    if (res.status === 405) return { alive: true } // method-not-allowed → URL exists
    return { alive: false, reason: `http_${res.status}` }
  } catch (err) {
    const e = err as { name?: string; message?: string }
    if (e?.name === "AbortError" || (e?.message ?? "").toLowerCase().includes("aborted")) {
      return { alive: false, reason: "timeout" }
    }
    const msg = (e?.message ?? "unknown").slice(0, 80)
    return { alive: false, reason: `network_error: ${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Sweep counters + types
// ---------------------------------------------------------------------------

export type SweepCounters = {
  processed: number
  dead_marked: number
  dead_recovered: number
  hard_deleted: number
  head_alive: number
  head_dead: number
  backfill_resolved: number
  backfill_attempted: number
  errors: number
  skipped_recheck_window: number
  skipped_no_url: number
}

export function emptyCounters(): SweepCounters {
  return {
    processed: 0,
    dead_marked: 0,
    dead_recovered: 0,
    hard_deleted: 0,
    head_alive: 0,
    head_dead: 0,
    backfill_resolved: 0,
    backfill_attempted: 0,
    errors: 0,
    skipped_recheck_window: 0,
    skipped_no_url: 0,
  }
}

export type SweepJobDoc = {
  id: string
  primaryUrl?: string
  companyName?: string
  jobTitle?: string
  roleTitle?: string
  atsApplyUrl?: string
  status?: string
  dead?: boolean
  /** ISO string OR Firestore Timestamp-like. */
  deadCheckedAt?: string | { toMillis: () => number } | null
}

export type SweepUpdates = {
  dead?: boolean
  deadCheckedAt?: string | null
  deadReason?: string | null
  atsApplyUrl?: string
  atsResolvedAt?: string
  atsResolvedBy?: string
}

export type SweepStore = {
  /** Snapshot of `matching-jobs` where `status==active`, capped to limit. */
  fetchActiveJobs: (limit: number) => Promise<SweepJobDoc[]>
  updateJob: (id: string, updates: SweepUpdates) => Promise<void>
  deleteJob: (id: string) => Promise<void>
  /** Best-effort audit write — never throws. */
  writeAudit: (counters: SweepCounters, runAt: string) => Promise<void>
}

export type SweepDeps = {
  store: SweepStore
  headCheck: (url: string) => Promise<LivenessVerdict>
  /** Optional Serper resolver for inline backfill. Returns null when key missing. */
  serper: SerperFn
  /** Returns ms-since-epoch; stubbable for tests. */
  now: () => number
  /** Concurrency & throttle knobs (override for tests). */
  concurrency?: number
  batchSize?: number
  throttleMs?: number
  rcheckDeadAfterDays?: number
  hardDeleteAfterDays?: number
  maxBackfillPerRun?: number
  log?: (msg: string, ctx?: Record<string, unknown>) => void
  errorLog?: (msg: string, ctx?: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Firestore Timestamp-like or ISO string into ms-since-epoch. */
function toMillis(t: string | { toMillis: () => number } | null | undefined): number | null {
  if (!t) return null
  if (typeof t === "string") {
    const parsed = Date.parse(t)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof t === "object" && typeof t.toMillis === "function") {
    try {
      return t.toMillis()
    } catch {
      return null
    }
  }
  return null
}

/**
 * Tiny p-limit-style concurrency limiter so we don't add a runtime
 * dependency. Returns a function that, when called with a task, queues
 * it and resolves once the task settles. Up to `concurrency` tasks run
 * in parallel; the rest queue.
 */
export function makeLimiter(concurrency: number) {
  let active = 0
  const queue: Array<() => void> = []
  const next = () => {
    if (active >= concurrency) return
    const task = queue.shift()
    if (!task) return
    task()
  }
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++
        fn().then(
          (v) => {
            active--
            resolve(v)
            next()
          },
          (e) => {
            active--
            reject(e)
            next()
          }
        )
      }
      if (active < concurrency) run()
      else queue.push(run)
    })
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Main driver
// ---------------------------------------------------------------------------

/**
 * Process one job document. Returns an update plan plus side-effect kind
 * (delete vs update vs noop). Pure-ish: mutates counters, calls deps for
 * I/O. Does NOT call store.updateJob/deleteJob — caller does that so tests
 * can intercept. Caller is also responsible for backfill cap.
 */
export async function processOneJob(
  job: SweepJobDoc,
  counters: SweepCounters,
  deps: SweepDeps & { allowBackfill: boolean }
): Promise<{ kind: "delete" } | { kind: "update"; updates: SweepUpdates } | { kind: "noop" }> {
  const now = deps.now()
  const recheckMs = (deps.rcheckDeadAfterDays ?? RECHECK_DEAD_AFTER_DAYS) * MS_PER_DAY
  const deleteMs = (deps.hardDeleteAfterDays ?? HARD_DELETE_AFTER_DAYS) * MS_PER_DAY

  // ── 1. Hard-delete dead jobs >30d old ──
  if (job.dead === true) {
    const checkedMs = toMillis(job.deadCheckedAt)
    if (checkedMs !== null && now - checkedMs > deleteMs) {
      counters.hard_deleted++
      return { kind: "delete" }
    }

    // ── 2. Skip dead jobs still inside the re-check window ──
    if (checkedMs !== null && now - checkedMs < recheckMs) {
      counters.skipped_recheck_window++
      return { kind: "noop" }
    }
  }

  // ── 3. Inline backfill if atsApplyUrl missing ──
  let atsUrl = job.atsApplyUrl
  if (!atsUrl) {
    if (!job.primaryUrl) {
      counters.skipped_no_url++
      return { kind: "noop" }
    }
    if (!deps.allowBackfill) {
      // Cap reached — defer to the dedicated backfill CF.
      counters.skipped_no_url++
      return { kind: "noop" }
    }
    counters.backfill_attempted++
    try {
      const outcome = await resolveAtsUrl(
        {
          primaryUrl: job.primaryUrl,
          companyName: job.companyName,
          jobTitle: job.jobTitle,
          roleTitle: job.roleTitle,
        },
        { serper: deps.serper }
      )
      if (outcome.kind === "miss") {
        counters.skipped_no_url++
        return { kind: "noop" }
      }
      atsUrl = outcome.url
      counters.backfill_resolved++
      // Fall through into HEAD check for the freshly resolved URL.
    } catch (err) {
      counters.errors++
      ;(deps.errorLog ?? (() => {}))("backfill_resolve_failed", {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      })
      return { kind: "noop" }
    }
  }

  // ── 4. HEAD check ──
  let verdict: LivenessVerdict
  try {
    verdict = await deps.headCheck(atsUrl!)
  } catch (err) {
    counters.errors++
    ;(deps.errorLog ?? (() => {}))("head_check_threw", {
      jobId: job.id,
      url: atsUrl,
      error: err instanceof Error ? err.message : String(err),
    })
    return { kind: "noop" }
  }

  const updates: SweepUpdates = {}
  // Stamp the freshly-resolved URL even if it ends up dead, so the
  // dedicated backfill CF doesn't re-spend Serper budget on it next run.
  if (atsUrl !== job.atsApplyUrl) {
    updates.atsApplyUrl = atsUrl!
    updates.atsResolvedAt = new Date(now).toISOString()
    updates.atsResolvedBy = "liveness-sweep-inline"
  }

  if (verdict.alive) {
    counters.head_alive++
    if (job.dead === true) {
      // Recovered — clear the dead flag.
      updates.dead = false
      updates.deadCheckedAt = new Date(now).toISOString()
      updates.deadReason = null
      counters.dead_recovered++
    } else if (Object.keys(updates).length === 0) {
      // Already alive, no resolved-URL stamp → no write needed.
      return { kind: "noop" }
    }
  } else {
    counters.head_dead++
    if (job.dead !== true) {
      updates.dead = true
      updates.deadCheckedAt = new Date(now).toISOString()
      updates.deadReason = verdict.reason
      counters.dead_marked++
    } else {
      // Was already dead, still dead → bump deadCheckedAt to push the
      // re-check window forward AND store the latest reason.
      updates.deadCheckedAt = new Date(now).toISOString()
      updates.deadReason = verdict.reason
    }
  }

  return { kind: "update", updates }
}

/**
 * Drive the sweep end-to-end. Pure logic; deps wire I/O.
 */
export async function runLivenessSweep(deps: SweepDeps): Promise<SweepCounters> {
  const log = deps.log ?? (() => {})
  const errorLog = deps.errorLog ?? log

  const counters = emptyCounters()
  const limit = deps.concurrency ?? CONCURRENCY
  const batchSize = deps.batchSize ?? BATCH_SIZE
  const throttleMs = deps.throttleMs ?? 100
  const maxBackfill = deps.maxBackfillPerRun ?? MAX_BACKFILL_PER_RUN

  let jobs: SweepJobDoc[]
  try {
    jobs = await deps.store.fetchActiveJobs(MAX_ACTIVE_DOCS)
  } catch (err) {
    errorLog("fetch_active_jobs_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }

  log("sweep_start", { totalCandidates: jobs.length })

  const limiter = makeLimiter(limit)
  let backfillCount = 0
  let processedThisBatch = 0

  const tasks = jobs.map((job) =>
    limiter(async () => {
      counters.processed++
      processedThisBatch++

      // Throttle every BATCH_SIZE docs to avoid Firestore rate-limits.
      // Done inside the limiter so concurrency is preserved.
      if (processedThisBatch >= batchSize) {
        processedThisBatch = 0
        await sleep(throttleMs)
      }

      const allowBackfill = backfillCount < maxBackfill
      const plan = await processOneJob(job, counters, { ...deps, allowBackfill })
      if (plan.kind === "noop") return
      if (plan.kind === "delete") {
        try {
          await deps.store.deleteJob(job.id)
        } catch (err) {
          counters.errors++
          errorLog("delete_failed", {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return
      }
      if (plan.kind === "update") {
        try {
          // Track Serper-backfill commits against the cap.
          if (plan.updates.atsResolvedBy === "liveness-sweep-inline") {
            backfillCount++
          }
          await deps.store.updateJob(job.id, plan.updates)
        } catch (err) {
          counters.errors++
          errorLog("update_failed", {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    })
  )

  await Promise.allSettled(tasks)

  log("sweep_complete", { ...counters })

  // Best-effort audit write — never blocks the sweep.
  try {
    await deps.store.writeAudit(counters, new Date(deps.now()).toISOString())
  } catch (err) {
    errorLog("audit_write_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return counters
}

// ---------------------------------------------------------------------------
// Production Firestore-backed store
// ---------------------------------------------------------------------------

function makeFirestoreStore(): SweepStore {
  return {
    fetchActiveJobs: async (limit) => {
      const db = getFirestore()
      const snap = await db
        .collection("matching-jobs")
        .where("status", "==", "active")
        .limit(limit)
        .get()
      return snap.docs.map((d): SweepJobDoc => {
        const data = d.data() as Record<string, unknown>
        const dca = data.deadCheckedAt
        return {
          id: d.id,
          primaryUrl: typeof data.primaryUrl === "string" ? data.primaryUrl : undefined,
          companyName: typeof data.companyName === "string" ? data.companyName : undefined,
          jobTitle: typeof data.jobTitle === "string" ? data.jobTitle : undefined,
          roleTitle: typeof data.roleTitle === "string" ? data.roleTitle : undefined,
          atsApplyUrl: typeof data.atsApplyUrl === "string" ? data.atsApplyUrl : undefined,
          status: typeof data.status === "string" ? data.status : undefined,
          dead: typeof data.dead === "boolean" ? data.dead : undefined,
          deadCheckedAt:
            typeof dca === "string"
              ? dca
              : dca && typeof dca === "object" && "toMillis" in dca
                ? (dca as { toMillis: () => number })
                : null,
        }
      })
    },
    updateJob: async (id, updates) => {
      const db = getFirestore()
      // Strip undefined values so Firestore doesn't reject the write.
      const sanitized: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) sanitized[k] = v
      }
      await db.collection("matching-jobs").doc(id).update(sanitized)
    },
    deleteJob: async (id) => {
      const db = getFirestore()
      await db.collection("matching-jobs").doc(id).delete()
    },
    writeAudit: async (counters, runAt) => {
      const db = getFirestore()
      await db.collection("matching-jobs-liveness-runs").add({
        runAt,
        counters,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Cloud Function — daily at 03:00 UTC.
// ---------------------------------------------------------------------------

export const paLivenessSweepDaily = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "UTC",
    memory: "1GiB",
    timeoutSeconds: 540,
    region: "us-central1",
    secrets: [SERPER_API_KEY],
    retryCount: 0,
  },
  async () => {
    const apiKey = (process.env.SERPER_API_KEY ?? "").trim()
    if (!apiKey) {
      logger.warn(
        "[liveness-sweep] SERPER_API_KEY missing — inline backfill will no-op"
      )
    }
    const serper: SerperFn = apiKey
      ? createSerperSearch({ apiKey })
      : async () => null

    const counters = await runLivenessSweep({
      store: makeFirestoreStore(),
      headCheck: (url) => headCheck(url),
      serper,
      now: () => Date.now(),
      log: (msg, ctx) => logger.info(`[liveness-sweep] ${msg}`, ctx ?? {}),
      errorLog: (msg, ctx) => logger.error(`[liveness-sweep] ${msg}`, ctx ?? {}),
    })

    logger.info("[liveness-sweep] done", counters)
  }
)
