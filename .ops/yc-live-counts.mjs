import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const since=new Date(Date.now()-24*3600*1000).toISOString()
const u = await db.collection("pa-users").where("source","==","yc_startup_school").get()
const perLine={}; let today=0
for (const d of u.docs){ const x=d.data(); if(String(x.createdAt??"")<since) continue; today++
  const n=x.senderNumber ?? "(none)"; perLine[n]=(perLine[n]||0)+1 }
console.log(`YC 用户总数 ${u.size} | 最近24h新增 ${today}`)
console.log(`按号码分（24h新增）:`)
Object.entries(perLine).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k}  ${v} / 1000`))
const daily = await db.collection("pa-sendblue-daily-new-users").doc(new Date().toISOString().slice(0,10)).get()
console.log(`\n日计数器 doc(${new Date().toISOString().slice(0,10)}): ${daily.exists ? JSON.stringify(daily.data()) : "(还没写入 — 需要 deploy)"}`)
process.exit(0)
