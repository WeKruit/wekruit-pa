import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = "2026-07-24T00:00:00.000Z"
const t = await db.collection("pa-turns").where("createdAt",">=",since).get()
const byUser = new Map()
for (const d of t.docs) { const x = d.data(); if (!byUser.has(x.userId)) byUser.set(x.userId, []); byUser.get(x.userId).push(x) }
const KICK = "hey!! welcome 🎉 i'm claire"
let victims = 0, dupTurns = 0
const rows = []
for (const [uid, list] of byUser) {
  list.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  const kicks = list.filter(x => String(x.finalText ?? "").startsWith(KICK))
  if (kicks.length > 1) {
    victims++; dupTurns += kicks.length - 1
    // the swallowed messages = the inbound of every kickoff turn after the first
    rows.push({ uid, n: kicks.length, swallowed: kicks.slice(1).map(k => String(k.inboundText ?? "").replace(/\n/g," ").slice(0,70)) })
  }
}
console.log(`turns since ${since}: ${t.size} | users: ${byUser.size}`)
console.log(`USERS WITH REPEAT KICKOFF: ${victims} | swallowed messages: ${dupTurns}`)
for (const r of rows.slice(0,25)) { console.log(`  ${r.uid} x${r.n}`); for (const s of r.swallowed) console.log(`      swallowed: ${JSON.stringify(s)}`) }
process.exit(0)
