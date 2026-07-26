import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-8*3600*1000).toISOString()
const w = await db.collection("pa-sendblue-webhook-raw").where("receivedAt",">=",since).get().catch(()=>({docs:[]}))
const seen = new Map()
for (const d of w.docs) {
  const x = d.data(); const p = x.payload ?? x.body ?? x
  const from = String(p.from_number ?? p.fromNumber ?? "")
  if (!from.includes("@")) continue
  const content = String(p.content ?? p.text ?? "")
  if (!seen.has(from)) seen.set(from, { at: String(x.receivedAt ?? "").slice(11,19), content })
}
console.log(`用邮箱发 iMessage 的人（收不到我们任何回复）: ${seen.size}\n`)
for (const [email, v] of seen) console.log(`  ${v.at}  ${email}\n      "${v.content.replace(/\n/g," ").slice(0,90)}"`)
process.exit(0)
