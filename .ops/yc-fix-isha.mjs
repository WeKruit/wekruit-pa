import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = process.argv[2]
const now = new Date().toISOString()
await db.collection("pa-users").doc(uid).set({
  source: "yc_startup_school",
  firstTouchCampaign: "yc-startup-school",
  ycEventEntryAt: now,
  updatedAt: now,
}, { merge: true })
const u = (await db.collection("pa-users").doc(uid).get()).data()
console.log(`uid=${uid}`)
console.log(`  source=${u.source}  campaign=${u.firstTouchCampaign}  ycEventEntryAt=${u.ycEventEntryAt}`)
console.log(`  → isYcPeopleUser 现在为 true，下一条消息走 YC lane`)
process.exit(0)
