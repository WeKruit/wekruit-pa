/**
 * Production wiring for the matching-rec send cadence + time-spread
 * (2026-06-02, Adam). Builds the optional `runDailyJobRecBatch` deps that turn
 * the all-at-once synchronous burst into a per-number-paced, jittered drip.
 *
 * Three deps:
 *   • fromNumberForUser — sticky Sendblue from-number (hash-by-userId, the same
 *     v1.9 router) so the planner can bucket users per number.
 *   • numberCapacities  — per-number `dailySendCap` as this window's budget so a
 *     single number never accepts more than its cap in one batch.
 *   • scheduleSend      — Cloud Tasks delayed enqueue of each due user's send at
 *     the planner's jittered delay. The task fires later → POSTs to the job-rec
 *     send target CF → `sendImessage` writes the synthetic inbound event →
 *     Claire runtime delivers. Reuses the EXISTING Cloud Tasks primitive.
 *
 * Fail-open: when the Cloud Tasks env is incomplete, `buildScheduleSend`
 * returns `undefined` so `runDailyJobRecBatch` falls back to the legacy
 * synchronous send — which is STILL due-gated + per-number-paced (no burst,
 * just no future-scheduling). A missing pool → no pacing buckets (unbounded),
 * which matches pre-change behavior for un-configured pools.
 */

import type { Firestore } from "firebase-admin/firestore"
import { GoogleCloudTasksClient, type TasksClient } from "./coalesce/tasks-client.js"
import {
  loadSendbluePoolWithCounters,
  pickFromNumber,
  normalizeSendbluePoolGroups,
  type SendbluePoolConfig,
} from "./sendblue/pool.js"

/** Env keys for the job-rec send Cloud Tasks queue + target (own queue/URL). */
export type JobRecTasksEnv = NodeJS.ProcessEnv

/**
 * Resolve the job-rec send-spread Cloud Tasks config. Distinct queue/target
 * from the coalescer so job-rec drips don't contend with inbound coalescing.
 * Falls back to GCLOUD_PROJECT / coalescer SA when the job-rec-specific vars
 * are unset. Returns null when required pieces are missing (→ sync fallback).
 */
export function resolveJobRecTasksConfig(env: JobRecTasksEnv = process.env): {
  projectId: string
  location: string
  queue: string
  targetUrl: string
  serviceAccountEmail: string
} | null {
  const projectId =
    env.PA_JOBREC_SEND_PROJECT_ID?.trim() ||
    env.PA_COALESCE_PROJECT_ID?.trim() ||
    env.GCLOUD_PROJECT?.trim() ||
    env.GCP_PROJECT?.trim() ||
    ""
  const location = env.PA_JOBREC_SEND_LOCATION?.trim() || env.PA_COALESCE_LOCATION?.trim() || "us-central1"
  const queue = env.PA_JOBREC_SEND_QUEUE?.trim() || "pa-jobrec-send"
  const targetUrl = env.PA_JOBREC_SEND_TARGET_URL?.trim() || ""
  const serviceAccountEmail =
    env.PA_JOBREC_SEND_INVOKER_SA?.trim() || env.PA_COALESCE_INVOKER_SA?.trim() || ""
  if (!projectId || !targetUrl || !serviceAccountEmail) return null
  return { projectId, location, queue, targetUrl, serviceAccountEmail }
}

/**
 * Per-GROUP remaining capacity for this batch window, keyed by groupId (the
 * planner's bucket key). We treat each group's `dailySendCap` as the per-batch
 * budget: the daily batch is the once-per-cadence delivery event, so a group
 * (which shares one Sendblue sending budget) should accept at most
 * `dailySendCap` sends in one window. Groups without a configured cap are
 * omitted → unbounded (back-compat). Reads the pool; never mutates it.
 */
export function buildNumberCapacities(
  pool: SendbluePoolConfig | null
): Record<string, { remaining: number }> {
  const out: Record<string, { remaining: number }> = {}
  if (!pool) return out
  for (const group of normalizeSendbluePoolGroups(pool)) {
    const cap = group.dailySendCap
    if (typeof cap === "number" && Number.isInteger(cap) && cap > 0) {
      out[group.groupId] = { remaining: cap }
    }
  }
  return out
}

