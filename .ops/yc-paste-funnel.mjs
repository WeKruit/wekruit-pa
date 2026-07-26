import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const DEPLOY16 = process.argv[2] ?? "2026-07-25T18:20:00.000Z"
const m = await db.collection("pa-messages").where("createdAt",">=","2026-07-25T00:00:00.000Z").get()
const pastes = []
for (const d of m.docs) {
  const x = d.data()
  const dir = x.direction ?? x.role
  if (dir !== "user") continue
  const t = String(x.text ?? x.body ?? "")
  if (!/linkedin\.com\/in\//i.test(t)) continue
  pastes.push({ uid: x.userId, at: String(x.createdAt), t: t.slice(0,60) })
}
pastes.sort((a,b)=>a.at.localeCompare(b.at))
console.log(`total pastes today: ${pastes.length} | deploy16 cutoff ${DEPLOY16}`)
let before=0, after=0
for (const p of pastes) {
  const u = (await db.collection("pa-users").doc(p.uid).get()).data() ?? {}
  const bg = (Array.isArray(u.experienceHighlights)&&u.experienceHighlights.length>0) || !!u.coresignalEmployeeId || !!u.recentRoleTitle
  const isAfter = p.at >= DEPLOY16
  if (isAfter) after++; else before++
  console.log(`  ${isAfter?"AFTER ":"before"} ${p.at.slice(11,19)} enriched=${bg?"YES":"NO "} li=${String(u.linkedinUrl??"-").slice(0,44)}`)
}
console.log(`\nbefore deploy16: ${before} | AFTER deploy16: ${after}`)
process.exit(0)
