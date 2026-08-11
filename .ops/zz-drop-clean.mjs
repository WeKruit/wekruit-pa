import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-26*3600*1000).toISOString()
const users = await db.collection("pa-users").where("createdAt",">=",new Date(Date.now()-30*3600*1000).toISOString()).get()
const uidByPhone=new Map(); for(const d of users.docs){const p=d.data().phoneE164; if(p)uidByPhone.set(String(p),d.id)}
const msgs = await db.collection("pa-messages").where("createdAt",">=",since).get()
const seen=new Set()
for (const d of msgs.docs){const x=d.data(); if((x.direction??x.role)!=="user")continue
  seen.add(`${x.userId}|${String(x.text??x.body??"").trim().slice(0,60)}`)}
const snap = await db.collection("pa-sendblue-webhook-raw").where("receivedAt",">=",since).get()
// iMessage tapbacks arrive as inbound webhooks with the quoted text; they are NOT messages.
// STOP is handled deterministically upstream and correctly never becomes a turn.
const TAPBACK=/^(Loved|Liked|Laughed at|Emphasized|Disliked|Questioned)\s+[“"]/
const dropped=[]
for (const d of snap.docs){
  const x=d.data(); let b={}; try{b=JSON.parse(x.bodyText??"{}")}catch{}
  if (b.is_outbound===true) continue
  const c=String(b.content??"").trim(); if(!c) continue
  if (TAPBACK.test(c)) continue
  if (/^stop$/i.test(c)) continue
  const uid=uidByPhone.get(String(b.from_number??"")); if(!uid) continue
  if (seen.has(`${uid}|${c.slice(0,60)}`)) continue
  dropped.push({t:String(x.receivedAt),from:String(b.from_number),c:c.replace(/\n/g," ").slice(0,64)})
}
dropped.sort((a,b)=>a.t.localeCompare(b.t))
console.log(`GENUINELY DROPPED user messages (not tapbacks, not STOP): ${dropped.length}`)
const byPhone=new Map(); for(const x of dropped) byPhone.set(x.from,(byPhone.get(x.from)??0)+1)
console.log(`distinct users affected: ${byPhone.size}`)
for (const x of dropped) console.log(`  ${x.t.slice(11,19)} ${x.from.padEnd(15)} "${x.c}"`)
process.exit(0)
