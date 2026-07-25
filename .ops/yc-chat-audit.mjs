import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-6*3600*1000).toISOString()
const users = await db.collection("pa-users").where("source","==","yc_startup_school").get()
const rows=[]
for (const d of users.docs) {
  const u=d.data(); if (String(u.createdAt??"")<since) continue
  const msgs = await db.collection("pa-messages").where("userId","==",d.id).get().catch(()=>({docs:[]}))
  const list = msgs.docs.map(m=>m.data()).sort((a,b)=>String(a.createdAt??"").localeCompare(String(b.createdAt??"")))
  const inbound = list.filter(m=>m.direction==="inbound"||m.role==="user")
  const outbound= list.filter(m=>m.direction==="outbound"||m.role==="assistant")
  const lastIn = inbound.at(-1), lastOut = outbound.at(-1)
  const lastInAt = String(lastIn?.createdAt??""), lastOutAt = String(lastOut?.createdAt??"")
  const unanswered = lastInAt && (!lastOutAt || lastOutAt < lastInAt)
  rows.push({ id:d.id.slice(0,8), phone:u.phoneE164, in:inbound.length, out:outbound.length,
    unanswered, li: u.linkedinOauthLinked?"oauth":(u.linkedinUrl?"url":"-"),
    enriched: Boolean(u.coresignalEmployeeId||((u.experienceHighlights??[]).length)),
    intake: Boolean(u.ycIntake?.completedAt), matched: (u.ycPeopleMatchSent??[]).length,
    lastInText: String(lastIn?.text ?? lastIn?.body ?? "").slice(0,50) })
}
const unans = rows.filter(r=>r.unanswered)
console.log(`YC users last 6h: ${rows.length}`)
console.log(`  连了LinkedIn但没enrich: ${rows.filter(r=>r.li!=="-"&&!r.enriched).length}`)
console.log(`  intake完成: ${rows.filter(r=>r.intake).length}   拿到匹配: ${rows.filter(r=>r.matched>0).length}`)
console.log(`\n⚠️ 用户说了话但我们没回 (${unans.length}):`)
unans.forEach(r=>console.log(`  ${r.id} ${r.phone} in=${r.in} out=${r.out} li=${r.li} enriched=${r.enriched} last="${r.lastInText}"`))
process.exit(0)
