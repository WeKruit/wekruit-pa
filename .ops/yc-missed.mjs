import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const OLD = /^(?:hey|hi|hello)?[!,.\s]*i['’]?m at yc startup school[\s,!.…—–-]*(?:this is\s+(?:my\s+)?code(?:\s+is)?|my\s+code\s+is|code(?:\s+is)?)?\s*:?\s*([a-z0-9][a-z0-9_-]{7,127})?\s*$/i
const NEW = /i(?:['’]?m| am) at yc startup school[\s,!.…—–-]*(?:this is\s+(?:my\s+)?code(?:\s+is)?|my\s+code\s+is|code(?:\s+is)?)?\s*:?\s*([a-z0-9][a-z0-9_-]{7,127})?\s*$/i
const since = new Date(Date.now()-12*3600*1000).toISOString()
const m = await db.collection("pa-messages").where("createdAt",">=",since).get()
const victims=[]
for (const d of m.docs) {
  const x=d.data(); if (x.role!=="user" && x.direction!=="inbound") continue
  const t=String(x.text ?? x.body ?? "")
  if (!/yc startup school/i.test(t)) continue
  if (OLD.test(t.trim())) continue
  if (!NEW.test(t.trim())) { victims.push({uid:x.userId, t, why:"NEITHER"}); continue }
  victims.push({uid:x.userId, t, why:"OLD-MISSED"})
}
console.log(`提到 YC Startup School 但旧正则没认出来的: ${victims.length}\n`)
for (const v of victims) {
  const u = await db.collection("pa-users").doc(String(v.uid)).get().catch(()=>null)
  const src = u?.data()?.source ?? "?"
  console.log(`  [${v.why}] uid=${String(v.uid).slice(0,8)} source=${src}\n      "${v.t.replace(/\n/g," ").slice(0,95)}"`)
}
process.exit(0)
