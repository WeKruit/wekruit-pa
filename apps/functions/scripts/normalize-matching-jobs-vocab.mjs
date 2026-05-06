#!/usr/bin/env node
/**
 * v1.6 Phase 57 — Normalize matching-jobs.jobType to canonical TAG-05 vocab.
 *
 * Mapping (D5 — no abbreviations in canonical vocab):
 *   intern               → internship
 *   intern_internship    → internship
 *   new_grad             → new_graduate
 *   newgrad              → new_graduate
 *   co-op                → co_op_rotation
 *   coop                 → co_op_rotation
 *   return-to-work       → return_to_work_program
 *   ft / fulltime        → full_time
 *   pt / parttime        → part_time
 *
 * Default DRY-RUN: writes proposed update + diff to
 * `matching-jobs-normalize-audit/{runId}/jobs/{jobId}` for Adam to review.
 * Use `--apply` to write the actual `jobType` field onto matching-jobs docs.
 *
 * Idempotent: skips docs whose jobType already matches a canonical TAG-05
 * value AND has `jobTypeNormalizedAt` set.
 *
 * Usage:
 *   node scripts/normalize-matching-jobs-vocab.mjs                  # dry-run all active
 *   node scripts/normalize-matching-jobs-vocab.mjs --limit 100      # first 100
 *   node scripts/normalize-matching-jobs-vocab.mjs --apply --limit 5000
 *   node scripts/normalize-matching-jobs-vocab.mjs --apply          # all
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON env.
 *
 * Output: per-batch progress, final SUMMARY JSON with sample of 5
 * before/after pairs.
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

// ─── Canonical vocab (TAG-05) ──────────────────────────────────────────────
// Mirrors packages/shared-tags/src/canonical/job-type.ts. Inlined so the
// script is standalone (matches migrate-matching-jobs-schema.mjs convention).

export const JOB_TYPE_VOCAB = [
  "full_time",
  "internship",
  "new_graduate",
  "contract",
  "part_time",
  "fellowship",
  "apprenticeship",
  "freelance",
  "return_to_work_program",
  "co_op_rotation",
]

/**
 * Map a legacy/freeform jobType value to a canonical TAG-05 token.
 * Returns null if no mapping found AND the input is not already canonical.
 */
export function normalizeJobType(raw) {
  if (raw == null) return null
  const s = String(raw).trim().toLowerCase()
  if (!s) return null
  // Already canonical
  if (JOB_TYPE_VOCAB.includes(s)) return s

  // Legacy / abbreviations / hyphenated forms
  const direct = LEGACY_JOB_TYPE_MAP[s]
  if (direct) return direct

  // Hyphen / space → underscore + retry
  const dash = s.replace(/[-\s]+/g, "_")
  if (JOB_TYPE_VOCAB.includes(dash)) return dash
  if (LEGACY_JOB_TYPE_MAP[dash]) return LEGACY_JOB_TYPE_MAP[dash]

  return null
}

