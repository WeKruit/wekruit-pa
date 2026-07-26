// READ-ONLY. For the worst-burst users: how does a 5-min burst decompose into tool calls?
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({credential:admin.credential.cert(JSON.parse(raw)),projectId:"wekruit-5f89b"})
const db=admin.firestore()
for(const uid of ["34d50a74-5b47-4127-a1a8-24bb17eeec73","6084e3ad-812d-40df-9788-b9afc9d0ccdb"]){
  const outs=await db.collection("pa-outbound").where("userId","==",uid).get()
  const rows=outs.docs.map(d=>d.data()).filter(o=>/linkedin\.com\/in\//.test(String(o.body??"")))
    .map(o=>({t:Date.parse(o.createdAt),seq:o.seq,k:String(o.idempotencyKey??"").split(":")[0]}))
    .sort((a,b)=>a.t-b.t)
  const byKey=new Map()
  for(const r of rows) byKey.set(r.k,(byKey.get(r.k)??0)+1)
  console.log(`\nuid=${uid} personBubbles=${rows.length} distinctDeliveryKeys=${byKey.size}`)
  for(const [k,n] of byKey) console.log(`   ${k}  → ${n} person bubbles`)
  const turns=await db.collection("pa-turns").where("userId","==",uid).get()
  for(const d of turns.docs){
    const t=d.data()
    const cs=(Array.isArray(t.toolCalls)?t.toolCalls:[]).filter(c=>String(c.name??"").includes("yc_people"))
    for(const c of cs){let a={};try{a=JSON.parse(c.arguments??"{}")}catch{}
      console.log(`   turn ${String(t.createdAt).slice(5,19)} limit=${a.limit} personType=${JSON.stringify(a.personType)} q="${String(a.query??"").slice(0,50)}"`)}
  }
}
process.exit(0)
