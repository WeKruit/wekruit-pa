/**
 * Backfill — compute the ADVISORY engagement (effort) signal for EVERY existing
 * prescreen session.
 *
 * The `paPrescreenCandidateEval` CF now writes `review.engagementSignal` when a session
 * enters pending review, but every historical session predates that. This walks the
 * whole `pa-prescreen-sessions` collection (cursor-paged by document id) and runs the
 * SAME pure-metric handler the CF runs — no LLM, no Coresignal, so it's cheap. Idempotent
 * (skips sessions already signalled at the current version unless --force). Fail-open
 * per session.
 *
 * Env: FIREBASE_SERVICE_ACCOUNT_JSON. Run from apps/functions.
 * Flags:
 *   --force            recompute even if a current-version signal exists
 *   --pending-only     only sessions with terminalActionPendingReview == true
 *   --limit=N          stop after N sessions (default: all)
 *   --concurrency=N    parallel workers (default 8 — no LLM, safe to raise)
 *   --batch=N          page size for the collection scan (default 300)
 *   --dry              count only, no writes
 */
import { initializeApp, cert } from "firebase-admin/app"
import { getFirestore, FieldPath } from "firebase-admin/firestore"

const argv = process.argv.slice(2)
const FORCE = argv.includes("--force")
const PENDING_ONLY = argv.includes("--pending-only")
const DRY = argv.includes("--dry")
const LIMIT = Number((argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || Infinity
const CONCURRENCY = Number((argv.find((a) => a.startsWith("--concurrency=")) || "").split("=")[1]) || 8
const BATCH = Number((argv.find((a) => a.startsWith("--batch=")) || "").split("=")[1]) || 300

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
initializeApp({ credential: cert(sa) })
const db = getFirestore()

const { runPrescreenEngagementSignal } = await import("../src/prescreen-engagement-signal.ts")

// Cursor-page the whole collection by document id so we never load it all into RAM.
const ids = []
let cursor = null
while (ids.length < LIMIT) {
  let q = db.collection("pa-prescreen-sessions").orderBy(FieldPath.documentId()).limit(BATCH)
  if (PENDING_ONLY) {
    q = db
      .collection("pa-prescreen-sessions")
      .where("terminalActionPendingReview", "==", true)
      .orderBy(FieldPath.documentId())
      .limit(BATCH)
  }
  if (cursor) q = q.startAfter(cursor)
  const snap = await q.get()
  if (snap.empty) break
  for (const d of snap.docs) {
    if (!FORCE && d.data()?.review?.engagementSignal?.version === "engagement-v1") continue
    ids.push(d.id)
    if (ids.length >= LIMIT) break
  }
  cursor = snap.docs[snap.docs.length - 1].id
  if (snap.size < BATCH) break
}

console.log(`sessions to backfill: ${ids.length} (force=${FORCE}, pendingOnly=${PENDING_ONLY}, dry=${DRY}, concurrency=${CONCURRENCY})`)
if (DRY) {
  console.log(ids.slice(0, 20).join("\n"))
  process.exit(0)
}

const counts = { written: 0, skipped: 0, error: 0, high: 0, medium: 0, low: 0 }
let done = 0
const queue = [...ids]

async function worker() {
  while (queue.length) {
    const sid = queue.shift()
    if (!sid) return
    try {
      const res = await runPrescreenEngagementSignal(sid, { db, now: () => new Date().toISOString(), log: () => {} }, { force: FORCE })
      if (res.status === "written") {
        counts.written++
        if (res.signal?.level) counts[res.signal.level]++
      } else if (res.status === "error") counts.error++
      else counts.skipped++
    } catch (e) {
      counts.error++
      console.error("  EXC", sid, e?.message)
    }
    done++
    if (done % 25 === 0) console.log(`  ...${done}/${ids.length} | ${JSON.stringify(counts)}`)
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length || 1) }, () => worker()))
console.log(`DONE ${done}/${ids.length} | ${JSON.stringify(counts)}`)
process.exit(0)
