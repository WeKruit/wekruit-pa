#!/usr/bin/env node
/**
 * v1.8 P7-C — force re-enrich `matching-jobs` docs whose `enricherVersion`
 * is stale or missing.
 *
 * Why: as of 2026-05-08, 4589 of 5275 active matching-jobs (87%) had no
 * `enricherVersion` field — meaning their canonical roleFunction /
 * industrySector / requiredSkills were written by a one-shot migration
 * script (`migrate-matching-jobs-schema.mjs`) rather than the unified
 * `pa-job-tag-enricher` service. Their `requiredSkills` are flat strings
 * (legacy shape), not the canonical bucketed `Skill[]` objects, so they
 * miss out on D7's per-skill `baseWeight × jdRelative` scoring.
 *
 * What this script does:
 *   - Find matching-jobs with `status=active` AND
 *     (`enricherVersion` missing OR `enricherVersion < TARGET_VERSION`).
 *   - Bump `enricherVersion` to a sentinel `pending-reenrich-{runId}`
 *     and clear `enricherContentHash`. This makes
 *     `paMatchingJobsAutoEnrich`'s `needsEnrichment()` return true on
 *     the next write event.
 *   - Touch each doc with a no-op `_reenrichRequestedAt` timestamp to
 *     trigger the Firestore onDocumentWritten event.
 *   - The trigger then fires synchronously (CF concurrency 20) and
 *     calls `enrichJobTags()`, writing the canonical bucketed shape.
 *
 * Why not just bump ENRICHER_VERSION constant in the CF? Because that
 * forces re-enrichment of all 5275 docs at once on next sync, including
 * the 686 that were already enriched at v1.8.1. This script is targeted.
 *
 * Default DRY-RUN. Use `--apply` to commit.
 *
 * Usage:
 *   node scripts/force-reenrich-stale-jobs.mjs                  # dry-run all stale
 *   node scripts/force-reenrich-stale-jobs.mjs --limit 50       # cap to 50
 *   node scripts/force-reenrich-stale-jobs.mjs --apply --limit 50
 *   node scripts/force-reenrich-stale-jobs.mjs --apply          # commit all
 *   node scripts/force-reenrich-stale-jobs.mjs --target-version v1.8.1
 *   node scripts/force-reenrich-stale-jobs.mjs --batch-size 200 --rate-limit-ms 5000
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON env.
 *
 * Output: per-batch progress; final SUMMARY with sample of 3 before/after pairs.
 */

import { initializeApp, applicationDefault } from "firebase-admin/app"
import { getFirestore, FieldValue } from "firebase-admin/firestore"

const TARGET_VERSION = process.env.TARGET_VERSION ?? "v1.8.1"
const PROJECT_ID = process.env.FIREBASE_PROJECT ?? "wekruit-5f89b"
const args = process.argv.slice(2)
const apply = args.includes("--apply")
const limitArg = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1] ?? "0", 10) : 0
const batchSize = args.includes("--batch-size") ? parseInt(args[args.indexOf("--batch-size") + 1] ?? "100", 10) : 100
const rateLimitMs = args.includes("--rate-limit-ms") ? parseInt(args[args.indexOf("--rate-limit-ms") + 1] ?? "2000", 10) : 2000
const targetVersion = args.includes("--target-version") ? args[args.indexOf("--target-version") + 1] : TARGET_VERSION

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`

console.log(`[force-reenrich] runId=${runId} apply=${apply} limit=${limitArg || "all"} target=${targetVersion} batchSize=${batchSize} rateLimitMs=${rateLimitMs}`)

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })
const db = getFirestore()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findStaleJobs() {
  const snap = await db.collection("matching-jobs").where("status", "==", "active").get()
  const stale = []
  for (const d of snap.docs) {
    const x = d.data()
    const v = x.enricherVersion
    // No version OR not at target version → stale
    if (v == null || v === "" || v !== targetVersion) {
      stale.push({ id: d.id, currentVersion: v ?? null, contentHash: x.contentHash ?? null })
      if (limitArg && stale.length >= limitArg) break
    }
  }
  return { totalActive: snap.size, stale }
}

async function bumpDoc(jobId, currentVersion) {
  const update = {
    enricherVersion: `pending-reenrich-${runId}`,
    enricherContentHash: null,
    _reenrichRequestedAt: new Date().toISOString(),
    _reenrichPreviousVersion: currentVersion,
  }
  if (apply) {
    await db.collection("matching-jobs").doc(jobId).update(update)
  }
  return update
}

async function main() {
  const { totalActive, stale } = await findStaleJobs()
  console.log(`[force-reenrich] active=${totalActive} stale=${stale.length} (target=${targetVersion})`)

  if (stale.length === 0) {
    console.log("[force-reenrich] nothing to do")
    return
  }

  const samplePairs = []
  let processed = 0
  let failed = 0

  for (let i = 0; i < stale.length; i += batchSize) {
    const batch = stale.slice(i, i + batchSize)
    const batchNum = Math.floor(i / batchSize) + 1
    const totalBatches = Math.ceil(stale.length / batchSize)

    const writePromises = batch.map(async (job) => {
      try {
        const update = await bumpDoc(job.id, job.currentVersion)
        processed++
        if (samplePairs.length < 3) {
          samplePairs.push({ id: job.id, before: { version: job.currentVersion }, after: { version: update.enricherVersion } })
        }
      } catch (err) {
        failed++
        console.error(`[force-reenrich] failed ${job.id}: ${err.message}`)
      }
    })
    await Promise.all(writePromises)

    console.log(`[force-reenrich] batch ${batchNum}/${totalBatches} processed=${processed}/${stale.length} failed=${failed}`)
    if (i + batchSize < stale.length && apply) {
      await sleep(rateLimitMs)
    }
  }

  console.log("\n[force-reenrich] SUMMARY")
  console.log(JSON.stringify({ runId, apply, targetVersion, totalActive, staleFound: stale.length, processed, failed, samplePairs }, null, 2))
  if (!apply) {
    console.log("\n[force-reenrich] DRY-RUN — no writes were committed. Re-run with --apply to commit.")
  } else {
    console.log("\n[force-reenrich] WRITES COMMITTED. The paMatchingJobsAutoEnrich Firestore trigger will now process each touched doc and write canonical roleFunction/industrySector/requiredSkills(Skill[])/relevantTags. Monitor with:")
    console.log(`  gcloud functions logs read paMatchingJobsAutoEnrich --project ${PROJECT_ID} --region us-central1 --limit 50`)
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[force-reenrich] fatal:", err)
  process.exit(1)
})
