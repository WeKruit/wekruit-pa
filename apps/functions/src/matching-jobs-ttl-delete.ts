/**
 * v1.7+ TTL — Weekly delete of stale matching-jobs docs.
 *
 * Adam directive (P9 → P8 → P7-J2, 2026-05-08, Option D hybrid):
 *   matching-jobs has accumulated 151k inactive + 3k dead docs with no
 *   garbage collection. Apply hybrid TTL:
 *     - inactive  → delete when (lastSeenAt | firstSeenAt fallback) < NOW-90d
 *     - dead==true → delete when (deadCheckedAt | lastSeenAt) < NOW-365d
 *   Postgres tombstone (P7-K, alembic 0007) preserves the dead flag after
 *   Firestore delete so the scraper does not re-add deleted dead URLs.
 *
 * Cloud Scheduler trigger Mon 04:00 UTC (after `paLlmRerankNightly`).
 *
 * Architecture: pure logic in `runTtlDelete` (deps-injected) so unit tests
 * drive it without booting firebase-admin. Two thin shims at the bottom:
 *   - `paMatchingJobsTtlDeleteWeekly`   — scheduled cron
 *   - `paMatchingJobsTtlDeleteCallable` — admin-only callable for canary
 *                                          dry-run + on-demand sweep
 *
 * Dry-run mode: env var `MATCHING_TTL_DRY_RUN=true` OR callable param
 * `{ dryRun: true }`. In dry-run we count what would be deleted and log,
 * but DO NOT issue the batch delete.
 *
 * Edge cases:
 *   - Inactive doc missing both lastSeenAt and firstSeenAt → skip (counted
 *     under `skipped_no_timestamp`). Conservative: never delete a doc that
 *     has no timestamp anchor.
 *   - Dead doc missing both deadCheckedAt and lastSeenAt → skip likewise.
 *   - Hard guard: never delete `status === "active"` AND `dead !== true`,
 *     even if a query somehow returns one. Belt-and-braces.
 *   - Dedup: doc that is BOTH dead AND inactive is queued under the dead
 *     classification (longer threshold = more conservative). Set-based
 *     dedupe across the two streams.
 *
 * Back-references audited (no hard FK to matching-jobs/{id}):
 *   - pa-user-skill-jdrel-cache/{userId}/jobs/{jobId} — graceful-miss cache
 *   - pa-job-rec-explanations/{userId__jobId__lang} — graceful-miss cache
 *   Both readers tolerate missing entries; their own GC is open tech-debt.
 *   Recommendations are computed live by query (no stored job FKs in
 *   pa-job-profiles or pa-users).
 *
 *   `paMatchingJobsAutoEnrich` is `onDocumentWritten` and tolerates delete
 *   events: `event.data?.after.data()` returns undefined → `needsEnrichment`
 *   returns false → handler returns early. No fan-out cost.
 */

import { onSchedule } from "firebase-functions/v2/scheduler"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import {
  getFirestore,
  type Firestore,
  type Query,
  type DocumentData,
  type QueryDocumentSnapshot,
  type WriteBatch,
} from "firebase-admin/firestore"

// ---------------------------------------------------------------------------
// Configuration — Adam Option D thresholds (locked, see CLAUDE.md design lock)
// ---------------------------------------------------------------------------

/** Inactive docs older than this many days are deleted. */
export const INACTIVE_TTL_DAYS_DEFAULT = 90
/** Dead docs older than this many days are deleted. Longer than inactive
 *  because dead docs are evidence the URL is gone — useful for tombstone
 *  inspection if a scraper bug re-surfaces the URL. */
export const DEAD_TTL_DAYS_DEFAULT = 365

export const BATCH_SIZE = 500
export const PAGE_SIZE = 500
/** Throttle between batches (ms) → ≤10 batches/sec. */
export const THROTTLE_MS = 100
/** Hard cap to avoid blowing the 540s schedule timeout on first run. The
 *  remainder rolls to next week. 50k = ~100 batches × 100ms = 10s minimum. */
export const MAX_DOCS_PER_RUN = 50_000

