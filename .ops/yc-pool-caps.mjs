import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const d = await db.collection("pa-config").doc("sendblue-pool").get()
console.log(JSON.stringify(d.data(), null, 1).slice(0, 2200))
// actual distribution
const users = await db.collection("pa-users").select("senderNumber").get()
const dist = {}
users.docs.forEach(x => { const n = x.data().senderNumber; if (n) dist[n] = (dist[n]||0)+1 })
console.log("\nACTUAL senderNumber distribution:", JSON.stringify(dist))
process.exit(0)
