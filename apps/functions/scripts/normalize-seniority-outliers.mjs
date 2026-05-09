#!/usr/bin/env node
/**
 * v1.8 P7-H — normalize matching-jobs whose seniorityLevel is a free-form
 * leak (not in the canonical TAG-06 13-enum from
 * `packages/shared-tags/src/canonical/career-stage.ts`).
 *
 * Why: Live Firestore probe (2026-05-08) of 6015 active matching-jobs:
 *   - 13 outliers: 11x "New Grad, Entry Level" + 2x "Entry Level"
 *   - V16 hard-filter `acceptableCareerStages` silently drops these because
 *     they don't equal any canonical token, so candidates lose otherwise-good
 *     matches
 *
 * Distinct from `backfill-seniority-level.mjs` (Phase 57/68):
 *   - The Phase 57/68 script writes seniority for ALL active jobs (audit-heavy,
 *     uses `roleTitle` regex inference + canonical mapping)
 *   - This script targets ONLY the small set of NON-canonical existing values
 *     (no audit collection, no title regex). Faster and surgical.
 *   - Reuses the `canonicalizeSeniorityLevel` helper from Phase 68 — single
 *     source of truth for the mapping table (DRY).
 *
 * Default DRY-RUN. `--apply` to commit. Idempotent (re-running is no-op once
 * all docs are canonical).
 *
 * Usage:
 *   node scripts/normalize-seniority-outliers.mjs                    # dry-run
 *   node scripts/normalize-seniority-outliers.mjs --apply             # commit
 *   node scripts/normalize-seniority-outliers.mjs --limit 5 --apply
 *   node scripts/normalize-seniority-outliers.mjs --status active
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON env.
 */

import { initializeApp, applicationDefault, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import {
  SENIORITY_LEVEL_VOCAB,
  canonicalizeSeniorityLevel,
  inferSeniority,
} from "./backfill-seniority-level.mjs"

// ─── CLI flags ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const DRY_RUN = !argv.includes("--apply")
const PROJECT_ID = process.env.FIREBASE_PROJECT ?? "wekruit-5f89b"
const STATUS = (() => {
  const i = argv.indexOf("--status")
  return i >= 0 ? argv[i + 1] : "active"
})()
const LIMIT = (() => {
  const i = argv.indexOf("--limit")
  return i >= 0 ? parseInt(argv[i + 1] ?? "0", 10) : 0
})()
const BATCH_SIZE = (() => {
  const i = argv.indexOf("--batch-size")
  return i >= 0 ? parseInt(argv[i + 1] ?? "100", 10) : 100
})()

const VOCAB_SET = new Set(SENIORITY_LEVEL_VOCAB)

// ─── Pure helpers (testable) ────────────────────────────────────────────────

/**
 * Decide what to do for one doc.
 *
 * Returns a plan object with `mode` ∈ { skip-canonical, skip-empty,
 * skip-no-mapping, rewrite }. Only `rewrite` mode performs a write.
 *
 * - skip-canonical : seniorityLevel is already a canonical lowercase token
 * - skip-empty     : seniorityLevel missing/empty (out of scope for THIS
 *                    script — Phase 57 backfill handles those)
 * - skip-no-mapping: non-canonical AND canonicalize/infer cannot resolve it
 *                    (caller leaves the doc alone for human review)
 * - rewrite        : non-canonical resolved → write canonical token
 */
export function planDoc(doc) {
  const sl = doc?.seniorityLevel
  if (sl == null || String(sl).trim() === "") {
    return { mode: "skip-empty" }
  }
  const slStr = String(sl).trim()
  // Already canonical lowercase passes through with no-op
  if (VOCAB_SET.has(slStr) && slStr === slStr.toLowerCase()) {
    return { mode: "skip-canonical", existing: sl }
  }
  // Try the mapping helper first
  const canonical = canonicalizeSeniorityLevel(slStr)
  if (canonical) {
    return { mode: "rewrite", from: sl, to: canonical, source: "canonical-map" }
  }
  // Last-resort: infer from roleTitle if available
  const title = doc?.roleTitle ?? doc?.jobTitle ?? doc?.title
  if (title && typeof title === "string" && title.trim()) {
    const inferred = inferSeniority(title)
    if (inferred) {
      return { mode: "rewrite", from: sl, to: inferred, source: "title-infer" }
    }
  }
  return { mode: "skip-no-mapping", existing: sl }
}

/**
 * Build the Firestore update payload for a rewrite plan.
 */
export function buildUpdate(plan) {
  if (plan.mode !== "rewrite") {
    throw new Error(`buildUpdate: non-rewrite plan mode=${plan.mode}`)
  }
  return {
    seniorityLevel: plan.to,
    seniorityNormalizedAt: new Date().toISOString(),
    seniorityNormalizedFrom: plan.from,
    seniorityNormalizedSource: plan.source,
  }
}

// ─── Firebase init ──────────────────────────────────────────────────────────

function initFirebase() {
  if (getApps().length > 0) return
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })
      return
    } catch {
      // fall through
    }
  }
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (inlineJson) {
    try {
      initializeApp({ credential: cert(JSON.parse(inlineJson)), projectId: PROJECT_ID })
      return
    } catch {
      // fall through
    }
  }
  initializeApp({ projectId: PROJECT_ID })
}

