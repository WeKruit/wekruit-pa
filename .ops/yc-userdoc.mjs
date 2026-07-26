import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
for (const phone of process.argv.slice(2)) {
  const us = await db.collection("pa-users").where("phoneE164","==",phone).get()
  for (const u of us.docs) {
    const d = u.data()
    console.log(`\n#### ${phone} ${u.id}`)
    for (const k of ["source","firstTouchCampaign","ycEventEntryAt","ycIntake","linkedinOauthLinked","linkedinUrl","onboardingState","sharedOnboarding","doNotContact","hasIngestedBackground","coresignalFetchedAt"]) {
      const v = d[k]
      console.log(`  ${k} = ${v===undefined?"<undefined>":(typeof v==="object"?JSON.stringify(v).slice(0,400):String(v))}`)
    }
  }
}
process.exit(0)
