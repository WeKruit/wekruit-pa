import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const phone = process.argv[2]
const r = await db.collection("pa-users").where("phoneE164","==",phone).get()
const uid = r.docs[0].id
const m = await db.collection("pa-messages").where("userId","==",uid).get()
const o = await db.collection("pa-outbound").where("userId","==",uid).get()
const msgs = m.docs.map(d=>d.data()).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
const outs = o.docs.map(d=>d.data()).filter(x=>x.status==="sent"||x.status==="delivered").sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
console.log(`${phone}  pa-messages=${msgs.length}  delivered pa-outbound=${outs.length}`)
console.log(`\n--- pa-messages tail (what the dashboard shows) ---`)
for (const x of msgs.slice(-5)) console.log(`  ${String(x.createdAt).slice(11,19)} [${x.direction??x.role}] ${String(x.text??x.body??"").replace(/\n/g," ").slice(0,60)}`)
console.log(`\n--- delivered pa-outbound tail (what the USER actually received) ---`)
for (const x of outs.slice(-8)) console.log(`  ${String(x.createdAt).slice(11,19)} ${String(x.body??"").replace(/\n/g," ").slice(0,60)}`)
const inMsgs = new Set(msgs.map(x=>String(x.text??x.body??"").slice(0,50)))
const missing = outs.filter(x=>!inMsgs.has(String(x.body??"").slice(0,50)))
console.log(`\nDELIVERED BUT ABSENT FROM TRANSCRIPT: ${missing.length} of ${outs.length}`)
process.exit(0)
