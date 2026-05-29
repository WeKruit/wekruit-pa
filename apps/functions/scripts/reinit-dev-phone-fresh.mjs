// Fresh-onboarding reinit for the dev phone (+14243201960) so Adam can test the FULL
// prompt→extractor→tags→matcher loop end-to-end: text → onboarding captures
// (open-to-anything/visa/salary) → canonical tags → matcher. Keeps résumé-derived
// tags (skills/yoe/embedding) so matching has substance; clears chat-derived intent
// tags + conversation + onboarding state so capture re-runs from scratch.
//   PA_ENV_PATH=.env node .ops/reinit-dev-phone-fresh.mjs            (DRY)
//   PA_ENV_PATH=.env node .ops/reinit-dev-phone-fresh.mjs --apply    (APPLY)
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
const APPLY = process.argv.includes("--apply")
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const PHONE = "+14243201960"
const now = new Date().toISOString()

// 1. Resolve phone → userId (query pa-users.phoneE164; assert single).
const q = await db.collection("pa-users").where("phoneE164", "==", PHONE).get()
const ids = q.docs.map(d => d.id)
console.log(`=== reinit-dev-phone-fresh  mode=${APPLY?"APPLY":"DRY"} ===`)
console.log(`phone ${PHONE} → pa-users: ${JSON.stringify(ids)}`)
if (ids.length !== 1) { console.log(`!! expected exactly 1 user, got ${ids.length}. Aborting (resolve manually).`); process.exit(1) }
const uid = ids[0]
const u = q.docs[0].data()
const tags = u.tags || {}

// 2. Chat-derived INTENT tags to CLEAR (onboarding/chat re-captures these canonically).
const CLEAR_INTENT = ["targetRoleFunction","negativeRoleFunction","roleFunctionNegativeList","targetLocations",
  "targetCountry","industrySector","negativeIndustrySector","visaStatus","minSalary","companySize","prefersStartup",
  "targetJobType","targetCompanyTags","companyNegativeList","companyPositiveList","urgentlySeeking","careerStage","relevantTags"]
const keptTagKeys = Object.keys(tags).filter(k => !CLEAR_INTENT.includes(k))
const newTags = {}; for (const k of keptTagKeys) newTags[k] = tags[k]
newTags.schemaVersion = 2
console.log(`tags: clearing intent [${CLEAR_INTENT.filter(k=>tags[k]!==undefined).join(", ")||"none set"}]`)
console.log(`tags: keeping résumé [${keptTagKeys.join(", ")||"none"}] (skills:${(tags.skills?.length??0)})`)

// 3. Conversation + prescreen + session + onboarding docs to clear.
const msgs = await db.collection("pa-messages").where("userId","==",uid).get()
const ps = await db.collection("pa-prescreen-sessions").where("userId","==",uid).get()
const sess = await db.collection("pa-sessions").where("userId","==",uid).get()
console.log(`clear: pa-messages=${msgs.size} pa-prescreen-sessions=${ps.size} pa-sessions=${sess.size}`)
console.log(`onboardingState → pending | sharedOnboarding/workSession → removed`)
if (!APPLY) { console.log("\nDRY — 0 writes. Re-run with --apply."); process.exit(0) }

// ---- APPLY ----
// update() (NOT set+merge) so the `tags` MAP is REPLACED wholesale with newTags
// (kept keys only) — set+merge deep-merges nested maps, so cleared intent keys
// would survive. update() sets the field value outright.
await db.collection("pa-users").doc(uid).update({
  tags: newTags,
  onboardingState: "pending",
  onboardingStatus: "invited",
  sharedOnboarding: admin.firestore.FieldValue.delete(),
  workSession: admin.firestore.FieldValue.delete(),
  reinitFreshAt: now,
  updatedAt: now,
})
const del = async (snap) => { if (!snap.size) return; const b = db.batch(); snap.docs.forEach(d=>b.delete(d.ref)); await b.commit() }
await del(msgs); await del(ps); await del(sess)
console.log(`\nAPPLIED. ${uid} reset to fresh onboarding. Text "Hello, WeKruit! ${uid}" (or just say hi) to start.`)
