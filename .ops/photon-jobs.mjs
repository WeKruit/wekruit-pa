/** What Photon roles actually exist in prod, and what does the backend one require? */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env", "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

for (const col of ["pa-jobs", "matching-jobs"]) {
  const s = await db.collection(col).get()
  const photon = s.docs.filter((d) => JSON.stringify(d.data()).toLowerCase().includes("photon"))
  console.log(`\n=== ${col}: ${photon.length} photon docs (of ${s.size}) ===`)
  for (const d of photon) {
    const j = d.data()
    console.log(` ${d.id}`)
    console.log(`   title=${j.title ?? j.roleTitle} status=${j.status ?? "-"} public=${j.publicVisible ?? "-"} collab=${j.collaborative ?? "-"}`)
    if (col === "matching-jobs") {
      console.log(`   roleFunction=${JSON.stringify(j.roleFunction)}`)
      console.log(`   seniority=${j.seniorityLevel} loc=${JSON.stringify(j.locationBuckets)} sponsor=${j.sponsorship}`)
      console.log(`   requiredSkills=${JSON.stringify(j.requiredSkills)}`)
    }
  }
}
process.exit(0)
