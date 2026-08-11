import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const s = await db.collection("pa-external-candidate-records").where("enrichment.cohort","==","yc_startup_school_2026").get()
const counts={}; let has=0, tot=0
for (const d of s.docs){ const u=d.data(); if(u.coresignalMatch!=="ok") continue; tot++
  const pt=u.businessDescriptor?.personType
  if(Array.isArray(pt)&&pt.length){ has++; pt.forEach(x=>counts[x]=(counts[x]||0)+1) } }
console.log(`有 personType 的记录: ${has}/${tot}`)
Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${String(v).padStart(4)}  ${k}`))
process.exit(0)
