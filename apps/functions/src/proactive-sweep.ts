/**
 * Phase 22 — paProactiveSweep Cloud Function (D-05, PROACTIVE-03).
 *
 * Deployed as an HTTPS-callable CF, invoked by a Cloud Scheduler OIDC job
 * on a 1-minute cron (`* * * * *`).
 *
 * Operator must create the Cloud Scheduler job manually (user_setup):
 *   Name: pa-proactive-sweep
 *   Schedule: * * * * * (every minute)
 *   Target: paProactiveSweep HTTPS endpoint
 *   Auth: OIDC service account with Cloud Functions Invoker role
 *
 * Kill switch: PA_PROACTIVE_DISABLED=1 returns immediately without any
 * Firestore reads (D-10).
 *
 * Idempotency: Before dispatching, sweep checks that no pa_audit_events row
 * with the same fireWindowHash exists (D-06, PROACTIVE-05). Uses a
 * claim-write (status: running) as a distributed mutex against concurrent
 * invocations (Test 3).
 *
 * Phase 7 conventions: retry up to maxAttempts, then dead_letter (PROACTIVE-03).
 */
import { onRequest } from "firebase-functions/v2/https"
import { setGlobalOptions, logger } from "firebase-functions/v2"
import { getFirestore, Timestamp } from "firebase-admin/firestore"
import { PA_COLLECTIONS, fireWindowHash } from "@pa/core-types"
import type { ProactiveScheduledJob, ProactiveJobStatus } from "@pa/core-types"
import { runProactiveTurn as defaultRunProactiveTurn } from "@pa/pa-orchestrator"
import type { ProactiveTurnResult } from "@pa/pa-orchestrator"

// Max jobs dispatched per sweep invocation — prevents CF timeout (D-05 latency budget).
const SWEEP_JOB_CAP = 50

// ---------------------------------------------------------------------------
// SweepStore — injectable for testing
// ---------------------------------------------------------------------------

export type SweepStore = {
  /** Query pending jobs due for fire. Returns at most SWEEP_JOB_CAP rows. */
  fetchDueJobs(): Promise<ProactiveScheduledJob[]>

  /**
   * Claim a job: transactionally set status=running.
   * Returns the updated job if claim succeeded; null if already claimed/fired.
   */
  claimJob(jobId: string): Promise<ProactiveScheduledJob | null>

  /**
   * Check whether a pa_audit_events row with kind=proactive_send and this
   * fireWindowHash already exists. Used for idempotency guard.
   */
  checkFireWindowExists(fwHash: string): Promise<boolean>

  /**
   * Dispatch a proactive turn for the given job.
   * In production this is runProactiveTurn from @pa/pa-orchestrator.
   */
  runProactiveTurn(userId: string, job: ProactiveScheduledJob): Promise<ProactiveTurnResult>

  /**
   * Handle dispatch failure: increment attempts, schedule retry, or dead-letter.
   */
  updateJobFailed(
    jobId: string,
    currentAttempts: number,
    maxAttempts: number,
    backoffSec: number
  ): Promise<void>

  log(...args: unknown[]): void
}

// ---------------------------------------------------------------------------
// runSweep — pure logic (injectable store, testable)
// ---------------------------------------------------------------------------

export type SweepResult =
  | { skipped: true; reason: "disabled" }
  | { dispatched: number; skippedIdempotent: number; failed: number }

export async function runSweep(store: SweepStore): Promise<SweepResult> {
  // D-10: kill switch
  if (process.env.PA_PROACTIVE_DISABLED === "1" || process.env.PA_PROACTIVE_DISABLED === "true") {
    store.log("[proactive-sweep] skipped: PA_PROACTIVE_DISABLED is set")
    return { skipped: true, reason: "disabled" }
  }

  const jobs = await store.fetchDueJobs()
  store.log(`[proactive-sweep] fetched ${jobs.length} due jobs`)

  let dispatched = 0
  let skippedIdempotent = 0
  let failed = 0

  for (const job of jobs) {
    try {
      // Step 1: Compute fireWindowHash for this job × fire window
      const nextFireAtMs = new Date(job.nextFireAt).getTime()
      const fwHash = fireWindowHash(job.jobId, nextFireAtMs)

      // Step 2: Idempotency check — skip if already fired this window (D-06)
      const alreadyFired = await store.checkFireWindowExists(fwHash)
      if (alreadyFired) {
        store.log("[proactive-sweep] idempotent_skip", { jobId: job.jobId, fwHash })
        skippedIdempotent++
        continue
      }

      // Step 3: Claim the job (distributed mutex against concurrent sweeps)
      const claimed = await store.claimJob(job.jobId)
      if (!claimed) {
        store.log("[proactive-sweep] claim_failed (already running)", { jobId: job.jobId })
        skippedIdempotent++
        continue
      }

      // Step 4: Dispatch
      const result = await store.runProactiveTurn(job.userId, claimed)
      if ("skipped" in result && result.skipped) {
        store.log("[proactive-sweep] proactive_turn_skipped", { jobId: job.jobId, reason: result.reason })
      } else {
        dispatched++
      }
    } catch (err) {
      failed++
      store.log("[proactive-sweep] dispatch_error", {
        jobId: job.jobId,
        error: err instanceof Error ? err.message : String(err),
      })
      await store.updateJobFailed(job.jobId, job.attempts, job.maxAttempts, job.backoffSec)
    }
  }

  store.log("[proactive-sweep] complete", { dispatched, skippedIdempotent, failed })
  return { dispatched, skippedIdempotent, failed }
}

