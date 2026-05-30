#!/usr/bin/env node
// Why does V16 return 0 for uid 8fE despite 10 active SWE jobs? Dump the drop histogram + the
// per-axis hard-filter counters so we see exactly which gate eliminates the catalog.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { loadEnv } from "./_claire-bundle.mjs"
loadEnv()
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz"

// Import the real V16 query from job-rec dist.
const mod = await import("../../../packages/job-rec/dist/query-matching-jobs-v16.js").catch(async () => {
  return await import("../../../packages/pa-orchestrator/dist/matching/query-matching-jobs-v16.js").catch(e => { console.log("V16 import failed:", e.message); return null })
})
if (!mod) process.exit(1)
const q = mod.queryMatchingJobsV16 || mod.default
const u = (await db.collection("pa-users").doc(uid).get()).data()
console.log("user tags:", JSON.stringify({
  role: u.tags?.targetRoleFunction, loc: u.tags?.targetLocations, careerStage: u.tags?.careerStage,
  jobType: u.tags?.targetJobType, visa: u.tags?.visaStatus, minSalary: u.tags?.minSalary,
}))
const res = await q({ userId: uid, limit: 50 }, { db })
console.log("\n=== V16 result ===")
console.log("  total evaluated:", res.total)
console.log("  returned jobs:", (res.jobs || []).length)
console.log("  needsOnboarding:", res.needsOnboarding, "| noUserTags:", res.noUserTags)
console.log("  missingAxes:", JSON.stringify(res.missingAxes))
console.log("  dropped:", res.dropped)
console.log("  hardFilter histogram:", JSON.stringify(res.hardFilter, null, 0))
console.log("  freshnessWindowDays:", res.freshnessWindowDays ?? res.freshnessDays ?? "?")
;(res.jobs || []).slice(0, 5).forEach((j, i) => console.log(`  [${i}] ${j.roleTitle || j.jobTitle} @ ${j.companyName} | loc=${JSON.stringify(j.locationBuckets)} | url=${j.atsApplyUrl ? "yes" : "NULL"}`))
process.exit(0)
