import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const since = new Date(Date.now()-6*3600*1000).toISOString()
const o = await db.collection("pa-outbound").where("createdAt",">=",since).get()
let uid=null
for (const d of o.docs){ const x=d.data(); if (String(x.body??"").startsWith("Matthew Kim — Incoming Business Analyst")) { uid=x.userId; break } }
if(!uid){ console.log("not found"); process.exit(0) }
const u=(await db.collection("pa-users").doc(uid).get()).data()
console.log(`uid=${uid} phone=${u.phoneE164}`)
console.log(`  ycIntake=${JSON.stringify(u.ycIntake ?? null)}`)
console.log(`  已推人数=${(u.ycPeopleMatchSent??[]).length}`)
console.log(`  highlights=${(u.experienceHighlights??[]).length} title=${u.recentRoleTitle ?? "-"} company=${u.recentCompany ?? "-"}`)
const m = await db.collection("pa-messages").where("userId","==",uid).get()
const list=m.docs.map(x=>x.data()).sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
console.log("--- 对话 ---")
for (const x of list.slice(-14)) console.log(`${String(x.createdAt).slice(11,19)} [${x.role??x.direction}] ${String(x.text??x.body??"").replace(/\n/g," ").slice(0,95)}`)
process.exit(0)
