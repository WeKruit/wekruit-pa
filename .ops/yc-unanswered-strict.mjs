/** Honest unanswered: needs an outbound that (a) actually DELIVERED and (b) was created after
 *  their message, allowing only the small write-order inversion. Reports several tolerances so
 *  the number is not an artifact of one arbitrary constant. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const now = Date.now()
const since = new Date(now - 8*3600*1000).toISOString()
const m = await db.collection("pa-messages").where("createdAt",">=",since).get()
const byUser = new Map()
for (const d of m.docs) { const x=d.data(); if(!byUser.has(x.userId)) byUser.set(x.userId,[]); byUser.get(x.userId).push(x) }
const cache = new Map()
async function outs(uid){ if(!cache.has(uid)){ const o=await db.collection("pa-outbound").where("userId","==",uid).get()
  cache.set(uid, o.docs.map(d=>d.data()).filter(x=>x.status==="sent"||x.status==="delivered")) } return cache.get(uid) }
for (const tol of [2000, 5000, 90000]) {
  let bad = 0
  for (const [uid,list] of byUser) {
    list.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
    const last=list[list.length-1]
    if ((last.direction??last.role)!=="user") continue
    const ms=Date.parse(String(last.createdAt))
    if (now-ms < 120000) continue
    const replied=(await outs(uid)).some(x=>Date.parse(String(x.createdAt??""))>ms-tol)
    if(!replied) bad++
  }
  console.log(`tolerance ${String(tol/1000).padStart(2)}s (delivered-only) → UNANSWERED: ${bad}`)
}
// detail at the honest 2s
const rows=[]
for (const [uid,list] of byUser) {
  list.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  const last=list[list.length-1]
  if ((last.direction??last.role)!=="user") continue
  const ms=Date.parse(String(last.createdAt))
  if (now-ms < 120000) continue
  if ((await outs(uid)).some(x=>Date.parse(String(x.createdAt??""))>ms-2000)) continue
  const u=(await db.collection("pa-users").doc(uid).get()).data()??{}
  rows.push({phone:u.phoneE164, mins:Math.round((now-ms)/60000), t:String(last.text??last.body??"").replace(/\n/g," ").slice(0,46)})
}
rows.sort((a,b)=>a.mins-b.mins)
console.log(`\n--- detail (2s, delivered-only): ${rows.length} ---`)
for (const r of rows.slice(0,30)) console.log(`  ${String(r.mins).padStart(3)}min  ${r.phone}  "${r.t}"`)
process.exit(0)
