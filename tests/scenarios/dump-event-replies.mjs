#!/usr/bin/env node
/**
 * Dump all assistant pa-messages rows for a given inbound eventId.
 * Useful when one inbound triggers a multi-message Claire bundle (e.g.
 * iter34 send_cv_analysis fires 4 messages: ack + analysis + jobRec +
 * tagSummary) — the runner picks only the first match, so we need this
 * to inspect the rest.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=... \
 *     node tests/scenarios/dump-event-replies.mjs <eventId>
 */
import { readFileSync } from "node:fs"
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const eventId = process.argv[2]
if (!eventId) {
  console.error("usage: dump-event-replies.mjs <eventId>")
  process.exit(2)
}

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
const sa = JSON.parse(readFileSync(credPath, "utf8"))
if (!getApps().length) initializeApp({ credential: cert(sa), projectId: sa.project_id })
const db = getFirestore()

const snap = await db.collection("pa-messages").where("rawMeta.eventId", "==", eventId).limit(20).get()
console.log(`found ${snap.size} pa-messages row(s) for eventId=${eventId}`)
const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
// Sort by createdAt
rows.sort((a, b) => {
  const ta = typeof a.createdAt === "string" ? Date.parse(a.createdAt) : 0
  const tb = typeof b.createdAt === "string" ? Date.parse(b.createdAt) : 0
  return ta - tb
})
for (const r of rows) {
  console.log("─────────────────────────────────────────────────────")
  console.log(`role=${r.role} createdAt=${r.createdAt}`)
  console.log(`rawMeta.kind=${r.rawMeta?.kind ?? "(none)"}`)
  console.log(`body:`)
  console.log(r.body)
}
console.log("─────────────────────────────────────────────────────")
process.exit(0)
