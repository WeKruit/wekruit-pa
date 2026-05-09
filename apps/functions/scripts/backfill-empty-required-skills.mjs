#!/usr/bin/env node
/**
 * v1.8 P7-H — backfill matching-jobs whose requiredSkills[] is empty
 * AT the current enricherVersion (v1.9.0).
 *
 * Why: Live Firestore probe (2026-05-08) of 6015 active matching-jobs:
 *   - 4515 (75.1%) have non-empty requiredSkills
 *   - 1500 (24.9%) have empty requiredSkills, ALL at enricherVersion=v1.9.0
 *     - 10 have jobDescription populated
 *     - 1490 have NO jobDescription (and no responsibilities/qualifications
 *       arrays either) — these are the legitimate Stage 2b backlog (title-only
 *       docs awaiting JD scrape)
 *
 * Distinct from `force-reenrich-stale-jobs.mjs` (P7-C):
 *   - force-reenrich targets stale enricherVersion (`!=` v1.9.0)
 *   - this script targets current version (`==` v1.9.0) AND empty requiredSkills
 *   - by design the two scripts touch disjoint doc sets — no concurrency conflict
 *
 * Default scope: JD present (matches P9-recommended scope). Use
 * `--include-title-only` to extend to docs with only roleTitle (the enricher
 * still produces something from title alone, but coverage is lower).
 *
 * Trigger mechanism: same as force-reenrich — clear `enricherContentHash` and
 * stamp `enricherVersion = "pending-reenrich-{runId}"` so
 * `paMatchingJobsAutoEnrich.needsEnrichment()` returns true on next write
 * (which is the same write — Firestore onDocumentWritten fires).
 *
 * Default DRY-RUN. Use `--apply` to commit. Idempotent.
 *
 * Usage:
 *   node scripts/backfill-empty-required-skills.mjs                       # dry-run, JD-present
 *   node scripts/backfill-empty-required-skills.mjs --apply                # commit, JD-present
 *   node scripts/backfill-empty-required-skills.mjs --include-title-only   # widen scope
 *   node scripts/backfill-empty-required-skills.mjs --limit 50 --apply
 *   node scripts/backfill-empty-required-skills.mjs --target-version v1.9.0
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON env.
 */

