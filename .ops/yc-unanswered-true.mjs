/** TRUE unanswered: no outbound row within 90s BEFORE or any time AFTER their message.
 *  The 90s back-tolerance exists because pa-outbound rows are written before pa-messages rows. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const now = Date.now()
const since = new Date(now - 6*3600*1000).toISOString()
const m = await db.collection("pa-messages").where("createdAt",">=",since).get()
const byUser = new Map()
for (const d of m.docs) { const x=d.data(); if(!byUser.has(x.userId)) byUser.set(x.userId,[]); byUser.get(x.userId).push(x) }
const rows=[]
for (const [uid,list] of byUser) {
  list.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  const last=list[list.length-1]
  if ((last.direction??last.role)!=="user") continue
  const lastMs = Date.parse(String(last.createdAt))
  if (now - lastMs < 120000) continue                     // <2min = still in flight
  const o = await db.collection("pa-outbound").where("userId","==",uid).get()
  const replied = o.docs.some(d=>{ const c=Date.parse(String(d.data().createdAt??"")); return Number.isFinite(c) && c > lastMs - 90000 })
  if (replied) continue
  const u=(await db.collection("pa-users").doc(uid).get()).data()??{}
  rows.push({ phone:u.phoneE164, at:String(last.createdAt), mins:Math.round((now-lastMs)/60000), t:String(last.text??last.body??"").replace(/\n/g," ").slice(0,50) })
}
rows.sort((a,b)=>b.mins-a.mins)
console.log(`TRUE UNANSWERED (last 6h, >2min old): ${rows.length}`)
for (const r of rows) console.log(`  ${String(r.mins).padStart(3)}min ago  ${r.phone}  "${r.t}"`)
process.exit(0)
