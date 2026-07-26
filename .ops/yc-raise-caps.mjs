import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const ref = db.collection("pa-config").doc("sendblue-pool")
const snap = await ref.get()
const data = snap.data()
const numbers = (data.numbers ?? data.pool ?? []).map((n) => ({ ...n, newUserCap: 1000, dailySendCap: 10000, capacity: 10000 }))
const key = data.numbers ? "numbers" : "pool"
await ref.set({ [key]: numbers, updatedAt: new Date().toISOString() }, { merge: true })
const after = (await ref.get()).data()
;(after.numbers ?? after.pool ?? []).forEach((n) =>
  console.log(`${n.number}  newUserCap=${n.newUserCap}  dailySendCap=${n.dailySendCap}  capacity=${n.capacity}  status=${n.status}`))
process.exit(0)
