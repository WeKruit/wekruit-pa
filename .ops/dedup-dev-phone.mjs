// Dedup the dev-phone (+14243201960) identity duplicate. DRY-RUN BY DEFAULT.
//
//   PA_ENV_PATH=.env node .ops/dedup-dev-phone.mjs                  (dry-run: prints plan + writes backup, ZERO Firestore writes)
//   PA_ENV_PATH=.env node .ops/dedup-dev-phone.mjs --label=manual1  (dry-run, custom backup label)
//   PA_ENV_PATH=.env node .ops/dedup-dev-phone.mjs --apply --label=manual1   (APPLY — performs writes; run by a human only)
//
// Context (Adam 2026-05-28): phone +14243201960 maps to TWO pa-users docs:
//   KEEP  = LF8blURXyFBaeF7bhupu  ("Adam Yang")     — active live conversation,
//           statedPreferences (crypto/fintech/AI, NYC/remote, early_startup,
//           sponsorship_needed), postMatchRetention. OLDEST createdAt -> the
//           doc the resolver now deterministically keeps.
//   ORPHAN = 8fEwIduUrzxZsblHHsNz ("Shixiang Yang") — later resume upload,
//           parsed Tesla resume: 63 skills + targetRoleFunction=[software_engineering]
//           + careerStage=intern + targetJobType=[internship].
//
// Plan: additively merge the resume-derived tags WORTH keeping from ORPHAN into
// KEEP.tags, then tombstone ORPHAN.phoneE164 so the resolver only ever finds KEEP.
//
// CONFLICT FLAGGED FOR HUMAN DECISION (NOT auto-merged): the orphan resume says
// careerStage=intern / targetJobType=[internship], but the live chat user states
// 3yr SWE. Merging intern/internship would corrupt KEEP's seniority + job-type
// matching. This script SKIPS those two fields and prints them under CONFLICTS.
import { readFileSync, writeFileSync } from "node:fs"
import admin from "firebase-admin"

// ---------- args ----------
const APPLY = process.argv.includes("--apply")
const labelArg = process.argv.find((a) => a.startsWith("--label="))
const LABEL = (labelArg ? labelArg.split("=")[1] : "dryrun").replace(/[^A-Za-z0-9_-]/g, "")

const PHONE = "+14243201960"
const KEEP_ID = "LF8blURXyFBaeF7bhupu" // Adam Yang — active conversation, oldest createdAt
const ORPHAN_ID = "8fEwIduUrzxZsblHHsNz" // Shixiang Yang — later resume orphan
const TOMBSTONE_PHONE = `${PHONE}__merged_${ORPHAN_ID}`

// Resume-derived tag fields to ADDITIVELY merge orphan -> keep.
const MERGE_TAG_FIELDS = ["skills", "targetRoleFunction", "relevantTags", "relevantIndustry", "industrySector"]
// Fields DELIBERATELY NOT merged because they conflict with the live 3yr-SWE chat.
const CONFLICT_TAG_FIELDS = ["careerStage", "targetJobType"]

