#!/usr/bin/env node
/**
 * v1.6 Phase 57 — Backfill matching-jobs.seniorityLevel from roleTitle regex.
 *
 * Maps `roleTitle` keywords to canonical TAG-06 careerStage tokens. Falls
 * back to `mid_level` when no keyword matches (most jobright dumps are
 * mid-level by default).
 *
 * Mapping order (first match wins):
 *   intern / internship / co-op       → intern
 *   new grad / early career / entry   → entry_level
 *   junior / jr.                      → junior
 *   senior / sr. eng / sr. analyst    → senior
 *   staff                             → staff
 *   principal                         → principal
 *   vp / vice president               → vp
 *   cto/ceo/cfo/chief X officer       → c_level
 *   director / head of                → director
 *   manager / lead                    → manager
 *   default                           → mid_level
 *
 * Default DRY-RUN: writes proposed update + diff to
 * `matching-jobs-seniority-audit/{runId}/jobs/{jobId}` for Adam to review.
 * Use `--apply` to write the actual `seniorityLevel` field onto matching-jobs docs.
 *
 * Idempotent: skips docs that already have `seniorityLevel` set AND have
 * `seniorityBackfilledAt` stamped.
 *
 * Usage:
 *   node scripts/backfill-seniority-level.mjs                 # dry-run all
 *   node scripts/backfill-seniority-level.mjs --limit 100     # first 100
 *   node scripts/backfill-seniority-level.mjs --apply --limit 5000
 *   node scripts/backfill-seniority-level.mjs --apply         # all
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
const RATE_LIMIT_MS = 100

// ─── Canonical vocab (TAG-06) ─────────────────────────────────────────────
// Mirrors packages/shared-tags/src/canonical/career-stage.ts.

export const SENIORITY_LEVEL_VOCAB = [
  "student",
  "intern",
  "entry_level",
  "junior",
  "mid_level",
  "senior",
  "staff",
  "principal",
  "manager",
  "director",
  "vp",
  "c_level",
  "founder",
]

// First-match-wins ordered regex list. Order matters: more specific first.
export const SENIORITY_REGEX = [
  // Executive level: detect chief X officer / cto / ceo etc. before director/manager.
  [/\b(c[teafmid]o|cxo)\b/i, "c_level"],
  [/\bchief\s+\w+(\s+\w+)?\s+officer\b/i, "c_level"],
  // VP
  [/\b(vp|vice\s*president)\b/i, "vp"],
  // Director / head of
  [/\b(director|head\s+of)\b/i, "director"],
  // Manager / lead
  [/\b(manager|engineering\s+lead|tech\s+lead|team\s+lead)\b/i, "manager"],
  // Staff / principal
  [/\bprincipal\b/i, "principal"],
  [/\bstaff\b/i, "staff"],
  // Intern / co-op (catch first because they may also contain "engineer" / "analyst")
  [/\b(intern(ship)?|co-?op)\b/i, "intern"],
  // New grad / entry-level / early career
  [/\b(new\s*grad(uate)?|entry[\s-]*level|early\s*career)\b/i, "entry_level"],
  // Senior — match any title that contains "senior" OR starts with "sr.".
  // Phase 68 — relaxed: "Sr. Data Analyst" + "Sr Backend Engineer" should match.
  [/\bsenior\b/i, "senior"],
  [/^sr\.?\s+/i, "senior"],
  [/\bsr\.?\s+(eng(ineer)?|developer|analyst|manager|associate|consultant|designer|scientist|architect|director|specialist|lead|sde|swe)\b/i, "senior"],
  // Junior — same approach
  [/\bjunior\b/i, "junior"],
  [/^jr\.?\s+/i, "junior"],
  [/\bjr\.?\s+(eng(ineer)?|developer|analyst|associate|consultant|designer|specialist)\b/i, "junior"],
]

export const SENIORITY_DEFAULT = "mid_level"

/**
 * Phase 68 (HYGIENE-02) — canonical-mapping helper for raw multi-word
 * seniorityLevel values stored on existing matching-jobs docs.
 *
 * Many active jobs have `seniorityLevel` already set, but to a raw string
 * like "Entry Level", "New Grad, Entry Level", "Entry, Mid Level", or
 * "Senior, Lead" (from upstream macmini ingestion). These are NOT canonical
 * (TAG-06 expects spelled-out underscored tokens like "entry_level"), so
 * the V16 hard-filter window (`acceptableCareerStages`) silently drops
 * them.
 *
 * This helper takes any string and returns the canonical token. Called by
 * planJob below — when `existing` is non-null but NOT in CAREER_STAGE_VOCAB,
 * we run it through this mapper; if it produces a canonical token the
 * doc is rewritten.
 *
 * First-match-wins ordered. Multi-token values default to the LOWER tier
 * (e.g., "Entry, Mid Level" → entry_level — degrade to the more inclusive
 * canonical bucket so the candidate sees more matches).
 */
