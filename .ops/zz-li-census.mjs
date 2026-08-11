/** Definitive census: every inbound today that mentions linkedin, what we did, what they got. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/in\/[^\s<>"')\]]+/i
const since = new Date(Date.now()-30*3600*1000).toISOString()
const users=(await db.collection("pa-users").where("createdAt",">=",new Date(Date.now()-34*3600*1000).toISOString()).get()).docs
const byPhone=new Map(); for(const d of users.docs??users){const x=d.data();if(x.phoneE164)byPhone.set(String(x.phoneE164),{id:d.id,...x})}
const snap = await db.collection("pa-sendblue-webhook-raw").where("receivedAt",">=",since).get()
const rows=[]
for (const d of snap.docs){
  const x=d.data(); let b={}; try{b=JSON.parse(x.bodyText??"{}")}catch{}
  if (b.is_outbound===true) continue
  const c=String(b.content??"").trim(); if(!c) continue
  if (/^(Loved|Liked|Laughed at|Emphasized|Disliked|Questioned)\s+[“"]/.test(c)) continue
  if (!/linked\s?in|\/in\/|lnkd\.in/i.test(c)) continue
  rows.push({t:String(x.receivedAt),from:String(b.from_number),c,media:!!(b.media_url&&String(b.media_url).length>2),url:RE.test(c)})
}
rows.sort((a,b)=>a.t.localeCompare(b.t))
let withMedia=0
console.log("time     phone           media url  enriched pitched   text")
for (const r of rows){
  const u=byPhone.get(r.from)
  const enr = u ? (typeof u.coresignalEmployeeId==="number"||u.experienceHighlights?.length>0) : null
  const pit = u ? Boolean(u.pitchedAt) : null
  if (r.media) withMedia++
  console.log(`${r.t.slice(11,19)} ${r.from.padEnd(15)} ${r.media?"MEDIA":"  -  "} ${r.url?"URL":" - "} ${enr===null?"?":enr?"YES":"NO "}      ${pit===null?"?":pit?"YES":"NO "}     "${r.c.replace(/\n/g," ").slice(0,52)}"`)
}
console.log(`\ntotal linkedin-mentioning inbound: ${rows.length} | arrived WITH media attached: ${withMedia}`)
process.exit(0)
