/**
 * Phase A4.1 — `paCompaniesJobCountSync` callable.
 *
 * Walks `matching-jobs`, groups by `normalize(companyName)`, writes
 * `jobsCount` + `jobsCountUpdatedAt` back to `pa-companies/{id}` via
 * Admin SDK. Decouples the directory-vs-jobs visibility gap noted in
 * `/admin/companies` review — without this, operators can't tell whether
 * a pa-companies row is enrichment-only or actually attached to any open
 * roles in the matching pool.
 *
 * Admin-only callable. Idempotent. Pages through matching-jobs in
 * deterministic chunks so a single invocation can update the full
 * directory without exceeding the 540s Cloud Functions timeout — the
 * caller polls for completion (`done: false` + `nextCursor`).
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { defineSecret } from "firebase-functions/params"
import { getFirestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions/v2"
import { normalizeCompanyName, PA_COLLECTIONS } from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const MATCHING_JOBS = "matching-jobs"
const PAGE_LIMIT = 5000

interface SyncInput {
  cursor?: string | null
  /** Hard cap on per-invocation pages (defaults to walking through). */
  maxPages?: number
}

interface SyncResult {
  ok: true
  done: boolean
  nextCursor: string | null
  pagesProcessed: number
  jobsScanned: number
  companiesUpdated: number
}

async function aggregateCounts(
  db: FirebaseFirestore.Firestore,
  startAfter: string | null,
  maxPages: number,
): Promise<{
  counts: Map<string, number>
  lastId: string | null
  pages: number
  scanned: number
}> {
  const counts = new Map<string, number>()
  let cursor: string | null = startAfter
  let pages = 0
  let scanned = 0
  while (pages < maxPages) {
    let q = db.collection(MATCHING_JOBS).orderBy("__name__").limit(PAGE_LIMIT)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()
    if (snap.empty) {
      cursor = null
      break
    }
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>
      const status = typeof data.status === "string" ? data.status : ""
      // Only count live, non-dead rows toward the directory badge.
      if (status !== "active") continue
      if (data.dead === true) continue
      const raw = typeof data.companyName === "string" ? data.companyName : ""
      const norm = normalizeCompanyName(raw)
      if (!norm) continue
      counts.set(norm, (counts.get(norm) ?? 0) + 1)
      scanned++
    }
    cursor = snap.docs[snap.docs.length - 1]!.id
    pages++
    if (snap.docs.length < PAGE_LIMIT) {
      cursor = null
      break
    }
  }
  return { counts, lastId: cursor, pages, scanned }
}

async function writeBack(
  db: FirebaseFirestore.Firestore,
  counts: Map<string, number>,
): Promise<number> {
  if (counts.size === 0) return 0
  const nowIso = new Date().toISOString()
  let updated = 0
  // Batch in groups of 400 (Firestore limit is 500 ops/batch; leave headroom).
  const entries = Array.from(counts.entries())
  for (let i = 0; i < entries.length; i += 400) {
    const slice = entries.slice(i, i + 400)
    const batch = db.batch()
    for (const [id, count] of slice) {
      batch.set(
        db.collection(PA_COLLECTIONS.companies).doc(id),
        { jobsCount: count, jobsCountUpdatedAt: nowIso },
        { merge: true },
      )
      updated++
    }
    await batch.commit()
  }
  return updated
}

export async function runCompaniesJobCountSync(
  db: FirebaseFirestore.Firestore,
  input: SyncInput,
): Promise<SyncResult> {
  const startAfter = typeof input.cursor === "string" && input.cursor.length > 0 ? input.cursor : null
  const maxPages = typeof input.maxPages === "number" && input.maxPages > 0 ? Math.min(input.maxPages, 100) : 100
  const agg = await aggregateCounts(db, startAfter, maxPages)
  const companiesUpdated = await writeBack(db, agg.counts)
  return {
    ok: true,
    done: agg.lastId === null,
    nextCursor: agg.lastId,
    pagesProcessed: agg.pages,
    jobsScanned: agg.scanned,
    companiesUpdated,
  }
}

export const paCompaniesJobCountSync = onCall(
  {
    region: "us-central1",
    // matching-jobs is 120K+ rows; 5000/page = 24+ pages. Each page parses
    // job docs and aggregates into the counts Map — 1 GiB needed to avoid
    // OOM at the full-pool scan tier (observed 525 MiB on first deploy).
    memory: "1GiB",
    timeoutSeconds: 540,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req): Promise<SyncResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const data = (req.data ?? {}) as Record<string, unknown>
    const input: SyncInput = {
      cursor: typeof data.cursor === "string" ? data.cursor : null,
      maxPages: typeof data.maxPages === "number" ? data.maxPages : undefined,
    }
    const result = await runCompaniesJobCountSync(getFirestore(), input)
    logger.info("[companies-job-count] adhoc result", result)
    return result
  },
)

/**
 * Nightly tick — Wed 03:00 UTC. Walks the whole matching-jobs pool in
 * one shot (timeout cap 540s; ~120k rows / 5k/page = 24 pages, fits).
 * Self-contained — does not chain pagination across invocations because
 * the scheduled CF can't (no client to resume).
 */
export const paCompaniesJobCountNightly = onSchedule(
  {
    schedule: "0 3 * * 3",
    timeZone: "UTC",
    region: "us-central1",
    // See sibling onCall for the 1 GiB justification.
    memory: "1GiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const r = await runCompaniesJobCountSync(getFirestore(), {})
    logger.info("[companies-job-count] nightly done", r)
    // Best-effort retry until done — single CF invocation cap.
    let cursor = r.nextCursor
    let safety = 5
    while (cursor && safety-- > 0) {
      const next = await runCompaniesJobCountSync(getFirestore(), { cursor })
      logger.info("[companies-job-count] continuation", next)
      cursor = next.nextCursor
    }
  },
)
