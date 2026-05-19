/**
 * v2.x — Active-pool hygiene sweep for matching-jobs.
 *
 * Adam directive (pre-launch matching hardening W6, 2026-05-19):
 *   Production audit shows ~10k status=="active" matching-jobs docs are
 *   placeholders (no jobTitle), 1,011 are `dead=true` mis-flagged, 1,050 are
 *   missing `atsApplyUrl`, 3,350 are past V16's 20-day hard-filter window
 *   (`firstSeenAt > 20d`). Real healthy active ≈ 940 / 16.5k (~5.7%).
 *
 *   V16's queryMatchingJobsV16 cascade dropped the `status=="active"` filter
 *   in favour of array-contains-any on `roleFunction`. That means
 *   well-formed-but-poisoned docs leak into match candidates until we flip
 *   them to `inactive` — at which point the V16 cascade's other hard filters
 *   (status check is gone but `dead != true`, freshness, atsApplyUrl validity)
 *   already drop them, AND this function removes them from any future
 *   status-gated query path too.
 *
 *   This CF flips bad-active docs to `status: "inactive"` so they disappear
 *   from any matching surface. Predicate:
 *     1. dead === true                                → inactiveReason="dead_flag"
 *     2. jobTitle missing/empty (trim().length === 0) → "no_title"
 *     3. firstSeenAt < (NOW - 20 days)                → "stale_firstseenat"
 *     4. atsApplyUrl missing OR matches /jobright.ai/i → "missing_or_placeholder_ats"
 *
 *   Write payload (merge=true preserves other fields):
 *     { status: "inactive",
 *       inactiveAt: FieldValue.serverTimestamp(),
 *       inactiveReason: <first predicate that matched> }
 *
 * Safe-because precondition (W1, PR #7 wekruit-core-service-cloud-function):
 *   `upsertJobs` in core-service is now status-respecting — next macmini scrape
 *   sees `status: "inactive"` and skips overwrite. Without W1 the next scrape
 *   would resurrect the flipped doc within hours. With W1 in main this hygiene
 *   pass is durable.
 *
 * Manual on-demand only (no scheduler). Default `dryRun: true` so a canary
 * surfaces counters before any write hits Firestore. Admin-gated via
 * PA_ADMIN_TOKEN secret (same shape as paMatchingJobsTtlDeleteCallable).
 *
 * Architecture: pure logic in `runJobPoolHygiene(deps)` so unit tests drive
 * it without booting firebase-admin. Thin `onCall` shim at the bottom.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import {
  getFirestore,
  FieldValue,
  type Firestore,
  type Query,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** V16 hard-filter freshness window. Docs older than this are bad-active. */
export const STALE_FIRSTSEENAT_DAYS_DEFAULT = 20

export const BATCH_SIZE = 500
export const PAGE_SIZE = 500
/** Throttle between batches (ms) → ≤10 batches/sec to stay nice to Firestore. */
export const THROTTLE_MS = 100
/** Hard cap to avoid blowing the 540s callable timeout on first run. */
export const MAX_DOCS_PER_RUN = 50_000

const MS_PER_DAY = 24 * 3600 * 1000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HygieneReason =
  | "dead_flag"
  | "no_title"
  | "stale_firstseenat"
  | "missing_or_placeholder_ats"

export type HygieneCounters = {
  dryRun: boolean
  scanned: number
  flipped_dead: number
  flipped_no_title: number
  flipped_stale: number
  flipped_missing_ats: number
  flipped_total: number
  /** Sanity counter — should be 0 because the streaming query is
   *  `where status == "active"`. If non-zero a query bug snuck in. */
  skipped_already_inactive: number
  batches: number
  duration_seconds: number
  errors: number
}

export function emptyCounters(): HygieneCounters {
  return {
    dryRun: false,
    scanned: 0,
    flipped_dead: 0,
    flipped_no_title: 0,
    flipped_stale: 0,
    flipped_missing_ats: 0,
    flipped_total: 0,
    skipped_already_inactive: 0,
    batches: 0,
    duration_seconds: 0,
    errors: 0,
  }
}

