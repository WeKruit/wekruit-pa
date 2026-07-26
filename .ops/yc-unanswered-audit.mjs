import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now() - 8*3600*1000).toISOString()
const m = await db.collection("pa-messages").where("createdAt",">=",since).get()
const byUser = new Map()
for (const d of m.docs) { const x=d.data(); if(!byUser.has(x.userId)) byUser.set(x.userId,[]); byUser.get(x.userId).push(x) }
const out = []
for (const [uid,list] of byUser) {
  list.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  const last = list[list.length-1]
  if ((last.direction ?? last.role) !== "user") continue
  // A reply row created AFTER their message = answered (tolerate the 90s write-order inversion).
  const o = await db.collection("pa-outbound").where("userId","==",uid).get()
  const replied = o.docs.some(x => String(x.data().createdAt ?? "") > String(last.createdAt))
  if (replied) continue
  const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
  out.push({ uid, phone: u.phoneE164, at: String(last.createdAt), text: String(last.text??last.body??"").replace(/\n/g," ").slice(0,64), paused: u.doNotContact === true })
}
out.sort((a,b)=>a.at.localeCompare(b.at))
console.log(`UNANSWERED (last 8h): ${out.length}`)
for (const s of out) console.log(`  ${s.at.slice(11,19)} ${s.phone} ${s.paused?"[paused]":"        "} "${s.text}"`)
process.exit(0)
