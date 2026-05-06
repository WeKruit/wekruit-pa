#!/usr/bin/env node
/**
 * Phase 54 (USER-TAG-04) — pa-users.tags migration script.
 *
 * Reads existing user fragments (parsedCandidateResumes, statedPreferences,
 * legacy industryTags) and composes a unified `pa-users/{userId}.tags`
 * document. Idempotent: running twice on the same data produces the same
 * tags doc.
 *
 * Default DRY-RUN: writes proposed merge + diff to
 * `pa-users-tags-migration-audit/{userId}` for Adam to review. Use
 * `--apply` to write the actual `pa-users.{userId}.tags` field.
 *
 * Modes:
 *   --user <uid>         single-user testing
 *   --limit <N>           stop after N users
 *   --apply               actually write to pa-users.tags (default: dry-run)
 *   --audit-only          list users missing tags doc, no merge attempt
 *   --project <id>        Firebase project (default: wekruit-5f89b)
 *
 * Output: per-user log lines + final JSON summary.
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON env.
 *
 * Usage:
 *   node apps/functions/scripts/migrate-pa-users-tags.mjs                  # dry-run all
 *   node apps/functions/scripts/migrate-pa-users-tags.mjs --user U123      # single user
 *   node apps/functions/scripts/migrate-pa-users-tags.mjs --limit 10       # first 10
 *   node apps/functions/scripts/migrate-pa-users-tags.mjs --apply          # write
 *   node apps/functions/scripts/migrate-pa-users-tags.mjs --audit-only     # gap report
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

// ─── CLI flags ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const DRY_RUN = !argv.includes("--apply")
const AUDIT_ONLY = argv.includes("--audit-only")
const PROJECT = (() => {
  const idx = argv.indexOf("--project")
  return idx >= 0 ? argv[idx + 1] : "wekruit-5f89b"
})()
const SINGLE_USER = (() => {
  const idx = argv.indexOf("--user")
  return idx >= 0 ? argv[idx + 1] : null
})()
const LIMIT = (() => {
  const idx = argv.indexOf("--limit")
  return idx >= 0 ? parseInt(argv[idx + 1], 10) : 0
})()

// ─── Firebase init ────────────────────────────────────────────────────────────

function initFirebase() {
  if (getApps().length > 0) return
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (credPath) {
    try {
      const cred = JSON.parse(readFileSync(credPath, "utf8"))
      initializeApp({ credential: cert(cred), projectId: PROJECT })
      return
    } catch {
      // fall through
    }
  }
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (inlineJson) {
    try {
      const cred = JSON.parse(inlineJson)
      initializeApp({ credential: cert(cred), projectId: PROJECT })
      return
    } catch {
      // fall through
    }
  }
  initializeApp({ projectId: PROJECT })
}

// ─── Phase 52 vocab projections ──────────────────────────────────────────────
// Inline copies of the canonical vocab tokens used by mappers below — keeps
// the script standalone without requiring the workspace to be built.

const ROLE_FUNCTION_VOCAB = [
  "software_engineering",
  "engineering_and_development",
  "data_analysis",
  "product_management",
  "business_analyst",
  "creatives_and_design",
  "consultant",
  "accounting_and_finance",
  "marketing",
  "management_and_executive",
  "sales",
  "human_resources",
  "legal_and_compliance",
  "arts_and_entertainment",
  "education_and_training",
  "public_sector_and_government",
  "customer_service_and_support",
]

const VISA_VOCAB_4 = ["citizen", "permanent_resident", "sponsor_needed", "other"]

// CanonicalRole (statedPreferences) → ROLE_FUNCTION_VOCAB (Phase 52)
const ROLE_TO_FUNCTION = {
  swe: "software_engineering",
  ml: "data_analysis",
  data: "data_analysis",
  research: "data_analysis",
  pm: "product_management",
  em: "management_and_executive",
  designer: "creatives_and_design",
  ops: "engineering_and_development",
  marketing: "marketing",
  sales: "sales",
  founder: "management_and_executive",
  other: null,
}

// CanonicalLocation (statedPreferences) → LOCATION_VOCAB (Phase 52)
const LOCATION_TO_PHASE52 = {
  sf: "san_francisco_bay_area",
  nyc: "new_york_metro",
  seattle: "seattle_metro",
  la: "los_angeles_metro",
  boston: "boston_metro",
  chicago: "chicago_metro",
  austin: "austin_metro",
  shanghai: "shanghai",
  beijing: "beijing",
  hangzhou: "hangzhou",
  shenzhen: "shenzhen",
  guangzhou: "guangzhou",
  remote: "remote_united_states",
  anywhere: "remote_anywhere",
  china: null,
  other: null,
}

const VISA_LEGACY_TO_PHASE52 = {
  citizen: "citizen",
  gc: "permanent_resident",
  opt: "sponsor_needed",
  h1b: "sponsor_needed",
  sponsorship_needed: "sponsor_needed",
  unknown: "other",
}

function bucketYoe(yoe) {
  if (yoe == null || typeof yoe !== "number" || !Number.isFinite(yoe) || yoe < 0) return null
  if (yoe <= 1) return "0-1"
  if (yoe <= 3) return "2-3"
  if (yoe <= 6) return "4-6"
  if (yoe <= 10) return "7-10"
  return "10+"
}

function projectStatedPrefsToPhase52(prefs) {
  const out = {}
  if (!prefs || typeof prefs !== "object") return out

  // targetRole (CanonicalRole[]) → targetRoleFunction[]
  if (Array.isArray(prefs.targetRole) && prefs.targetRole.length > 0) {
    const mapped = []
    for (const r of prefs.targetRole) {
      const fn = ROLE_TO_FUNCTION[r]
      if (fn && !mapped.includes(fn)) mapped.push(fn)
    }
    if (mapped.length > 0) out.targetRoleFunction = mapped
  }

  // yoeRange ([min, max]) → bucket
  if (Array.isArray(prefs.yoeRange) && prefs.yoeRange.length === 2) {
    const bucket = bucketYoe(prefs.yoeRange[0])
    if (bucket) out.yoeRange = bucket
  }

  // visaStatus
  if (typeof prefs.visaStatus === "string" && VISA_LEGACY_TO_PHASE52[prefs.visaStatus]) {
    out.visaStatus = VISA_LEGACY_TO_PHASE52[prefs.visaStatus]
  }

  // targetLocations (CanonicalLocation[]) → Phase 52 LOCATION_VOCAB
  if (Array.isArray(prefs.targetLocations) && prefs.targetLocations.length > 0) {
    const mapped = []
    for (const l of prefs.targetLocations) {
      const tok = LOCATION_TO_PHASE52[l]
      if (tok && !mapped.includes(tok)) mapped.push(tok)
    }
    if (mapped.length > 0) out.targetLocations = mapped
  }

  if (prefs.prefersStartup === true) out.prefersStartup = true
  else if (prefs.prefersStartup === false) out.prefersStartup = false

  if (prefs.preferredLang === "zh" || prefs.preferredLang === "en" || prefs.preferredLang === "mixed") {
    out.preferredLang = prefs.preferredLang
  }
  return out
}

function projectCvSignalsToPhase52(cv) {
  const out = {}
  if (!cv || typeof cv !== "object") return out
  // Skills — full list, lowercased, deduped.
  const skills = []
  const seen = new Set()
  const ingest = (s) => {
    if (typeof s !== "string") return
    const norm = s.toLowerCase().trim().replace(/\s+/g, " ")
    if (!norm || seen.has(norm)) return
    seen.add(norm)
    skills.push(norm)
  }
  if (cv.candidateProfile && Array.isArray(cv.candidateProfile.skills)) {
    for (const s of cv.candidateProfile.skills) ingest(s)
  }
  if (Array.isArray(cv.workHistory)) {
    for (const w of cv.workHistory) {
      if (Array.isArray(w?.skills)) {
        for (const s of w.skills) ingest(s)
      }
    }
  }
  if (Array.isArray(cv.skills)) {
    for (const s of cv.skills) ingest(s)
  }
  if (skills.length > 0) out.skills = skills

  // industryTags (legacy 10-tag) → industryEnum
  if (Array.isArray(cv.industryTags) && cv.industryTags.length > 0) {
    out.industryEnum = cv.industryTags.filter((t) => typeof t === "string" && t.trim().length > 0)
  }

  // industries (Phase 52 42-token) — pass through if present.
  if (Array.isArray(cv.industries) && cv.industries.length > 0) {
    out.industrySector = cv.industries.filter((t) => typeof t === "string" && t.trim().length > 0)
  }
  if (Array.isArray(cv.relevantIndustry) && cv.relevantIndustry.length > 0) {
    out.relevantIndustry = cv.relevantIndustry.filter((t) => typeof t === "string" && t.trim().length > 0)
  }
  if (Array.isArray(cv.relevantSpecialization) && cv.relevantSpecialization.length > 0) {
    out.relevantSpecialization = cv.relevantSpecialization.filter((t) => typeof t === "string" && t.trim().length > 0)
  }
  if (Array.isArray(cv.proposedTags) && cv.proposedTags.length > 0) {
    out.proposedTags = cv.proposedTags.filter((t) => typeof t === "string" && t.trim().length > 0)
  }

  // Recent role + workHistorySummary
  const wh = Array.isArray(cv.workHistory) ? cv.workHistory[0] : null
  const ex = Array.isArray(cv.experiences) ? cv.experiences[0] : null
  if (wh?.title) out.recentRoleTitle = wh.title
  else if (ex?.title) out.recentRoleTitle = ex.title
  if (wh?.company) out.recentCompany = wh.company
  else if (ex?.company) out.recentCompany = ex.company

  if (Array.isArray(cv.embedding) && cv.embedding.length === 1536) {
    out.embedding = cv.embedding
    if (typeof cv.embeddingModel === "string") out.embeddingModel = cv.embeddingModel
    if (typeof cv.embeddingComputedAt === "string") out.embeddingComputedAt = cv.embeddingComputedAt
  }

  return out
}

// ─── Migration logic ──────────────────────────────────────────────────────────

async function getLatestParsedResume(db, userId) {
  try {
    const snap = await db
      .collection("parsedCandidateResumes")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get()
    if (snap.empty) return null
    return snap.docs[0].data()
  } catch (err) {
    // Index may not exist for non-prod project — degrade.
    return null
  }
}

function diffTagsObjects(existing, proposed) {
  const out = { added: {}, changed: {}, unchanged: 0 }
  const existingObj = existing ?? {}
  for (const [k, v] of Object.entries(proposed)) {
    if (!(k in existingObj)) out.added[k] = v
    else if (JSON.stringify(existingObj[k]) !== JSON.stringify(v)) out.changed[k] = { from: existingObj[k], to: v }
    else out.unchanged++
  }
  return out
}

async function migrateUser(db, userId, userData, opts) {
  const { dryRun, log } = opts
  // 1. Read latest resume.
  const cvDoc = await getLatestParsedResume(db, userId)
  const cvProj = projectCvSignalsToPhase52(cvDoc ?? {})
  const prefsProj = projectStatedPrefsToPhase52(userData?.statedPreferences)

  // 2. Compose unified tags.
  const merged = { schemaVersion: 1, ...cvProj, ...prefsProj }
  if (cvDoc) merged.lastUpdatedFromCv = userData?.updatedAt ?? new Date().toISOString()
  if (userData?.statedPreferences) {
    merged.lastUpdatedFromChat = userData.statedPreferences.updatedAt ?? new Date().toISOString()
  }

  // 3. Diff against existing tags (idempotency check).
  const existing = userData?.tags ?? null
  const diff = diffTagsObjects(existing, merged)
  const hasChanges = Object.keys(diff.added).length + Object.keys(diff.changed).length > 0

  if (dryRun) {
    // Write audit record only.
    try {
      await db.collection("pa-users-tags-migration-audit").doc(userId).set({
        userId,
        timestamp: new Date().toISOString(),
        proposed: merged,
        existing: existing ?? null,
        diff,
        hasChanges,
        cvSourceFound: cvDoc != null,
      })
    } catch (err) {
      log(`  AUDIT-WRITE-FAIL ${userId}: ${err?.message ?? String(err)}`)
    }
    return { mode: "dry-run", userId, hasChanges, addedKeys: Object.keys(diff.added).length, changedKeys: Object.keys(diff.changed).length }
  }

  // APPLY mode: write tags to pa-users.
  try {
    await db.collection("pa-users").doc(userId).set({ tags: merged }, { merge: true })
    return { mode: "applied", userId, hasChanges, addedKeys: Object.keys(diff.added).length, changedKeys: Object.keys(diff.changed).length }
  } catch (err) {
    return { mode: "error", userId, error: err?.message ?? String(err) }
  }
}

async function auditOnly(db) {
  let total = 0
  let withTags = 0
  const missing = []
  let lastDoc = null
  while (true) {
    let q = db.collection("pa-users").orderBy("__name__").limit(200)
    if (lastDoc) q = q.startAfter(lastDoc)
    const snap = await q.get()
    if (snap.empty) break
    lastDoc = snap.docs[snap.docs.length - 1]
    for (const doc of snap.docs) {
      total++
      const d = doc.data()
      if (d?.tags && typeof d.tags === "object" && !Array.isArray(d.tags)) withTags++
      else missing.push(doc.id)
      if (LIMIT > 0 && total >= LIMIT) break
    }
    if (LIMIT > 0 && total >= LIMIT) break
    if (snap.docs.length < 200) break
  }
  return { total, withTags, missing }
}

async function main() {
  console.log(
    `Phase 54 pa-users.tags migration (project=${PROJECT}, mode=${DRY_RUN ? "DRY-RUN" : "APPLY"}${AUDIT_ONLY ? " --audit-only" : ""}, user=${SINGLE_USER ?? "all"}, limit=${LIMIT || "none"})`
  )
  initFirebase()
  const db = getFirestore()

  if (AUDIT_ONLY) {
    const res = await auditOnly(db)
    console.log("AUDIT:", JSON.stringify(res, null, 2))
    return
  }

  const log = (...args) => console.log(...args)
  let processed = 0
  let withChanges = 0
  let errored = 0
  const errors = []

  if (SINGLE_USER) {
    const snap = await db.collection("pa-users").doc(SINGLE_USER).get()
    if (!snap.exists) {
      console.error(`User not found: ${SINGLE_USER}`)
      process.exit(1)
    }
    const res = await migrateUser(db, SINGLE_USER, snap.data(), { dryRun: DRY_RUN, log })
    console.log(JSON.stringify(res, null, 2))
    return
  }

  // Page through all pa-users.
  let lastDoc = null
  while (true) {
    let q = db.collection("pa-users").orderBy("__name__").limit(100)
    if (lastDoc) q = q.startAfter(lastDoc)
    const snap = await q.get()
    if (snap.empty) break
    lastDoc = snap.docs[snap.docs.length - 1]
    for (const doc of snap.docs) {
      if (LIMIT > 0 && processed >= LIMIT) break
      const userId = doc.id
      const userData = doc.data()
      try {
        const res = await migrateUser(db, userId, userData, { dryRun: DRY_RUN, log })
        processed++
        if (res.hasChanges) withChanges++
        if (res.mode === "error") {
          errored++
          errors.push({ userId, error: res.error })
        }
        if (processed % 25 === 0) console.log(`  ${processed} processed...`)
      } catch (err) {
        errored++
        errors.push({ userId, error: err?.message ?? String(err) })
      }
    }
    if (LIMIT > 0 && processed >= LIMIT) break
    if (snap.docs.length < 100) break
  }

  const summary = {
    project: PROJECT,
    mode: DRY_RUN ? "dry-run" : "apply",
    total: processed,
    withChanges,
    errored,
    errors: errors.slice(0, 20),
  }
  console.log("SUMMARY:", JSON.stringify(summary, null, 2))
  if (DRY_RUN) {
    console.log(
      "\nDry-run complete. Audit collection: pa-users-tags-migration-audit/{userId}"
    )
    console.log(
      "Adam-action: review audit collection, then re-run with --apply to write to pa-users.tags."
    )
  }
}

// Run main() ONLY when invoked as a script (not when imported by tests).
// import.meta.url + process.argv[1] check is the standard ESM entrypoint guard.
const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error("FATAL:", err?.stack ?? err?.message ?? String(err))
    process.exit(1)
  })
}

// Test seam — exposed for unit tests.
export {
  projectStatedPrefsToPhase52,
  projectCvSignalsToPhase52,
  bucketYoe,
  diffTagsObjects,
  migrateUser,
  ROLE_TO_FUNCTION,
  LOCATION_TO_PHASE52,
  VISA_LEGACY_TO_PHASE52,
}
