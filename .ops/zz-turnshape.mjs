import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const t = await db.collection("pa-turns").get()
let n = 0
for (const d of t.docs) {
  const x = d.data()
  for (const c of (x.toolCalls ?? [])) {
    if (!/match_yc_people/.test(c.name ?? "")) continue
    if (n++ > 1) { process.exit(0) }
    console.log("TURN KEYS:", Object.keys(x).join(","))
    console.log("TOOLCALL KEYS:", Object.keys(c).join(","))
    console.log("TOOLCALL:", JSON.stringify(c).slice(0,2000))
  }
}
process.exit(0)
