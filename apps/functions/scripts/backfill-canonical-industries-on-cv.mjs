#!/usr/bin/env node
/**
 * Phase 68 (HYGIENE-03) — Backfill canonical `industries` on parsedCandidateResumes.
 *
 * Background. Pre-Phase 53, the cv-ingest pipeline wrote `industryTags`
 * to parsedCandidateResumes — a 10-bucket vocab (`tech_software`,
 * `fintech_finance`, ...). Phase 53 introduced the canonical 42-token
 * `industrySector` vocab, and `pa-users.tags.industrySector[]` is now the
 * single source for matching (V16 cascade reads it via `loadUserTags`).
 *
 * However many older parsedCandidateResumes docs still have `industryTags`
 * but no `industries` (canonical) field. The `mergeUserTags()` library
 * (commit 253ce87) prefers `industries`/`relevantIndustry` if present;
 * else falls back to `industryTags`. This script promotes the legacy field
 * by translating via `LEGACY_INDUSTRY_TO_CANONICAL` (apps/functions/src/lib/matching-jobs-mappers.ts)
 * and writing a canonical `industries: string[]` field.
 *
 * Default DRY-RUN: writes proposed update + diff to
 * `parsedCandidateResumes-industries-audit/{runId}/docs/{docId}` for review.
 * Use `--apply` to write the actual `industries` field.
 *
 * Idempotent: skips docs that already have a non-empty `industries` field.
 *
 * Usage:
 *   node scripts/backfill-canonical-industries-on-cv.mjs               # dry-run all
 *   node scripts/backfill-canonical-industries-on-cv.mjs --limit 100   # first 100
 *   node scripts/backfill-canonical-industries-on-cv.mjs --apply       # all
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON env.
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

// ─── CLI flags ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const DRY_RUN = !argv.includes("--apply")
const PROJECT = (() => {
  const idx = argv.indexOf("--project")
  return idx >= 0 ? argv[idx + 1] : "wekruit-5f89b"
})()
const LIMIT = (() => {
  const idx = argv.indexOf("--limit")
  return idx >= 0 ? parseInt(argv[idx + 1], 10) : 0
})()
const PAGE_SIZE = 200
const RATE_LIMIT_MS = 100

// ─── LEGACY_INDUSTRY_TO_CANONICAL (mirrors matching-jobs-mappers.ts) ─────
//
// Inlined so the script is self-contained (no TS import needed). Keep in
// sync with apps/functions/src/lib/matching-jobs-mappers.ts. The cv-ingest
// `industryTags` 10-bucket vocab maps via the bottom block (tech_software,
// fintech_finance, etc); the upper rows are for jobs-side parity.

export const LEGACY_INDUSTRY_TO_CANONICAL = {
  // Job-side legacy `industryKey` values (kept for completeness; CVs don't
  // produce these but parsedCandidateResumes.industryTags may have them
  // for legacy rows that re-used wekruit-matching's vocab).
  tech: ["technology_general"],
  technology: ["technology_general"],
  fintech: ["financial_technology"],
  financial_services: ["financial_technology"],
  healthtech: ["healthcare_and_life_sciences"],
  healthcare: ["healthcare_and_life_sciences"],
  life_sciences: ["healthcare_and_life_sciences"],
  medical_diagnostics: ["healthcare_and_life_sciences"],
  ecommerce: ["e_commerce_and_retail"],
  enterprise_saas: ["software_and_saas"],
  ai_ml: ["artificial_intelligence_and_machine_learning"],
  ai: ["artificial_intelligence_and_machine_learning"],
  hr_analytics: ["artificial_intelligence_and_machine_learning"],
  cybersecurity: ["cybersecurity"],
  gaming: ["gaming_and_esports"],
  social_media: ["media_and_entertainment"],
  hardware: ["hardware_and_semiconductors"],
  consulting: ["management_consulting"],
  telecom: ["telecommunications"],
  automotive: ["automotive_and_mobility"],
  aerospace_defense: ["aerospace_and_defense"],
  construction: ["construction_and_built_environment"],
  defense: ["aerospace_and_defense"],
  security: ["cybersecurity"],
  manufacturing: ["manufacturing_and_industrial"],
  industrial_automation: ["manufacturing_and_industrial"],
  retail: ["e_commerce_and_retail"],
  media: ["media_and_entertainment"],
  education: ["education_technology"],
  government: ["public_sector_and_government"],
  energy: ["energy_and_utilities"],
  transportation: ["transportation_and_logistics"],
  hospitality: ["hospitality_and_travel"],
  real_estate: ["real_estate_and_proptech"],
  nonprofit: ["non_profit_and_social_impact"],
  legal: ["legal_services"],
  pharma: ["biotechnology_and_pharmaceuticals"],
  pharmaceutical: ["biotechnology_and_pharmaceuticals"],
  banking: ["financial_technology"],
  finance: ["financial_technology"],
  insurance: ["financial_technology"],
  logistics: ["transportation_and_logistics"],
  food_service: ["hospitality_and_travel"],
  agriculture: ["agriculture_and_foodtech"],
  mining: ["manufacturing_and_industrial"],
  utilities: ["energy_and_utilities"],
  blockchain: ["crypto_web3_blockchain"],
  data_technology: ["software_and_saas"],
  // 10-bucket cv-ingest legacy `industryTags` tokens (PRIMARY for CVs).
  tech_software: ["software_and_saas"],
  tech_hardware: ["hardware_and_semiconductors"],
  fintech_finance: ["financial_technology"],
  healthcare_biotech: ["healthcare_and_life_sciences"],
  consumer_retail: ["e_commerce_and_retail"],
  media_entertainment: ["media_and_entertainment"],
  manufacturing_industrial: ["manufacturing_and_industrial"],
  other: [],
  unknown: [],
}

/**
 * Translate a list of legacy industryTags → canonical industries[].
 * Pure / deterministic. Returns empty array when no input or no mappable
 * tokens; deduplicated.
 */
