import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-60*60*1000).toISOString()
const o = await db.collection("pa-outbound").where("createdAt",">=",since).get()
const rows = o.docs.map(d=>({id:d.id,...d.data()}))
// split lag by paced/seq to test the SEQ order gate hypothesis
const buck = { "paced seq>0":[], "paced seq0":[], "unpaced":[] }
for (const r of rows) {
  const c=Date.parse(r.createdAt??""), s=Date.parse(r.sendblueDeliveredAt??r.sentAt??r.updatedAt??"")
  if(!Number.isFinite(c)||!Number.isFinite(s)||s<c) continue
  const k = r.paced===true ? (Number(r.seq)>0 ? "paced seq>0":"paced seq0") : "unpaced"
  buck[k].push((s-c)/1000)
}
for (const [k,v] of Object.entries(buck)) {
  v.sort((a,b)=>a-b)
  const p=(q)=>v[Math.floor(v.length*q)]?.toFixed(1)
  console.log(`${k.padEnd(12)} n=${String(v.length).padStart(4)} p50=${p(.5)}s p90=${p(.9)}s p99=${p(.99)}s max=${v[v.length-1]?.toFixed(1)}s`)
}
// retry / attempt counts
const withAttempts = rows.filter(r=>Number(r.attempts??r.attemptCount??0)>1)
console.log(`\nrows with >1 attempt: ${withAttempts.length}`)
const slow = rows.filter(r=>{const c=Date.parse(r.createdAt??""),s=Date.parse(r.sendblueDeliveredAt??r.sentAt??r.updatedAt??"");return Number.isFinite(c)&&Number.isFinite(s)&&(s-c)>120000}).slice(0,6)
console.log(`\nSLOWEST sample (full field dump):`)
for (const r of slow.slice(0,3)) console.log(JSON.stringify({id:r.id,createdAt:r.createdAt,updatedAt:r.updatedAt,status:r.status,paced:r.paced,seq:r.seq,attempts:r.attempts,claimedAt:r.claimedAt,sendingAt:r.sendingAt,capacityDeferred:r.capacityDeferred,typingAt:r.typingAt},null,0))
process.exit(0)
