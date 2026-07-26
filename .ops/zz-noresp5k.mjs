/** READ-ONLY: DEFINITIVE lost-reply census — every turn with a real finalText that has NO pa-outbound row carrying it. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const TS=(v)=>{if(!v)return 0;if(typeof v==="string")return Date.parse(v);if(v.toDate)return v.toDate().getTime();if(v._seconds)return v._seconds*1000;return 0}
const N=(v)=>String(v??"").replace(/\s+/g," ").trim()
const ob=(await db.collection("pa-outbound").where("createdAt",">=","2026-07-24T00:00:00.000Z").get()).docs.map(d=>d.data())
const byUser=new Map(); for(const o of ob){if(!byUser.has(o.userId))byUser.set(o.userId,[]);byUser.get(o.userId).push(N(o.body))}
const turns=(await db.collection("pa-turns").where("createdAt",">=","2026-07-25T00:00:00.000Z").get()).docs.map(d=>d.data())
const withText=turns.filter(t=>N(t.finalText).length>=20)
const lost=withText.filter(t=>{const h=N(t.finalText).slice(0,30);return !(byUser.get(t.userId)??[]).some(b=>b.startsWith(h)||N(t.finalText).startsWith(b.slice(0,30)))})
console.log(`turns 07-25+: ${turns.length} | with real finalText(>=20ch): ${withText.length} | LOST (no outbound carries it): ${lost.length}`)
const cls={}
for(const t of lost){const names=JSON.stringify((t.toolCalls??[]).map(x=>x.name))
  const k=t.deliveredViaTool===true&&names.includes("react_to_user")?"TAPBACK-SWALLOW (reaction ate the reply)":t.deliveredViaTool===true?"deliveredViaTool (no_reply/blocked)":t.suppressed===true?"dedup suppressed":"other"
  ;(cls[k]??=[]).push(t)}
for(const [k,v] of Object.entries(cls).sort((a,b)=>b[1].length-a[1].length)){
  const s=v.sort((a,b)=>TS(a.createdAt)-TS(b.createdAt))
  console.log(`\n## ${k}: ${v.length}  (first ${String(s[0].createdAt).slice(11,19)}  LAST ${String(s.at(-1).createdAt).slice(5,19)})`)
  for(const t of s.slice(-6)) console.log(`   ${String(t.createdAt).slice(11,19)} u=${String(t.userId).slice(0,12)} in="${N(t.inboundText).slice(0,40)}" LOST="${N(t.finalText).slice(0,60)}"`)
}
process.exit(0)
