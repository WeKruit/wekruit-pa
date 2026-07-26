import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const s = await db.collection("pa-recruiter-submissions").where("jobId","==","photon-backend-engineer-high-concurrency").get()
console.log(`photon backend submissions: ${s.size}`)
let evald=0
for (const d of s.docs) {
  const x = d.data()
  if (x.aiEvaluation) evald++
}
console.log(`with aiEvaluation: ${evald}`)
for (const d of s.docs.slice(0,3)) {
  const x = d.data(); const e = x.aiEvaluation
  console.log(`\n--- ${x.candidate?.name} (${x.candidate?.currentRole} @ ${x.candidate?.currentCompany}) status=${x.status}`)
  console.log(`    score hard=${x.score?.hardChecked}/${x.score?.hardTotal} fit=${x.score?.fitChecked}/${x.score?.fitTotal} anti=${x.score?.antiChecked}/${x.score?.antiTotal}`)
  if (!e) { console.log("    aiEvaluation: PENDING"); continue }
  console.log(`    verdict=${e.verdict} conf=${e.confidence} model=${e.model} identityConflict=${e.identityConflict ?? false}`)
  console.log(`    summary: ${String(e.summary).slice(0,260)}`)
  console.log(`    research: ${e.research ? `${e.research.subjectName ?? "?"} | ${String(e.research.headline).slice(0,90)}` : "NONE"}`)
  console.log(`    reasons: ${(e.reasons??[]).slice(0,3).join(" | ").slice(0,300)}`)
  if (e.error) console.log(`    ERROR: ${e.error}`)
}
process.exit(0)
