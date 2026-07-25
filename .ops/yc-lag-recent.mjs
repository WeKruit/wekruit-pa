import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const mins = Number(process.argv[2] ?? 12)
const since = new Date(Date.now()-mins*60*1000).toISOString()
const o = await db.collection("pa-outbound").where("createdAt",">=",since).get()
const lags=[]
for (const d of o.docs) { const r=d.data(); const c=Date.parse(r.createdAt??""),s=Date.parse(r.sendblueDeliveredAt??r.sentAt??r.updatedAt??""); if(Number.isFinite(c)&&Number.isFinite(s)&&s>=c) lags.push((s-c)/1000) }
lags.sort((a,b)=>a-b)
const p=(q)=>lags[Math.floor(lags.length*q)]?.toFixed(1)
console.log(`last ${mins} min: rows=${o.size} measured=${lags.length}`)
console.log(`  p50=${p(.5)}s p90=${p(.9)}s p99=${p(.99)}s max=${lags[lags.length-1]?.toFixed(1)}s`)
process.exit(0)
