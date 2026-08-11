import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-8*3600*1000).toISOString()
const o = await db.collection("pa-outbound").where("createdAt",">=",since).get()
const emails = new Map()
for (const d of o.docs) { const x=d.data(); if (x.status==="failed" && String(x.toE164??"").includes("@")) emails.set(x.toE164, x.userId) }
console.log(`邮箱发信、我们回不了的人: ${emails.size}\n`)
for (const [email, uid] of emails) {
  const m = await db.collection("pa-messages").where("userId","==",uid).get().catch(()=>({docs:[]}))
  const inbound = m.docs.map(d=>d.data()).filter(x=>x.direction==="inbound"||x.role==="user")
    .sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
  const first = String(inbound[0]?.text ?? inbound[0]?.body ?? "")
  console.log(`  ${email}`)
  console.log(`      uid=${uid}  他们发的: "${first.replace(/\n/g," ").slice(0,100)}"`)
}
process.exit(0)
