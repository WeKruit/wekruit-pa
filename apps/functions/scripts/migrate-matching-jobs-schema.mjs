#!/usr/bin/env node
/**
 * v1.6 Phase 55 (MATCH-02) — matching-jobs schema migration.
 *
 * Adds `roleFunction[]` + `industrySector[]` to existing matching-jobs docs.
 * Source: legacy `category` (jobright) + `industryKey` / `industryEnum`.
 *
 * Default DRY-RUN: writes proposed update + diff to
 * `matching-jobs-migration-audit/{runId}/jobs/{jobId}` for Adam to review.
 * Use `--apply` to write the actual `roleFunction` + `industrySector`
 * fields onto matching-jobs docs.
 *
 * Idempotent: when `roleFunctionMigratedAt` is already set AND the
 * computed roleFunction is identical to the stored value, the doc is
 * skipped. Same for industrySector.
 *
 * Usage:
 *   node scripts/migrate-matching-jobs-schema.mjs                       # dry-run all active
 *   node scripts/migrate-matching-jobs-schema.mjs --limit 100           # first 100
 *   node scripts/migrate-matching-jobs-schema.mjs --status active       # filter
 *   node scripts/migrate-matching-jobs-schema.mjs --apply --limit 5000  # actual write
 *   node scripts/migrate-matching-jobs-schema.mjs --apply               # all
 *   node scripts/migrate-matching-jobs-schema.mjs --project wekruit-5f89b
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON env.
 *
 * Output: per-batch progress, final SUMMARY JSON with sample of 5
 * before/after pairs.
 *
 * Adam-action after dry-run: read
 * `matching-jobs-migration-audit/{runId}/jobs/{jobId}` collection in
 * Firestore console, eyeball mapping correctness, then re-run with
 * `--apply`.
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
const STATUS_FILTER = (() => {
  const idx = argv.indexOf("--status")
  return idx >= 0 ? argv[idx + 1] : "active"
})()
const LIMIT = (() => {
  const idx = argv.indexOf("--limit")
  return idx >= 0 ? parseInt(argv[idx + 1], 10) : 0
})()
const PAGE_SIZE = 200
const RATE_LIMIT_MS = 100 // 10 batches/sec ceiling

// ─── Inline mapper logic (mirrors src/lib/matching-jobs-mappers.ts) ──────────
// Inlined so the script is standalone and doesn't need a built workspace.
// MUST stay in sync with src/lib/matching-jobs-mappers.ts. Tests verify
// both produce the same output for the canonical fixtures.

const JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION = {
  tech: ["software_engineering"],
  data_analytics: ["data_analysis"],
  engineering: ["engineering_and_development"],
  product: ["product_management"],
  business: ["business_analyst"],
  design: ["creatives_and_design"],
  consulting: ["consultant"],
  accounting_finance: ["accounting_and_finance"],
  marketing: ["marketing"],
  management: ["management_and_executive"],
  sales: ["sales"],
  human_resources: ["human_resources"],
  legal: ["legal_and_compliance"],
  arts_entertainment: ["arts_and_entertainment"],
  education: ["education_and_training"],
  government: ["public_sector_and_government"],
  customer_service: ["customer_service_and_support"],
  general: [],
}

const LEGACY_INDUSTRY_TO_CANONICAL = {
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
  // 10-bucket legacy `industryEnum` tokens (from cv-ingest/industry-tags.ts).
  // Stored on jobs alongside / instead of the snake_case industryKey above.
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

const TITLE_KEYWORD_TO_ROLE = [
  [
    /\b(software\s+engineer(ing)?|swe|developer|programmer|coder|backend|frontend|fullstack|full\s*stack|web\s+developer|mobile\s+developer|ios\s+developer|android\s+developer)\b/i,
    ["software_engineering"],
  ],
  [
    /\b(data\s+(scientist|analyst|engineer)|analytics|business\s+intelligence|\bbi\b)\b/i,
    ["data_analysis"],
  ],
  [
    /\b(machine\s+learning|ml\s+engineer|ai\s+engineer|deep\s+learning|nlp)\b/i,
    ["software_engineering", "data_analysis"],
  ],
  [/\b(product\s+(manager|owner|lead)|\bpm\b)\b/i, ["product_management"]],
  [/\b(business\s+analyst|\bba\b|requirements)\b/i, ["business_analyst"]],
  [
    /\b(designer|ui\s+designer|ux\s+designer|graphic|creative)\b/i,
    ["creatives_and_design"],
  ],
  [/\b(consultant|consulting|advisor)\b/i, ["consultant"]],
  [
    /\b(accountant|accounting|finance|cfo|controller|treasurer|fp&a)\b/i,
    ["accounting_and_finance"],
  ],
  [/\b(marketing|growth|brand|content\s+marketing)\b/i, ["marketing"]],
  [
    /\b(manager|director|\bvp\b|head\s+of|lead|principal|chief)\b/i,
    ["management_and_executive"],
  ],
  [
    /\b(sales|account\s+executive|\bae\b|\bbdr\b|\bsdr\b|business\s+development)\b/i,
    ["sales"],
  ],
  [/\b(\bhr\b|human\s+resources|recruiter|talent|people\s+ops)\b/i, ["human_resources"]],
  [
    /\b(legal|attorney|lawyer|paralegal|compliance|counsel)\b/i,
    ["legal_and_compliance"],
  ],
  [
    /\b(artist|musician|actor|performer|writer|editor)\b/i,
    ["arts_and_entertainment"],
  ],
  [
    /\b(teacher|professor|tutor|instructor|trainer)\b/i,
    ["education_and_training"],
  ],
  [
    /\b(government|public\s+sector|policy|federal|state)\b/i,
    ["public_sector_and_government"],
  ],
  [
    /\b(customer\s+(service|support|success)|cs\s+rep|help\s+desk)\b/i,
    ["customer_service_and_support"],
  ],
]

function dedupe(arr) {
  const seen = new Set()
  const out = []
  for (const v of arr) {
    if (!seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

function inferRoleFromTitle(title) {
  if (!title || typeof title !== "string") return []
  const collected = []
  for (const [re, roles] of TITLE_KEYWORD_TO_ROLE) {
    if (re.test(title)) {
      for (const r of roles) collected.push(r)
    }
  }
  return dedupe(collected)
}

function mapJobrightCategoryToRoleFunction(category, title) {
  const cat = typeof category === "string" ? category.toLowerCase().trim() : ""
  if (cat) {
    const direct = JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION[cat]
    if (direct && direct.length > 0) return direct
  }
  return inferRoleFromTitle(title)
}

function mapLegacyIndustryToCanonical(legacyKey) {
  if (!legacyKey || typeof legacyKey !== "string") return []
  const key = legacyKey.toLowerCase().trim()
  if (!key) return []
  return LEGACY_INDUSTRY_TO_CANONICAL[key] ?? []
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

// ─── Migration logic ──────────────────────────────────────────────────────────

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Compute new roleFunction[] + industrySector[] for a job doc.
 *
 * Live-data shape (verified 2026-05-06 against production matching-jobs):
 *  - NO `category` field — does not exist on the doc.
 *  - NO `title` field — title is in `roleTitle`.
 *  - `industryKey` (and equal-valued `industry`) does DOUBLE-DUTY: holds
 *    BOTH jobright-category-style values (engineering, human_resources,
 *    customer_service, sales, management, marketing, ...) AND
 *    industry-style values (fintech, healthtech, enterprise_saas, ai_ml,
 *    hardware, ecommerce, ...). We try both maps.
 *  - `industryEnum` (when present) is the legacy 10-bucket
 *    (tech_software, healthcare_biotech, ...) — also covered by
 *    LEGACY_INDUSTRY_TO_CANONICAL.
 *
 * Resolution order:
 *  1. If `category` present (future-proof) → JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION
 *  2. Else if `industryKey` matches a category token → that category's
 *     RoleFunction[]
 *  3. Else fall back to title regex on `roleTitle`/`title`/`jobTitle`
 *
 *  industrySector:
 *  1. If `industryEnum` is non-empty array → map each, dedupe.
 *  2. Else if `industryEnum` is scalar → map.
 *  3. Else if `industryKey` matches an industry token → use it.
 *  4. Else if `industry` (free-text) matches → use it.
 *
 * Returns { newRoleFunction, newIndustrySector, mapperUsed }.
 */
