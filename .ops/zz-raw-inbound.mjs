/** Did the webhook even RECEIVE these messages, and did they become pa-messages / pa-turns?
 *  Adam's dashboard shows text we have no pa-messages row for -> the inbound pipeline may be
 *  dropping them BEFORE they reach the agent. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-26*3600*1000).toISOString()
const snap = await db.collection("pa-sendblue-webhook-raw").where("createdAt",">=",since).get()
console.log(`raw webhook rows (26h): ${snap.size}`)
const want = new Set(process.argv.slice(2))
const norm = (s)=>String(s??"").replace(/[^\d+]/g,"")
for (const d of snap.docs) {
  const x=d.data()
  const b=x.body??x.payload??x
  const from = norm(b.from_number ?? b.from ?? x.fromNumber)
  if (!want.has(from)) continue
  console.log(`\n  ${String(x.createdAt).slice(11,23)} from=${from} status=${b.status??"-"} isOutbound=${b.is_outbound??b.isOutbound??"-"}`)
  console.log(`     content="${String(b.content??b.text??"").replace(/\n/g," ").slice(0,80)}"`)
  console.log(`     media=${JSON.stringify(b.media_url??b.mediaUrl??null)} keys=${Object.keys(b).slice(0,14).join(",")}`)
  console.log(`     docKeys=${Object.keys(x).join(",")}  handled=${x.handled??"-"} skip=${x.skipReason??x.reason??"-"}`)
}
process.exit(0)