const MS_PER_DAY = 24 * 3600 * 1000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TtlDeleteCounters = {
  /** Total docs streamed from both queries (pre-cutoff filter). */
  scanned: number
  /** Docs that matched cutoff and were enqueued for delete. */
  to_delete_inactive: number
  to_delete_dead: number
  /** Docs actually deleted (0 in dry-run; equals to_delete_* otherwise). */
  deleted_inactive: number
  deleted_dead: number
  /** Skipped because no usable timestamp anchor — never delete. */
  skipped_no_timestamp: number
  /** Skipped because doc was status===active && dead !== true (defensive). */
  skipped_active_guard: number
  /** Number of Firestore commit() calls issued (0 in dry-run). */
  batches: number
  /** Total wall-clock seconds. Filled at end. */
  duration_seconds: number
  errors: number
}

export function emptyCounters(): TtlDeleteCounters {
  return {
    scanned: 0,
    to_delete_inactive: 0,
    to_delete_dead: 0,
    deleted_inactive: 0,
    deleted_dead: 0,
    skipped_no_timestamp: 0,
    skipped_active_guard: 0,
    batches: 0,
    duration_seconds: 0,
    errors: 0,
  }
}

/** Minimal projection of a matching-jobs doc — only fields we read. */
export type TtlJobDoc = {
  id: string
  status?: string | null
  dead?: boolean | null
  /** ISO string OR Firestore Timestamp-like. */
  lastSeenAt?: string | { toMillis: () => number } | null
  firstSeenAt?: string | { toMillis: () => number } | null
  deadCheckedAt?: string | { toMillis: () => number } | null
}

export type TtlBatchPlan = {
  ids: Array<{ id: string; kind: "inactive" | "dead" }>
}

/** Storage abstraction so tests don't boot firebase-admin. */
export type TtlStore = {
  /**
   * Stream docs page-by-page. Implementation must call `onPage` once per page
   * and may stop early if `onPage` returns `{ stop: true }`.
   */
  streamInactive: (
    pageSize: number,
    onPage: (docs: TtlJobDoc[]) => Promise<{ stop: boolean }>,
  ) => Promise<void>
  streamDead: (
    pageSize: number,
    onPage: (docs: TtlJobDoc[]) => Promise<{ stop: boolean }>,
  ) => Promise<void>
  /** Commit a batch delete. Caller passes ≤500 ids. */
  batchDelete: (ids: string[]) => Promise<void>
  /** Best-effort audit row — never throws. */
  writeAudit: (counters: TtlDeleteCounters, runAt: string, dryRun: boolean) => Promise<void>
}

