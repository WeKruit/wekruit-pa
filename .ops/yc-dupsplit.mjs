import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const since=new Date(Date.now()-20*3600*1000).toISOString()
const us=await db.collection("pa-users").where("source","==","yc_startup_school").get()
const U=new Map(us.docs.filter(d=>String(d.data().createdAt??"")>since).map(d=>[d.id,d.data()]))
async function bulk(c){const o=new Map();let cur=since
 for(;;){const s=await db.collection(c).where("createdAt",">=",cur).orderBy("createdAt").limit(5000).get()
  if(s.empty)break;for(const d of s.docs){const x=d.data();if(!U.has(x.userId))continue
   if(!o.has(x.userId))o.set(x.userId,[]);o.get(x.userId).push({_id:d.id,...x})}
  if(s.size<5000)break;cur=String(s.docs.at(-1).data().createdAt)}return o}
const OUT=await bulk("pa-outbound")
const norm=s=>String(s??"").toLowerCase().replace(/\s+/g," ").trim()
let fast=0,slow=0; const fastEx=[],bodies={}
for(const [uid,u] of U){
  const del=(OUT.get(uid)??[]).filter(o=>o.status==="sent"||o.status==="delivered").sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  const seen=new Map()
  for(const d of del){const k=norm(d.body);if(!k)continue
    if(seen.has(k)){const dt=(Date.parse(d.createdAt)-Date.parse(seen.get(k).createdAt))/1000
      bodies[k.slice(0,60)]=(bodies[k.slice(0,60)]??0)+1
      if(dt<=30){fast++;if(fastEx.length<8)fastEx.push(`${uid.slice(0,8)} ${u.phoneE164} Δ${dt.toFixed(0)}s "${String(d.body).replace(/\n/g," ").slice(0,80)}"`)}
      else slow++}
    seen.set(k,d)}
}
console.log(`dup delivered <=30s apart (concurrency bug): ${fast}`)
console.log(`dup delivered  >30s apart (repeated frame) : ${slow}`)
console.log("\n--- fast (real) examples ---"); fastEx.forEach(e=>console.log("  "+e))
console.log("\n--- most-duplicated bodies ---")
Object.entries(bodies).sort((a,b)=>b[1]-a[1]).slice(0,8).forEach(([b,n])=>console.log(`  ${n}x "${b}"`))
process.exit(0)
