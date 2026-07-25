import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const r = await db.collection("pa-users").where("phoneE164","==",process.argv[2]).get()
for (const d of r.docs) {
  const m = await db.collection("pa-messages").where("userId","==",d.id).get()
  const list = m.docs.map(x=>x.data()).sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
  for (const x of list.slice(-8)) console.log(`${String(x.createdAt).slice(5,19)} [${x.role ?? x.direction}] ${String(x.text ?? x.body ?? "").replace(/\n/g," ").slice(0,110)}`)
  const o = await db.collection("pa-outbound").where("userId","==",d.id).get()
  const ol = o.docs.map(x=>x.data()).sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
  console.log("--- outbound ---")
  for (const x of ol.slice(-5)) console.log(`${String(x.createdAt).slice(5,19)} ${x.status} err=${String(x.error??"-").slice(0,60)} "${String(x.body??"").slice(0,60)}"`)
}
process.exit(0)
