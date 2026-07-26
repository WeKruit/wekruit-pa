import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const o = await db.collection("pa-outbound").where("createdAt",">=",new Date(Date.now()-3*3600*1000).toISOString()).get()
const rec = o.docs.map(d=>d.data()).filter(x=>String(x.idempotencyKey??"").startsWith("yc-recover-"))
const users = new Set(rec.map(x=>x.userId))
rec.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
console.log(`yc-recover rows total: ${rec.length} across ${users.size} users`)
console.log(`first: ${String(rec[0]?.createdAt).slice(11,19)}   LAST: ${String(rec.at(-1)?.createdAt).slice(11,19)}`)
console.log(`now:   ${new Date().toISOString().slice(11,19)}`)
const secsSinceLast = (Date.now() - Date.parse(String(rec.at(-1)?.createdAt)))/1000
console.log(`seconds since last recover row: ${secsSinceLast.toFixed(0)}  → ${secsSinceLast > 60 ? "STOPPED" : "STILL RUNNING"}`)
process.exit(0)
