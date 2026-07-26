import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const r = await db.collection("pa-users").where("phoneE164","==",process.argv[2]).get()
const uid = r.docs[0].id
console.log("uid", uid, "intake:", JSON.stringify(r.docs[0].data().ycIntake ?? {}))
const t = await db.collection("pa-turns").where("userId","==",uid).get()
for (const d of t.docs.sort((a,b)=>String(a.data().createdAt).localeCompare(String(b.data().createdAt)))) {
  const x = d.data()
  for (const c of (x.toolCalls ?? [])) {
    if (!/match_yc_people/.test(c.name ?? "")) continue
    console.log(`\n${String(x.createdAt).slice(11,19)}  in="${String(x.inboundText??"").slice(0,60)}"`)
    console.log(`  ARGS: ${JSON.stringify(c.arguments ?? c.args ?? c.input ?? {})}`)
  }
}
process.exit(0)
