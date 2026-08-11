import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = process.argv[2]
const snap = await db.collection("pa-outbound").where("userId","==",uid).get()
const rows = snap.docs.map(d=>d.data()).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
for (const r of rows) {
  const t = String(r.body ?? r.text ?? "").replace(/\n/g," | ").slice(0,150)
  console.log(`${String(r.createdAt).slice(11,19)}  ${t}`)
}
process.exit(0)