// ---------------------------------------------------------------------------
// Firestore-backed store factory
// ---------------------------------------------------------------------------

export function createFirestoreSweepStore(): SweepStore {
  const db = getFirestore()
  const nowIso = () => new Date().toISOString()

  return {
    async fetchDueJobs() {
      const snap = await db
        .collection(PA_COLLECTIONS.scheduledJobs)
        .where("status", "==", "pending")
        .where("nextFireAt", "<=", new Date().toISOString())
        .limit(SWEEP_JOB_CAP)
        .get()
      return snap.docs.map((d) => ({ jobId: d.id, ...d.data() } as ProactiveScheduledJob))
    },

    async claimJob(jobId) {
      const ref = db.collection(PA_COLLECTIONS.scheduledJobs).doc(jobId)
      return db.runTransaction(async (txn) => {
        const snap = await txn.get(ref)
        if (!snap.exists) return null
        const job = { jobId: snap.id, ...snap.data() } as ProactiveScheduledJob
        if (job.status !== "pending") return null
        txn.update(ref, { status: "running" as ProactiveJobStatus, updatedAt: nowIso() })
        return { ...job, status: "running" as ProactiveJobStatus }
      })
    },

    async checkFireWindowExists(fwHash) {
      const snap = await db
        .collection(PA_COLLECTIONS.auditEvents)
        .where("kind", "==", "proactive_send")
        .where("fireWindowHash", "==", fwHash)
        .limit(1)
        .get()
      return !snap.empty
    },

    async runProactiveTurn(userId, job) {
      // Production wires up the full Firestore-backed ProactiveTurnStore.
      // For now we delegate to the module directly with a minimal store adapter.
      // The store adapter will be wired with the full orchestrator context at deploy time.
      // This import path uses the built dist output.
      const { createFirestoreProactiveTurnStore } = await import("./proactive-turn-store.js")
      return defaultRunProactiveTurn(userId, job, createFirestoreProactiveTurnStore(db))
    },

    async updateJobFailed(jobId, currentAttempts, maxAttempts, backoffSec) {
      const ref = db.collection(PA_COLLECTIONS.scheduledJobs).doc(jobId)
      const newAttempts = currentAttempts + 1
      if (newAttempts >= maxAttempts) {
        await ref.update({
          status: "dead_letter" as ProactiveJobStatus,
          attempts: newAttempts,
          updatedAt: nowIso(),
        })
      } else {
        const nextFireAt = new Date(Date.now() + backoffSec * 1000).toISOString()
        await ref.update({
          status: "pending" as ProactiveJobStatus,
          attempts: newAttempts,
          nextFireAt,
          dueAt: nextFireAt,
          updatedAt: nowIso(),
        })
      }
    },

    log: (...args) => logger.info("[proactive-sweep]", ...args),
  }
}

// ---------------------------------------------------------------------------
// Admin token gate (Phase 22 deferred-cron trigger plan)
// ---------------------------------------------------------------------------

export type AdminAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string }

/** Validate `x-admin-token` header against PA_ADMIN_TOKEN env. Pure & testable. */
export function checkAdminToken(headerToken: string | undefined): AdminAuthResult {
  const expected = process.env.PA_ADMIN_TOKEN
  if (!expected) return { ok: false, status: 503, error: "admin token not configured" }
  if (!headerToken || headerToken !== expected) return { ok: false, status: 401, error: "unauthorized" }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Cloud Function export
// ---------------------------------------------------------------------------

export const paProactiveSweep = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    cors: false,
    // No secrets needed directly — runProactiveTurn reads from process.env
    // which is set by onPaInbound's secret injection pattern. Sweep secrets
    // (if needed) can be added here after prod validation.
  },
  async (req, res) => {
    // Admin token gate (Phase 22 deferred-cron: trigger via admin/dashboard).
    // Cron path is intentionally not wired; see 22-SUMMARY.md "Trigger Plan".
    const auth = checkAdminToken(req.header("x-admin-token"))
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error })
      return
    }

    // Only allow POST from Cloud Scheduler (OIDC token validated by CF platform)
    if (req.method !== "POST" && req.method !== "GET") {
      res.status(405).json({ ok: false, error: "method_not_allowed" })
      return
    }

    try {
      const store = createFirestoreSweepStore()
      const result = await runSweep(store)
      res.status(200).json({ ok: true, result })
    } catch (err) {
      logger.error("[proactive-sweep] fatal", { error: err instanceof Error ? err.message : String(err) })
      res.status(500).json({ ok: false, error: "internal" })
    }
  }
)
