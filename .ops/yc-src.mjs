import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const r = await db.collection("pa-users").where("phoneE164","==",process.argv[2]).get()
for (const d of r.docs) { const u=d.data()
  console.log(`uid=${d.id}`)
  console.log(`  source=${u.source ?? "-"}  firstTouchCampaign=${u.firstTouchCampaign ?? "-"}  ycEventEntryAt=${u.ycEventEntryAt ?? "-"}`)
  console.log(`  createdAt=${u.createdAt ?? "-"}  onboardingStatus=${u.onboardingStatus ?? "-"}`)
  console.log(`  ycIntake=${JSON.stringify(u.ycIntake ?? null)}`)
}
process.exit(0)
