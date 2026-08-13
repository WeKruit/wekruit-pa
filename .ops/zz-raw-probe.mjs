import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
for (const c of ["pa-sendblue-webhook-raw","pa-inbound-events","pa-messages"]) {
  const s = await db.collection(c).limit(2).get()
  console.log(`\n=== ${c} (${s.size} sampled) ===`)
  for (const d of s.docs) { console.log(`  id=${d.id}`); console.log(`  ${JSON.stringify(d.data()).slice(0,600)}`) }
}
process.exit(0)
