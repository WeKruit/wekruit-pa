import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const s = await db.collection("pa-recruiter-submissions").where("jobId","==","photon-backend-engineer-high-concurrency").get()
for (const want of process.argv.slice(2)) {
  const d = s.docs.find(x=>String(x.data().candidate?.name??"").toLowerCase().includes(want.toLowerCase()))
  if (!d) { console.log(`${want}: NOT FOUND`); continue }
  const x=d.data(), e=x.aiEvaluation
  console.log(`\n=== ${x.candidate.name} — ${e.verdict} ${e.confidence} | hard ${e.checklist.hard.met}/${e.checklist.hard.total} fit ${e.checklist.fit.met}/${e.checklist.fit.total}`)
  console.log(`gaps hard: ${e.checklist.hard.gaps.join(" ; ").slice(0,400)}`)
  console.log(`reasons: ${(e.reasons??[]).join("\n  ").slice(0,900)}`)
  console.log(`notesLen=${String(x.candidate.notes??"").length} evaluatedAt=${e.evaluatedAt}`)
}
process.exit(0)
