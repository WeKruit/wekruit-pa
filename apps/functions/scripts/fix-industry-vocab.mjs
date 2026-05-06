#!/usr/bin/env node
/**
 * Phase 61 — Normalize industrySector / relevantIndustry tokens to the
 * Phase 52 canonical INDUSTRY_SECTOR_VOCAB (42 tokens, spelled-out, no
 * abbreviations).
 *
 * Bug source 1: Adam's pa-users.tags carries `software_as_a_service`
 *   (the seed-adam-v16-tags.mjs script wrote a typo'd token in production
 *   that doesn't exist in the canonical vocab — Phase 52 has
 *   `software_and_saas`).
 * Bug source 2: pa-resume-parser prompt example mentioned the typo as
 *   the spelled-out form, so the LLM occasionally emits it too.
 * Bug source 3: free-text tokens persisted by older parsers ("tech_software",
 *   "ai_ml", etc.) — map via Phase 55 LEGACY_INDUSTRY_TO_CANONICAL.
 *
 * Default DRY-RUN: writes proposed update + diff to
 * `industry-vocab-fix-audit/{runId}/users/{userId}` and
 * `industry-vocab-fix-audit/{runId}/parsed-cvs/{cvId}`.
 * Use `--apply` to write the fix.
 *
 * Usage:
 *   node apps/functions/scripts/fix-industry-vocab.mjs                # dry-run all
 *   node apps/functions/scripts/fix-industry-vocab.mjs --limit 5      # first 5 of each
 *   node apps/functions/scripts/fix-industry-vocab.mjs --user U123    # single user
 *   node apps/functions/scripts/fix-industry-vocab.mjs --apply
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

// ─── Legacy → canonical mapper (mirrors apps/functions/src/lib/matching-jobs-mappers.ts) ───
export const TYPO_AND_LEGACY_MAP = {
  // Phase 61 known typos
  software_as_a_service: "software_and_saas",
  // Phase 55 LEGACY_INDUSTRY_TO_CANONICAL (subset most common in pa-users.tags)
  tech: "technology_general",
  technology: "technology_general",
  fintech: "financial_technology",
  fintech_finance: "financial_technology",
  financial_services: "financial_technology",
  healthtech: "healthcare_and_life_sciences",
  healthcare: "healthcare_and_life_sciences",
  healthcare_biotech: "healthcare_and_life_sciences",
  life_sciences: "healthcare_and_life_sciences",
  medical_diagnostics: "healthcare_and_life_sciences",
  ecommerce: "e_commerce_and_retail",
  consumer_retail: "e_commerce_and_retail",
  enterprise_saas: "software_and_saas",
  tech_software: "software_and_saas",
  data_technology: "software_and_saas",
  ai_ml: "artificial_intelligence_and_machine_learning",
  ai: "artificial_intelligence_and_machine_learning",
  hr_analytics: "artificial_intelligence_and_machine_learning",
  cybersecurity: "cybersecurity",
  gaming: "gaming_and_esports",
  social_media: "media_and_entertainment",
  media_entertainment: "media_and_entertainment",
  hardware: "hardware_and_semiconductors",
  tech_hardware: "hardware_and_semiconductors",
  consulting: "management_consulting",
  telecom: "telecommunications",
  automotive: "automotive_and_mobility",
  aerospace_defense: "aerospace_and_defense",
  construction: "construction_and_built_environment",
  defense: "aerospace_and_defense",
  security: "cybersecurity",
  manufacturing: "manufacturing_and_industrial",
  manufacturing_industrial: "manufacturing_and_industrial",
  industrial_automation: "manufacturing_and_industrial",
  retail: "e_commerce_and_retail",
  media: "media_and_entertainment",
  education: "education_technology",
  government: "public_sector_and_government",
  energy: "energy_and_utilities",
  transportation: "transportation_and_logistics",
  hospitality: "hospitality_and_travel",
  real_estate: "real_estate_and_proptech",
  nonprofit: "non_profit_and_social_impact",
  legal: "legal_services",
  pharma: "biotechnology_and_pharmaceuticals",
  pharmaceutical: "biotechnology_and_pharmaceuticals",
  banking: "financial_technology",
  finance: "financial_technology",
  insurance: "financial_technology",
  logistics: "transportation_and_logistics",
  food_service: "hospitality_and_travel",
  agriculture: "agriculture_and_foodtech",
  mining: "manufacturing_and_industrial",
  utilities: "energy_and_utilities",
  blockchain: "crypto_web3_blockchain",
}

/**
 * Map a single token to a canonical INDUSTRY_SECTOR_VOCAB token, or null
 * to indicate "drop entirely".
 */