/** Minimal projection of a matching-jobs doc — only fields the predicate reads. */
export type HygieneJobDoc = {
  id: string
  status?: string | null
  dead?: boolean | null
  jobTitle?: string | null
  /** ISO string OR Firestore Timestamp-like. */
  firstSeenAt?: string | { toMillis: () => number } | null
  atsApplyUrl?: string | null
}

/** Result of evaluating the predicate against one doc. */
export type HygieneEvaluation =
  | { flip: false }
  | { flip: true; reason: HygieneReason }

/** Storage abstraction so tests don't boot firebase-admin. */
export type HygieneStore = {
  /**
   * Stream active docs page-by-page. Implementation must call `onPage` once
   * per page and may stop early if `onPage` returns `{ stop: true }`.
   */
  streamActive: (
    pageSize: number,
    onPage: (docs: HygieneJobDoc[]) => Promise<{ stop: boolean }>,
  ) => Promise<void>
  /**
   * Commit a batched merge-write that flips each id's status to inactive
   * with the supplied reason. Caller passes ≤500 entries.
   */
  batchFlipInactive: (
    items: Array<{ id: string; reason: HygieneReason }>,
  ) => Promise<void>
  /** Best-effort audit row — never throws. */
  writeAudit: (counters: HygieneCounters, runAt: string) => Promise<void>
}

