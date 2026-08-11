import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
for (const uid of process.argv.slice(2)) {
  console.log(`\n######## ${uid}`)
  const o = await db.collection("pa-outbound").where("userId","==",uid).get()
  const ol=o.docs.map(x=>x.data()).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  console.log(` outbound (${ol.length}):`)
  for (const x of ol.slice(-12)) console.log(`   ${String(x.createdAt).slice(11,23)} ${x.status} "${String(x.body??"").replace(/\n/g," ").slice(0,70)}"`)
  const t = await db.collection("pa-turns").where("userId","==",uid).get()
  const tl=t.docs.map(x=>x.data()).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  console.log(` turns (${tl.length}):`)
  for (const x of tl.slice(-8)) console.log(`   ${String(x.createdAt).slice(11,23)} viaTool=${x.deliveredViaTool} sup=${x.suppressed} tools=[${(x.toolCalls??[]).map(c=>c.name).join(",")}]\n      in="${String(x.inboundText??"").replace(/\n/g," ").slice(0,60)}" out="${String(x.finalText??"").replace(/\n/g," ").slice(0,60)}"`)
}
process.exit(0)