export function normalizeToken(raw) {
  if (typeof raw !== "string") return null
  const t = raw.trim().toLowerCase()
  if (!t) return null
  if (INDUSTRY_SECTOR_VOCAB.has(t)) return t
  const mapped = TYPO_AND_LEGACY_MAP[t]
  if (mapped && INDUSTRY_SECTOR_VOCAB.has(mapped)) return mapped
  return null // drop unknown token
}

/**
 * Normalize an array of tokens. Returns { normalized, changed }.
 * `changed` = true when any token was rewritten OR dropped.
 */
export function normalizeArray(arr) {
  if (!Array.isArray(arr)) return { normalized: arr, changed: false }
  const seen = new Set()
  const out = []
  let changed = false
  for (const item of arr) {
    const norm = normalizeToken(item)
    if (norm === null) {
      // dropped
      if (typeof item === "string" && item.trim().length > 0) changed = true
      continue
    }
    if (norm !== item) changed = true
    if (!seen.has(norm)) {
      seen.add(norm)
      out.push(norm)
    }
  }
  return { normalized: out, changed }
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

async function fixUser(db, runId, userId, userData, opts) {
  const tags = userData?.tags
  if (!tags || typeof tags !== "object") return { mode: "skip-no-tags", userId }

  const indUpd = normalizeArray(tags.industrySector)
  const relUpd = normalizeArray(tags.relevantIndustry)

  if (!indUpd.changed && !relUpd.changed) {
    return { mode: "skip-clean", userId }
  }

  const before = {}
  const after = {}
  if (indUpd.changed) {
    before.industrySector = tags.industrySector
    after.industrySector = indUpd.normalized
  }
  if (relUpd.changed) {
    before.relevantIndustry = tags.relevantIndustry
    after.relevantIndustry = relUpd.normalized
  }

  if (opts.dryRun) {
    try {
      await db
        .collection("industry-vocab-fix-audit")
        .doc(runId)
        .collection("users")
        .doc(userId)
        .set({ userId, runId, timestamp: new Date().toISOString(), before, after })
    } catch (err) {
      return { mode: "error", userId, error: err?.message ?? String(err) }
    }
    return { mode: "dry-run-rewrite", userId, before, after }
  }

  try {
    const update = { tags: {} }
    if (indUpd.changed) update.tags.industrySector = indUpd.normalized
    if (relUpd.changed) update.tags.relevantIndustry = relUpd.normalized
    await db.collection("pa-users").doc(userId).set(update, { merge: true })
    return { mode: "applied", userId, before, after }
  } catch (err) {
    return { mode: "error", userId, error: err?.message ?? String(err) }
  }
}

async function fixParsedCv(db, runId, cvId, cvData, opts) {
  const indUpd = normalizeArray(cvData?.industries)
  const relUpd = normalizeArray(cvData?.relevantIndustry)
  // industryTags is the legacy 10-bucket — leave alone unless typo shows up
  // (the canonical 42 tokens are stored under `industries`).

  if (!indUpd.changed && !relUpd.changed) {
    return { mode: "skip-clean", cvId }
  }

  const before = {}
  const after = {}
  if (indUpd.changed) {
    before.industries = cvData.industries
    after.industries = indUpd.normalized
  }
  if (relUpd.changed) {
    before.relevantIndustry = cvData.relevantIndustry
    after.relevantIndustry = relUpd.normalized
  }

  if (opts.dryRun) {
    try {
      await db
        .collection("industry-vocab-fix-audit")
        .doc(runId)
        .collection("parsed-cvs")
        .doc(cvId)
        .set({ cvId, runId, timestamp: new Date().toISOString(), before, after })
    } catch (err) {
      return { mode: "error", cvId, error: err?.message ?? String(err) }
    }
    return { mode: "dry-run-rewrite", cvId, before, after }
  }

  try {
    const update = {}
    if (indUpd.changed) update.industries = indUpd.normalized
    if (relUpd.changed) update.relevantIndustry = relUpd.normalized
    await db.collection("parsedCandidateResumes").doc(cvId).set(update, { merge: true })
    return { mode: "applied", cvId, before, after }
  } catch (err) {
    return { mode: "error", cvId, error: err?.message ?? String(err) }
  }
}

async function main() {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  console.log(
    `Phase 61 industry vocab normalize\n` +
      `  project=${PROJECT}\n` +
      `  mode=${DRY_RUN ? "DRY-RUN (audit only)" : "APPLY"}\n` +
      `  user=${SINGLE_USER ?? "all"}\n` +
      `  limit=${LIMIT || "none"}\n` +
      `  runId=${runId}`
  )
  initFirebase()
  const db = getFirestore()

  // ── Pass 1: pa-users.tags ──
  let userTotal = 0,
    userRewritten = 0,
    userSkipped = 0,
    userErrored = 0
  const userErrors = []
  const userSample = []

  if (SINGLE_USER) {
    const snap = await db.collection("pa-users").doc(SINGLE_USER).get()
    if (snap.exists) {
      userTotal = 1
      const res = await fixUser(db, runId, SINGLE_USER, snap.data(), { dryRun: DRY_RUN })
      console.log("user result:", JSON.stringify(res, null, 2))
      if (res.mode === "applied" || res.mode === "dry-run-rewrite") userRewritten++
      else if (res.mode === "error") {
        userErrored++
        userErrors.push(res)
      } else userSkipped++
    }
  } else {
    let lastDoc = null
    while (true) {
      let q = db.collection("pa-users").orderBy("__name__").limit(100)
      if (lastDoc) q = q.startAfter(lastDoc)
      const snap = await q.get()
      if (snap.empty) break
      lastDoc = snap.docs[snap.docs.length - 1]
      for (const doc of snap.docs) {
        if (LIMIT > 0 && userTotal >= LIMIT) break
        userTotal++
        try {
          const res = await fixUser(db, runId, doc.id, doc.data(), { dryRun: DRY_RUN })
          if (res.mode === "applied" || res.mode === "dry-run-rewrite") {
            userRewritten++
            if (userSample.length < 5)
              userSample.push({ userId: res.userId, before: res.before, after: res.after })
          } else if (res.mode === "error") {
            userErrored++
            userErrors.push(res)
          } else {
            userSkipped++
          }
        } catch (err) {
          userErrored++
          userErrors.push({ userId: doc.id, error: err?.message ?? String(err) })
        }
      }
      if (LIMIT > 0 && userTotal >= LIMIT) break
      if (snap.docs.length < 100) break
    }
  }
  console.log(
    `pa-users: total=${userTotal} rewritten=${userRewritten} skipped=${userSkipped} errored=${userErrored}`
  )

  // ── Pass 2: parsedCandidateResumes ──
  let cvTotal = 0,
    cvRewritten = 0,
    cvSkipped = 0,
    cvErrored = 0
  const cvErrors = []
  const cvSample = []
  let lastCvDoc = null
  while (true) {
    let q = db.collection("parsedCandidateResumes").orderBy("__name__").limit(100)
    if (lastCvDoc) q = q.startAfter(lastCvDoc)
    const snap = await q.get()
    if (snap.empty) break
    lastCvDoc = snap.docs[snap.docs.length - 1]
    for (const doc of snap.docs) {
      if (LIMIT > 0 && cvTotal >= LIMIT) break
      cvTotal++
      try {
        const res = await fixParsedCv(db, runId, doc.id, doc.data(), { dryRun: DRY_RUN })
        if (res.mode === "applied" || res.mode === "dry-run-rewrite") {
          cvRewritten++
          if (cvSample.length < 5) cvSample.push({ cvId: res.cvId, before: res.before, after: res.after })
        } else if (res.mode === "error") {
          cvErrored++
          cvErrors.push(res)
        } else {
          cvSkipped++
        }
      } catch (err) {
        cvErrored++
        cvErrors.push({ cvId: doc.id, error: err?.message ?? String(err) })
      }
    }
    if (LIMIT > 0 && cvTotal >= LIMIT) break
    if (snap.docs.length < 100) break
  }
  console.log(
    `parsedCandidateResumes: total=${cvTotal} rewritten=${cvRewritten} skipped=${cvSkipped} errored=${cvErrored}`
  )

  const summary = {
    runId,
    project: PROJECT,
    mode: DRY_RUN ? "dry-run" : "apply",
    paUsers: { total: userTotal, rewritten: userRewritten, skipped: userSkipped, errored: userErrored, sample: userSample, errors: userErrors.slice(0, 10) },
    parsedCvs: { total: cvTotal, rewritten: cvRewritten, skipped: cvSkipped, errored: cvErrored, sample: cvSample, errors: cvErrors.slice(0, 10) },
  }
  console.log("\nSUMMARY:", JSON.stringify(summary, null, 2))
  if (DRY_RUN) {
    console.log(
      `\nDry-run complete. Audit: industry-vocab-fix-audit/${runId}/{users,parsed-cvs}/{id}\n` +
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
