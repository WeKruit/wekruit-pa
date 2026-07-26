import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const s = await db.collection("pa-sendblue-webhook-raw").where("receivedAt",">=",new Date(Date.now()-3*3600*1000).toISOString()).limit(3).get()
console.log("raw webhook docs in last 3h:", s.size)
for (const d of s.docs) console.log(" keys:", Object.keys(d.data()).join(","), "| id:", d.id)
const ev = await db.collection("pa-inbound-events").where("createdAt",">=",new Date(Date.now()-3*3600*1000).toISOString()).limit(3).get()
console.log("\ninbound-events sample:", ev.size)
for (const d of ev.docs) { const x=d.data(); console.log(` ${d.id} status=${x.status} handledBy=${x.handledBy}`) }
process.exit(0)
