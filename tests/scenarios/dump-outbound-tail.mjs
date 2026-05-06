#!/usr/bin/env node
/**
 * Dump all pa-outbound rows for a given userId since a given timestamp.
 *
 * Why this exists: the deterministic onboarding `send_cv_analysis` edge
 * fires FOUR sendDirect calls in one event (interim ack + CV summary +
 * job-rec push + tag summary). All four share the same idempotencyKey
 * `out-onboarding-${eventId}` for the pa-messages append step, so
 * pa-messages collapses to a single row whose body = the LAST overwrite
 * (tag summary). To verify the full bundle, we have to look at
 * pa-outbound, which uses random doc IDs (no dedup) — every sendDirect
 * call enqueues a fresh row.
 *
 * Pre-condition: scenario must have run with `suppressOutbound: false`.
 * The runner sets this true by default; for verification runs flip
 * tests/scenarios/runner.mjs line 262 to `false` and revert after.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=... \
 *     node tests/scenarios/dump-outbound-tail.mjs <userId> [sinceMs]
 *
 * sinceMs defaults to (now - 10 min).
 */
import { readFileSync } from "node:fs"
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore, Timestamp } from "firebase-admin/firestore"

const userId = process.argv[2]
const sinceArg = process.argv[3]
if (!userId) {
  console.error("usage: dump-outbound-tail.mjs <userId> [sinceMs]")
  process.exit(2)
}

const sinceMs = sinceArg ? Number(sinceArg) : Date.now() - 600_000
if (!Number.isFinite(sinceMs)) {
  console.error("sinceMs must be a number (ms epoch)")
  process.exit(2)
}

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
if (!credPath) {
  console.error("GOOGLE_APPLICATION_CREDENTIALS env var required")
  process.exit(2)
}
const sa = JSON.parse(readFileSync(credPath, "utf8"))
if (!getApps().length) initializeApp({ credential: cert(sa), projectId: sa.project_id })
const db = getFirestore()

const sinceIso = new Date(sinceMs).toISOString()
console.log(`=== pa-outbound rows for userId=${userId} since ${sinceIso} ===`)

// pa-outbound stores createdAt as ISO string (per orchestrator FirestoreStore.enqueueOutbound).
// So we filter client-side after fetching.
const snap = await db
  .collection("pa-outbound")
  .where("userId", "==", userId)
  .limit(50)
  .get()

const rows = snap.docs
  .map((d) => ({ docId: d.id, ...d.data() }))
  .filter((r) => {
    const t = typeof r.createdAt === "string" ? Date.parse(r.createdAt) : 0
    return t >= sinceMs
  })
  .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))

console.log(`found ${rows.length} row(s)\n`)

let i = 1
for (const r of rows) {
  console.log("─────────────────────────────────────────────────────")
  console.log(`#${i++}  docId=${r.docId}`)
  console.log(`createdAt=${r.createdAt}  status=${r.status}  attempts=${r.attempts ?? 0}`)
  console.log(`idempotencyKey=${r.idempotencyKey ?? "(none)"}`)
  console.log(`toE164=${r.toE164}`)
  console.log("body:")
  console.log(r.body)
}
console.log("─────────────────────────────────────────────────────")
process.exit(0)
