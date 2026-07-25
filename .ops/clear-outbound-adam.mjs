// Clear leftover pa-outbound for a test user. The outbox dedups on userId + body hash within a
// window, and the YC kickoff/pitch copy is deterministic — leftover rows silently suppress a
// rescan as a "duplicate", which reads on the phone as no response at all.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
const uid = process.argv[2]
const APPLY = process.argv.includes("--apply")
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const ids = new Set()
for (const f of ["userId", "candidateId"]) {
  const r = await db.collection("pa-outbound").where(f, "==", uid).get().catch(() => ({ docs: [] }))
  r.docs.forEach((d) => ids.add(d.id))
}
console.log(`pa-outbound rows for ${uid}: ${ids.size}  mode=${APPLY ? "APPLY" : "DRY"}`)
if (!APPLY) { console.log("DRY — 0 writes."); process.exit(0) }
const all = [...ids]
for (let i = 0; i < all.length; i += 400) {
  const b = db.batch(); all.slice(i, i + 400).forEach((id) => b.delete(db.collection("pa-outbound").doc(id))); await b.commit()
}
const left = await db.collection("pa-outbound").where("userId", "==", uid).get().catch(() => ({ size: -1 }))
console.log(`deleted ${all.length}; remaining=${left.size}`)
process.exit(0)
