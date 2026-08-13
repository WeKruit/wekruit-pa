import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
for (const phone of process.argv.slice(2)) {
  const r = await db.collection("pa-users").where("phoneE164","==",phone).get()
  const uid = r.docs[0].id
  console.log(`\n======== ${phone}  uid=${uid} ========`)
  const ts=(await db.collection("pa-turns").where("userId","==",uid).get()).docs.map(d=>d.data())
    .sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  for (const t of ts.slice(-4)) {
    console.log(`  ${String(t.createdAt).slice(11,23)} mode=${t.mode} pattern=${t.pattern} handledBy=${t.handledBy} model=${t.servedByModel??"-"}`)
    console.log(`     inbound="${String(t.inboundText??"").replace(/\n/g," ").slice(0,70)}"`)
    console.log(`     finalText="${String(t.finalText??"").replace(/\n/g," ").slice(0,70)}" tool=${t.deliveredViaTool} suppressed=${t.suppressed}`)
    console.log(`     toolCalls=${JSON.stringify(t.toolCalls??[]).slice(0,200)}  eventId=${t.eventId}`)
  }
  const ev=(await db.collection("pa-inbound-events").where("userId","==",uid).get()).docs.map(d=>({id:d.id,...d.data()}))
    .sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  console.log(`  --- pa-inbound-events (last 4 of ${ev.length}) ---`)
  for (const e of ev.slice(-4)) console.log(`     ${String(e.createdAt).slice(11,23)} status=${e.status} handled=${e.handled} reason=${e.reason??e.skipReason??"-"} text="${String(e.text??e.body??"").slice(0,45)}"`)
}
process.exit(0)
