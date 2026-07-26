import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const s = await db.collection("pa-jobs").get()
console.log("id | publicVisible | dead | wekruitCollaborationStatus | inMatchingJobs")
for (const d of s.docs) {
  const j = d.data()
  if (!/photon/i.test(d.id) && !/photon/i.test(String(j.companyName ?? j.company ?? ""))) continue
  const mj = await db.collection("matching-jobs").doc(d.id).get()
  console.log(`${d.id}\n   publicVisible=${j.publicVisible} dead=${j.dead} collab=${j.wekruitCollaborationStatus} inMatchingJobs=${mj.exists}`)
}
console.log("\n--- ALL eligible partner roles (what the tool would show) ---")
let n=0
for (const d of s.docs) {
  const j = d.data()
  if (j.publicVisible===true && j.dead!==true && j.wekruitCollaborationStatus==="collaborated") { console.log(`  ${j.companyName ?? j.company} — ${j.title ?? j.jobTitle}`); n++ }
}
console.log(`  total eligible: ${n} of ${s.size} pa-jobs`)
process.exit(0)