// ---------- bootstrap (mirrors .ops/enable-canary.mjs) ----------
const txt = readFileSync(process.env.PA_ENV_PATH, "utf8")
const m = txt.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)
if (!m) throw new Error("no FIREBASE_SERVICE_ACCOUNT_JSON (set PA_ENV_PATH to a .env with it)")
let raw = m[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const j = (v) => JSON.stringify(v)
const arr = (v) => (Array.isArray(v) ? v : [])
const tagCount = (v) => (Array.isArray(v) ? v.length : v === undefined ? "(unset)" : typeof v)

console.log(`=== dedup-dev-phone  mode=${APPLY ? "APPLY" : "DRY-RUN"}  label=${LABEL} ===`)
console.log(`phone=${PHONE}  KEEP=${KEEP_ID}  ORPHAN=${ORPHAN_ID}`)

// ---------- 1. read BOTH docs ----------
const keepSnap = await db.collection("pa-users").doc(KEEP_ID).get()
const orphanSnap = await db.collection("pa-users").doc(ORPHAN_ID).get()
if (!keepSnap.exists) { console.error(`KEEP doc ${KEEP_ID} does not exist — aborting.`); process.exit(1) }
if (!orphanSnap.exists) { console.error(`ORPHAN doc ${ORPHAN_ID} does not exist — aborting.`); process.exit(1) }
const keep = keepSnap.data() || {}
const orphan = orphanSnap.data() || {}
const keepTags = keep.tags || {}
const orphanTags = orphan.tags || {}

// Sanity: confirm BOTH still actually carry this phone before we plan a merge.
console.log("\n--- sanity ---")
console.log(`  KEEP.phoneE164   = ${keep.phoneE164}  (name=${keep.name ?? keep.displayName ?? "?"}, createdAt=${keep.createdAt})`)
console.log(`  ORPHAN.phoneE164 = ${orphan.phoneE164}  (name=${orphan.name ?? orphan.displayName ?? "?"}, createdAt=${orphan.createdAt})`)
if (orphan.phoneE164 !== PHONE) {
  console.log(`  NOTE: ORPHAN.phoneE164 is not ${PHONE} (already tombstoned/changed?) — review before --apply.`)
}

// ---------- 2. write JSON backup of BOTH full docs (always, even in dry-run) ----------
const backup = {
  generatedAtLabel: LABEL,
  mode: APPLY ? "apply" : "dry-run",
  phone: PHONE,
  keep: { id: KEEP_ID, data: keep },
  orphan: { id: ORPHAN_ID, data: orphan },
}
const backupPath = new URL(`./dedup-backup-${LABEL}.json`, import.meta.url)
writeFileSync(backupPath, JSON.stringify(backup, null, 2))
console.log(`\nBACKUP written: ${backupPath.pathname}`)
console.log(`  (full snapshot of BOTH docs — restore source if --apply is later reverted)`)

// ---------- 3. compute + print merge plan ----------
console.log("\n=== MERGE PLAN (additive: ORPHAN resume tags -> KEEP.tags) ===")
const tagUpdates = {}
for (const field of MERGE_TAG_FIELDS) {
  const orphanVal = orphanTags[field]
  const keepVal = keepTags[field]
  if (Array.isArray(orphanVal)) {
    // additive union, KEEP values first (stable), de-duped
    const merged = Array.from(new Set([...arr(keepVal), ...orphanVal]))
    const added = orphanVal.filter((x) => !arr(keepVal).includes(x))
    if (added.length > 0) {
      tagUpdates[field] = merged
      console.log(`  + tags.${field}: KEEP has ${tagCount(keepVal)} -> add ${added.length} from ORPHAN -> ${merged.length} total`)
      console.log(`      added: ${j(added.slice(0, 12))}${added.length > 12 ? ` …(+${added.length - 12})` : ""}`)
    } else {
      console.log(`  = tags.${field}: no new values from ORPHAN (KEEP already has all ${tagCount(keepVal)})`)
    }
  } else if (orphanVal !== undefined && keepVal === undefined) {
    // scalar present on orphan, absent on keep -> safe to copy (none of these are the conflict fields)
    tagUpdates[field] = orphanVal
    console.log(`  + tags.${field}: KEEP unset -> copy ORPHAN value ${j(orphanVal)}`)
  } else {
    console.log(`  = tags.${field}: KEEP=${tagCount(keepVal)} ORPHAN=${tagCount(orphanVal)} (no change)`)
  }
}

console.log("\n=== CONFLICTS — NOT MERGED (human decision required) ===")
for (const field of CONFLICT_TAG_FIELDS) {
  console.log(`  ! tags.${field}: ORPHAN(resume)=${j(orphanTags[field])}  KEEP(chat)=${j(keepTags[field])}`)
}
console.log("  Reason: ORPHAN resume parsed as intern/internship, but the LIVE chat user")
console.log("  states 3yr SWE. Merging would corrupt KEEP seniority + job-type matching.")
console.log("  -> Decide careerStage / targetJobType for KEEP manually, then set explicitly.")

console.log("\n=== TOMBSTONE (so resolver only ever finds KEEP) ===")
console.log(`  ORPHAN ${ORPHAN_ID}:`)
console.log(`    phoneE164:        ${orphan.phoneE164}  ->  ${TOMBSTONE_PHONE}`)
console.log(`    phoneE164Source:  -> "dedup_merged_${LABEL}"`)
console.log(`    mergedInto:       -> ${KEEP_ID}`)
console.log(`    mergedAt:         -> (set at apply time)`)
console.log(`    runtimeMode:      -> "paused"  (orphan should never drive a live turn again)`)

// ---------- 4. apply (guarded) ----------
if (!APPLY) {
  console.log("\n=== DRY-RUN COMPLETE — 0 Firestore writes. ===")
  console.log("Re-run with --apply (and the SAME --label) to perform the merge + tombstone.")
  process.exit(0)
}

// ---- APPLY PATH (only runs with explicit --apply; a human runs this) ----
const isoNow = new Date().toISOString()
console.log("\n=== APPLYING (explicit --apply) ===")
if (Object.keys(tagUpdates).length > 0) {
  const tagsPatch = {}
  for (const [k, v] of Object.entries(tagUpdates)) tagsPatch[`tags.${k}`] = v
  await db.collection("pa-users").doc(KEEP_ID).set(
    { tags: { ...keepTags, ...tagUpdates }, updatedAt: isoNow, dedupMergedFrom: ORPHAN_ID, dedupMergedAt: isoNow },
    { merge: true },
  )
  console.log(`  KEEP ${KEEP_ID}: merged tag fields [${Object.keys(tagUpdates).join(", ")}]`)
} else {
  console.log(`  KEEP ${KEEP_ID}: no tag updates to write`)
}
await db.collection("pa-users").doc(ORPHAN_ID).set(
  {
    phoneE164: TOMBSTONE_PHONE,
    phoneE164Source: `dedup_merged_${LABEL}`,
    mergedInto: KEEP_ID,
    mergedAt: isoNow,
    runtimeMode: "paused",
    runtimeModeAt: isoNow,
    runtimeModeSetBy: `dedup-dev-phone ${LABEL}`,
    updatedAt: isoNow,
  },
  { merge: true },
)
console.log(`  ORPHAN ${ORPHAN_ID}: phoneE164 tombstoned -> ${TOMBSTONE_PHONE}, mergedInto=${KEEP_ID}, runtimeMode=paused`)
console.log("\n=== APPLY COMPLETE. Re-run resolver/probe to confirm phone resolves only to KEEP. ===")
process.exit(0)
