// COLD reinit — wipe a user to a brand-new cold sender so "Hi" runs the FULL fresh onboarding
// (NO pitch from old data). loadGlobalContext (agent.ts) reads MANY fields beyond tags: top-level
// `displayName`, `experienceHighlights`, plus globalTags/candidateContext/coresignal*/linkedin*.
// Clearing only `tags` is NOT enough (that left the pitch alive). Strategy: keep a small identity/
// routing/canary KEEP-set, DELETE every other field, reset tags+onboarding, delete context docs.
//
//   PA_ENV_PATH=../../.env node --import tsx .ops/reinit-user-cold.mjs [uid] [--apply]
//   default uid = 8fEwIduUrzxZsblHHsNz (+14243201960 canary).  DRY unless --apply.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"

const args = process.argv.slice(2)
const APPLY = args.includes("--apply")
const uid = args.find((a) => a !== "--apply") ?? "8fEwIduUrzxZsblHHsNz"

let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const FV = admin.firestore.FieldValue
const now = new Date().toISOString()

// Fields a COLD user keeps: identity, Sendblue routing, canary/runtime config, audit stamps.
// EVERYTHING else (profile / résumé / enrichment / conversation / onboarding) is deleted.
const KEEP = new Set([
  "id", "phoneE164", "phoneE164Source", "email", "createdAt",
  "testMode", "runtimeMode", "runtimeModeAt", "runtimeModeReason", "runtimeModeSetBy",
  "versionChannel", "versionChannelAt", "versionChannelSetBy",
  "senderNumber", "senderGroupId", "senderAssignedAt", "senderAssignedSource",
  "source", "firstTouchCampaign", "signupSource", "resetEpoch",
  "reinitColdAt", "reinitFreshAt", "reinitializedAt",
  // explicitly re-set below:
  "tags", "onboardingState", "onboardingStatus", "enrichmentInFlight", "updatedAt",
])

const snap = await db.collection("pa-users").doc(uid).get()
if (!snap.exists) { console.log(`!! pa-users/${uid} missing`); process.exit(1) }
const u = snap.data()
const deleteKeys = Object.keys(u).filter((k) => !KEEP.has(k))
console.log(`=== reinit-user-cold ${uid}  mode=${APPLY ? "APPLY" : "DRY"} ===`)
console.log(`phone=${u.phoneE164} displayName=${u.displayName ?? "-"} experienceHighlights=${Array.isArray(u.experienceHighlights) ? u.experienceHighlights.length : 0} skills=${(u.tags?.skills?.length) ?? 0}`)
console.log(`DELETE ${deleteKeys.length} profile fields: [${deleteKeys.join(", ")}]`)

