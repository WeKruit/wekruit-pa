#!/usr/bin/env node
/**
 * v1.7 Phase 63 — Backfill matching-jobs.sources for legacy JobRight rows.
 *
 * Phase 63 (SENIOR-05) introduces multi-source attribution: every
 * matching-jobs doc now carries `sources: string[]` so downstream queries
 * can filter / group / display by origin. Pre-Phase 63 the corpus is 100%
 * JobRight (via macmini wekruit-matching pipeline → Firestore sync), but
 * those legacy rows lack a `sources` field entirely.
 *
 * This script writes `sources: ['jobright']` onto each matching-jobs doc
 * that:
 *   - has no `sources` field at all, OR
 *   - has `sources` set to an empty array
 *
 * Idempotent: docs that already have `sources` populated are skipped.
 *
 * Default DRY-RUN: prints proposed updates without writing. `--apply` writes.
 *
 * Usage:
 *   node scripts/backfill-sources-attribution.mjs                # dry-run all
 *   node scripts/backfill-sources-attribution.mjs --limit 100    # first 100
 *   node scripts/backfill-sources-attribution.mjs --apply        # full run
 *   node scripts/backfill-sources-attribution.mjs --apply --limit 5000
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

// ─── CLI flags ────────────────────────────────────────────────────────────────

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
const RATE_LIMIT_MS = 50

// Default source for legacy backfill — the entire pre-Phase-63 corpus came
// from the JobRight pipeline (intern + newgrad GitHub repos + minisites).
export const LEGACY_SOURCE = "jobright"

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

// ─── Plan one job ─────────────────────────────────────────────────────────

/**
 * Decide what to do for a single matching-jobs doc.
 *   - "skip-already-set" : sources is a non-empty array
 *   - "rewrite"          : sources missing OR empty array
 *
 * Exported for unit tests.
 */
export function planJob(jobData) {
  const existing = jobData?.sources
  if (Array.isArray(existing) && existing.length > 0) {
    return { mode: "skip-already-set", existing }
  }
  return { mode: "rewrite", to: [LEGACY_SOURCE] }
}

// ─── Apply one job ────────────────────────────────────────────────────────

export async function migrateJob(db, jobId, jobData, opts) {
  const plan = planJob(jobData)
  if (plan.mode === "skip-already-set") {
    return { ...plan, jobId }
  }

  if (opts.dryRun) {
    return { mode: "dry-run-rewrite", jobId, to: plan.to }
  }

  try {
    await db
      .collection("matching-jobs")
      .doc(jobId)
      .update({
        sources: plan.to,
        sourcesBackfilledAt: new Date().toISOString(),
      })
    return { mode: "applied", jobId, to: plan.to }
  } catch (err) {
    return { mode: "error", jobId, error: err?.message ?? String(err) }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `Phase 63 sources backfill\n` +
      `  project=${PROJECT}\n` +
      `  mode=${DRY_RUN ? "DRY-RUN" : "APPLY"}\n` +
      `  legacy_source=${LEGACY_SOURCE}\n` +
      `  limit=${LIMIT || "none"}`
  )

  initFirebase()
  const db = getFirestore()

  let total = 0
  let rewritten = 0
  let skippedAlreadySet = 0
  let errored = 0
  const errors = []
  const sample = []

  let lastDoc = null
  while (true) {
    let q = db.collection("matching-jobs").orderBy("__name__").limit(PAGE_SIZE)
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
        const res = await migrateJob(db, jobId, jobData, { dryRun: DRY_RUN })
        if (res.mode === "skip-already-set") {
          skippedAlreadySet++
        } else if (res.mode === "error") {
          errored++
          errors.push({ jobId, error: res.error })
        } else {
          rewritten++
          if (sample.length < 5) sample.push({ jobId, to: res.to })
        }
        if (total % 200 === 0) {
          console.log(
            `  ${total} scanned (rewritten=${rewritten} skipSet=${skippedAlreadySet} errored=${errored})...`
          )
        }
      } catch (err) {
        errored++
        errors.push({ jobId, error: err?.message ?? String(err) })
      }
    }

    if (LIMIT > 0 && total >= LIMIT) break
    if (snap.docs.length < PAGE_SIZE) break
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS))
  }

  console.log("\n=== Summary ===")
  console.log(`  total            : ${total}`)
  console.log(`  rewritten        : ${rewritten}`)
  console.log(`  skippedAlreadySet: ${skippedAlreadySet}`)
  console.log(`  errored          : ${errored}`)
  if (sample.length > 0) {
    console.log("\n  sample updates:")
    for (const s of sample) console.log(`    ${s.jobId} → sources=${JSON.stringify(s.to)}`)
  }
  if (errors.length > 0) {
    console.log("\n  errors (first 5):")
    for (const e of errors.slice(0, 5)) console.log(`    ${e.jobId}: ${e.error}`)
  }
}

// node v18+ — entry-point detection via import.meta.url
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("FATAL:", err)
    process.exit(1)
  })
}
