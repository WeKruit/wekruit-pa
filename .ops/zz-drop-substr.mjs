/** Before calling these "dropped": the coalescer merges a burst into ONE turn, so an individual
 *  message may live INSIDE a combined pa-messages row. Exact-match would miss that. Test substring. */
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
const userText=new Map()
for (const d of msgs.docs){const x=d.data(); if((x.direction??x.role)!=="user")continue
  const k=String(x.userId); if(!userText.has(k))userText.set(k,[]); userText.get(k).push(String(x.text??x.body??""))}
const turns = await db.collection("pa-turns").where("createdAt",">=",since).get()
const turnText=new Map()
for (const d of turns.docs){const t=d.data(); const k=String(t.userId); if(!turnText.has(k))turnText.set(k,[]); turnText.get(k).push(String(t.inboundText??""))}

const snap = await db.collection("pa-sendblue-webhook-raw").where("receivedAt",">=",since).get()
const TAPBACK=/^(Loved|Liked|Laughed at|Emphasized|Disliked|Questioned)\s+[“"]/
let real=0, inMsg=0, inTurn=0
const gone=[]
for (const d of snap.docs){
  const x=d.data(); let b={}; try{b=JSON.parse(x.bodyText??"{}")}catch{}
  if (b.is_outbound===true) continue
  const c=String(b.content??"").trim(); if(!c||TAPBACK.test(c)||/^stop$/i.test(c)) continue
  const uid=uidByPhone.get(String(b.from_number??"")); if(!uid) continue
  real++
  const mt=(userText.get(uid)??[]).some(s=>s.includes(c))
  if (mt){inMsg++;continue}
  const tt=(turnText.get(uid)??[]).some(s=>s.includes(c))
  if (tt){inTurn++;continue}
  gone.push({t:String(x.receivedAt),from:String(b.from_number),c:c.replace(/\n/g," ").slice(0,60)})
}
console.log(`real inbound user messages (26h)     : ${real}`)
console.log(`  present in a pa-messages row       : ${inMsg}`)
console.log(`  only inside a pa-turns inboundText : ${inTurn}`)
console.log(`  NOWHERE — truly never processed    : ${gone.length}`)
gone.sort((a,b)=>a.t.localeCompare(b.t))
for (const g of gone) console.log(`  ${g.t.slice(11,19)} ${g.from.padEnd(15)} "${g.c}"`)
process.exit(0)