export function translateLegacyToCanonicalIndustries(legacyTags) {
  if (!Array.isArray(legacyTags) || legacyTags.length === 0) return []
  const seen = new Set()
  const out = []
  for (const t of legacyTags) {
    if (typeof t !== "string") continue
    const k = t.trim().toLowerCase()
    if (!k) continue
    const mapped = LEGACY_INDUSTRY_TO_CANONICAL[k]
    if (!Array.isArray(mapped)) continue
    for (const v of mapped) {
      if (typeof v === "string" && !seen.has(v)) {
        seen.add(v)
        out.push(v)
      }
    }
  }
  return out
}

/**
 * Decide what to do for one parsedCandidateResumes doc.
 *   - skip-already-set : `industries` already non-empty (idempotent)
 *   - skip-no-mapping  : no legacy industryTags to translate
 *   - rewrite          : translation produced ≥1 canonical token
 */
export function planCv(doc) {
  const existing = doc?.industries
  if (Array.isArray(existing) && existing.length > 0) {
    return { mode: "skip-already-set", existing }
  }
  const legacy = doc?.industryTags
  if (!Array.isArray(legacy) || legacy.length === 0) {
    return { mode: "skip-no-mapping" }
  }
  const canonical = translateLegacyToCanonicalIndustries(legacy)
  if (canonical.length === 0) {
    return { mode: "skip-no-mapping" }
  }
  return { mode: "rewrite", from: legacy, to: canonical }
}

export async function migrateCv(db, runId, docId, doc, opts) {
  const plan = planCv(doc)
  if (plan.mode === "skip-already-set" || plan.mode === "skip-no-mapping") {
    return { ...plan, docId }
  }

  const before = { industries: doc?.industries ?? null, industryTags: doc?.industryTags ?? null }
  const after = { industries: plan.to }
  const now = new Date().toISOString()

  if (opts.dryRun) {
    try {
      await db
        .collection("parsedCandidateResumes-industries-audit")
        .doc(runId)
        .collection("docs")
        .doc(docId)
        .set({ docId, runId, timestamp: now, before, after })
    } catch (err) {
      return { mode: "error", docId, error: err?.message ?? String(err) }
    }
    return { mode: "dry-run-rewrite", docId, before, after }
  }

  try {
    await db
      .collection("parsedCandidateResumes")
      .doc(docId)
      .update({ industries: plan.to, industriesBackfilledAt: now })
    return { mode: "applied", docId, before, after }
  } catch (err) {
    return { mode: "error", docId, error: err?.message ?? String(err) }
  }
}