export type TtlDeps = {
  store: TtlStore
  /** Returns ms-since-epoch; stubbable for tests. */
  now: () => number
  /** Default 90. */
  inactiveTtlDays?: number
  /** Default 365. */
  deadTtlDays?: number
  batchSize?: number
  pageSize?: number
  throttleMs?: number
  maxDocsPerRun?: number
  /** When true, count what would be deleted but skip batchDelete. */
  dryRun?: boolean
  log?: (msg: string, ctx?: Record<string, unknown>) => void
  errorLog?: (msg: string, ctx?: Record<string, unknown>) => void
  /** Stubbable sleep — tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Firestore Timestamp-like or ISO string into ms-since-epoch. */
export function toMillis(
  t: string | { toMillis: () => number } | null | undefined,
): number | null {
  if (!t) return null
  if (typeof t === "string") {
    const parsed = Date.parse(t)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof t === "object" && typeof (t as { toMillis?: unknown }).toMillis === "function") {
    try {
      return (t as { toMillis: () => number }).toMillis()
    } catch {
      return null
    }
  }
  return null
}

/**
 * Resolve the "last seen" anchor used to compare against the cutoff.
 *
 * Priority for an INACTIVE doc:
 *   1. lastSeenAt (preferred — set by macmini Stage 4 sync on every scrape)
 *   2. firstSeenAt (fallback — always present on ingest)
 *
 * Priority for a DEAD doc:
 *   1. deadCheckedAt (preferred — written by liveness-sweep when marked dead)
 *   2. lastSeenAt (fallback)
 *
 * Returns null if no usable timestamp — caller MUST skip such docs.
 */
export function resolveAnchorMs(job: TtlJobDoc, kind: "inactive" | "dead"): number | null {
  if (kind === "dead") {
    return toMillis(job.deadCheckedAt) ?? toMillis(job.lastSeenAt)
  }
  return toMillis(job.lastSeenAt) ?? toMillis(job.firstSeenAt)
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Core: classify one page of candidates against the appropriate cutoff
// ---------------------------------------------------------------------------

/**
 * Pure: classifies docs in `page` as delete/skip. Mutates counters,
 * returns the list of doc IDs that should be deleted (with kind tag).
 *
 * `expectedKind` selects which cutoff applies. The defensive guard refuses
 * to delete a doc that is `status==="active" && dead!==true` regardless of
 * which stream it came from. This keeps the routine safe even if Firestore
 * returns a stale view or the caller passes the wrong query.
 */
export function classifyPage(
  page: TtlJobDoc[],
  inactiveCutoffMs: number,
  deadCutoffMs: number,
  expectedKind: "inactive" | "dead",
  counters: TtlDeleteCounters,
): TtlBatchPlan {
  const ids: Array<{ id: string; kind: "inactive" | "dead" }> = []
  for (const doc of page) {
    counters.scanned++

    // Defensive: refuse to delete an active+!dead doc even if caller queried wrong.
    const isActive = doc.status === "active"
    const isDead = doc.dead === true
    if (isActive && !isDead) {
      counters.skipped_active_guard++
      continue
    }

    // Determine kind. Dead takes priority — a doc that is both dead AND inactive
    // gets the longer (365d) threshold. Conservative: don't delete a dead doc
    // any earlier than the dead window allows.
    const kind: "inactive" | "dead" = isDead ? "dead" : "inactive"
    void expectedKind // kept for diagnostic logging callers

    const anchorMs = resolveAnchorMs(doc, kind)
    if (anchorMs === null) {
      counters.skipped_no_timestamp++
      continue
    }

    const cutoffMs = kind === "dead" ? deadCutoffMs : inactiveCutoffMs
    if (anchorMs >= cutoffMs) {
      // Inside the kind-specific TTL window — keep.
      continue
    }

    ids.push({ id: doc.id, kind })
  }
  return { ids }
}

// ---------------------------------------------------------------------------
// Main driver
// ---------------------------------------------------------------------------

export async function runTtlDelete(deps: TtlDeps): Promise<TtlDeleteCounters> {
  const startMs = deps.now()
  const log = deps.log ?? (() => {})
  const errorLog = deps.errorLog ?? log
  const sleep = deps.sleep ?? defaultSleep
  const inactiveTtlDays = deps.inactiveTtlDays ?? INACTIVE_TTL_DAYS_DEFAULT
  const deadTtlDays = deps.deadTtlDays ?? DEAD_TTL_DAYS_DEFAULT
  const batchSize = deps.batchSize ?? BATCH_SIZE
  const pageSize = deps.pageSize ?? PAGE_SIZE
  const throttleMs = deps.throttleMs ?? THROTTLE_MS
  const maxDocs = deps.maxDocsPerRun ?? MAX_DOCS_PER_RUN
  const dryRun = deps.dryRun === true

  const counters = emptyCounters()
  const inactiveCutoffMs = startMs - inactiveTtlDays * MS_PER_DAY
  const deadCutoffMs = startMs - deadTtlDays * MS_PER_DAY

  log("ttl_delete_start", {
    inactiveTtlDays,
    deadTtlDays,
    inactiveCutoffIso: new Date(inactiveCutoffMs).toISOString(),
    deadCutoffIso: new Date(deadCutoffMs).toISOString(),
    dryRun,
    maxDocsPerRun: maxDocs,
  })

  // Track IDs we've already queued in this run so the dead+inactive stream
  // overlap (a doc with status=inactive AND dead=true) doesn't double-delete.
  const queued = new Set<string>()
  let pending: Array<{ id: string; kind: "inactive" | "dead" }> = []

  const flush = async () => {
    if (pending.length === 0) return
    const slice = pending.splice(0, batchSize)
    if (dryRun) {
      // Don't issue the delete, but tally what we would have deleted.
      for (const item of slice) {
        if (item.kind === "inactive") counters.deleted_inactive++ // counted as-if
        else counters.deleted_dead++
      }
      counters.batches++
      log("ttl_delete_batch_dryrun", { size: slice.length, batchNum: counters.batches })
    } else {
      try {
        await deps.store.batchDelete(slice.map((s) => s.id))
        counters.batches++
        for (const item of slice) {
          if (item.kind === "inactive") counters.deleted_inactive++
          else counters.deleted_dead++
        }
        log("ttl_delete_batch", { size: slice.length, batchNum: counters.batches })
      } catch (err) {
        counters.errors++
        errorLog("ttl_delete_batch_failed", {
          batchNum: counters.batches + 1,
          size: slice.length,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (throttleMs > 0) await sleep(throttleMs)
  }

  const totalQueued = () => counters.to_delete_inactive + counters.to_delete_dead

  // ── Stream 1: inactive ──
  await deps.store.streamInactive(pageSize, async (page) => {
    const plan = classifyPage(page, inactiveCutoffMs, deadCutoffMs, "inactive", counters)
    for (const item of plan.ids) {
      if (queued.has(item.id)) continue
      queued.add(item.id)
      if (item.kind === "inactive") counters.to_delete_inactive++
      else counters.to_delete_dead++
      pending.push(item)
      if (pending.length >= batchSize) await flush()
    }
    if (totalQueued() >= maxDocs) {
      log("ttl_delete_max_docs_reached", { totalQueued: totalQueued(), maxDocs })
      return { stop: true }
    }
    return { stop: false }
  })

  // Flush whatever's left from inactive stream before starting dead stream.
  while (pending.length > 0) await flush()

  // ── Stream 2: dead ──
  if (totalQueued() < maxDocs) {
    await deps.store.streamDead(pageSize, async (page) => {
      const plan = classifyPage(page, inactiveCutoffMs, deadCutoffMs, "dead", counters)
      for (const item of plan.ids) {
        if (queued.has(item.id)) continue
        queued.add(item.id)
        if (item.kind === "inactive") counters.to_delete_inactive++
        else counters.to_delete_dead++
        pending.push(item)
        if (pending.length >= batchSize) await flush()
      }
      if (totalQueued() >= maxDocs) {
        log("ttl_delete_max_docs_reached", { totalQueued: totalQueued(), maxDocs })
        return { stop: true }
      }
      return { stop: false }
    })
  }

  // Final flush.
  while (pending.length > 0) await flush()

  counters.duration_seconds = Math.round((deps.now() - startMs) / 1000)

  log("ttl_delete_complete", { ...counters, dryRun })

  // Best-effort audit.
  try {
    await deps.store.writeAudit(counters, new Date(deps.now()).toISOString(), dryRun)
  } catch (err) {
    errorLog("ttl_delete_audit_write_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return counters
}

// ---------------------------------------------------------------------------
// Production Firestore-backed store
// ---------------------------------------------------------------------------

function projectDoc(snap: QueryDocumentSnapshot<DocumentData>): TtlJobDoc {
  const data = snap.data()
  return {
    id: snap.id,
    status: typeof data.status === "string" ? data.status : null,
    dead: typeof data.dead === "boolean" ? data.dead : null,
    lastSeenAt: pickTs(data.lastSeenAt),
    firstSeenAt: pickTs(data.firstSeenAt),
    deadCheckedAt: pickTs(data.deadCheckedAt),
  }
}

function pickTs(v: unknown): string | { toMillis: () => number } | null {
  if (typeof v === "string") return v
  if (
    v &&
    typeof v === "object" &&
    typeof (v as { toMillis?: unknown }).toMillis === "function"
  ) {
    return v as { toMillis: () => number }
  }
  return null
}

async function pageQuery(
  baseQ: Query<DocumentData>,
  pageSize: number,
  onPage: (docs: TtlJobDoc[]) => Promise<{ stop: boolean }>,
): Promise<void> {
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null
  // 200k docs / 500 = 400 pages — give 1000 headroom for runaway-loop defense.
  const MAX_PAGES = 1000
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = baseQ.limit(pageSize)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()
    if (snap.empty) return
    const docs = snap.docs.map(projectDoc)
    const result = await onPage(docs)
    if (result.stop) return
    if (snap.docs.length < pageSize) return
    cursor = snap.docs[snap.docs.length - 1] ?? null
    if (!cursor) return
  }
}

export function makeFirestoreStore(db?: Firestore): TtlStore {
  // Lazy db so unit tests inject `deps.store` directly without booting admin.
  const getDb = () => db ?? getFirestore()
  return {
    streamInactive: async (pageSize, onPage) => {
      // status==="inactive" — no orderBy so we don't require a composite index.
      // Cursor pagination uses Firestore's implicit __name__ ordering, which is
      // deterministic. Some legacy docs may lack lastSeenAt → resolveAnchorMs
      // falls back to firstSeenAt; if both missing classifyPage skips them.
      const q = getDb().collection("matching-jobs").where("status", "==", "inactive")
      await pageQuery(q, pageSize, onPage)
    },
    streamDead: async (pageSize, onPage) => {
      // dead===true (boolean) — independent of status. Some dead docs may also
      // be status===inactive; the runner's `queued` Set dedupes.
      const q = getDb().collection("matching-jobs").where("dead", "==", true)
      await pageQuery(q, pageSize, onPage)
    },
    batchDelete: async (ids) => {
      if (ids.length === 0) return
      const fs = getDb()
      const batch: WriteBatch = fs.batch()
      for (const id of ids) {
        batch.delete(fs.collection("matching-jobs").doc(id))
      }
      await batch.commit()
    },
    writeAudit: async (counters, runAt, dryRun) => {
      try {
        await getDb().collection("matching-jobs-ttl-runs").add({
          runAt,
          dryRun,
          counters,
        })
      } catch {
        // Swallow — auditing must never block the sweep.
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Cloud Function — weekly scheduled cron
// ---------------------------------------------------------------------------

export const paMatchingJobsTtlDeleteWeekly = onSchedule(
  {
    schedule: "0 4 * * 1", // Mon 04:00 UTC (after paLlmRerankNightly 04:00 daily)
    timeZone: "UTC",
    memory: "512MiB",
    timeoutSeconds: 540,
    region: "us-central1",
    retryCount: 0,
  },
  async () => {
    const dryRun = process.env.MATCHING_TTL_DRY_RUN === "true"
    const counters = await runTtlDelete({
      store: makeFirestoreStore(),
      now: () => Date.now(),
      dryRun,
      log: (msg, ctx) =>
        logger.info(`[pa.matching_jobs.ttl_delete] ${msg}`, ctx ?? {}),
      errorLog: (msg, ctx) =>
        logger.error(`[pa.matching_jobs.ttl_delete] ${msg}`, ctx ?? {}),
    })
    logger.info("[pa.matching_jobs.ttl_delete] done", {
      deleted_inactive: counters.deleted_inactive,
      deleted_dead: counters.deleted_dead,
      batches: counters.batches,
      duration_seconds: counters.duration_seconds,
      dryRun,
    })
  },
)

// ---------------------------------------------------------------------------
// Manual canary callable — admin-only, for dry-run + on-demand sweep
// ---------------------------------------------------------------------------

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

type CallableRequest = {
  dryRun?: boolean
  inactiveTtlDays?: number
  deadTtlDays?: number
  maxDocsPerRun?: number
  /** Required admin secret to authorize. */
  adminToken?: string
}

export const paMatchingJobsTtlDeleteCallable = onCall<CallableRequest>(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 540,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req) => {
    // Authorize via PA_ADMIN_TOKEN secret.
    const expected = (PA_ADMIN_TOKEN.value() ?? "").trim()
    if (!expected) {
      throw new HttpsError("failed-precondition", "PA_ADMIN_TOKEN not configured")
    }
    const provided =
      typeof req.data?.adminToken === "string" ? req.data.adminToken.trim() : ""
    if (!provided || provided !== expected) {
      throw new HttpsError("permission-denied", "invalid admin token")
    }

    // Default dryRun=true for canary safety — explicit `false` to actually delete.
    const dryRun = req.data?.dryRun !== false
    const inactiveTtlDays =
      typeof req.data?.inactiveTtlDays === "number"
        ? req.data.inactiveTtlDays
        : INACTIVE_TTL_DAYS_DEFAULT
    const deadTtlDays =
      typeof req.data?.deadTtlDays === "number"
        ? req.data.deadTtlDays
        : DEAD_TTL_DAYS_DEFAULT
    const maxDocs =
      typeof req.data?.maxDocsPerRun === "number"
        ? req.data.maxDocsPerRun
        : MAX_DOCS_PER_RUN

    const counters = await runTtlDelete({
      store: makeFirestoreStore(),
      now: () => Date.now(),
      dryRun,
      inactiveTtlDays,
      deadTtlDays,
      maxDocsPerRun: maxDocs,
      log: (msg, ctx) =>
        logger.info(`[pa.matching_jobs.ttl_delete:callable] ${msg}`, ctx ?? {}),
      errorLog: (msg, ctx) =>
        logger.error(`[pa.matching_jobs.ttl_delete:callable] ${msg}`, ctx ?? {}),
    })

    return { dryRun, inactiveTtlDays, deadTtlDays, maxDocsPerRun: maxDocs, counters }
  },
)
