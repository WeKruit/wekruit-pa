import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-20*3600*1000).toISOString()
const u = (await db.collection("pa-users").where("createdAt",">=",since).get()).docs
  .map(d=>d.data()).filter(x=>x.experienceHighlights?.length && x.ycIntake?.building)
console.log(`enriched WITH building text: ${u.length}`)
for (const x of u.slice(0,2)) {
  console.log("\n=====================")
  console.log("recentRoleTitle:", x.tags?.recentRoleTitle, "| recentCompany:", x.tags?.recentCompany)
  console.log("industryEnum:", JSON.stringify(x.tags?.industryEnum))
  console.log("targetRoleFunction:", JSON.stringify(x.tags?.targetRoleFunction))
  console.log("workHistorySummary:", String(x.tags?.workHistorySummary).slice(0,500))
  console.log("experienceHighlights:", JSON.stringify(x.experienceHighlights).slice(0,900))
  console.log("ycIntake:", JSON.stringify(x.ycIntake).slice(0,400))
}
process.exit(0)
