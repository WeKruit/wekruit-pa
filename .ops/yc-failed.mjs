import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-6*3600*1000).toISOString()
const o = await db.collection("pa-outbound").where("createdAt",">=",since).get()
for (const d of o.docs) {
  const x=d.data(); if (x.status!=="failed") continue
  console.log(`${String(x.createdAt).slice(11,19)} uid=${String(x.userId??"").slice(0,8)} to=${x.toE164??"-"} from=${x.fromE164??x.senderNumber??"-"}`)
  console.log(`   err=${String(x.error ?? x.lastError ?? x.failureReason ?? "-").slice(0,220)}`)
  console.log(`   body="${String(x.body??"").replace(/\n/g," ").slice(0,80)}"`)
}
process.exit(0)