export const LEGACY_JOB_TYPE_MAP = {
  intern: "internship",
  internship: "internship",
  intern_internship: "internship",
  // new-grad variants
  new_grad: "new_graduate",
  newgrad: "new_graduate",
  "new-grad": "new_graduate",
  new_graduate: "new_graduate",
  ng: "new_graduate",
  // co-op
  "co-op": "co_op_rotation",
  coop: "co_op_rotation",
  co_op: "co_op_rotation",
  "co-op-rotation": "co_op_rotation",
  // return-to-work
  "return-to-work": "return_to_work_program",
  return_to_work: "return_to_work_program",
  rtw: "return_to_work_program",
  // full / part time
  ft: "full_time",
  fulltime: "full_time",
  "full-time": "full_time",
  pt: "part_time",
  parttime: "part_time",
  "part-time": "part_time",
  // contract / freelance / apprenticeship spellings
  contractor: "contract",
  contracting: "contract",
  freelancer: "freelance",
  freelancing: "freelance",
  apprentice: "apprenticeship",
  fellow: "fellowship",
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

/**
 * Compute the new jobType. Returns:
 *   { mode: "skip-canonical" }  — already canonical, nothing to do
 *   { mode: "skip-no-mapping" } — value not mappable, leave alone
 *   { mode: "skip-empty" }      — no jobType field
 *   { mode: "rewrite", from, to } — mapped to a different canonical token
 */
export function planJob(job) {
  const raw = job?.jobType
  if (raw == null) return { mode: "skip-empty" }
  const s = String(raw).trim().toLowerCase()
  if (!s) return { mode: "skip-empty" }
  const mapped = normalizeJobType(raw)
  if (mapped === null) return { mode: "skip-no-mapping", from: raw }
  if (mapped === s) return { mode: "skip-canonical", from: raw }
  return { mode: "rewrite", from: raw, to: mapped }
}

export async function migrateJob(db, runId, jobId, jobData, opts) {
  const plan = planJob(jobData)

  if (plan.mode === "skip-canonical" || plan.mode === "skip-empty" || plan.mode === "skip-no-mapping") {
    return { ...plan, jobId }
  }

  const before = { jobType: jobData?.jobType ?? null }
  const after = { jobType: plan.to }
  const now = new Date().toISOString()

  if (opts.dryRun) {
    try {
      await db
        .collection("matching-jobs-normalize-audit")
        .doc(runId)
        .collection("jobs")
        .doc(jobId)
        .set({ jobId, runId, timestamp: now, before, after })
    } catch (err) {
      return { mode: "error", jobId, error: err?.message ?? String(err) }
    }
    return { mode: "dry-run-rewrite", jobId, before, after }
  }

  // APPLY
  try {
    await db
      .collection("matching-jobs")
      .doc(jobId)
      .update({ jobType: plan.to, jobTypeNormalizedAt: now })
    return { mode: "applied", jobId, before, after }
  } catch (err) {
    return { mode: "error", jobId, error: err?.message ?? String(err) }
  }
}

// ─── Main entrypoint ──────────────────────────────────────────────────────────

async function main() {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  console.log(
    `Phase 57 jobType vocab normalize\n` +
      `  project=${PROJECT}\n` +
      `  mode=${DRY_RUN ? "DRY-RUN (audit only)" : "APPLY"}\n` +
      `  status=${STATUS_FILTER}\n` +
      `  limit=${LIMIT || "none"}\n` +
      `  runId=${runId}`
  )

  initFirebase()
  const db = getFirestore()

  const auditHead = {
    runId,
    project: PROJECT,
    mode: DRY_RUN ? "dry-run" : "apply",
    statusFilter: STATUS_FILTER,
    limit: LIMIT,
    startedAt: new Date().toISOString(),
    completedAt: null,
    total: 0,
    rewritten: 0,
    skippedCanonical: 0,
    skippedNoMapping: 0,
    skippedEmpty: 0,
    errored: 0,
    errors: [],
    sample: [],
  }
  try {
    await db.collection("matching-jobs-normalize-audit").doc(runId).set(auditHead)
  } catch (err) {
    console.error("FAIL: cannot write audit head:", err?.message ?? String(err))
    process.exit(1)
  }

  let total = 0
  let rewritten = 0
  let skippedCanonical = 0
  let skippedNoMapping = 0
  let skippedEmpty = 0
  let errored = 0
  const errors = []
  const sample = []

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
        const res = await migrateJob(db, runId, jobId, jobData, { dryRun: DRY_RUN })
        if (res.mode === "skip-canonical") skippedCanonical++
        else if (res.mode === "skip-no-mapping") skippedNoMapping++
        else if (res.mode === "skip-empty") skippedEmpty++
        else if (res.mode === "error") {
          errored++
          errors.push({ jobId, error: res.error })
        } else {
          rewritten++
          if (sample.length < 5) sample.push({ jobId, before: res.before, after: res.after })
        }
        if (total % 200 === 0) {
          console.log(
            `  ${total} scanned (rewritten=${rewritten} skipCanon=${skippedCanonical} skipNoMap=${skippedNoMapping} skipEmpty=${skippedEmpty} errored=${errored})...`
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
    await db.collection("matching-jobs-normalize-audit").doc(runId).set(
      {
        completedAt,
        total,
        rewritten,
        skippedCanonical,
        skippedNoMapping,
        skippedEmpty,
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
    total,
    rewritten,
    skippedCanonical,
    skippedNoMapping,
    skippedEmpty,
    errored,
    errors: errors.slice(0, 20),
    sample,
  }
  console.log("\nSUMMARY:", JSON.stringify(summary, null, 2))
  if (DRY_RUN) {
    console.log(
      `\nDry-run complete. Audit collection: matching-jobs-normalize-audit/${runId}/jobs/{jobId}`
    )
    console.log("Adam-action: review audit, then re-run with --apply.")
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
