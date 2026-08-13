import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db=admin.firestore()
const u = await db.collection("pa-users").where("source","==","yc_startup_school").get()
let eid=null
for (const d of u.docs){ const x=d.data(); if (x.coresignalEmployeeId){ eid=x.coresignalEmployeeId; break } }
console.log("employeeId:", eid)
const s = await db.collection("pa-coresignal-cache").doc(String(eid)).get()
console.log("doc(id) exists:", s.exists, s.exists ? Object.keys(s.data()).sort().join(",") : "")
if (!s.exists) {
  const q = await db.collection("pa-coresignal-cache").where("coresignalId","==",Number(eid)).limit(1).get()
  console.log("by coresignalId:", q.size, q.size? Object.keys(q.docs[0].data()).sort().join(","):"")
  const q2 = await db.collection("pa-coresignal-cache").limit(1).get()
  console.log("any doc keys:", q2.size? `${q2.docs[0].id} → ${Object.keys(q2.docs[0].data()).sort().join(",")}`:"empty")
}
process.exit(0)