export const CANONICAL_SENIORITY_MAP_REGEX = [
  // Already canonical (case-insensitive)
  [/^(student|intern|entry_level|junior|mid_level|senior|staff|principal|manager|director|vp|c_level|founder)$/i, (m) => m[1].toLowerCase()],
  // Multi-word raw forms
  [/^entry[\s-]?level$/i, () => "entry_level"],
  [/^mid[\s-]?level$/i, () => "mid_level"],
  [/^c[\s-]?level$/i, () => "c_level"],
  [/^new[\s-]?grad(uate)?$/i, () => "entry_level"],
  [/^early[\s-]?career$/i, () => "entry_level"],
  [/^vice[\s-]?president$/i, () => "vp"],
  // Comma-separated multi-tier — degrade to the lower tier (broader window)
  [/^new[\s-]?grad(uate)?\s*,\s*entry[\s-]?level$/i, () => "entry_level"],
  [/^entry[\s-]?level\s*,\s*new[\s-]?grad(uate)?$/i, () => "entry_level"],
  [/^entry\s*,\s*mid[\s-]?level$/i, () => "entry_level"],
  [/^mid\s*,\s*entry[\s-]?level$/i, () => "entry_level"],
  [/^entry[\s-]?level\s*,\s*mid[\s-]?level$/i, () => "entry_level"],
  [/^mid[\s-]?level\s*,\s*senior$/i, () => "mid_level"],
  [/^senior\s*,\s*mid[\s-]?level$/i, () => "mid_level"],
  [/^senior\s*,\s*lead$/i, () => "senior"],
  [/^lead\s*,\s*senior$/i, () => "senior"],
  [/^senior\s*,\s*staff$/i, () => "senior"],
  [/^staff\s*,\s*senior$/i, () => "senior"],
  [/^manager\s*,\s*lead$/i, () => "manager"],
  [/^lead\s*,\s*manager$/i, () => "manager"],
  [/^director\s*,\s*manager$/i, () => "manager"],
  [/^manager\s*,\s*director$/i, () => "manager"],
  [/^director\s*,\s*vp$/i, () => "director"],
  [/^vp\s*,\s*director$/i, () => "director"],
  // Bare aliases (no comma)
  [/^lead$/i, () => "manager"],
  [/^chief$/i, () => "c_level"],
  [/^founder$/i, () => "founder"],
  [/^associate$/i, () => "junior"],
  [/^intern(ship)?$/i, () => "intern"],
]

/**
 * Map any seniorityLevel string to a canonical TAG-06 token. Returns null
 * when no rule matches (caller leaves the field alone). Called in two
 * places:
 *   1. planJob's "rewrite raw existing value" branch (Phase 68)
 *   2. Manual one-off normalization scripts that need to validate corpus values
 */
export function canonicalizeSeniorityLevel(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  for (const [re, fn] of CANONICAL_SENIORITY_MAP_REGEX) {
    const m = s.match(re)
    if (m) return fn(m)
  }
  return null
}

/**
 * Infer seniorityLevel from a roleTitle string. Returns null if input
 * empty; returns the canonical token otherwise (defaulting to mid_level
 * when nothing matches).
 */
