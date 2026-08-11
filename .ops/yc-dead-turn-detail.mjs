import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const r = await db.collection("pa-users").where("phoneE164","==","+16269054870").get()
const uid = r.docs[0]?.id
console.log("uid:", uid)
const t = await db.collection("pa-turns").where("userId","==",uid).get().catch(()=>({docs:[]}))
const list = t.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
for (const x of list.slice(-4)) {
  console.log(`\n--- turn ${String(x.createdAt).slice(11,19)} id=${x.id.slice(0,20)}`)
  for (const k of Object.keys(x).sort()) {
    if (k==="id") continue
    const v = x[k]
    const s = typeof v === "string" ? v : JSON.stringify(v)
    if (s && s !== "null" && s !== "[]" && s !== "{}") console.log(`   ${k}: ${String(s).slice(0,220)}`)
  }
}
process.exit(0)