// ─── Main scan + apply ──────────────────────────────────────────────────────

async function main() {
  console.log(`[normalize-seniority] apply=${!DRY_RUN} status=${STATUS} limit=${LIMIT || "all"}`)

  initFirebase()
  const db = getFirestore()

  const snap = await db.collection("matching-jobs").where("status", "==", STATUS).get()
  const totalActive = snap.size

  const counters = {
    totalActive,
    "skip-canonical": 0,
    "skip-empty": 0,
    "skip-no-mapping": 0,
    "rewrite": 0,
  }
  const outliers = []  // collected for apply phase
  const noMappingSamples = []  // for human review
  const distribution = {}  // canonical bucket → rewrite count
  const fromValueDistribution = {}  // raw value → count

  for (const d of snap.docs) {
    const x = d.data()
    const plan = planDoc(x)
    counters[plan.mode] = (counters[plan.mode] ?? 0) + 1
    if (plan.mode === "rewrite") {
      outliers.push({ id: d.id, plan, roleTitle: x.roleTitle ?? null })
      distribution[plan.to] = (distribution[plan.to] ?? 0) + 1
      fromValueDistribution[String(plan.from)] = (fromValueDistribution[String(plan.from)] ?? 0) + 1
      if (LIMIT && outliers.length >= LIMIT) break
    } else if (plan.mode === "skip-no-mapping") {
      if (noMappingSamples.length < 20) {
        noMappingSamples.push({ id: d.id, existing: plan.existing, roleTitle: x.roleTitle ?? null })
      }
    }
  }

  console.log("[normalize-seniority] scan summary:")
  console.log(JSON.stringify({
    counters,
    distribution,
    fromValueDistribution,
    noMappingSamples,
  }, null, 2))

  if (outliers.length === 0) {
    console.log("[normalize-seniority] zero outliers — nothing to do")
    return
  }

  if (DRY_RUN) {
    console.log("[normalize-seniority] sample first 5 rewrites:")
    for (const o of outliers.slice(0, 5)) {
      console.log(`  - ${o.id} | ${o.plan.from} → ${o.plan.to} (via ${o.plan.source})${o.roleTitle ? " | " + o.roleTitle : ""}`)
    }
    console.log(`\n[normalize-seniority] DRY-RUN — no writes. Re-run with --apply to commit ${outliers.length} rewrite(s).`)
    return
  }

  // Apply phase
  let processed = 0
  let failed = 0
  const samplePairs = []
  for (let i = 0; i < outliers.length; i += BATCH_SIZE) {
    const batch = outliers.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(outliers.length / BATCH_SIZE)

    await Promise.all(batch.map(async (o) => {
      try {
        const upd = buildUpdate(o.plan)
        await db.collection("matching-jobs").doc(o.id).update(upd)
        processed++
        if (samplePairs.length < 5) {
          samplePairs.push({ id: o.id, from: o.plan.from, to: o.plan.to, source: o.plan.source })
        }
      } catch (err) {
        failed++
        console.error(`[normalize-seniority] failed ${o.id}: ${err?.message ?? err}`)
      }
    }))

    console.log(`[normalize-seniority] batch ${batchNum}/${totalBatches} processed=${processed}/${outliers.length} failed=${failed}`)
  }

  console.log("\n[normalize-seniority] SUMMARY:")
  console.log(JSON.stringify({
    apply: true,
    counters,
    distribution,
    fromValueDistribution,
    processed,
    failed,
    samplePairs,
    noMappingSamples,
  }, null, 2))
}

const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error("[normalize-seniority] FATAL:", err?.stack ?? err?.message ?? String(err))
    process.exit(1)
  })
}