export function inferSeniority(roleTitle) {
  if (!roleTitle || typeof roleTitle !== "string") return null
  const s = roleTitle.trim()
  if (!s) return null
  for (const [re, level] of SENIORITY_REGEX) {
    if (re.test(s)) return level
  }
  return SENIORITY_DEFAULT
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

// ─── Plan / migrate ───────────────────────────────────────────────────────

/**
 * Decide what to do for one job.
 *   - skip-canonical    : seniorityLevel is already a canonical TAG-06 token
 *   - skip-no-title     : no roleTitle to regex against AND no existing value
 *   - rewrite-canonical : existing raw string mapped to canonical token (Phase 68)
 *   - rewrite           : value missing → infer from roleTitle
 *
 * Phase 68 (HYGIENE-02) — also rewrites jobs with existing NON-canonical
 * seniorityLevel values (e.g., "Entry Level", "New Grad, Entry Level"),
 * mapping them to TAG-06 canonical tokens via canonicalizeSeniorityLevel.
 */
export function planJob(job) {
  const existing = job?.seniorityLevel
  const title = job?.roleTitle ?? job?.jobTitle ?? job?.title

  if (existing != null && String(existing).trim() !== "") {
    const existingStr = String(existing).trim()
    // Already canonical (case-insensitive match against vocab)
    if (SENIORITY_LEVEL_VOCAB.includes(existingStr.toLowerCase())) {
      // Lowercase canonical (rare misformatting) — write back
      if (existingStr !== existingStr.toLowerCase()) {
        return { mode: "rewrite-canonical", from: existing, to: existingStr.toLowerCase() }
      }
      return { mode: "skip-already-set", existing }
    }
    // Phase 68 — try canonical-mapping helper for raw multi-word values
    const canonical = canonicalizeSeniorityLevel(existingStr)
    if (canonical) {
      return { mode: "rewrite-canonical", from: existing, to: canonical }
    }
    // Not canonical and not in regex map — try title-based inference as a
    // last-resort fallback. If even that fails, leave alone (skip-no-mapping).
    if (title && typeof title === "string" && title.trim()) {
      const inferred = inferSeniority(title)
      if (inferred) {
        return { mode: "rewrite-canonical", from: existing, to: inferred }
      }
    }
    return { mode: "skip-no-mapping", existing }
  }

  if (!title || typeof title !== "string" || !title.trim()) {
    return { mode: "skip-no-title" }
  }

  const inferred = inferSeniority(title)
  if (!inferred) return { mode: "skip-no-title" }

  return { mode: "rewrite", from: existing ?? null, to: inferred, title }
}

export async function migrateJob(db, runId, jobId, jobData, opts) {
  const plan = planJob(jobData)
  if (
    plan.mode === "skip-already-set" ||
    plan.mode === "skip-no-title" ||
    plan.mode === "skip-no-mapping"
  ) {
    return { ...plan, jobId }
  }

  const before = {
    seniorityLevel: jobData?.seniorityLevel ?? null,
    roleTitle: jobData?.roleTitle ?? jobData?.jobTitle ?? jobData?.title ?? null,
  }
  const after = { seniorityLevel: plan.to }
  const now = new Date().toISOString()

  if (opts.dryRun) {
    try {
      await db
        .collection("matching-jobs-seniority-audit")
        .doc(runId)
        .collection("jobs")
        .doc(jobId)
        .set({ jobId, runId, timestamp: now, before, after, regex_matched: plan.to })
    } catch (err) {
      return { mode: "error", jobId, error: err?.message ?? String(err) }
    }
    return { mode: "dry-run-rewrite", jobId, before, after }
  }

  try {
    await db
      .collection("matching-jobs")
      .doc(jobId)
      .update({ seniorityLevel: plan.to, seniorityBackfilledAt: now })
    return { mode: "applied", jobId, before, after }
  } catch (err) {
    return { mode: "error", jobId, error: err?.message ?? String(err) }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  console.log(
    `Phase 57 seniorityLevel backfill\n` +
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
    skippedAlreadySet: 0,
    skippedNoTitle: 0,
    errored: 0,
    errors: [],
    sample: [],
    distribution: {},
  }
  try {
    await db.collection("matching-jobs-seniority-audit").doc(runId).set(auditHead)
  } catch (err) {
    console.error("FAIL: cannot write audit head:", err?.message ?? String(err))
    process.exit(1)
  }

  let total = 0
  let rewritten = 0
  let rewrittenCanonical = 0  // Phase 68 — canonicalize raw existing values
  let skippedAlreadySet = 0
  let skippedNoTitle = 0
  let skippedNoMapping = 0  // Phase 68 — non-canonical, no rule matched
  let errored = 0
  const errors = []
  const sample = []
  const sampleCanonical = []  // Phase 68 — separate audit trail for canonicalization
  const distribution = {} // bucket → count
  const nonCanonicalSamples = []  // Phase 68 — track unmapped values

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
        if (res.mode === "skip-already-set") skippedAlreadySet++
        else if (res.mode === "skip-no-title") skippedNoTitle++
        else if (res.mode === "skip-no-mapping") {
          skippedNoMapping++
          if (nonCanonicalSamples.length < 20) {
            nonCanonicalSamples.push({ jobId, existing: res.existing })
          }
        }
        else if (res.mode === "error") {
          errored++
          errors.push({ jobId, error: res.error })
        } else {
          // applied / dry-run-rewrite — track distribution
          if (res.before && res.before.seniorityLevel != null && String(res.before.seniorityLevel).trim() !== "") {
            rewrittenCanonical++
            if (sampleCanonical.length < 10) sampleCanonical.push({ jobId, before: res.before, after: res.after })
          } else {
            rewritten++
            if (sample.length < 5) sample.push({ jobId, before: res.before, after: res.after })
          }
          const bucket = res.after.seniorityLevel
          distribution[bucket] = (distribution[bucket] ?? 0) + 1
        }
        if (total % 200 === 0) {
          console.log(
            `  ${total} scanned (rewritten=${rewritten} canonicalized=${rewrittenCanonical} skipSet=${skippedAlreadySet} skipNoTitle=${skippedNoTitle} skipNoMap=${skippedNoMapping} errored=${errored})...`
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
    await db.collection("matching-jobs-seniority-audit").doc(runId).set(
      {
        completedAt,
        total,
        rewritten,
        rewrittenCanonical,
        skippedAlreadySet,
        skippedNoTitle,
        skippedNoMapping,
        errored,
        errors: errors.slice(0, 50),
        sample,
        sampleCanonical,
        nonCanonicalSamples,
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
    rewrittenCanonical,
    skippedAlreadySet,
    skippedNoTitle,
    skippedNoMapping,
    errored,
    errors: errors.slice(0, 20),
    sample,
    sampleCanonical,
    nonCanonicalSamples,
    distribution,
  }
  console.log("\nSUMMARY:", JSON.stringify(summary, null, 2))
  if (DRY_RUN) {
    console.log(
      `\nDry-run complete. Audit collection: matching-jobs-seniority-audit/${runId}/jobs/{jobId}`
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
