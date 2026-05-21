#!/usr/bin/env node
/**
 * One-shot backfill: align macmini Postgres `jobs.status` with Firestore
 * `matching-jobs` source-of-truth. Closes the hygiene-sync race residue.
 *
 * Background (2026-05-20 matching-quality launch blocker)
 * -------------------------------------------------------
 * Before alembic migration 0008 + scraper/upsert.py CASE-WHEN guard,
 * macmini's scraper rerun reset every hygiene-flipped row back to
 * status='active' on the next ON CONFLICT. PA's `paJobPoolHygiene`
 * Cloud Function never wrote back to Postgres, so the race produced a
 * silent drift:
 *
 *     Postgres jobs.status='active'        ~32,000+ rows
 *     Firestore matching-jobs.status='active'  4,797 rows
 *     ─────────────────────────────────────────────────
 *     race residue:                        ~27,000 rows
 *
 * Now that 0008 added `hygiene_flipped` + `POST /jobs/hygiene-flip` is
 * live on macmini, we can do a one-time push of every Firestore-inactive
 * doc back to Postgres so the two stores converge. Going forward, PA's
 * hygiene CF will call the endpoint inline (separate PR).
 *
 * Algorithm
 * ---------
 * 1. Stream every `matching-jobs` doc with `status=='inactive'`. Use
 *    paginated queries (cursor on docref) — Firestore won't return more
 *    than 10k in a single fetch.
 * 2. Group their IDs into batches of 1000 (Postgres ANY array limit
 *    comfortable; matching API's HygieneFlipRequest cap is 10k).
 * 3. POST each batch to `${MATCHING_API_URL}/jobs/hygiene-flip` with
 *    reason inherited from Firestore `inactiveReason` (or fallback to
 *    'firestore_inactive_backfill').
 * 4. Verify post-run by re-counting Postgres active rows.
 *
 * Idempotency
 * -----------
 * * The endpoint UPDATE filters to state-changing rows only — re-runs
 *   return flipped=0 once the state is in place.
 * * COALESCE on `hygiene_flipped_at` + `hygiene_flip_reason` preserves
 *   the first-flip audit trail across duplicate calls.
 * * Safe to re-invoke this script any time (e.g. after a fresh hygiene
 *   sweep adds more inactive docs).
 *
 * Usage
 * -----
 *     MATCHING_API_URL=https://matching.wekruit.com \
 *     MATCHING_API_KEY=<key> \
 *     node apps/functions/scripts/backfill-postgres-hygiene-from-firestore.mjs
 *
 *     # Optional flags
 *     --dry-run        Don't POST — just report counts
 *     --batch-size=N   Override default batch size (1000)
 *     --reason-group   Group batches by inactiveReason (default false —
 *                      faster but every batch is mixed-reason)
 */

import { initializeApp, getApps, applicationDefault, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const DEFAULT_BATCH_SIZE = 2000
const DEFAULT_CONCURRENCY = 5
const FIRESTORE_PAGE_SIZE = 1000
const DEFAULT_REASON = "firestore_inactive_backfill"

function parseArgs() {
  const out = {
    dryRun: false,
    batchSize: DEFAULT_BATCH_SIZE,
    reasonGroup: false,
    concurrency: DEFAULT_CONCURRENCY,
  }
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") out.dryRun = true
    else if (arg.startsWith("--batch-size=")) out.batchSize = Number(arg.split("=")[1])
    else if (arg.startsWith("--concurrency=")) out.concurrency = Number(arg.split("=")[1])
    else if (arg === "--reason-group") out.reasonGroup = true
    else throw new Error(`Unknown flag: ${arg}`)
  }
  if (!Number.isInteger(out.batchSize) || out.batchSize <= 0 || out.batchSize > 10000) {
    throw new Error(`--batch-size must be a positive int <= 10000, got ${out.batchSize}`)
  }
  if (!Number.isInteger(out.concurrency) || out.concurrency <= 0 || out.concurrency > 20) {
    throw new Error(`--concurrency must be a positive int <= 20, got ${out.concurrency}`)
  }
  return out
}


async function runWithConcurrency(items, concurrency, worker) {
  /**
   * Process `items` calling worker(item) with at most `concurrency`
   * promises in flight. Returns an array of worker results in input
   * order. Failures from a single worker bubble up — the standalone
   * backfill is a one-shot ops script, so fail-fast is the right
   * behaviour (operator notices, debugs, re-runs).
   */
  const results = new Array(items.length)
  let nextIndex = 0
  async function workerLoop() {
    for (;;) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  }
  const loops = Array.from({ length: Math.min(concurrency, items.length) }, () => workerLoop())
  await Promise.all(loops)
  return results
}

function initAdmin() {
  if (getApps().length) return
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (inlineJson) {
    initializeApp({ credential: cert(JSON.parse(inlineJson)) })
  } else {
    initializeApp({ credential: applicationDefault() })
  }
}