export function computeNewFields(job) {
  const category = job?.category
  // Prefer roleTitle (live-data field) → title (legacy) → jobTitle.
  const title = job?.roleTitle ?? job?.title ?? job?.jobTitle
  const industryEnum = job?.industryEnum
  const industryKey = job?.industryKey
  const industry = job?.industry

  // ─── roleFunction ────────────────────────────────────────────────────
  let newRoleFunction = []
  let roleSource = "no_mapping"

  // Step 1: explicit `category` field (future-proof).
  if (category) {
    const cat = String(category).toLowerCase().trim()
    const direct = JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION[cat]
    if (direct && direct.length > 0) {
      newRoleFunction = direct
      roleSource = "category_direct"
    }
  }

  // Step 2: industryKey is doing double-duty in live data — try category map.
  if (newRoleFunction.length === 0 && industryKey) {
    const k = String(industryKey).toLowerCase().trim()
    const direct = JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION[k]
    if (direct && direct.length > 0) {
      newRoleFunction = direct
      roleSource = "industryKey_as_category"
    }
  }

  // Step 3: fall back to roleTitle regex.
  if (newRoleFunction.length === 0 && title) {
    const fromTitle = inferRoleFromTitle(title)
    if (fromTitle.length > 0) {
      newRoleFunction = fromTitle
      roleSource = "title_regex_fallback"
    }
  }

  // ─── industrySector ──────────────────────────────────────────────────
  let newIndustrySector = []
  let industrySource = "no_mapping"

  if (Array.isArray(industryEnum) && industryEnum.length > 0) {
    const collected = []
    for (const k of industryEnum) {
      const mapped = mapLegacyIndustryToCanonical(k)
      for (const m of mapped) collected.push(m)
    }
    if (collected.length > 0) {
      newIndustrySector = dedupe(collected)
      industrySource = "industryEnum_array"
    }
  }

  if (newIndustrySector.length === 0 && industryEnum && !Array.isArray(industryEnum)) {
    const mapped = mapLegacyIndustryToCanonical(industryEnum)
    if (mapped.length > 0) {
      newIndustrySector = mapped
      industrySource = "industryEnum_scalar"
    }
  }

  if (newIndustrySector.length === 0 && industryKey) {
    const mapped = mapLegacyIndustryToCanonical(industryKey)
    if (mapped.length > 0) {
      newIndustrySector = mapped
      industrySource = "industryKey"
    }
  }

  if (newIndustrySector.length === 0 && industry) {
    const mapped = mapLegacyIndustryToCanonical(industry)
    if (mapped.length > 0) {
      newIndustrySector = mapped
      industrySource = "industry"
    }
  }

  return {
    newRoleFunction,
    newIndustrySector,
    mapperUsed: { role: roleSource, industry: industrySource },
  }
}

