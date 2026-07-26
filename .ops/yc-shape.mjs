import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
for (const c of ["pa-inbound-events","pa-sendblue-webhook-raw","pa-turns"]) {
  const s = await db.collection(c).limit(2).get()
  console.log(`\n### ${c} (${s.size})`)
  s.docs.forEach(d=>console.log(" id="+d.id+"\n  keys="+Object.keys(d.data()).join(",")))
}
process.exit(0)
