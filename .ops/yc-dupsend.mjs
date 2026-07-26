import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-20*3600*1000).toISOString()
const us = await db.collection("pa-users").where("source","==","yc_startup_school").get()
const uidSet = new Map(us.docs.filter(d=>String(d.data().createdAt??"")>since).map(d=>[d.id,d.data()]))
async function bulk(coll){ const out=new Map(); let cursor=since
  for(;;){ const s=await db.collection(coll).where("createdAt",">=",cursor).orderBy("createdAt").limit(5000).get()
    if(s.empty)break; for(const d of s.docs){const x=d.data(); if(!uidSet.has(x.userId))continue
      if(!out.has(x.userId))out.set(x.userId,[]); out.get(x.userId).push({_id:d.id,...x})}
    if(s.size<5000)break; cursor=String(s.docs.at(-1).data().createdAt)} return out }
const MSG=await bulk("pa-messages"), OUT=await bulk("pa-outbound")
const norm=s=>String(s??"").toLowerCase().replace(/\s+/g," ").trim()

let msgDup=0, outDupSent=0, outDupAny=0, threadsOutDup=new Set(), threadsMsgDup=new Set()
const ex=[]
for (const [uid,u] of uidSet){
  const msgs=(MSG.get(uid)??[]).filter(m=>m.role==="assistant").sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  const outs=(OUT.get(uid)??[]).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  const seenM=new Map()
  for(const m of msgs){const k=norm(m.body); if(!k)continue
    if(seenM.has(k)){msgDup++;threadsMsgDup.add(uid)} else seenM.set(k,m)}
  const seenO=new Map()
  for(const o of outs){const k=norm(o.body); if(!k)continue
    if(seenO.has(k)){ const prev=seenO.get(k); outDupAny++
      const bothSent = ["sent","delivered"].includes(String(prev.status)) && ["sent","delivered"].includes(String(o.status))
      if(bothSent){ outDupSent++; threadsOutDup.add(uid)
        if(ex.length<6) ex.push(`uid ${uid} ${u.phoneE164}\n    A ${String(prev.createdAt).slice(11,19)} id=${prev._id.slice(0,22)} idem=${String(prev.idempotencyKey).slice(0,46)} status=${prev.status}\n    B ${String(o.createdAt).slice(11,19)} id=${o._id.slice(0,22)} idem=${String(o.idempotencyKey).slice(0,46)} status=${o.status}\n    body="${String(o.body).replace(/\n/g," ").slice(0,90)}"`) }
    } else seenO.set(k,o)}
}
console.log(`threads scanned: ${uidSet.size}`)
console.log(`pa-messages assistant dup-body: ${msgDup} hits across ${threadsMsgDup.size} threads`)
console.log(`pa-outbound  dup-body (any status): ${outDupAny}`)
console.log(`pa-outbound  dup-body BOTH sent/delivered (user REALLY got it 2x): ${outDupSent} across ${threadsOutDup.size} threads`)
console.log("\n--- examples of genuinely double-SENT ---")
ex.forEach(e=>console.log("  "+e))
// status histogram
const st={}; for(const arr of OUT.values()) for(const o of arr) st[o.status]=(st[o.status]??0)+1
console.log("\noutbound status histogram:", JSON.stringify(st))
process.exit(0)