/**
 * Decide whether this job is already migrated and the new computed
 * fields match. If so, skip writing.
 */
export function isAlreadyMigrated(job, newRoleFunction, newIndustrySector) {
  if (!job?.roleFunctionMigratedAt) return false
  if (!job?.industrySectorMigratedAt) return false
  if (!arraysEqual(job?.roleFunction ?? [], newRoleFunction)) return false
  if (!arraysEqual(job?.industrySector ?? [], newIndustrySector)) return false
  return true
}

/**
 * Migrate one job. Returns a result object (logged + tallied by caller).
 */
export async function migrateJob(db, runId, jobId, jobData, opts) {
  const { dryRun, log } = opts
  const { newRoleFunction, newIndustrySector, mapperUsed } = computeNewFields(jobData)

  if (isAlreadyMigrated(jobData, newRoleFunction, newIndustrySector)) {
    return { mode: "skipped-already-migrated", jobId }
  }

  const before = {
    category: jobData?.category ?? null,
    title: jobData?.title ?? null,
    roleTitle: jobData?.roleTitle ?? null,
    jobTitle: jobData?.jobTitle ?? null,
    industry: jobData?.industry ?? null,
    industryKey: jobData?.industryKey ?? null,
    industryEnum: jobData?.industryEnum ?? null,
    roleFunction: jobData?.roleFunction ?? null,
    industrySector: jobData?.industrySector ?? null,
  }
  const after = {
    roleFunction: newRoleFunction,
    industrySector: newIndustrySector,
  }
  const now = new Date().toISOString()

  if (dryRun) {
    try {
      await db
        .collection("matching-jobs-migration-audit")
        .doc(runId)
        .collection("jobs")
        .doc(jobId)
        .set({
          jobId,
          runId,
          timestamp: now,
          before,
          after,
          mapper_used: mapperUsed,
        })
    } catch (err) {
      const msg = err?.message ?? String(err)
      log(`  AUDIT-WRITE-FAIL ${jobId}: ${msg}`)
      return { mode: "error", jobId, error: msg }
    }
    return { mode: "dry-run", jobId, before, after, mapperUsed }
  }

  // APPLY mode: write the new fields onto the matching-jobs doc.
  try {
    await db.collection("matching-jobs").doc(jobId).update({
      roleFunction: newRoleFunction,
      industrySector: newIndustrySector,
      roleFunctionMigratedAt: now,
      industrySectorMigratedAt: now,
    })
    return { mode: "applied", jobId, before, after, mapperUsed }
  } catch (err) {
    return { mode: "error", jobId, error: err?.message ?? String(err) }
  }
}

