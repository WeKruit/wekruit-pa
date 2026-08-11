// READ-ONLY. Raw inbound-event docs for the paste turns + neighbours in the same minutes.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

for (const id of ["inb_75af5ccf", "inb_b1513479"]) {
  const s = await db.collection("pa-inbound-events").where(admin.firestore.FieldPath.documentId(), ">=", id)
    .where(admin.firestore.FieldPath.documentId(), "<", id + "").limit(3).get()
  for (const d of s.docs) {
    console.log("=".repeat(100)); console.log("DOC", d.id)
    console.log(JSON.stringify(d.data(), null, 1).slice(0, 2500))
  }
}

// Everything processed in the 17:40-18:10 window: who handled what, to see the deploy boundary.
console.log("\n" + "=".repeat(100))
console.log("ALL pa-inbound-events 17:30-18:30 UTC — handledBy distribution over time")
const all = await db.collection("pa-inbound-events")
  .where("createdAt", ">=", "2026-07-25T17:20:00.000Z")
  .where("createdAt", "<=", "2026-07-25T18:40:00.000Z").get()
const rows = all.docs.map((d) => ({ id: d.id, ...d.data() }))
  .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
for (const r of rows) {
  console.log(`${String(r.createdAt).slice(11, 19)} ${r.id.slice(0, 14).padEnd(15)} st=${String(r.status).padEnd(10)} by=${String(r.handledBy ?? "—").padEnd(38)} rt=${r.rawMeta?.runtimeEventKind ?? "-"} ${JSON.stringify(String(r.text ?? r.body ?? "").slice(0, 60))}`)
}
process.exit(0)
