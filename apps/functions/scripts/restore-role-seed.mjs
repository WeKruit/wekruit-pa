// Restore the matcher seed that the dev reinit wrongly wiped: derive targetRoleFunction from the
// résumé (the real enrichment path, point 3) + clean the over-generated targetLocations down to the
// two cities the user actually stated. NOT a fabrication — this is exactly what cv-ingest enrichment
// produces ("Software Engineer Intern" → software_engineering) and what the user said ("nye or sf").
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
const APPLY = process.argv.includes("--apply")
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz"

// Derive role from the résumé title via the REAL mapper (mapAnswerToRoleFunction).
const om = await import("../../../packages/pa-orchestrator/dist/tags/onboarding-mappers.js")
const u = (await db.collection("pa-users").doc(uid).get()).data()
const title = u.tags?.recentRoleTitle || ""
let role = []
if (typeof om.mapAnswerToRoleFunction === "function") role = om.mapAnswerToRoleFunction(title)
if (!role || role.length === 0) role = ["software_engineering"] // title maps to SWE; explicit fallback
const cleanLocations = ["new_york_metro", "san_francisco_bay_area"] // what the user actually said: "nye or sf"

console.log(`mode=${APPLY?"APPLY":"DRY"}`)
console.log(`résumé title: ${JSON.stringify(title)} → targetRoleFunction: ${JSON.stringify(role)}`)
console.log(`targetLocations: ${JSON.stringify(u.tags?.targetLocations)}  →  ${JSON.stringify(cleanLocations)}`)

if (APPLY) {
  await db.collection("pa-users").doc(uid).update({
    "tags.targetRoleFunction": role,
    "tags.targetLocations": cleanLocations,
    "tags.lastUpdatedFromChat": new Date().toISOString(),
  })
  console.log("APPLIED.")
}

// Prove the seed yields candidate jobs (raw hard-filter query, same axis as V16 step 2).
const mj = await db.collection("matching-jobs").where("status","==","active")
  .where("roleFunction","array-contains-any",role).limit(10).get().catch(e=>({size:-1,_err:e.message}))
console.log(`\nactive matching-jobs with roleFunction ∈ ${JSON.stringify(role)}: ${mj.size}${mj._err?` (ERR ${mj._err})`:""}`)
if (mj.size>0) mj.docs.slice(0,5).forEach(d=>{const j=d.data(); console.log(`  • ${j.title} @ ${j.company||j.employer||"?"} | loc=${JSON.stringify((j.locationBuckets||[]).slice(0,3))} | fresh=${j.firstSeenAt}`)})
process.exit(0)
