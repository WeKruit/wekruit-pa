import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const s = await db.collection("pa-users").get()
let yc=0, ycPaused=0, opPause=0, allPaused=0
for (const d of s.docs) {
  const u=d.data()
  if (u.doNotContact===true) allPaused++
  if (u.operatorPause) opPause++
  const isYc = u.source==="yc_startup_school"||u.ycEventEntryAt||u.firstTouchCampaign==="yc-startup-school"
  if (!isYc) continue
  yc++
  if (u.doNotContact===true) ycPaused++
}
console.log(`YC users: ${yc} | YC still paused (doNotContact): ${ycPaused}`)
console.log(`still carrying operatorPause marker: ${opPause}`)
console.log(`ALL users with doNotContact=true (incl. real opt-outs): ${allPaused} of ${s.size}`)
process.exit(0)
