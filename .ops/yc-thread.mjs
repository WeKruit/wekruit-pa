import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = process.argv[2]
const m = await db.collection("pa-messages").where("userId","==",uid).get()
const list = m.docs.map(d=>d.data()).sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
for (const x of list.slice(-12)) {
  const dir = x.direction ?? x.role ?? "?"
  console.log(`${String(x.createdAt).slice(11,19)} [${dir}] ${String(x.text ?? x.body ?? "").replace(/\n/g," ").slice(0,120)}`)
}
console.log(`--- pa-outbound 最近 ---`)
const o = await db.collection("pa-outbound").where("userId","==",uid).get()
const ol = o.docs.map(d=>d.data()).sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
for (const x of ol.slice(-8)) console.log(`${String(x.createdAt).slice(11,19)} status=${x.status} sent=${String(x.sendblueDeliveredAt??"-").slice(11,19)} "${String(x.body??"").replace(/\n/g," ").slice(0,90)}"`)
process.exit(0)
