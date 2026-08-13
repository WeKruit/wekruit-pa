/** DETERMINISTIC answered-check: link pa-outbound to the INBOUND EVENT it replies to, instead of
 *  comparing clocks. Outbound idempotencyKeys carry the inbound event id (claire-reply-<eventId>:…),
 *  so "did we answer THIS message" stops being a tolerance guess. */
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
  const msgs = await db.collection("pa-messages").where("userId","==",uid).get()
  const list = msgs.docs.map(d=>d.data()).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  const lastUser = [...list].reverse().find(x=>(x.direction??x.role)==="user")
  const text = String(lastUser?.text ?? lastUser?.body ?? "")
  const turns = await db.collection("pa-turns").where("userId","==",uid).get()
  const turn = turns.docs.map(d=>({id:d.id,...d.data()}))
    .filter(t=>String(t.inboundText??"") === text)
    .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0]
  const outs = await db.collection("pa-outbound").where("userId","==",uid).get()
  const linked = turn ? outs.docs.map(d=>d.data()).filter(o =>
      String(o.idempotencyKey??"").includes(String(turn.eventId ?? turn.id)) &&
      (o.status==="sent"||o.status==="delivered")) : []
  console.log(`${phone}`)
  console.log(`   their last : ${String(lastUser?.createdAt).slice(11,19)} "${text.replace(/\n/g," ").slice(0,46)}"`)
  console.log(`   turn ran   : ${turn ? `${String(turn.createdAt).slice(11,19)} tools=[${(turn.toolCalls??[]).map(c=>c.name??c).join(",")}] finalText=${String(turn.finalText??"").length}ch` : "NO TURN FOR THIS MESSAGE"}`)
  console.log(`   DELIVERED replying to it: ${linked.length}  → ${linked.length ? "ANSWERED" : "** UNANSWERED **"}`)
}
process.exit(0)
