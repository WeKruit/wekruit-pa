import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const s = await db.collection("pa-recruiter-submissions").where("jobId","==","photon-backend-engineer-high-concurrency").get()
const rows = s.docs.map(d=>({id:d.id,...d.data()}))
const V = new Map()
let ident=0, errs=0, noResearch=0
for (const r of rows) {
  const e=r.aiEvaluation ?? {}
  V.set(e.verdict??"none",(V.get(e.verdict??"none")??0)+1)
  if (e.identityConflict) ident++
  if (e.error) errs++
  if (!e.research) noResearch++
}
console.log(`total submissions: ${rows.length}`)
console.log("verdicts:", [...V].map(([k,v])=>`${k}=${v}`).join("  "))
console.log(`identityConflict=${ident}  evalError=${errs}  noCoresignalResearch=${noResearch}`)

const adv = rows.filter(r=>r.aiEvaluation?.verdict==="advance").sort((a,b)=>(b.aiEvaluation.confidence)-(a.aiEvaluation.confidence))
console.log(`\n════ ADVANCE (${adv.length}) ════`)
for (const r of adv) {
  const e=r.aiEvaluation, c=r.candidate
  console.log(`\n  conf ${e.confidence}  ${c.name}  —  ${c.currentRole} @ ${c.currentCompany}  (${c.yoe}y)`)
  console.log(`     ${c.linkedinUrl}`)
  console.log(`     ${String(e.summary).replace(/\n/g," ").slice(0,240)}`)
}
const bl = rows.filter(r=>r.aiEvaluation?.verdict==="borderline").sort((a,b)=>(b.aiEvaluation.confidence)-(a.aiEvaluation.confidence))
console.log(`\n════ BORDERLINE top 10 of ${bl.length} ════`)
for (const r of bl.slice(0,10)) {
  const e=r.aiEvaluation, c=r.candidate
  console.log(`  conf ${e.confidence}  ${c.name} — ${c.currentRole} @ ${c.currentCompany} (${c.yoe}y)  ${c.linkedinUrl}`)
}
process.exit(0)