// ─── Main entrypoint ──────────────────────────────────────────────────────────

async function main() {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  console.log(
    `Phase 55 matching-jobs schema migration\n` +
      `  project=${PROJECT}\n` +
      `  mode=${DRY_RUN ? "DRY-RUN (audit only)" : "APPLY"}\n` +
      `  status=${STATUS_FILTER}\n` +
      `  limit=${LIMIT || "none"}\n` +
      `  runId=${runId}`
  )

  initFirebase()
  const db = getFirestore()

  // Audit head doc up front so partial runs are still observable.
  const auditHead = {
    runId,
    project: PROJECT,
    mode: DRY_RUN ? "dry-run" : "apply",
    statusFilter: STATUS_FILTER,
    limit: LIMIT,
    startedAt: new Date().toISOString(),
    completedAt: null,
    total: 0,
    processed: 0,
    skippedAlreadyMigrated: 0,
    errored: 0,
    errors: [],
    sample: [],
    dryRun: DRY_RUN,
  }
  try {
    await db.collection("matching-jobs-migration-audit").doc(runId).set(auditHead)
  } catch (err) {
    console.error("FAIL: cannot write audit head:", err?.message ?? String(err))
    process.exit(1)
  }

  let processed = 0
  let skipped = 0
  let errored = 0
  let total = 0
  const errors = []
  const sample = []
  const log = (...args) => console.log(...args)

  let lastDoc = null
  while (true) {
    let q = db
      .collection("matching-jobs")
      .where("status", "==", STATUS_FILTER)
      .orderBy("__name__")
      .limit(PAGE_SIZE)
    if (lastDoc) q = q.startAfter(lastDoc)
    const snap = await q.get()
    if (snap.empty) break
    lastDoc = snap.docs[snap.docs.length - 1]

    for (const doc of snap.docs) {
      if (LIMIT > 0 && total >= LIMIT) break
      total++
      const jobId = doc.id
      const jobData = doc.data()
      try {
        const res = await migrateJob(db, runId, jobId, jobData, { dryRun: DRY_RUN, log })
        if (res.mode === "skipped-already-migrated") skipped++
        else if (res.mode === "error") {
          errored++
          errors.push({ jobId, error: res.error })
        } else {
          processed++
          if (sample.length < 5) {
            sample.push({
              jobId,
              before: res.before,
              after: res.after,
              mapper_used: res.mapperUsed,
            })
          }
        }
        if (total % 100 === 0) {
          console.log(
            `  ${total} scanned (processed=${processed} skipped=${skipped} errored=${errored})...`
          )
        }
      } catch (err) {
        errored++
        errors.push({ jobId, error: err?.message ?? String(err) })
      }
    }

    if (LIMIT > 0 && total >= LIMIT) break
    if (snap.docs.length < PAGE_SIZE) break
    // Throttle between pages: 10 page-batches/sec ceiling.
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS))
  }

  // Update audit head with completion stats.
  const completedAt = new Date().toISOString()
  try {
    await db.collection("matching-jobs-migration-audit").doc(runId).set(
      {
        completedAt,
        total,
        processed,
        skippedAlreadyMigrated: skipped,
        errored,
        errors: errors.slice(0, 50),
        sample,
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
    statusFilter: STATUS_FILTER,
    total,
    processed,
    skippedAlreadyMigrated: skipped,
    errored,
    errors: errors.slice(0, 20),
    sample,
    dryRun: DRY_RUN,
  }
  console.log("\nSUMMARY:", JSON.stringify(summary, null, 2))
  if (DRY_RUN) {
    console.log(
      `\nDry-run complete. Audit collection: matching-jobs-migration-audit/${runId}/jobs/{jobId}`
    )
    console.log(
      "Adam-action: review audit collection sample, then re-run with --apply to write."
    )
  }
}

// Run main() ONLY when invoked as a script (not when imported by tests).
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

// ─── Test seam ───────────────────────────────────────────────────────────────

export {
  JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION,
  LEGACY_INDUSTRY_TO_CANONICAL,
  mapJobrightCategoryToRoleFunction,
  mapLegacyIndustryToCanonical,
  inferRoleFromTitle,
}
