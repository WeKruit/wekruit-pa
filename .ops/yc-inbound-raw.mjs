import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const ts = (v) => { if(!v) return "-"; if (typeof v === "string") return v.slice(5,19); if (v._seconds) return new Date(v._seconds*1000).toISOString().slice(5,19); if (v.toDate) return v.toDate().toISOString().slice(5,19); return String(v).slice(0,19) }
for (const phone of process.argv.slice(2)) {
  console.log(`\n=========== ${phone} ===========`)
  // raw sendblue webhooks
  const rawq = await db.collection("pa-sendblue-webhook-raw").where("from_number","==",phone).get()
  const rl = rawq.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(ts(a.receivedAt??a.createdAt)).localeCompare(String(ts(b.receivedAt??b.createdAt))))
  console.log(`--- pa-sendblue-webhook-raw (${rl.length}) ---`)
  for (const x of rl.slice(-12)) console.log(`  ${ts(x.receivedAt??x.createdAt)} id=${x.id.slice(0,24)} status=${x.status??"-"} isOut=${x.is_outbound} "${String(x.content??"").replace(/\n/g," ").slice(0,80)}"`)
  // inbound events
  const ie = await db.collection("pa-inbound-events").where("fromNumber","==",phone).get()
  const il = ie.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(ts(a.createdAt)).localeCompare(String(ts(b.createdAt))))
  console.log(`--- pa-inbound-events by fromNumber (${il.length}) ---`)
  for (const x of il.slice(-12)) console.log(`  ${ts(x.createdAt)} id=${x.id.slice(0,30)} status=${x.status} err=${String(x.error??"-").slice(0,70)} "${String(x.text??x.body??"").replace(/\n/g," ").slice(0,70)}"`)
}
process.exit(0)
