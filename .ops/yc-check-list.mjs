import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
for (const phone of process.argv.slice(2)) {
  const r = await db.collection("pa-users").where("phoneE164","==",phone).get()
  if (r.empty) { console.log(`${phone}  NO USER`); continue }
  const uid = r.docs[0].id
  const m = await db.collection("pa-messages").where("userId","==",uid).get()
  const list = m.docs.map(d=>d.data()).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  const last = list[list.length-1]
  const lastUser = [...list].reverse().find(x=>(x.direction??x.role)==="user")
  const o = await db.collection("pa-outbound").where("userId","==",uid).get()
  const lastOut = o.docs.map(d=>d.data()).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).pop()
  const answered = lastOut && Date.parse(String(lastOut.createdAt)) > Date.parse(String(lastUser?.createdAt??0)) - 90000
  console.log(`${phone}  ${answered?"ANSWERED":"** UNANSWERED **"}`)
  console.log(`   their last : ${String(lastUser?.createdAt).slice(11,19)} "${String(lastUser?.text??lastUser?.body??"").replace(/\n/g," ").slice(0,50)}"`)
  console.log(`   our last   : ${String(lastOut?.createdAt).slice(11,19)} [${lastOut?.status}] "${String(lastOut?.body??"").replace(/\n/g," ").slice(0,50)}"`)
}
process.exit(0)