/**
 * Map every pool number → its groupId so a picked from-number resolves to the
 * shared-budget bucket key the planner paces against.
 */
function buildNumberToGroup(pool: SendbluePoolConfig | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!pool) return out
  for (const group of normalizeSendbluePoolGroups(pool)) {
    for (const num of group.numbers) out[num] = group.groupId
  }
  return out
}

export type JobRecSendSpreadDeps = {
  /** Sticky from-number resolver (undefined when pool empty). */
  fromNumberForUser?: (userId: string) => string | undefined
  /** Per-number remaining capacity for this window. */
  numberCapacities?: Record<string, { remaining: number }>
  /** Cloud Tasks delayed enqueue (undefined → sync fallback). */
  scheduleSend?: (input: {
    userId: string
    context: Record<string, unknown>
    idempotencyKey: string
    delayMs: number
    fromNumber?: string
  }) => Promise<{ ok: boolean }>
}

/**
 * Build the send-spread deps for a batch run. Loads the pool once (cached),
 * derives the sticky router + per-number caps, and wires Cloud Tasks when env
 * is complete. Best-effort: any failure degrades to a partial/empty dep set so
 * the batch never throws here.
 */
export async function buildJobRecSendSpreadDeps(
  db: Firestore,
  opts: {
    /** Inject a TasksClient in tests; production constructs GoogleCloudTasksClient. */
    tasksClient?: TasksClient
    log?: (event: string, payload?: Record<string, unknown>) => void
    env?: NodeJS.ProcessEnv
  } = {}
): Promise<JobRecSendSpreadDeps> {
  const log = opts.log ?? (() => {})
  const env = opts.env ?? process.env
  let pool: SendbluePoolConfig | null = null
  try {
    pool = await loadSendbluePoolWithCounters(db)
  } catch (err) {
    log("jobrec_send_spread_pool_load_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    pool = null
  }

  // The planner buckets by the value `fromNumberForUser` returns. Caps are
  // per-GROUP (shared budget), so we return the user's sticky number's groupId
  // as the bucket key — falling back to the raw number when it has no group.
  const numberToGroup = buildNumberToGroup(pool)
  const fromNumberForUser = (userId: string): string | undefined => {
    const num = pickFromNumber(pool, userId)
    if (!num) return undefined
    return numberToGroup[num] ?? num
  }
  const numberCapacities = buildNumberCapacities(pool)

  // Cloud Tasks scheduleSend — only when env is complete. Otherwise omit it so
  // runDailyJobRecBatch uses the synchronous (still paced + due-gated) path.
  let scheduleSend: JobRecSendSpreadDeps["scheduleSend"]
  const cfg = resolveJobRecTasksConfig(env)
  if (cfg) {
    const client: TasksClient = opts.tasksClient ?? new GoogleCloudTasksClient(cfg)
    scheduleSend = async (input) => {
      try {
        // Task name derived from the idempotency key → Cloud Tasks dedups a
        // re-enqueue of the same user's batch within its tombstone window.
        const taskName = `jobrec-${sanitizeTaskName(input.idempotencyKey)}`
        await client.enqueueDelayedTask({
          taskName,
          delayMs: Math.max(0, Math.trunc(input.delayMs)),
          payload: {
            userId: input.userId,
            context: input.context,
            idempotencyKey: input.idempotencyKey,
            fromNumber: input.fromNumber,
          },
        })
        return { ok: true }
      } catch (err) {
        const e = err as { code?: number; message?: string }
        // ALREADY_EXISTS (gRPC 6) → idempotent no-op (treat as enqueued).
        if (e?.code === 6) return { ok: true }
        log("jobrec_send_enqueue_failed", { userId: input.userId, error: e?.message ?? String(err) })
        return { ok: false }
      }
    }
  }

  return { fromNumberForUser, numberCapacities, scheduleSend }
}

/** Cloud Tasks task names must be [A-Za-z0-9_-]; map other chars to '-'. */
export function sanitizeTaskName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 500)
}