import { initializeApp, applicationDefault, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

// ─── CLI flags ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const DRY_RUN = !argv.includes("--apply")
const INCLUDE_TITLE_ONLY = argv.includes("--include-title-only")
const PROJECT_ID = process.env.FIREBASE_PROJECT ?? "wekruit-5f89b"
const TARGET_VERSION = (() => {
  const i = argv.indexOf("--target-version")
  return i >= 0 ? argv[i + 1] : "v1.9.0"
})()
const LIMIT = (() => {
  const i = argv.indexOf("--limit")
  return i >= 0 ? parseInt(argv[i + 1] ?? "0", 10) : 0
})()
const BATCH_SIZE = (() => {
  const i = argv.indexOf("--batch-size")
  return i >= 0 ? parseInt(argv[i + 1] ?? "100", 10) : 100
})()
const RATE_LIMIT_MS = (() => {
  const i = argv.indexOf("--rate-limit-ms")
  return i >= 0 ? parseInt(argv[i + 1] ?? "2000", 10) : 2000
})()

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`

// ─── Pure helpers (testable) ────────────────────────────────────────────────

/**
 * Decide whether a doc qualifies for re-enrichment.
 *
 * Eligible iff:
 *   - status == 'active'
 *   - requiredSkills missing or empty array
 *   - enricherVersion === targetVersion (avoid clashing with force-reenrich)
 *   - has roleTitle (enricher needs a title)
 *   - JD signal present (jobDescription / coreResponsibilities / qualifications)
 *     OR includeTitleOnly=true
 *
 * Returns { eligible: bool, reason: string, jdSignal: 'jd'|'aux'|'title'|'none' }
 */
export function planJob(doc, opts) {
  const { targetVersion, includeTitleOnly = false } = opts
  if (!doc || typeof doc !== "object") {
    return { eligible: false, reason: "empty-doc", jdSignal: "none" }
  }
  if (doc.status !== "active") {
    return { eligible: false, reason: "not-active", jdSignal: "none" }
  }
  const skills = doc.requiredSkills
  const hasSkills = Array.isArray(skills) && skills.length > 0
  if (hasSkills) {
    return { eligible: false, reason: "has-skills", jdSignal: "none" }
  }
  if (doc.enricherVersion !== targetVersion) {
    return { eligible: false, reason: "version-mismatch", jdSignal: "none" }
  }
  const title = doc.roleTitle ?? doc.jobTitle ?? doc.title
  if (!title || typeof title !== "string" || !title.trim()) {
    return { eligible: false, reason: "no-title", jdSignal: "none" }
  }

  const hasJD = typeof doc.jobDescription === "string" && doc.jobDescription.trim().length > 0
  const hasResp = Array.isArray(doc.coreResponsibilities) && doc.coreResponsibilities.length > 0
  const hasQual = Array.isArray(doc.qualifications) && doc.qualifications.length > 0
  const hasBens = Array.isArray(doc.benefits) && doc.benefits.length > 0

  let jdSignal = "none"
  if (hasJD) jdSignal = "jd"
  else if (hasResp || hasQual || hasBens) jdSignal = "aux"
  else jdSignal = "title"

  if (jdSignal === "title" && !includeTitleOnly) {
    return { eligible: false, reason: "no-jd-need-stage-2b", jdSignal }
  }

  return { eligible: true, reason: "eligible", jdSignal }
}

/**
 * Build the Firestore update payload that will trigger re-enrichment.
 *
 * Mirrors force-reenrich-stale-jobs.mjs exactly — clear contentHash so
 * `needsEnrichment()` returns true (it skips when version+hash both match).
 */
export function buildReenrichUpdate(doc, runIdArg) {
  return {
    enricherVersion: `pending-reenrich-${runIdArg}`,
    enricherContentHash: null,
    _reenrichRequestedAt: new Date().toISOString(),
    _reenrichPreviousVersion: doc.enricherVersion ?? null,
    _reenrichReason: "empty-required-skills",
  }
}

// ─── Firebase init ──────────────────────────────────────────────────────────

function initFirebase() {
  if (getApps().length > 0) return
  // Try GOOGLE_APPLICATION_CREDENTIALS path → applicationDefault
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })
      return
    } catch {
      // fall through
    }
  }
  // Inline JSON env
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
  console.log(`[backfill-empty-skills] runId=${runId} apply=${!DRY_RUN} target=${TARGET_VERSION} includeTitleOnly=${INCLUDE_TITLE_ONLY} limit=${LIMIT || "all"}`)

  initFirebase()
  const db = getFirestore()

  console.log("[backfill-empty-skills] scanning matching-jobs status=active ...")
  const snap = await db.collection("matching-jobs").where("status", "==", "active").get()
  const totalActive = snap.size

  let withSkills = 0
  let scoped = []        // eligible docs
  let reasonCounts = {}  // skip-reason histogram
  let jdSignalCounts = { jd: 0, aux: 0, title: 0, none: 0 }

  for (const d of snap.docs) {
    const x = d.data()
    const hasSkills = Array.isArray(x.requiredSkills) && x.requiredSkills.length > 0
    if (hasSkills) {
      withSkills++
      continue
    }
    const plan = planJob(x, { targetVersion: TARGET_VERSION, includeTitleOnly: INCLUDE_TITLE_ONLY })
    jdSignalCounts[plan.jdSignal] = (jdSignalCounts[plan.jdSignal] ?? 0) + 1
    if (plan.eligible) {
      scoped.push({ id: d.id, currentVersion: x.enricherVersion ?? null, jdSignal: plan.jdSignal, roleTitle: x.roleTitle ?? null })
      if (LIMIT && scoped.length >= LIMIT) break
    } else {
      reasonCounts[plan.reason] = (reasonCounts[plan.reason] ?? 0) + 1
    }
  }

  const coveragePctBefore = ((withSkills / totalActive) * 100).toFixed(1)

  console.log("[backfill-empty-skills] scan summary:")
  console.log(JSON.stringify({
    totalActive,
    withSkills,
    coveragePctBefore,
    eligibleForBackfill: scoped.length,
    skipReasonCounts: reasonCounts,
    jdSignalCounts,
  }, null, 2))

  if (scoped.length === 0) {
    console.log("[backfill-empty-skills] nothing eligible — exit")
    return
  }

  // Sample 3 docs for visibility
  const sample = scoped.slice(0, 3)
  console.log("[backfill-empty-skills] sample first 3 eligible:")
  for (const s of sample) console.log(`  - ${s.id} | ${s.roleTitle} | jdSignal=${s.jdSignal}`)

  if (DRY_RUN) {
    console.log(`\n[backfill-empty-skills] DRY-RUN — no writes. Re-run with --apply to commit ${scoped.length} doc touch(es).`)
    return
  }

  // Apply phase — touch each eligible doc
  let processed = 0
  let failed = 0
  const samplePairs = []
  for (let i = 0; i < scoped.length; i += BATCH_SIZE) {
    const batch = scoped.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(scoped.length / BATCH_SIZE)

    await Promise.all(batch.map(async (job) => {
      try {
        const update = buildReenrichUpdate({ enricherVersion: job.currentVersion }, runId)
        await db.collection("matching-jobs").doc(job.id).update(update)
        processed++
        if (samplePairs.length < 3) {
          samplePairs.push({ id: job.id, before: { version: job.currentVersion }, after: { version: update.enricherVersion } })
        }
      } catch (err) {
        failed++
        console.error(`[backfill-empty-skills] failed ${job.id}: ${err?.message ?? err}`)
      }
    }))

    console.log(`[backfill-empty-skills] batch ${batchNum}/${totalBatches} processed=${processed}/${scoped.length} failed=${failed}`)
    if (i + BATCH_SIZE < scoped.length) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
    }
  }

  console.log("\n[backfill-empty-skills] SUMMARY:")
  console.log(JSON.stringify({
    runId,
    apply: true,
    totalActive,
    coveragePctBefore,
    eligibleForBackfill: scoped.length,
    processed,
    failed,
    samplePairs,
  }, null, 2))

  console.log("\n[backfill-empty-skills] WRITES COMMITTED. paMatchingJobsAutoEnrich Firestore trigger will now process each touched doc and write canonical requiredSkills (Skill[]). Monitor with:")
  console.log(`  gcloud functions logs read paMatchingJobsAutoEnrich --project ${PROJECT_ID} --region us-central1 --limit 50`)
  console.log("\n  Then probe coverage with `node scripts/_probe-after.mjs` (or the same query) after ~5min settle.")
}

const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error("[backfill-empty-skills] FATAL:", err?.stack ?? err?.message ?? String(err))
    process.exit(1)
  })
}
