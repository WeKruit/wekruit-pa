#!/usr/bin/env node
/**
 * Dump last N pa-messages rows for a userId regardless of idempotencyKey,
 * to surface multi-message turns where the dispatcher fired sendDirect
 * 4× but appendMessage's same-idempotencyKey dedup collapsed to 1 row.
 *
 * Usage: GOOGLE_APPLICATION_CREDENTIALS=... node tests/scenarios/dump-session-tail.mjs <userId> [N]
 */
import { readFileSync } from "node:fs"
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const userId = process.argv[2]
const N = Number(process.argv[3] ?? 20)
if (!userId) {
  console.error("usage: dump-session-tail.mjs <userId> [N]")
  process.exit(2)
}

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
const sa = JSON.parse(readFileSync(credPath, "utf8"))
if (!getApps().length) initializeApp({ credential: cert(sa), projectId: sa.project_id })
const db = getFirestore()

const snap = await db.collection("pa-messages")
  .where("userId", "==", userId)
  .limit(200)
  .get()
console.log(`found ${snap.size} pa-messages row(s) for userId=${userId}`)
let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
rows.sort((a, b) => {
  const ta = typeof a.createdAt === "string" ? Date.parse(a.createdAt) : 0
  const tb = typeof b.createdAt === "string" ? Date.parse(b.createdAt) : 0
  return tb - ta
})
rows = rows.slice(0, N)
rows.reverse() // chronological
for (const r of rows) {
  console.log("─────────────────────────────────────────────────────")
  console.log(`role=${r.role} createdAt=${r.createdAt} idemKey=${r.idempotencyKey ?? "(none)"}`)
  console.log(`rawMeta=${JSON.stringify(r.rawMeta ?? {})}`)
  console.log(`body:`)
  console.log(r.body)
}
console.log("─────────────────────────────────────────────────────")
process.exit(0)
