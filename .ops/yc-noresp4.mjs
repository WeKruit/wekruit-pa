import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const phones = process.argv.slice(2)
for (const phone of phones) {
  console.log(`\n================ ${phone} ================`)
  const us = await db.collection("pa-users").where("phoneE164","==",phone).get()
  if (us.empty) { console.log("  !! NO pa-users doc for this phone"); continue }
  for (const u of us.docs) {
    const d = u.data()
    console.log(`uid=${u.id} src=${d.source ?? "-"} yc=${d.ycIntake ? JSON.stringify(d.ycIntake).slice(0,120) : "-"} sendblue=${d.sendblueFromNumber ?? d.assignedSendblueNumber ?? "-"} li=${d.linkedinUrl ?? "-"} enriched=${d.recentRoleTitle ?? "-"}`)
    const m = await db.collection("pa-messages").where("userId","==",u.id).get()
    const list = m.docs.map(x=>x.data()).sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
    console.log(`  --- pa-messages (${list.length}) ---`)
    for (const x of list.slice(-14)) {
      const dir = x.direction ?? x.role ?? "?"
      console.log(`  ${String(x.createdAt).slice(5,19)} [${dir}] ${String(x.text ?? x.body ?? "").replace(/\n/g," ").slice(0,150)}`)
    }
    const o = await db.collection("pa-outbound").where("userId","==",u.id).get()
    const ol = o.docs.map(x=>({id:x.id,...x.data()})).sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
    console.log(`  --- pa-outbound (${ol.length}) ---`)
    for (const x of ol.slice(-10)) console.log(`  ${String(x.createdAt).slice(5,19)} status=${x.status} err=${String(x.error??x.failureReason??"-").slice(0,60)} "${String(x.body??"").replace(/\n/g," ").slice(0,90)}"`)
    const t = await db.collection("pa-turns").where("userId","==",u.id).get()
    const tl = t.docs.map(x=>({id:x.id,...x.data()})).sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
    console.log(`  --- pa-turns (${tl.length}) ---`)
    for (const x of tl.slice(-6)) {
      console.log(`  ${String(x.createdAt).slice(5,19)} deliveredViaTool=${x.deliveredViaTool} handled=${x.handled} tools=[${(x.toolCalls??[]).map(c=>c.name??c).join(",")}] err=${String(x.error??"-").slice(0,80)}`)
      console.log(`      in="${String(x.userText??x.inputText??"").replace(/\n/g," ").slice(0,90)}"`)
      console.log(`     out="${String(x.finalText??x.replyText??"").replace(/\n/g," ").slice(0,160)}"`)
    }
  }
}
process.exit(0)
