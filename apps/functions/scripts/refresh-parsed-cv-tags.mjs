#!/usr/bin/env node
/**
 * Phase 61 — Backfill parsedCandidateResumes canonical Phase 52 fields
 * (`industries[]` 42-token + `relevantIndustry[]`) from legacy
 * `industryTags[]` 10-bucket tokens.
 *
 * Background: Phase 53 wired pa-resume-parser v2 with the new Phase 52
 * canonical fields, but CVs ingested BEFORE Phase 53 only have the legacy
 * `industryTags` field. Without backfill, `pa-users.tags.industrySector`
 * (sourced from CV) is empty for these users → V16 industrySector soft
 * score = 0 for them.
 *
 * Translation: legacy 10-bucket → Phase 52 42-bucket via the same
 * mapper as `apps/functions/src/lib/matching-jobs-mappers.ts`
 * `LEGACY_INDUSTRY_TO_CANONICAL`.
 *
 * Idempotent: skips CVs that already have non-empty `industries` AND
 * `relevantIndustry` fields.
 *
 * Default DRY-RUN: writes proposed update + diff to
 * `parsed-cv-backfill-audit/{runId}/cvs/{cvId}`.
 * `--apply` writes the backfill onto parsedCandidateResumes.
 *
 * Usage:
 *   node apps/functions/scripts/refresh-parsed-cv-tags.mjs              # dry-run all
 *   node apps/functions/scripts/refresh-parsed-cv-tags.mjs --user U123  # single user
 *   node apps/functions/scripts/refresh-parsed-cv-tags.mjs --apply
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON env.
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

// ─── CLI flags ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const DRY_RUN = !argv.includes("--apply")
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

// ─── Phase 52 canonical INDUSTRY_SECTOR_VOCAB (42) ────────────────────────
export const INDUSTRY_SECTOR_VOCAB = new Set([
  "artificial_intelligence_and_machine_learning",
  "financial_technology",
  "healthcare_and_life_sciences",
  "biotechnology_and_pharmaceuticals",
  "software_and_saas",
  "hardware_and_semiconductors",
  "e_commerce_and_retail",
  "consumer_goods",
  "cybersecurity",
  "crypto_web3_blockchain",
  "gaming_and_esports",
  "education_technology",
  "real_estate_and_proptech",
  "transportation_and_logistics",
  "automotive_and_mobility",
  "aerospace_and_defense",
  "energy_and_utilities",
  "clean_energy_and_climate_tech",
  "manufacturing_and_industrial",
  "construction_and_built_environment",
  "agriculture_and_foodtech",
  "hospitality_and_travel",
  "media_and_entertainment",
  "advertising_and_marketing",
  "telecommunications",
  "professional_services",
  "legal_services",
  "accounting_and_audit",
  "management_consulting",
  "human_resources_and_recruiting",
  "non_profit_and_social_impact",
  "public_sector_and_government",
  "research_and_academia",
  "sports_and_recreation",
  "fashion_and_apparel",
  "beauty_and_personal_care",
  "arts_and_culture",
  "accessibility_and_assistive_technology",
  "robotics_and_automation",
  "quantum_computing",
  "space_technology",
  "technology_general",
])

// ─── Phase 55 LEGACY_INDUSTRY_TO_CANONICAL (mirror) ──────────────────────
export const LEGACY_INDUSTRY_TO_CANONICAL = {
  // Phase 61 typo
  software_as_a_service: ["software_and_saas"],
  // 10-bucket legacy industryTags
  tech_software: ["software_and_saas"],
  tech_hardware: ["hardware_and_semiconductors"],
  fintech_finance: ["financial_technology"],
  ai_ml: ["artificial_intelligence_and_machine_learning"],
  healthcare_biotech: ["healthcare_and_life_sciences"],
  consumer_retail: ["e_commerce_and_retail"],
  media_entertainment: ["media_and_entertainment"],
  manufacturing_industrial: ["manufacturing_and_industrial"],
  education: ["education_technology"],
  // additional snake_case industry keys
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
  other: [],
  unknown: [],
}

export function mapLegacyIndustryToCanonical(legacyKey) {
  if (typeof legacyKey !== "string") return []
  const k = legacyKey.trim().toLowerCase()
  if (!k) return []
  if (INDUSTRY_SECTOR_VOCAB.has(k)) return [k]
  return LEGACY_INDUSTRY_TO_CANONICAL[k] ?? []
}

/**
 * Build Phase 52 industries[] from legacy industryTags[].
 */
