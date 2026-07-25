import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const d = (await db.collection("pa-config").doc("sendblue-pool").get()).data()
const arr = d.numbers ?? d.pool ?? []
arr.forEach(n => console.log(`${n.number}  audience=${n.audience}  adminOnly=${n.adminOnly}  status=${n.status}  newUserCap=${n.newUserCap}  dailySendCap=${n.dailySendCap}  label="${n.label ?? "-"}"`))
process.exit(0)
