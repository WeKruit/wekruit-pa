// Reset + résumé-enrich the dev-phone candidate LF8 (Adam) "as if just finished onboarding from
// résumé". Merges 8fE's parsed-résumé tags → LF8.tags, copies the parsed-résumé doc to LF8, clears
// LF8's conversation (pa-messages) + prescreen sessions + session doc so thin starts fresh.
//
//   PA_ENV_PATH=.env node .ops/reset-enrich-dev-phone.mjs            (DRY-RUN: plan + counts)
//   PA_ENV_PATH=.env node .ops/reset-enrich-dev-phone.mjs --apply    (APPLY)
//
// Run from apps/functions (firebase-admin resolves there).
import { readFileSync } from "node:fs"
import admin from "firebase-admin"

const APPLY = process.argv.includes("--apply")
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const KEEP = "LF8blURXyFBaeF7bhupu"   // Adam — the doc the dev phone resolves to
const RESUME_SRC = "8fEwIduUrzxZsblHHsNz" // Shixiang/Tesla — the résumé-enriched doc
const now = new Date().toISOString()
console.log(`=== reset-enrich-dev-phone  mode=${APPLY ? "APPLY" : "DRY-RUN"} ===`)
console.log(`KEEP=${KEEP}  RESUME_SRC=${RESUME_SRC}`)

const keep = (await db.collection("pa-users").doc(KEEP).get()).data() || {}
const src = (await db.collection("pa-users").doc(RESUME_SRC).get()).data() || {}

// 1. résumé-derived tag fields to set on LF8 (the freshly-onboarded-from-résumé profile).
const RESUME_FIELDS = [
  "skills", "yoeRange", "industrySector", "relevantIndustry", "relevantTags", "recentCompany",
  "recentRoleTitle", "workHistorySummary", "proposedTags", "targetRoleFunction", "careerStage",
  "targetJobType", "industryEnum", "relevantSpecialization", "embedding", "embeddingModel",
  "embeddingComputedAt", "lastUpdatedFromCv",
]
const srcTags = src.tags || {}, keepTags = keep.tags || {}
const newTags = { ...keepTags }
const applied = []
for (const f of RESUME_FIELDS) {
  if (srcTags[f] !== undefined) { newTags[f] = srcTags[f]; applied.push(f) }
}
newTags.schemaVersion = 2
newTags.lastUpdatedFromChat = now
// drop the stale chat-only negative/positive role intent so it's purely résumé-derived
delete newTags.negativeRoleFunction
console.log("\n-- TAG MERGE (résumé → LF8) --")
console.log("  setting fields:", applied.join(", "))
console.log("  targetRoleFunction:", JSON.stringify(keepTags.targetRoleFunction), "->", JSON.stringify(newTags.targetRoleFunction))
console.log("  careerStage:", keepTags.careerStage, "->", newTags.careerStage, "| skills:", (newTags.skills?.length ?? 0))

// 2. parsed résumé doc → copy to LF8
const srcResumeQ = await db.collection("parsedCandidateResumes").where("userId", "==", RESUME_SRC).limit(1).get()
const srcResume = srcResumeQ.docs[0]?.data()
console.log("\n-- RÉSUMÉ DOC -- found for src:", !!srcResume, srcResume ? `(${srcResume.topSkills?.length ?? 0} skills, ${srcResume.totalYearsExperience ?? "?"}y)` : "")

// 3. clear conversation + prescreen + session for a fresh thin start
const msgs = await db.collection("pa-messages").where("userId", "==", KEEP).get()
const ps = await db.collection("pa-prescreen-sessions").where("userId", "==", KEEP).get()
const sess = await db.collection("pa-sessions").where("userId", "==", KEEP).get()
console.log("\n-- RESET (delete) --")
console.log(`  pa-messages: ${msgs.size}  pa-prescreen-sessions: ${ps.size}  pa-sessions: ${sess.size}`)
console.log("  onboardingState -> complete | onboardingStatus -> active")
console.log("  (Qdrant mem0 is legacy + not read by thin; thin memory = pa-messages, cleared above)")

if (!APPLY) { console.log("\nDRY-RUN — 0 writes. Re-run with --apply."); process.exit(0) }

// ---- APPLY ----
await db.collection("pa-users").doc(KEEP).set({
  tags: newTags,
  onboardingState: "complete",
  onboardingStatus: "active",
  updatedAt: now,
  resumeEnrichedFrom: RESUME_SRC,
}, { merge: true })
if (srcResume) await db.collection("parsedCandidateResumes").doc(KEEP).set({ ...srcResume, userId: KEEP, copiedFrom: RESUME_SRC, copiedAt: now }, { merge: true })
const del = async (snap) => { const b = db.batch(); snap.docs.forEach(d => b.delete(d.ref)); if (snap.size) await b.commit() }
await del(msgs); await del(ps); await del(sess)
console.log("\nAPPLIED. LF8 reset + résumé-enriched. tags.targetRoleFunction:", JSON.stringify(newTags.targetRoleFunction), "| skills:", newTags.skills?.length ?? 0)
