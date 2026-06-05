// COMPLETE delete of a user's INFO (Adam 2026-06-03: "delete completely 4243201960 user info; then test").
// Wipes EVERY per-user doc across the marketplace collections (coverage derived from the admin
// delete-user tool), then resets pa-users/{uid} to a BARE canary identity shell so the phone still
// resolves to the SAME uid (stays in the dev cohort → offer-first) with thread continuity on its
// sender number. This is stronger than reinit-user-cold (which only resets fields).
//
//   PA_ENV_PATH=/abs/.env node --import tsx .ops/complete-delete-user.mjs [uid] [--apply]
//   default uid = 8fEwIduUrzxZsblHHsNz (+14243201960 canary). DRY unless --apply.
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

// Collections scoped by a query field == uid (chunked batch delete, 400/batch).
const BY_USERID = [
  "pa-messages", "pa-sessions", "pa-prescreen-sessions", "pa-agent-turns", "pa-turns",
  "pa-inbound-events", "pa-outbound", "pa-conversation-archives", "pa-message-archives",
  "pa-conversation-summaries", "pa-memory-facts", "pa-memory-actions", "pa-memory-events",
  "pa-memory-profiles", "pa-memory-evolution-events", "pa-surprise-events", "pa-tag-events",
  "pa-tapback-events", "pa-scheduled-jobs", "pa-tool-calls", "pa-abuse-events", "pa-rate-limits",
  "pa-cv-pending", "pa-job-profiles", "pa-job-rec-explanations", "pa-pending-outbound",
  "pa-interview-bookings", "parsedCandidateResumes", "pa-cv-upload-tokens", "pa-linkedin-connect-tokens",
]
const BY_CANDIDATEID = [
  "pa-candidate-handles", "pa-candidate-job-states", "pa-candidate-job-matches",
  "pa-employer-visible-profiles", "pa-outbound-invites", "pa-feedback-events",
  "pa-correction-events", "pa-candidate-identity-events", "pa-candidate-source-links",
  "pa-candidate-auth", "parsedCandidateResumes",
]
const BY_PHONECANDIDATEID = ["pa-connect-phone-codes"]
const DOC_ID = ["pa-candidate-self-profiles"] // doc id == uid

async function delByField(coll, field, val) {
  let total = 0
  while (true) {
    const snap = await db.collection(coll).where(field, "==", val).limit(400).get().catch(() => ({ empty: true, docs: [] }))
    if (snap.empty || snap.docs.length === 0) break
    if (APPLY) { const b = db.batch(); snap.docs.forEach((d) => b.delete(d.ref)); await b.commit() }
    total += snap.docs.length
    if (snap.docs.length < 400) break
  }
  return total
}
async function delSubcollection(parentPath, sub) {
  let total = 0
  while (true) {
    const snap = await db.doc(parentPath).collection(sub).limit(400).get().catch(() => ({ empty: true, docs: [] }))
    if (snap.empty || snap.docs.length === 0) break
    if (APPLY) { const b = db.batch(); snap.docs.forEach((d) => b.delete(d.ref)); await b.commit() }
    total += snap.docs.length
    if (snap.docs.length < 400) break
  }
  return total
}

const snap = await db.collection("pa-users").doc(uid).get()
if (!snap.exists) { console.log(`!! pa-users/${uid} missing`); process.exit(1) }
const u = snap.data()
console.log(`=== complete-delete ${uid}  mode=${APPLY ? "APPLY" : "DRY"} ===`)
console.log(`phone=${u.phoneE164} sender=${u.senderNumber} displayName=${u.displayName ?? "-"} skills=${(u.tags?.skills?.length) ?? 0}`)

const counts = {}
for (const c of new Set(BY_USERID)) counts[`${c}[userId]`] = await delByField(c, "userId", uid)
for (const c of new Set(BY_USERID)) counts[`${c}[candidateId]`] = (counts[`${c}[candidateId]`] ?? 0) + await delByField(c, "candidateId", uid)
for (const c of new Set(BY_CANDIDATEID)) counts[`${c}[candidateId]`] = (counts[`${c}[candidateId]`] ?? 0) + await delByField(c, "candidateId", uid)
for (const c of BY_PHONECANDIDATEID) counts[`${c}[phoneCandidateId]`] = await delByField(c, "phoneCandidateId", uid)
counts["pa-entity-tags/items"] = await delSubcollection(`pa-entity-tags/pa-user:${uid}`, "items")
counts["pa-user-job-recommendations/jobs"] = await delSubcollection(`pa-user-job-recommendations/${uid}`, "jobs")
for (const c of DOC_ID) { if (APPLY) await db.collection(c).doc(uid).delete().catch(() => {}); counts[`${c}/{uid}`] = "deleted" }
if (APPLY) {
  await db.doc(`pa-entity-tags/pa-user:${uid}`).delete().catch(() => {})
  await db.doc(`pa-user-job-recommendations/${uid}`).delete().catch(() => {})
}

const nonzero = Object.fromEntries(Object.entries(counts).filter(([, v]) => v && v !== 0))
console.log("deleted:", JSON.stringify(nonzero, null, 0))

// Reset pa-users/{uid} → BARE canary identity shell (keep identity/routing/canary; drop ALL else).
const KEEP = new Set([
  "id", "phoneE164", "phoneE164Source", "email", "createdAt",
  "testMode", "runtimeMode", "runtimeModeAt", "runtimeModeReason", "runtimeModeSetBy",
  "versionChannel", "versionChannelAt", "versionChannelSetBy",
  "senderNumber", "senderGroupId", "senderAssignedAt", "senderAssignedSource",
  "source", "firstTouchCampaign", "signupSource",
  "tags", "onboardingState", "onboardingStatus", "enrichmentInFlight", "updatedAt", "completeDeletedAt",
])
const deleteKeys = Object.keys(u).filter((k) => !KEEP.has(k))
const patch = { tags: { schemaVersion: 2 }, onboardingState: "pending", onboardingStatus: "invited", enrichmentInFlight: false, completeDeletedAt: now, updatedAt: now }
for (const k of deleteKeys) patch[k] = FV.delete()
console.log(`\npa-users reset: DELETE ${deleteKeys.length} fields [${deleteKeys.join(", ")}]`)
if (!APPLY) { console.log("\nDRY — 0 writes. Re-run with --apply."); process.exit(0) }
await db.collection("pa-users").doc(uid).update(patch)
console.log(`\n✅ ${uid} COMPLETELY DELETED → bare canary shell (uid+phone+sender kept). "Hi" runs fresh offer-first.`)
console.log("   NOTE: mem0/Qdrant vectors NOT wiped by this script (not read by cold onboarding); admin paAdminDeleteUser covers that.")
process.exit(0)
