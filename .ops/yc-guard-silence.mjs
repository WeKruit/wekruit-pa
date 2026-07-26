import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const turns = await db.collection("pa-turns").where("createdAt",">=","2026-07-25T00:00:00Z").get()
// index outbound by user
const ob = await db.collection("pa-outbound").where("createdAt",">=","2026-07-25T00:00:00Z").get()
const byUser = new Map()
for (const d of ob.docs) { const x=d.data(); if(!byUser.has(x.userId)) byUser.set(x.userId,[]); byUser.get(x.userId).push(x) }
const dead=[]
for (const t of turns.docs) {
  const d = t.data()
  const names = (d.toolCalls??[]).map(c=>c.name)
  if (!names.includes("match_yc_people")) continue
  const t0 = new Date(d.createdAt).getTime()
  const rows = (byUser.get(d.userId)??[]).filter(r=>{ const ms=new Date(r.createdAt).getTime(); return ms>=t0-90000 && ms<=t0+120000 })
  const hadText = String(d.finalText??"").trim().length>0
  if (rows.length === 0 && !hadText) dead.push({at:d.createdAt, uid:d.userId, inb:String(d.inboundText??"").slice(0,70), tools:names.join(",")})
}
dead.sort((a,b)=>a.at.localeCompare(b.at))
console.log(`\n===== match_yc_people turns with ZERO outbound AND zero final text (${dead.length}) =====`)
for (const x of dead) console.log(` ${x.at.slice(11,19)} ${x.uid} in="${x.inb}" tools=[${x.tools}]`)
process.exit(0)
