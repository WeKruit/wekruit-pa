import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
for (const phone of process.argv.slice(2)) {
  const us = await db.collection("pa-users").where("phoneE164","==",phone).get()
  for (const u of us.docs) {
    const o = await db.collection("pa-outbound").where("userId","==",u.id).get()
    const ol = o.docs.map(x=>({id:x.id,...x.data()})).sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
    console.log(`\n#### ${phone} outbound (${ol.length})`)
    for (const x of ol) {
      console.log(`\n  docId=${x.id}`)
      for (const k of Object.keys(x)) { if(k==="id")continue; let v=x[k]; let s=typeof v==="object"?JSON.stringify(v):String(v); if(s.length>200)s=s.slice(0,200)+"…"; console.log(`    ${k}=${s}`) }
    }
  }
}
process.exit(0)
