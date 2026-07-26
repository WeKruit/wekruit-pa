/** For a message hours old, tolerance is irrelevant: a reply must be DELIVERED and created STRICTLY
 *  AFTER it. No clock guessing, no event-id linkage (the coalescer shares an id across turns). */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
for (const phone of process.argv.slice(2)) {
  const r = await db.collection("pa-users").where("phoneE164","==",phone).get()
  if (r.empty) { console.log(`${phone} NO USER`); continue }
  const uid = r.docs[0].id
  const m = await db.collection("pa-messages").where("userId","==",uid).get()
  const list = m.docs.map(d=>d.data()).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  const lastUser = [...list].reverse().find(x=>(x.direction??x.role)==="user")
  const ms = Date.parse(String(lastUser?.createdAt))
  const o = await db.collection("pa-outbound").where("userId","==",uid).get()
  const after = o.docs.map(d=>d.data())
    .filter(x=>(x.status==="sent"||x.status==="delivered") && Date.parse(String(x.createdAt??""))>ms)
  const mins = Math.round((Date.now()-ms)/60000)
  console.log(`${after.length?"ANSWERED  ":"UNANSWERED"} ${phone}  ${String(mins).padStart(3)}min  "${String(lastUser?.text??lastUser?.body??"").replace(/\n/g," ").slice(0,42)}"`)
}
process.exit(0)
