import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
// pool = pa-external-candidate-records with a yc cohort; scanners synced by syncYcPoolMember
const rec = await db.collection("pa-external-candidate-records").where("ycPoolMember","==",true).get()
console.log(`YC pool members (ycPoolMember=true): ${rec.size}`)
const fromScan = rec.docs.map(d=>d.data()).filter(x=>x.ycPoolSource === "scanner" || x.sourceUserId)
console.log(`  of which synced from live scanners: ${fromScan.length}`)
const recent = fromScan.filter(x=>String(x.updatedAt??x.createdAt??"") >= "2026-07-25T00:00:00.000Z")
console.log(`  synced TODAY: ${recent.length}`)
for (const r of recent.slice(-8)) console.log(`   ${String(r.updatedAt??r.createdAt).slice(11,19)} ${r.name ?? "-"} | ${r.currentTitle ?? "-"} @ ${r.currentCompany ?? "-"}`)
// how many YC users are enriched but NOT in pool
const us = await db.collection("pa-users").get()
let ycEnriched = 0, ycEnrichedInPool = 0
const inPool = new Set(rec.docs.map(d=>d.data().sourceUserId).filter(Boolean))
for (const d of us.docs) {
  const u = d.data()
  const isYc = u.source === "yc_startup_school" || u.ycEventEntryAt || u.firstTouchCampaign === "yc-startup-school"
  if (!isYc) continue
  const bg = (Array.isArray(u.experienceHighlights)&&u.experienceHighlights.length>0) || !!u.coresignalEmployeeId || !!u.recentRoleTitle
  if (!bg) continue
  ycEnriched++
  if (inPool.has(d.id)) ycEnrichedInPool++
}
console.log(`\nYC users WITH background: ${ycEnriched} | of those in the pool: ${ycEnrichedInPool} | MISSING: ${ycEnriched - ycEnrichedInPool}`)
process.exit(0)
