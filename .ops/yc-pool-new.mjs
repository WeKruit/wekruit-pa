import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const s = await db.collection("pa-external-candidate-records").where("enrichment.cohort","==","yc_startup_school_2026").get()
let scanners=0, imported=0
for (const d of s.docs){ const u=d.data(); if (u.enrichment?.origin==="live_scanner"||u.sourceBatchId==="live"||u.paUserId) scanners++; else imported++ }
console.log(`池子总数 ${s.size}  (导入 ${imported} / 现场扫码进来的 ${scanners})`)
const users = await db.collection("pa-users").where("source","==","yc_startup_school").get()
const since=new Date(Date.now()-8*3600*1000).toISOString()
let today=0, enriched=0
for (const d of users.docs){ const u=d.data(); if(String(u.createdAt??"")<since) continue; today++
  if (u.coresignalEmployeeId || (u.experienceHighlights??[]).length) enriched++ }
console.log(`今天扫码 ${today} 人，其中 enrich 成功 ${enriched} 人`)
console.log(`→ 这 ${enriched} 人本该进池子，实际进了 ${scanners} 人`)
process.exit(0)
