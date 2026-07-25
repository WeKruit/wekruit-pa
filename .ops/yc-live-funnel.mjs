import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now() - 24*3600*1000).toISOString()
const snap = await db.collection("pa-users").where("source","==","yc_startup_school").get()
let total=0, today=0, li=0, enriched=0, intake=0, matched=0, pitched=0
const stuck=[]
for (const d of snap.docs) {
  const u=d.data(); total++
  const created = String(u.createdAt ?? "")
  if (created < since) continue
  today++
  const hasLi = Boolean(u.linkedinUrl || u.linkedinOauthLinked || u.linkedinOauthSub)
  const hasEnrich = Boolean(u.coresignalEmployeeId || (Array.isArray(u.experienceHighlights) && u.experienceHighlights.length))
  if (hasLi) li++
  if (hasEnrich) enriched++
  if (u.ycIntake?.completedAt) intake++
  if (Array.isArray(u.ycPeopleMatchSent) && u.ycPeopleMatchSent.length) matched++
  if (u.pitchedAt) pitched++
  if (hasLi && !hasEnrich) stuck.push(`${d.id.slice(0,8)} phone=${u.phoneE164} li=${String(u.linkedinUrl??"oauth").slice(0,50)} enrichStartedAt=${u.enrichmentStartedAt??"-"} inFlight=${u.enrichmentInFlight??"-"}`)
}
console.log(`YC users total        ${total}`)
console.log(`created last 24h      ${today}`)
console.log(`  has LinkedIn        ${li}`)
console.log(`  ENRICHED            ${enriched}`)
console.log(`  intake complete     ${intake}`)
console.log(`  got matches         ${matched}`)
console.log(`  pitched             ${pitched}`)
console.log(`\nHAS LINKEDIN BUT NOT ENRICHED (${stuck.length}):`)
stuck.slice(0,15).forEach(x=>console.log("  "+x))
process.exit(0)
