import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { createHash } from "node:crypto"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz"

// Pull ALL pa-outbound for uid, print id + idempotencyKey + body + status
const snap = await db.collection("pa-outbound").where("userId","==",uid).get()
console.log(`=== pa-outbound for uid: ${snap.size} docs ===`)
const docId = (k)=>"out_"+createHash("sha256").update(k,"utf8").digest("hex").slice(0,40)
for (const d of snap.docs) {
  const x = d.data()
  console.log(`\n  docId: ${d.id}`)
  console.log(`  status: ${x.status} | createdAt: ${x.createdAt}`)
  console.log(`  idempotencyKey: ${x.idempotencyKey}`)
  console.log(`  body: ${JSON.stringify(String(x.body||"").slice(0,70))}`)
  console.log(`  verify id == docId(idempotencyKey)? ${d.id === docId(x.idempotencyKey)}`)
}

// The kickoff body the agent composed at 22:34 (from pa-messages)
const msgs = await db.collection("pa-messages").where("userId","==",uid).get()
const asst = msgs.docs.map(d=>d.data()).find(m=>(m.role||m.direction)==="assistant")
const kickoffBody = String(asst?.text||asst?.body||asst?.content||"")
console.log(`\n=== 22:34 kickoff body (from transcript): ${JSON.stringify(kickoffBody.slice(0,70))} ===`)

// Does its idempotency doc already exist (the collision)? Try both sessionId candidates.
console.log("\n=== collision check ===")
console.log("cutover passes sessionId =", JSON.stringify(asst?.sessionId || "(unknown — check session id scheme)"))
// the 18:56:29 sent doc body:
const sent1856 = snap.docs.map(d=>d.data()).find(x=>String(x.body||"").startsWith("hey! for this next phase"))
if (sent1856) {
  console.log("STALE sent doc body:", JSON.stringify(String(sent1856.body).slice(0,70)))
  console.log("STALE sent doc idempotencyKey:", sent1856.idempotencyKey, "| status:", sent1856.status)
  console.log("SAME BODY as 22:34 kickoff?", String(sent1856.body) === kickoffBody)
}
process.exit(0)
