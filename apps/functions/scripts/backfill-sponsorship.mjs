#!/usr/bin/env node
/**
 * v1.7 Phase 64 — Backfill `matching-jobs.sponsorship` via allowlist + LLM JD inference.
 *
 * Reads active matching-jobs WHERE `sponsorship == null`, calls
 * `inferSponsorship()` per job, writes `sponsorship`, `sponsorshipSource`,
 * `sponsorshipConfidence`, `sponsorshipBackfilledAt` back to the doc.
 *
 * Idempotent: re-running skips docs that already have `sponsorshipBackfilledAt`
 * stamped UNLESS `--force-rerun` is passed.
 *
 * DRY-RUN by default: no writes; per-job inferences sampled to console + audit
 * collection `matching-jobs-sponsorship-runs/{runId}` with summary stats.
 *
 * Usage:
 *   node scripts/backfill-sponsorship.mjs                  # dry-run all
 *   node scripts/backfill-sponsorship.mjs --limit 10       # dry-run first 10
 *   node scripts/backfill-sponsorship.mjs --apply --limit 100
 *   node scripts/backfill-sponsorship.mjs --apply          # all
 *   node scripts/backfill-sponsorship.mjs --apply --force-rerun  # re-do already-backfilled
 *
 * Env (optional but recommended):
 *   PA_OPENAI_AGENT_API_KEY  | OPENAI_API_KEY
 *   ANTHROPIC_API_KEY
 *   SILICONFLOW_API_KEY
 *   GOOGLE_APPLICATION_CREDENTIALS | FIREBASE_SERVICE_ACCOUNT_JSON
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

// We import the compiled-from-TS helper via tsx so this `.mjs` script can
// reuse the canonical inference helper without duplicating LLM glue. The
// path is relative to this file when run from the repo root.
import { inferSponsorship } from "../src/lib/sponsorship-inference.ts"

// ─── CLI flags ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const DRY_RUN = !argv.includes("--apply")
const FORCE_RERUN = argv.includes("--force-rerun")
const PROJECT = (() => {
  const idx = argv.indexOf("--project")
  return idx >= 0 ? argv[idx + 1] : "wekruit-5f89b"
})()
const LIMIT = (() => {
  const idx = argv.indexOf("--limit")
  return idx >= 0 ? parseInt(argv[idx + 1], 10) : 0
})()
const STATUS_FILTER = (() => {
  const idx = argv.indexOf("--status")
  return idx >= 0 ? argv[idx + 1] : "active"
})()
const PAGE_SIZE = 100
const RATE_LIMIT_MS = 200 // throttle between pages — respect LLM rate limits

const COLLECTION = "matching-jobs"
const AUDIT_COLLECTION = "matching-jobs-sponsorship-runs"

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

// ─── Plan / migrate ───────────────────────────────────────────────────────

/**
 * Decide what to do for one job.
 *   - skip-already-set     : sponsorship !== null AND already backfilled (idempotency)
 *   - skip-already-set-true: sponsorship === true (don't re-infer; trusted from upstream/allowlist)
 *   - skip-no-title        : missing roleTitle/jobTitle (can't infer)
 *   - infer                : null sponsorship → run inferSponsorship()
 */
export function planJob(job, forceRerun = false) {
  const sponsorship = job?.sponsorship
  const backfilledAt = job?.sponsorshipBackfilledAt

  if (!forceRerun) {
    // Already explicit boolean → skip (whether from upstream or prior backfill).
    if (sponsorship === true || sponsorship === false) {
      return { mode: "skip-already-set", existing: sponsorship }
    }
    // Null but already backfilled → skip (don't waste $ on already-attempted).
    if (sponsorship === null && backfilledAt) {
      return { mode: "skip-already-attempted", existing: null }
    }
  }

  const title = job?.roleTitle ?? job?.jobTitle ?? job?.title
  if (!title || typeof title !== "string" || !title.trim()) {
    return { mode: "skip-no-title" }
  }

  return { mode: "infer", title }
}

