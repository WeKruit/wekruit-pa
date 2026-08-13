import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const needle = process.argv[2].toLowerCase()
const since = new Date(Date.now()-6*3600*1000).toISOString()
const m = await db.collection("pa-messages").where("createdAt",">=",since).get()
const hits = new Map()
for (const d of m.docs) { const x=d.data(); if (String(x.text??x.body??"").toLowerCase().includes(needle)) hits.set(x.userId, String(x.text??x.body??"").slice(0,70)) }
for (const [uid,txt] of hits) {
  const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
  console.log(`uid=${uid} phone=${u.phoneE164} dnc=${u.doNotContact===true} :: "${txt}"`)
}
process.exit(0)
