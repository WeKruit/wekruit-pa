/** Rank by the AI's OWN verified checklist tallies (its independent read of the profile), not by
 *  `confidence` — confidence clusters at ~0.46 because my submitted checklist is deliberately
 *  near-blank, so it measures "how much did the recruiter claim", not "how good is this person". */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const s = await db.collection("pa-recruiter-submissions").where("jobId","==","photon-backend-engineer-high-concurrency").get()
const rows = s.docs.map(d=>d.data()).filter(r=>r.aiEvaluation)
const K = (r)=>{const c=r.aiEvaluation.checklist??{};return{h:c.hard?.met??0,ht:c.hard?.total??0,f:c.fit?.met??0,ft:c.fit?.total??0,a:c.anti?.flagged??0}}
const dist = new Map()
for (const r of rows){const k=K(r);dist.set(`hard ${k.h}/${k.ht}`,(dist.get(`hard ${k.h}/${k.ht}`)??0)+1)}
console.log("AI-verified HARD tally distribution:")
for (const [k,v] of [...dist].sort()) console.log(`   ${k}  ->  ${v}`)
const scored = rows.map(r=>({r,k:K(r),s:K(r).h*10+K(r).f*3-K(r).a*4})).sort((a,b)=>b.s-a.s)
console.log(`\n════ TOP 20 by AI-verified evidence ════`)
for (const {r,k} of scored.slice(0,20)) {
  const c=r.candidate,e=r.aiEvaluation
  console.log(`\n  hard ${k.h}/${k.ht} · fit ${k.f}/${k.ft} · anti ${k.a}  [${e.verdict} ${e.confidence}]  ${c.name}`)
  console.log(`     ${c.currentRole} @ ${c.currentCompany} · ${c.yoe}y · ${c.linkedinUrl}`)
  console.log(`     ${String(e.summary).replace(/\n/g," ").slice(0,200)}`)
}
process.exit(0)