export async function migrateJob(db, runId, jobId, jobData, opts) {
  const plan = planJob(jobData, opts.forceRerun)
  if (plan.mode !== "infer") {
    return { ...plan, jobId }
  }

  const input = {
    jobTitle: plan.title,
    companyName: jobData?.companyName ?? jobData?.company ?? null,
    jobDescription: jobData?.jobDescription ?? jobData?.description ?? null,
  }

  let result
  try {
    result = await inferSponsorship(input, opts.inferConfig)
  } catch (err) {
    return { mode: "error", jobId, error: err?.message ?? String(err) }
  }

  const before = {
    sponsorship: jobData?.sponsorship ?? null,
    sponsorshipSource: jobData?.sponsorshipSource ?? null,
  }
  const after = {
    sponsorship: result.sponsorship,
    sponsorshipSource: result.source,
    sponsorshipConfidence: result.confidence,
  }
  const now = new Date().toISOString()

  if (opts.dryRun) {
    try {
      await db
        .collection(AUDIT_COLLECTION)
        .doc(runId)
        .collection("jobs")
        .doc(jobId)
        .set({
          jobId,
          runId,
          timestamp: now,
          before,
          after,
          reasoning: result.reasoning,
        })
    } catch (err) {
      return { mode: "error", jobId, error: err?.message ?? String(err) }
    }
    return { mode: "dry-run-infer", jobId, before, after, reasoning: result.reasoning }
  }

  try {
    await db.collection(COLLECTION).doc(jobId).update({
      sponsorship: result.sponsorship,
      sponsorshipSource: result.source,
      sponsorshipConfidence: result.confidence,
      sponsorshipBackfilledAt: now,
    })
    return { mode: "applied", jobId, before, after, reasoning: result.reasoning }
  } catch (err) {
    return { mode: "error", jobId, error: err?.message ?? String(err) }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  console.log(
    `Phase 64 sponsorship backfill\n` +
      `  project=${PROJECT}\n` +
      `  mode=${DRY_RUN ? "DRY-RUN (audit only)" : "APPLY"}\n` +
      `  forceRerun=${FORCE_RERUN}\n` +
      `  status=${STATUS_FILTER}\n` +
      `  limit=${LIMIT || "none"}\n` +
      `  runId=${runId}`
  )

  initFirebase()
  const db = getFirestore()

  const inferConfig = {
    db,
    openaiApiKey: process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    siliconflowApiKey: process.env.SILICONFLOW_API_KEY,
  }
  const providerStatus = {
    anthropic: !!inferConfig.anthropicApiKey,
    openai: !!inferConfig.openaiApiKey,
    siliconflow: !!inferConfig.siliconflowApiKey,
  }
  console.log("  providers:", JSON.stringify(providerStatus))

  const auditHead = {
    runId,
    project: PROJECT,
    mode: DRY_RUN ? "dry-run" : "apply",
    statusFilter: STATUS_FILTER,
    limit: LIMIT,
    forceRerun: FORCE_RERUN,
    providerStatus,
    startedAt: new Date().toISOString(),
    completedAt: null,
    total: 0,
    inferred: 0,
    skippedAlreadySet: 0,
    skippedAlreadyAttempted: 0,
    skippedNoTitle: 0,
    errored: 0,
    sources: {
      allowlist: 0,
      jd_inference: 0,
      jd_inference_fallback: 0,
      all_failed: 0,
      no_input: 0,
    },
    sponsorshipDistribution: { true: 0, false: 0, null: 0 },
    errors: [],
    sample: [],
  }
  try {
    await db.collection(AUDIT_COLLECTION).doc(runId).set(auditHead)
  } catch (err) {
    console.error("FAIL: cannot write audit head:", err?.message ?? String(err))
    process.exit(1)
  }

  let total = 0
  let inferred = 0
  let skippedAlreadySet = 0
  let skippedAlreadyAttempted = 0
  let skippedNoTitle = 0
  let errored = 0
  const errors = []
  const sample = []
  const sources = { ...auditHead.sources }
  const sponsorshipDistribution = { true: 0, false: 0, null: 0 }

  // Page through active jobs ordered by __name__ for deterministic resumes.
  let lastDoc = null
  while (true) {
    let q = db
      .collection(COLLECTION)
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
        const res = await migrateJob(db, runId, jobId, jobData, {
          dryRun: DRY_RUN,
          forceRerun: FORCE_RERUN,
          inferConfig,
        })
        if (res.mode === "skip-already-set") {
          skippedAlreadySet++
        } else if (res.mode === "skip-already-attempted") {
          skippedAlreadyAttempted++
        } else if (res.mode === "skip-no-title") {
          skippedNoTitle++
        } else if (res.mode === "error") {
          errored++
          errors.push({ jobId, error: res.error })
        } else {
          // dry-run-infer or applied
          inferred++
          const src = res.after.sponsorshipSource
          if (sources[src] !== undefined) sources[src]++
          const sp = String(res.after.sponsorship)
          if (sponsorshipDistribution[sp] !== undefined) sponsorshipDistribution[sp]++
          if (sample.length < 10) {
            sample.push({
              jobId,
              before: res.before,
              after: res.after,
              reasoning: res.reasoning,
            })
          }
        }
        if (total % 50 === 0) {
          console.log(
            `  ${total} scanned (inferred=${inferred} ` +
              `skipSet=${skippedAlreadySet} skipAttempt=${skippedAlreadyAttempted} ` +
              `skipNoTitle=${skippedNoTitle} errored=${errored})...`
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

  const completedAt = new Date().toISOString()
  try {
    await db.collection(AUDIT_COLLECTION).doc(runId).set(
      {
        completedAt,
        total,
        inferred,
        skippedAlreadySet,
        skippedAlreadyAttempted,
        skippedNoTitle,
        errored,
        sources,
        sponsorshipDistribution,
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
    total,
    inferred,
    skippedAlreadySet,
    skippedAlreadyAttempted,
    skippedNoTitle,
    errored,
    sources,
    sponsorshipDistribution,
    errors: errors.slice(0, 20),
    sample,
  }
  console.log("\nSUMMARY:", JSON.stringify(summary, null, 2))
  if (DRY_RUN) {
    console.log(`\nDry-run complete. Audit collection: ${AUDIT_COLLECTION}/${runId}/jobs/{jobId}`)
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
