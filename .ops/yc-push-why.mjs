import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const r = await db.collection("pa-users").where("phoneE164","==",process.argv[2]).get()
for (const d of r.docs) {
  const m = await db.collection("pa-messages").where("userId","==",d.id).get()
  const list=m.docs.map(x=>x.data()).sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
  let cards=0
  for (const x of list) {
    const t=String(x.text??x.body??"").replace(/\n/g," ")
    const role=x.role??x.direction
    const isCard = role!=="user" && /^[A-Z][^—]{1,40} — /.test(t)
    if (isCard) { cards++; continue }
    if (cards>0) { console.log(`            … ${cards} 张人卡`); cards=0 }
    console.log(`${String(x.createdAt).slice(11,19)} [${role}] ${t.slice(0,90)}`)
  }
  if (cards>0) console.log(`            … ${cards} 张人卡`)
}
process.exit(0)
