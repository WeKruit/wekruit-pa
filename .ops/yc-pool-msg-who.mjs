import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const o = await db.collection("pa-outbound").where("createdAt",">=","2026-07-25T00:00:00.000Z").get()
const hits = o.docs.map(d=>d.data()).filter(x=>String(x.body??"").startsWith("got it — you're in the founder-match pool"))
console.log("pool-bubble sends today:", hits.length)
let noBg = 0
for (const h of hits) {
  const u = (await db.collection("pa-users").doc(h.userId).get()).data() ?? {}
  const bg = (Array.isArray(u.experienceHighlights)&&u.experienceHighlights.length>0) || !!u.coresignalEmployeeId || !!u.recentRoleTitle
  if (!bg) noBg++
  console.log(`  ${String(h.createdAt).slice(11,19)} ${u.phoneE164 ?? "-"} bg=${bg?"YES":"NO "} oauth=${u.linkedinOauthLinked===true} li=${String(u.linkedinUrl??"-").slice(0,45)}`)
}
console.log(`\nSENT WITH NO BACKGROUND: ${noBg} / ${hits.length}`)
process.exit(0)
