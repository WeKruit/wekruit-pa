import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const snap = await db.collection("pa-external-candidate-records").where("enrichment.cohort", "==", "yc_startup_school_2026").limit(3).get()
console.log("count sample:", snap.size)
for (const d of snap.docs) {
  const x = d.data()
  console.log("docId=", d.id)
  console.log(JSON.stringify(x, null, 1).slice(0, 2500))
  console.log("-----")
}
process.exit(0)
