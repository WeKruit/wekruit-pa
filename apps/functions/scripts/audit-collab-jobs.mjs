// Audit WeKruit collab jobs vs matching-jobs enrichment state.
// Run FROM apps/functions:
//   PA_ENV_PATH=/Users/adam/Desktop/WeKruit/wekruit-pa/.env node scripts/audit-collab-jobs.mjs
import { readFileSync } from "node:fs"
import admin from "firebase-admin"

let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const CANON = ["roleFunction", "requiredSkills", "industrySector", "seniorityLevel", "jobType", "locationBuckets", "atsApplyUrl", "firstSeenAt", "status", "dead"]

const snap = await db.collection("pa-jobs").where("wekruitCollaborationStatus", "==", "collaborated").get()
console.log(`\n=== COLLAB JOBS in pa-jobs: ${snap.size} ===\n`)

let inMatching = 0, missing = 0, bare = 0
for (const doc of snap.docs) {
  const d = doc.data()
  const jd = d.jobDescription || d.description || d.jd || d.jobDescriptionText || ""
  const jdLen = typeof jd === "string" ? jd.length : 0
  const title = d.roleTitle || d.title || d.jobTitle || "(no title)"
  const company = d.companyName || d.company || "(no company)"
  const applyUrl = d.atsApplyUrl || d.applyUrl || d.primaryUrl || d.url || ""
  const loc = d.locationRaw || d.location || ""
  const hasPrescreen = d.prescreenConfig && Array.isArray(d.prescreenConfig.questions) && d.prescreenConfig.questions.length > 0

  const mj = await db.collection("matching-jobs").doc(doc.id).get()
  let mjState = "MISSING"
  let presentFields = [], missingFields = []
  if (mj.exists) {
    const m = mj.data()
    for (const f of CANON) {
      const v = m[f]
      const present = Array.isArray(v) ? v.length > 0 : (v !== undefined && v !== null && v !== "")
      if (present) presentFields.push(f); else missingFields.push(f)
    }
    const enriched = (Array.isArray(m.roleFunction) && m.roleFunction.length > 0) && (Array.isArray(m.requiredSkills) && m.requiredSkills.length > 0)
    mjState = enriched ? "ENRICHED" : "BARE"
    if (enriched) inMatching++; else bare++
  } else {
    missing++
  }
  console.log(`${doc.id}`)
  console.log(`  title="${title}" company="${company}" loc="${loc}"`)
  console.log(`  jdLen=${jdLen} applyUrl=${applyUrl ? "yes" : "NO"} prescreenQs=${hasPrescreen ? (d.prescreenConfig.questions.length) : 0}`)
  console.log(`  matching-jobs: ${mjState}` + (mj.exists ? ` present=[${presentFields.join(",")}] missing=[${missingFields.join(",")}]` : ""))
  console.log("")
}
console.log(`=== SUMMARY: total=${snap.size} enriched-in-matching=${inMatching} bare=${bare} missing=${missing} ===`)
process.exit(0)
