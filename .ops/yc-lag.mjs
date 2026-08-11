import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now() - 90*60*1000).toISOString()
const o = await db.collection("pa-outbound").where("createdAt",">=",since).get()
const rows = o.docs.map(d=>d.data())
const byStatus = {}
for (const r of rows) byStatus[r.status] = (byStatus[r.status]??0)+1
console.log("outbound last 90min:", rows.length, byStatus)
const lags = []
for (const r of rows) {
  const c = Date.parse(r.createdAt ?? ""), s = Date.parse(r.sendblueDeliveredAt ?? r.sentAt ?? r.updatedAt ?? "")
  if (Number.isFinite(c) && Number.isFinite(s) && s >= c) lags.push({ s: (s-c)/1000, at: String(r.createdAt).slice(11,19), st: r.status })
}
lags.sort((a,b)=>a.s-b.s)
const p = (q)=>lags[Math.floor(lags.length*q)]?.s?.toFixed(1)
console.log(`lag createdAt→sent (n=${lags.length}): p50=${p(.5)}s p90=${p(.9)}s p99=${p(.99)}s max=${lags[lags.length-1]?.s.toFixed(1)}s`)
console.log("\nqueued/pending right now:")
const stuck = rows.filter(r=>!["sent","duplicate_skipped","delivered"].includes(String(r.status)))
for (const r of stuck.slice(0,15)) console.log(`  ${String(r.createdAt).slice(11,19)} ${r.status} err=${String(r.error??r.failureReason??"-").slice(0,50)} "${String(r.body??"").slice(0,50)}"`)
console.log("\nlast 15 min lag detail:")
for (const l of lags.filter(l=>l.at >= new Date(Date.now()-15*60*1000).toISOString().slice(11,19)).slice(-12)) console.log(`  ${l.at} ${l.s.toFixed(1)}s ${l.st}`)
process.exit(0)