const resumes = new Set()
for (const f of ["userId", "candidateId"]) { const r = await db.collection("parsedCandidateResumes").where(f, "==", uid).get().catch(() => ({ docs: [] })); r.docs.forEach((d) => resumes.add(d.id)) }
// SUPER-CLEAN (dev phone). The dedup source getRecentSentMessages reads pa-messages by sessionId, but
// the old reinit deleted them ONLY by userId — any doc the thin path wrote without a matching userId
// survived → a fresh "Hi" reply matched leftover history → suppressed ("no response"). Wipe pa-sessions
// AND pa-messages by EVERY owner key: userId, candidateId, and sessionId (the dedup's actual read key).
const sessSet = new Set()
for (const f of ["userId", "candidateId"]) {
  const r = await db.collection("pa-sessions").where(f, "==", uid).get().catch(() => ({ docs: [] }))
  r.docs.forEach((d) => sessSet.add(d.id))
}
const sess = [...sessSet]
const msgSet = new Set()
for (const f of ["userId", "candidateId"]) {
  const r = await db.collection("pa-messages").where(f, "==", uid).get().catch(() => ({ docs: [] }))
  r.docs.forEach((d) => msgSet.add(d.id))
}
for (const sid of sess) {
  const r = await db.collection("pa-messages").where("sessionId", "==", sid).get().catch(() => ({ docs: [] }))
  r.docs.forEach((d) => msgSet.add(d.id))
}
const msgs = [...msgSet]
const ps = (await db.collection("pa-prescreen-sessions").where("userId", "==", uid).get()).docs.map((d) => d.id)
const recJobs = (await db.collection("pa-user-job-recommendations").doc(uid).collection("jobs").get().catch(() => ({ docs: [] }))).docs.map((d) => d.id)
// IDENTITY (2026-06-04): cold = truly UNKNOWN, so clear the LinkedIn bind handle too — otherwise a
// lingering `pa-candidate-handles {kind:linkedin}` row makes candidateHasLinkedinBind() return true
// while the profile is empty (the inconsistent state that suppressed the cold LinkedIn offer). KEEP
// the phone/email handles — they're how inbound resolves to THIS uid (deleting the phone handle
// re-triggers the duplicate-pa-users-doc flap).
const linkedinHandles = (await db.collection("pa-candidate-handles").where("candidateId", "==", uid).get().catch(() => ({ docs: [] })))
  .docs.filter((d) => String(d.data()?.kind ?? "").toLowerCase().startsWith("linkedin")).map((d) => d.id)
console.log(`DELETE docs: parsedResumes=${resumes.size} messages=${msgs.length} sessions=${sess.length} prescreen=${ps.length} recJobs=${recJobs.length} linkedinHandles=${linkedinHandles.length}`)
if (!APPLY) { console.log("\nDRY — 0 writes. Re-run with --apply."); process.exit(0) }

// update() so the `tags` map is REPLACED (set+merge would deep-merge and keep old tag fields).
const patch = { tags: { schemaVersion: 2 }, onboardingState: "pending", onboardingStatus: "invited", enrichmentInFlight: false, reinitColdAt: now, updatedAt: now }
for (const k of deleteKeys) patch[k] = FV.delete()
await db.collection("pa-users").doc(uid).update(patch)

const del = async (coll, ids) => { for (let i = 0; i < ids.length; i += 400) { const b = db.batch(); ids.slice(i, i + 400).forEach((id) => b.delete(db.collection(coll).doc(id))); await b.commit() } }
await del("parsedCandidateResumes", [...resumes]); await del("pa-messages", msgs); await del("pa-sessions", sess); await del("pa-prescreen-sessions", ps)
await del("pa-candidate-handles", linkedinHandles)
for (let i = 0; i < recJobs.length; i += 400) { const b = db.batch(); recJobs.slice(i, i + 400).forEach((id) => b.delete(db.collection("pa-user-job-recommendations").doc(uid).collection("jobs").doc(id))); await b.commit() }
await db.collection("pa-user-job-recommendations").doc(uid).delete().catch(() => {})

// verify loadGlobalContext would be starved AND the LinkedIn bind is gone (so the cold opener offers LinkedIn)
const c = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
const liRemain = (await db.collection("pa-candidate-handles").where("candidateId", "==", uid).get().catch(() => ({ docs: [] })))
  .docs.filter((d) => String(d.data()?.kind ?? "").toLowerCase().startsWith("linkedin")).length
const clean = !c.displayName && !(Array.isArray(c.experienceHighlights) && c.experienceHighlights.length) && (c.tags?.skills?.length ?? 0) === 0 && !c.globalTags && !c.candidateContext && c.onboardingState === "pending" && liRemain === 0
console.log(`\nremaining keys: [${Object.keys(c).sort().join(", ")}]  linkedinHandlesRemaining=${liRemain}`)
console.log(clean ? `\n✅ ${uid} COLD + UNBOUND. loadGlobalContext starved + no LinkedIn bind → "Hi" runs fresh onboarding WITH the LinkedIn offer.` : `\n⚠️ residual profile fields or a LinkedIn handle remains — inspect above.`)
process.exit(0)