function requireEnv(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name}`)
  return v
}

async function streamInactiveDocs(db) {
  /**
   * Yields {id, inactiveReason} for every matching-jobs doc with
   * status='inactive'. Pages via Firestore cursor so we don't pull the
   * entire collection into memory at once.
   */
  const collection = db.collection("matching-jobs")
  let lastDoc = null
  const out = []
  for (;;) {
    let q = collection.where("status", "==", "inactive")
                      .orderBy("__name__")
                      .limit(FIRESTORE_PAGE_SIZE)
    if (lastDoc) q = q.startAfter(lastDoc)
    const snap = await q.get()
    if (snap.empty) break
    for (const doc of snap.docs) {
      const data = doc.data()
      out.push({
        id: doc.id,
        inactiveReason:
          (typeof data.inactiveReason === "string" && data.inactiveReason) ||
          (typeof data.hygieneReason === "string" && data.hygieneReason) ||
          DEFAULT_REASON,
      })
    }
    if (snap.size < FIRESTORE_PAGE_SIZE) break
    lastDoc = snap.docs[snap.docs.length - 1]
  }
  return out
}

function groupByReason(rows) {
  const m = new Map()
  for (const r of rows) {
    const list = m.get(r.inactiveReason) || []
    list.push(r.id)
    m.set(r.inactiveReason, list)
  }
  return m
}

function chunked(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function postBatch({ apiUrl, apiKey, jobIds, reason }) {
  const resp = await fetch(`${apiUrl}/jobs/hygiene-flip`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({ job_ids: jobIds, reason }),
  })
  const text = await resp.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { _rawText: text.slice(0, 500) }
  }
  if (!resp.ok) {
    throw new Error(
      `POST /jobs/hygiene-flip failed: status=${resp.status} body=${JSON.stringify(body)}`,
    )
  }
  return body
}

async function main() {
  const { dryRun, batchSize, reasonGroup, concurrency } = parseArgs()
  const apiUrl = requireEnv("MATCHING_API_URL").replace(/\/$/, "")
  const apiKey = requireEnv("MATCHING_API_KEY")

  initAdmin()
  const db = getFirestore()

  console.log(`[backfill] streaming Firestore matching-jobs where status='inactive'...`)
  const rows = await streamInactiveDocs(db)
  console.log(`[backfill] found ${rows.length} inactive docs`)

  if (rows.length === 0) {
    console.log(`[backfill] nothing to backfill, exiting`)
    return
  }

  // Pre-flight reason-distribution histogram
  const histogram = new Map()
  for (const r of rows) histogram.set(r.inactiveReason, (histogram.get(r.inactiveReason) || 0) + 1)
  const sortedReasons = [...histogram.entries()].sort((a, b) => b[1] - a[1])
  console.log(`[backfill] reason histogram:`)
  for (const [reason, count] of sortedReasons) {
    console.log(`  ${count.toString().padStart(7)}  ${reason}`)
  }

  if (dryRun) {
    console.log(`[backfill] --dry-run set; no POSTs sent`)
    return
  }

  let totalFlipped = 0
  let totalReceived = 0
  let batches = 0
  let processedBatches = 0
  const counterLock = { value: 0 }

  // Build a flat batches list (jobIds + reason per batch) so we can fan out.
  const batchPlan = []
  if (reasonGroup) {
    const byReason = groupByReason(rows)
    for (const [reason, ids] of byReason.entries()) {
      for (const chunk of chunked(ids, batchSize)) {
        batchPlan.push({ reason, jobIds: chunk })
      }
    }
  } else {
    const reasonByChunkFirst = chunked(rows, batchSize).map(c => c[0]?.inactiveReason || DEFAULT_REASON)
    const idChunks = chunked(rows.map(r => r.id), batchSize)
    for (let i = 0; i < idChunks.length; i++) {
      batchPlan.push({ reason: reasonByChunkFirst[i], jobIds: idChunks[i] })
    }
  }

  console.log(`[backfill] starting ${batchPlan.length} batches, concurrency=${concurrency}, batch_size=${batchSize}`)
  const tStart = Date.now()

  await runWithConcurrency(batchPlan, concurrency, async (batch) => {
    const result = await postBatch({ apiUrl, apiKey, jobIds: batch.jobIds, reason: batch.reason })
    totalFlipped += result.flipped
    totalReceived += result.received
    processedBatches += 1
    if (processedBatches % 10 === 0 || processedBatches === batchPlan.length) {
      const elapsed = (Date.now() - tStart) / 1000
      const rate = processedBatches / Math.max(elapsed, 0.001)
      const remaining = (batchPlan.length - processedBatches) / Math.max(rate, 0.001)
      console.log(
        `[backfill] ${processedBatches}/${batchPlan.length} batches (${(elapsed).toFixed(0)}s elapsed, ETA ${remaining.toFixed(0)}s, flipped_so_far=${totalFlipped})`,
      )
    }
    return result
  })
  batches = processedBatches

  console.log(`\n[backfill] DONE`)
  console.log(`[backfill] batches=${batches}`)
  console.log(`[backfill] received=${totalReceived}`)
  console.log(`[backfill] flipped=${totalFlipped}  (rows whose Postgres state actually changed)`)
  console.log(`[backfill] noop=${totalReceived - totalFlipped}  (rows already in target state)`)
}

main().catch((err) => {
  console.error("[backfill] FATAL:", err.message)
  console.error(err.stack)
  process.exit(1)
})
