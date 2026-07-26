import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = process.argv[2]
const t = await db.collection("pa-turns").where("userId","==",uid).get()
const tl = t.docs.map(x=>({id:x.id,...x.data()})).sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
for (const x of tl) {
  console.log("=========", x.id, x.createdAt)
  console.log(JSON.stringify(x, null, 1).slice(0, 2600))
}
process.exit(0)