export function planCv(cv) {
  const hasIndustries = Array.isArray(cv?.industries) && cv.industries.length > 0
  const hasRelevantIndustry = Array.isArray(cv?.relevantIndustry) && cv.relevantIndustry.length > 0
  if (hasIndustries && hasRelevantIndustry) {
    return { mode: "skip-already-canonical" }
  }
  const legacy = Array.isArray(cv?.industryTags) ? cv.industryTags : []
  if (legacy.length === 0) {
    return { mode: "skip-no-legacy-signal" }
  }
  const seen = new Set()
  const canonical = []
  for (const t of legacy) {
    for (const m of mapLegacyIndustryToCanonical(t)) {
      if (!seen.has(m)) {
        seen.add(m)
        canonical.push(m)
      }
    }
  }
  if (canonical.length === 0) {
    return { mode: "skip-no-mapping" }
  }
  const update = {}
  if (!hasIndustries) update.industries = canonical
  if (!hasRelevantIndustry) update.relevantIndustry = canonical.slice(0, 6)
  return { mode: "rewrite", before: { industryTags: legacy }, after: update }
}

// ─── Firebase init ────────────────────────────────────────────────────────────
function initFirebase() {
  if (getApps().length > 0) return
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (credPath) {
    try {
      const cred = JSON.parse(readFileSync(credPath, "utf8"))
      initializeApp({ credential: cert(cred), projectId: PROJECT })
      return
    } catch {}
  }
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (inlineJson) {
    try {
      const cred = JSON.parse(inlineJson)
      initializeApp({ credential: cert(cred), projectId: PROJECT })
      return
    } catch {}
  }
  initializeApp({ projectId: PROJECT })
}

async function backfillCv(db, runId, cvId, cvData, opts) {
  const plan = planCv(cvData)
  if (plan.mode !== "rewrite") return { ...plan, cvId }

  if (opts.dryRun) {
    try {
      await db
        .collection("parsed-cv-backfill-audit")
        .doc(runId)
        .collection("cvs")
        .doc(cvId)
        .set({ cvId, runId, timestamp: new Date().toISOString(), before: plan.before, after: plan.after })
    } catch (err) {
      return { mode: "error", cvId, error: err?.message ?? String(err) }
    }
    return { mode: "dry-run-rewrite", cvId, before: plan.before, after: plan.after }
  }

  try {
    await db.collection("parsedCandidateResumes").doc(cvId).set(plan.after, { merge: true })
    return { mode: "applied", cvId, before: plan.before, after: plan.after }
  } catch (err) {
    return { mode: "error", cvId, error: err?.message ?? String(err) }
  }
}

async function main() {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  console.log(
    `Phase 61 parsedCandidateResumes canonical-industry backfill\n` +
      `  project=${PROJECT}\n` +
      `  mode=${DRY_RUN ? "DRY-RUN" : "APPLY"}\n` +
      `  user=${SINGLE_USER ?? "all"}\n` +
      `  limit=${LIMIT || "none"}\n` +
      `  runId=${runId}`
  )
  initFirebase()
  const db = getFirestore()

  let total = 0,
    rewritten = 0,
    skipped = 0,
    errored = 0
  const errors = []
  const sample = []

  if (SINGLE_USER) {
    const snap = await db
      .collection("parsedCandidateResumes")
      .where("userId", "==", SINGLE_USER)
      .get()
    if (snap.empty) {
      console.error(`No CVs for user: ${SINGLE_USER}`)
      process.exit(1)
    }
    for (const doc of snap.docs) {
      total++
      const res = await backfillCv(db, runId, doc.id, doc.data(), { dryRun: DRY_RUN })
      console.log(JSON.stringify(res, null, 2))
      if (res.mode === "applied" || res.mode === "dry-run-rewrite") rewritten++
      else if (res.mode === "error") {
        errored++
        errors.push(res)
      } else skipped++
    }
  } else {
    let lastDoc = null
    while (true) {
      let q = db.collection("parsedCandidateResumes").orderBy("__name__").limit(100)
      if (lastDoc) q = q.startAfter(lastDoc)
      const snap = await q.get()
      if (snap.empty) break
      lastDoc = snap.docs[snap.docs.length - 1]
      for (const doc of snap.docs) {
        if (LIMIT > 0 && total >= LIMIT) break
        total++
        try {
          const res = await backfillCv(db, runId, doc.id, doc.data(), { dryRun: DRY_RUN })
          if (res.mode === "applied" || res.mode === "dry-run-rewrite") {
            rewritten++
            if (sample.length < 5) sample.push(res)
          } else if (res.mode === "error") {
            errored++
            errors.push(res)
          } else skipped++
        } catch (err) {
          errored++
          errors.push({ cvId: doc.id, error: err?.message ?? String(err) })
        }
      }
      if (LIMIT > 0 && total >= LIMIT) break
      if (snap.docs.length < 100) break
    }
  }

  const summary = {
    runId,
    project: PROJECT,
    mode: DRY_RUN ? "dry-run" : "apply",
    total,
    rewritten,
    skipped,
    errored,
    errors: errors.slice(0, 20),
    sample: sample.slice(0, 5),
  }
  console.log("\nSUMMARY:", JSON.stringify(summary, null, 2))
  if (DRY_RUN) {
    console.log(
      `\nDry-run complete. Audit: parsed-cv-backfill-audit/${runId}/cvs/{cvId}\n` +
        "Adam-action: review audit, then re-run with --apply."
    )
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
