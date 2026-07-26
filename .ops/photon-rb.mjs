import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
for (const id of ["photon-backend-engineer-high-concurrency","wekruit-37429d02-photon-macos-devops"]) {
  const j = (await db.collection("pa-jobs").doc(id).get()).data()
  console.log(`\n===== ${id} =====`)
  console.log("recruiterBoard:", JSON.stringify(j.recruiterBoard, null, 1)?.slice(0,2500) ?? "MISSING")
}
console.log("\n===== a real submission doc =====")
const s = await db.collection("pa-recruiter-submissions").limit(1).get()
console.log(JSON.stringify(s.docs[0]?.data(), null, 1).slice(0,2600))
process.exit(0)
