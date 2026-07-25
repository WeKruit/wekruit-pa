import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-6*3600*1000).toISOString()
const m = await db.collection("pa-messages").where("createdAt",">=",since).get()
for (const d of m.docs) {
  const x=d.data(); const t=String(x.text ?? x.body ?? "")
  if (!t.trim().startsWith('{"messages"')) continue
  console.log(JSON.stringify({ id:d.id.slice(0,24), keys:Object.keys(x).sort().join(","), direction:x.direction, role:x.role, source:x.source, channel:x.channel, text:t.slice(0,60) }, null, 0))
  break
}
process.exit(0)