// ─── Firebase init ────────────────────────────────────────────────────────

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

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  console.log(
    `Phase 68 (HYGIENE-03) industries canonical backfill\n` +
      `  project=${PROJECT}\n` +
      `  mode=${DRY_RUN ? "DRY-RUN (audit only)" : "APPLY"}\n` +
      `  limit=${LIMIT || "none"}\n` +
      `  runId=${runId}`
  )

  initFirebase()
  const db = getFirestore()

  const auditHead = {
    runId,
    project: PROJECT,
    mode: DRY_RUN ? "dry-run" : "apply",
    limit: LIMIT,
    startedAt: new Date().toISOString(),
    completedAt: null,
    total: 0,
    rewritten: 0,
    skippedAlreadySet: 0,
    skippedNoMapping: 0,
    errored: 0,
    errors: [],
    sample: [],
    distribution: {},
  }
  try {
    await db.collection("parsedCandidateResumes-industries-audit").doc(runId).set(auditHead)
  } catch (err) {
    console.error("FAIL: cannot write audit head:", err?.message ?? String(err))
    process.exit(1)
  }

  let total = 0
  let rewritten = 0
  let skippedAlreadySet = 0
  let skippedNoMapping = 0
  let errored = 0
  const errors = []
  const sample = []
  const distribution = {}

  let lastDoc = null
  while (true) {
    let q = db.collection("parsedCandidateResumes").orderBy("__name__").limit(PAGE_SIZE)
    if (lastDoc) q = q.startAfter(lastDoc)
    const snap = await q.get()
    if (snap.empty) break
    lastDoc = snap.docs[snap.docs.length - 1]

    for (const doc of snap.docs) {
      if (LIMIT > 0 && total >= LIMIT) break
      total++
      const docId = doc.id
      const docData = doc.data()
      try {
        const res = await migrateCv(db, runId, docId, docData, { dryRun: DRY_RUN })
        if (res.mode === "skip-already-set") skippedAlreadySet++
        else if (res.mode === "skip-no-mapping") skippedNoMapping++
        else if (res.mode === "error") {
          errored++
          errors.push({ docId, error: res.error })
        } else {
          rewritten++
          for (const v of res.after.industries ?? []) {
            distribution[v] = (distribution[v] ?? 0) + 1
          }
          if (sample.length < 10) sample.push({ docId, before: res.before, after: res.after })
        }
        if (total % 200 === 0) {
          console.log(
            `  ${total} scanned (rewritten=${rewritten} skipSet=${skippedAlreadySet} skipNoMap=${skippedNoMapping} errored=${errored})...`
          )
        }
      } catch (err) {
        errored++
        errors.push({ docId, error: err?.message ?? String(err) })
      }
    }
    if (LIMIT > 0 && total >= LIMIT) break
    if (snap.docs.length < PAGE_SIZE) break
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS))
  }

  const completedAt = new Date().toISOString()
  try {
    await db
      .collection("parsedCandidateResumes-industries-audit")
      .doc(runId)
      .set(
        {
          completedAt,
          total,
          rewritten,
          skippedAlreadySet,
          skippedNoMapping,
          errored,
          errors: errors.slice(0, 50),
          sample,
          distribution,
        },
        { merge: true }
      )
  } catch (err) {
    console.error("WARN: failed to update audit head:", err?.message ?? String(err))
  }

  const summary = {
    runId,
    project: PROJECT,
    mode: DRY_RUN ? "dry-run" : "apply",
    total,
    rewritten,
    skippedAlreadySet,
    skippedNoMapping,
    errored,
    errors: errors.slice(0, 20),
    sample,
    distribution,
  }
  console.log("\nSUMMARY:", JSON.stringify(summary, null, 2))
  if (DRY_RUN) {
    console.log(
      `\nDry-run complete. Audit collection: parsedCandidateResumes-industries-audit/${runId}/docs/{docId}`
    )
    console.log("Adam-action: review distribution + sample, then re-run with --apply.")
  }
}

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