export type HygieneDeps = {
  store: HygieneStore
  /** Returns ms-since-epoch; stubbable for tests. */
  now: () => number
  /** Default 20 (matches V16 freshness window). */
  staleFirstSeenAtDays?: number
  batchSize?: number
  pageSize?: number
  throttleMs?: number
  maxDocsPerRun?: number
  /** When true, evaluate predicate + count but skip the write. */
  dryRun?: boolean
  log?: (msg: string, ctx?: Record<string, unknown>) => void
  errorLog?: (msg: string, ctx?: Record<string, unknown>) => void
  /** Stubbable sleep — tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>
}

// ---------------------------------------------------------------------------
// Predicate (pure)
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
 * Pure predicate. First-match wins so we attribute each flip to a single
 * reason for the audit counters. Order is:
 *   1. dead_flag                (cheapest + most damning)
 *   2. no_title                 (placeholder doc)
 *   3. stale_firstseenat        (past V16 hard-filter window)
 *   4. missing_or_placeholder_ats
 *
 * Returns `{ flip: false }` for healthy docs (and for docs whose firstSeenAt
 * is unparseable — conservative: never flip a doc whose age we can't read).
 */
export function evaluateHygiene(
  doc: HygieneJobDoc,
  nowMs: number,
  staleCutoffMs: number,
): HygieneEvaluation {
  if (doc.dead === true) {
    return { flip: true, reason: "dead_flag" }
  }
  const title = typeof doc.jobTitle === "string" ? doc.jobTitle : ""
  if (String(title).trim().length === 0) {
    return { flip: true, reason: "no_title" }
  }
  const firstSeenMs = toMillis(doc.firstSeenAt)
  // Only flag stale when we have a parseable timestamp AND it's past the
  // cutoff. A doc with no firstSeenAt is suspicious but not unambiguously
  // stale — don't classify it here (the no_title / dead / missing_ats
  // predicates will catch it if it's also placeholder-shaped).
  if (firstSeenMs !== null && firstSeenMs < staleCutoffMs) {
    return { flip: true, reason: "stale_firstseenat" }
  }
  const ats = typeof doc.atsApplyUrl === "string" ? doc.atsApplyUrl : ""
  if (ats.length === 0 || /jobright\.ai/i.test(ats)) {
    return { flip: true, reason: "missing_or_placeholder_ats" }
  }
  void nowMs
  return { flip: false }
}

// ---------------------------------------------------------------------------
// Page classification
// ---------------------------------------------------------------------------

/**
 * Pure: classifies docs in `page` as flip/keep. Mutates counters, returns
 * the ids that should be flipped (with reason tag).
 *
 * Defensive guard: if the streaming query returns a doc whose status is
 * already not "active" (shouldn't happen — query is `where status=="active"`)
 * we bump `skipped_already_inactive` and skip. This catches a query bug.
 */
export function classifyPage(
  page: HygieneJobDoc[],
  nowMs: number,
  staleCutoffMs: number,
  counters: HygieneCounters,
): Array<{ id: string; reason: HygieneReason }> {
  const out: Array<{ id: string; reason: HygieneReason }> = []
  for (const doc of page) {
    counters.scanned++
    if (doc.status && doc.status !== "active") {
      counters.skipped_already_inactive++
      continue
    }
    const ev = evaluateHygiene(doc, nowMs, staleCutoffMs)
    if (!ev.flip) continue
    out.push({ id: doc.id, reason: ev.reason })
  }
  return out
}

function bumpReasonCounter(counters: HygieneCounters, reason: HygieneReason): void {
  switch (reason) {
    case "dead_flag":
      counters.flipped_dead++
      break
    case "no_title":
      counters.flipped_no_title++
      break
    case "stale_firstseenat":
      counters.flipped_stale++
      break
    case "missing_or_placeholder_ats":
      counters.flipped_missing_ats++
      break
  }
  counters.flipped_total++
}

// ---------------------------------------------------------------------------
// Main driver
// ---------------------------------------------------------------------------

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function runJobPoolHygiene(deps: HygieneDeps): Promise<HygieneCounters> {
  const startMs = deps.now()
  const log = deps.log ?? (() => {})
  const errorLog = deps.errorLog ?? log
  const sleep = deps.sleep ?? defaultSleep
  const staleDays = deps.staleFirstSeenAtDays ?? STALE_FIRSTSEENAT_DAYS_DEFAULT
  const batchSize = deps.batchSize ?? BATCH_SIZE
  const pageSize = deps.pageSize ?? PAGE_SIZE
  const throttleMs = deps.throttleMs ?? THROTTLE_MS
  const maxDocs = deps.maxDocsPerRun ?? MAX_DOCS_PER_RUN
  const dryRun = deps.dryRun === true

  const counters = emptyCounters()
  counters.dryRun = dryRun
  const staleCutoffMs = startMs - staleDays * MS_PER_DAY

  log("job_pool_hygiene_start", {
    staleFirstSeenAtDays: staleDays,
    staleCutoffIso: new Date(staleCutoffMs).toISOString(),
    dryRun,
    maxDocsPerRun: maxDocs,
  })

  // Dedup: a Firestore re-page could in theory return the same doc twice if
  // a concurrent writer mutates the cursor key. Cheap insurance.
  const queued = new Set<string>()
  let pending: Array<{ id: string; reason: HygieneReason }> = []

  const flush = async () => {
    if (pending.length === 0) return
    const slice = pending.splice(0, batchSize)
    if (dryRun) {
      // Don't write, but tally what we would have flipped.
      for (const item of slice) bumpReasonCounter(counters, item.reason)
      counters.batches++
      log("job_pool_hygiene_batch_dryrun", {
        size: slice.length,
        batchNum: counters.batches,
      })
    } else {
      try {
        await deps.store.batchFlipInactive(slice)
        counters.batches++
        for (const item of slice) bumpReasonCounter(counters, item.reason)
        log("job_pool_hygiene_batch", {
          size: slice.length,
          batchNum: counters.batches,
        })
      } catch (err) {
        counters.errors++
        errorLog("job_pool_hygiene_batch_failed", {
          batchNum: counters.batches + 1,
          size: slice.length,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (throttleMs > 0) await sleep(throttleMs)
  }

  await deps.store.streamActive(pageSize, async (page) => {
    const plan = classifyPage(page, startMs, staleCutoffMs, counters)
    for (const item of plan) {
      if (queued.has(item.id)) continue
      queued.add(item.id)
      pending.push(item)
      if (pending.length >= batchSize) await flush()
    }
    if (queued.size >= maxDocs) {
      log("job_pool_hygiene_max_docs_reached", {
        totalQueued: queued.size,
        maxDocs,
      })
      return { stop: true }
    }
    return { stop: false }
  })

  while (pending.length > 0) await flush()

  counters.duration_seconds = Math.round((deps.now() - startMs) / 1000)
  log("job_pool_hygiene_complete", { ...counters })

  try {
    await deps.store.writeAudit(counters, new Date(deps.now()).toISOString())
  } catch (err) {
    errorLog("job_pool_hygiene_audit_write_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return counters
}

// ---------------------------------------------------------------------------
// Production Firestore-backed store
// ---------------------------------------------------------------------------

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

function projectDoc(snap: QueryDocumentSnapshot<DocumentData>): HygieneJobDoc {
  const data = snap.data()
  return {
    id: snap.id,
    status: typeof data.status === "string" ? data.status : null,
    dead: typeof data.dead === "boolean" ? data.dead : null,
    jobTitle: typeof data.jobTitle === "string" ? data.jobTitle : null,
    firstSeenAt: pickTs(data.firstSeenAt),
    atsApplyUrl: typeof data.atsApplyUrl === "string" ? data.atsApplyUrl : null,
  }
}

async function pageQuery(
  baseQ: Query<DocumentData>,
  pageSize: number,
  onPage: (docs: HygieneJobDoc[]) => Promise<{ stop: boolean }>,
): Promise<void> {
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null
  // 50k cap / 500 = 100 pages; give 400 headroom for runaway-loop defense.
  const MAX_PAGES = 400
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

export function makeFirestoreStore(db?: Firestore): HygieneStore {
  const getDb = () => db ?? getFirestore()
  return {
    streamActive: async (pageSize, onPage) => {
      // No orderBy → uses implicit __name__ ordering, no composite index
      // required. Cursor pagination is deterministic.
      const q = getDb().collection("matching-jobs").where("status", "==", "active")
      await pageQuery(q, pageSize, onPage)
    },
    batchFlipInactive: async (items) => {
      if (items.length === 0) return
      const fs = getDb()
      const batch = fs.batch()
      for (const { id, reason } of items) {
        batch.set(
          fs.collection("matching-jobs").doc(id),
          {
            status: "inactive",
            inactiveAt: FieldValue.serverTimestamp(),
            inactiveReason: reason,
          },
          { merge: true },
        )
      }
      await batch.commit()
    },
    writeAudit: async (counters, runAt) => {
      try {
        await getDb().collection("matching-jobs-hygiene-runs").add({
          runAt,
          counters,
        })
      } catch {
        // Swallow — auditing must never block the sweep.
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Manual canary callable — admin-only, dry-run by default
// ---------------------------------------------------------------------------

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

type CallableRequest = {
  dryRun?: boolean
  staleFirstSeenAtDays?: number
  maxDocsPerRun?: number
  /** Required admin secret to authorize. */
  adminToken?: string
}

export const paJobPoolHygiene = onCall<CallableRequest>(
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

    // Default dryRun=true for canary safety — explicit `false` to actually flip.
    const dryRun = req.data?.dryRun !== false
    const staleDays =
      typeof req.data?.staleFirstSeenAtDays === "number"
        ? req.data.staleFirstSeenAtDays
        : STALE_FIRSTSEENAT_DAYS_DEFAULT
    const maxDocs =
      typeof req.data?.maxDocsPerRun === "number"
        ? req.data.maxDocsPerRun
        : MAX_DOCS_PER_RUN

    const counters = await runJobPoolHygiene({
      store: makeFirestoreStore(),
      now: () => Date.now(),
      dryRun,
      staleFirstSeenAtDays: staleDays,
      maxDocsPerRun: maxDocs,
      log: (msg, ctx) =>
        logger.info(`[pa.matching_jobs.hygiene] ${msg}`, ctx ?? {}),
      errorLog: (msg, ctx) =>
        logger.error(`[pa.matching_jobs.hygiene] ${msg}`, ctx ?? {}),
    })

    return { dryRun, staleFirstSeenAtDays: staleDays, maxDocsPerRun: maxDocs, counters }
  },
)
