import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const snap = await db.collection("pa-external-candidate-records").where("enrichment.cohort", "==", "yc_startup_school_2026").get()
let ok=0, prof=0, matchLine=0, yc=0, stage=0, descEmb=0, descHasYc=0
for (const d of snap.docs) {
  const u = d.data()
  if (u.coresignalMatch !== "ok") continue
  ok++
  const p = u.companyProfile
  if (p && typeof p === "object") {
    prof++
    if (p.matchLine) matchLine++
    if (p.ycBatch || p.isYcBacked) yc++
    if (p.stage && p.stage !== "unknown") stage++
  }
  if (Array.isArray(u.descriptorEmbedding) && u.descriptorEmbedding.length) descEmb++
  const dt = JSON.stringify(u.businessDescriptor ?? "")
  if (/y combinator|yc-backed|yc backed/i.test(dt)) descHasYc++
}
console.log(`enriched(ok)          ${ok}`)
console.log(`companyProfile        ${prof}`)
console.log(`  matchLine           ${matchLine}`)
console.log(`  ycBatch/isYcBacked  ${yc}`)
console.log(`  real stage          ${stage}`)
console.log(`descriptorEmbedding   ${descEmb}`)
console.log(`descriptor mentions YC ${descHasYc}   <- what "YC backed founders" can actually bind to`)
process.exit(0)
