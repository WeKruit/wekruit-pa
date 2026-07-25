// Replays the internal-narration scrub over every message actually DELIVERED to a YC
// attendee today, to verify it catches the real leaks and eats none of the honest copy.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { scrubYcInternalNarration } from "../apps/functions/src/claire-agent/yc-people-guard.js"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)![1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-20*3600*1000).toISOString()
const us = await db.collection("pa-users").where("source","==","yc_startup_school").get()
const U = new Set(us.docs.filter(d=>String(d.data().createdAt??"")>since).map(d=>d.id))
let cur = since; const bodies: {b:string,uid:string,t:string}[] = []
for(;;){ const s = await db.collection("pa-outbound").where("createdAt",">=",cur).orderBy("createdAt").limit(5000).get()
  if(s.empty)break
  for(const d of s.docs){const x=d.data() as any
    if(!U.has(x.userId))continue
    if(x.status!=="sent"&&x.status!=="delivered")continue
    bodies.push({b:String(x.body??""),uid:String(x.userId),t:String(x.createdAt)})}
  if(s.size<5000)break; cur=String(s.docs.at(-1)!.data().createdAt)}
console.log(`delivered YC messages replayed: ${bodies.length}`)
const changed = bodies.filter(x => scrubYcInternalNarration([x.b]).scrubbed > 0)
console.log(`WOULD HAVE BEEN SCRUBBED: ${changed.length} (${(changed.length/bodies.length*100).toFixed(2)}%) across ${new Set(changed.map(c=>c.uid)).size} threads\n`)
for (const c of changed) {
  const after = scrubYcInternalNarration([c.b]).bubbles[0]!
  console.log(`--- ${c.t.slice(11,19)} ${c.uid.slice(0,8)}`)
  console.log(`  BEFORE: ${c.b.replace(/\n/g," ").slice(0,180)}`)
  console.log(`  AFTER : ${after.replace(/\n/g," ").slice(0,180)}`)
}
process.exit(0)
