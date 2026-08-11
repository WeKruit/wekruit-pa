import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now() - 60*60*1000).toISOString()
const m = await db.collection("pa-messages").where("createdAt",">=",since).get()
const byUser = new Map()
for (const d of m.docs) { const x=d.data(); if(!byUser.has(x.userId)) byUser.set(x.userId,[]); byUser.get(x.userId).push(x) }
const silent = []
for (const [uid,list] of byUser) {
  list.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  const last = list[list.length-1]
  if ((last.direction ?? last.role) === "user") {
    const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
    silent.push({ uid, phone: u.phoneE164, at: String(last.createdAt).slice(11,19), text: String(last.text??last.body??"").slice(0,50), turns: list.length })
  }
}
silent.sort((a,b)=>a.at.localeCompare(b.at))
console.log(`users active last 60min: ${byUser.size} | LAST MESSAGE IS THEIRS: ${silent.length}`)
for (const s of silent) console.log(`  ${s.at}  ${s.phone}  msgs=${s.turns}  "${s.text}"`)
process.exit(0)
