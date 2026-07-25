import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const phone = process.argv[2]
const r = await db.collection("pa-users").where("phoneE164","==",phone).get()
for (const d of r.docs) {
  const u=d.data()
  console.log(`uid=${d.id}`)
  console.log(`  linkedinOauthLinked=${u.linkedinOauthLinked ?? "-"}  sub=${u.linkedinOauthSub ? "yes":"-"}  connectedAt=${u.linkedinOauthConnectedAt ?? "-"}`)
  console.log(`  linkedinUrl=${u.linkedinUrl ?? "-"}`)
  console.log(`  picture=${u.linkedinOauthPicture ? "yes":"-"}  coresignalEmployeeId=${u.coresignalEmployeeId ?? "-"}`)
  console.log(`  highlights=${(u.experienceHighlights??[]).length}  displayName=${u.displayName ?? "-"}`)
  console.log(`  ycIntake=${JSON.stringify(u.ycIntake ?? null)}`)
  console.log(`  pitchedAt=${u.pitchedAt ?? "-"}  senderNumber=${u.senderNumber ?? "-"}`)
}
process.exit(0)
