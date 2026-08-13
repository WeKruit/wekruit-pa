import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const id = "photon-backend-engineer-high-concurrency"
for (const col of ["pa-jobs","matching-jobs"]) {
  const d = await db.collection(col).doc(id).get()
  console.log(`\n=== ${col}/${id} exists=${d.exists} ===`)
  if (!d.exists) continue
  const j = d.data()
  console.log(JSON.stringify(j, null, 1).slice(0, 4000))
}
process.exit(0)
