/** Ground truth, no rule: interleave pa-messages and pa-outbound for a phone and print the tail. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
for (const phone of process.argv.slice(2)) {
  const r = await db.collection("pa-users").where("phoneE164","==",phone).get()
  if (r.empty) { console.log(`${phone}: NO USER`); continue }
  const uid = r.docs[0].id
  const rows = []
  for (const d of (await db.collection("pa-messages").where("userId","==",uid).get()).docs) {
    const x=d.data(); rows.push({t:String(x.createdAt),who:(x.direction??x.role)==="user"?"THEM":"us(msg)",body:String(x.text??x.body??"")})
  }
  for (const d of (await db.collection("pa-outbound").where("userId","==",uid).get()).docs) {
    const x=d.data(); rows.push({t:String(x.createdAt),who:`OUT[${x.status}]`,body:String(x.body??"")})
  }
  rows.sort((a,b)=>a.t.localeCompare(b.t))
  console.log(`\n======== ${phone} (${rows.length} rows) ========`)
  for (const x of rows.slice(-9)) console.log(`  ${x.t.slice(11,19)} ${x.who.padEnd(14)} ${x.body.replace(/\n/g," ").slice(0,88)}`)
}
process.exit(0)
