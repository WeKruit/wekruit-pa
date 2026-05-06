#!/usr/bin/env node
/**
 * Phase 61 — Normalize pa-users.tags closed-vocab fields.
 *
 * Cleans these fields per the Phase 52 canonical vocabs:
 *   - targetJobType[]: dedupe + canonicalize via JOB_TYPE_VOCAB +
 *     LEGACY_JOB_TYPE_MAP. e.g. ["intern", "internship", "new_grad"]
 *     → ["internship", "new_graduate"]
 *   - targetRoleFunction[]: dedupe + filter to ROLE_FUNCTION_VOCAB
 *     (drop any non-canonical token)
 *
 * Idempotent: skips users whose fields are already canonical AND have no
 * duplicates / non-canonical tokens.
 *
 * Default DRY-RUN: writes proposed update + diff to
 * `pa-users-vocab-normalize-audit/{runId}/users/{userId}`.
 * `--apply` writes the rewrite.
 *
 * Usage:
 *   node apps/functions/scripts/normalize-pa-users-vocab.mjs              # dry-run all
 *   node apps/functions/scripts/normalize-pa-users-vocab.mjs --user U123  # single user
 *   node apps/functions/scripts/normalize-pa-users-vocab.mjs --apply
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

// ─── Phase 52 JOB_TYPE_VOCAB (TAG-05, 10 spelled-out tokens) ───────────────
export const JOB_TYPE_VOCAB = new Set([
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
])

export const LEGACY_JOB_TYPE_MAP = {
  intern: "internship",
  internship: "internship",
  intern_internship: "internship",
  new_grad: "new_graduate",
  newgrad: "new_graduate",
  "new-grad": "new_graduate",
  new_graduate: "new_graduate",
  ng: "new_graduate",
  "co-op": "co_op_rotation",
  coop: "co_op_rotation",
  co_op: "co_op_rotation",
  "co-op-rotation": "co_op_rotation",
  "return-to-work": "return_to_work_program",
  return_to_work: "return_to_work_program",
  rtw: "return_to_work_program",
  ft: "full_time",
  fulltime: "full_time",
  "full-time": "full_time",
  pt: "part_time",
  parttime: "part_time",
  "part-time": "part_time",
  contractor: "contract",
  contracting: "contract",
  freelancer: "freelance",
  freelancing: "freelance",
  apprentice: "apprenticeship",
  fellow: "fellowship",
}

export function normalizeJobType(raw) {
  if (typeof raw !== "string") return null
  const s = raw.trim().toLowerCase()
  if (!s) return null
  if (JOB_TYPE_VOCAB.has(s)) return s
  if (LEGACY_JOB_TYPE_MAP[s]) return LEGACY_JOB_TYPE_MAP[s]
  const dash = s.replace(/[-\s]+/g, "_")
  if (JOB_TYPE_VOCAB.has(dash)) return dash
  if (LEGACY_JOB_TYPE_MAP[dash]) return LEGACY_JOB_TYPE_MAP[dash]
  return null
}

// ─── Phase 52 ROLE_FUNCTION_VOCAB (TAG-01, 17 spelled-out tokens) ─────────
export const ROLE_FUNCTION_VOCAB = new Set([
  "software_engineering",
  "engineering_and_development",
  "data_analysis",
  "product_management",
  "business_analyst",
  "creatives_and_design",
  "consultant",
  "accounting_and_finance",
  "marketing",
  "management_and_executive",
  "sales",
  "human_resources",
  "legal_and_compliance",
  "arts_and_entertainment",
  "education_and_training",
  "public_sector_and_government",
  "customer_service_and_support",
])

// CanonicalRole (statedPreferences) → ROLE_FUNCTION_VOCAB (Phase 52)
export const ROLE_TO_FUNCTION = {
  swe: "software_engineering",
  ml: "data_analysis",
  data: "data_analysis",
  research: "data_analysis",
  pm: "product_management",
  em: "management_and_executive",
  designer: "creatives_and_design",
  ops: "engineering_and_development",
  marketing: "marketing",
  sales: "sales",
  founder: "management_and_executive",
}

export function normalizeRoleFunction(raw) {
  if (typeof raw !== "string") return null
  const s = raw.trim().toLowerCase()
  if (!s) return null
  if (ROLE_FUNCTION_VOCAB.has(s)) return s
  const mapped = ROLE_TO_FUNCTION[s]
  if (mapped && ROLE_FUNCTION_VOCAB.has(mapped)) return mapped
  return null
}

export function normalizeArrayWith(arr, normalizeFn) {
  if (!Array.isArray(arr)) return { normalized: arr, changed: false }
  const seen = new Set()
  const out = []
  let changed = false
  for (const item of arr) {
    const norm = normalizeFn(item)
    if (norm === null) {
      if (typeof item === "string" && item.trim().length > 0) changed = true
      continue
    }
    if (norm !== item) changed = true
    if (!seen.has(norm)) {
      seen.add(norm)
      out.push(norm)
    }
  }
  // Order-preserving dedupe ⇒ if the original had duplicates, length differs
  if (Array.isArray(arr) && out.length !== arr.length) changed = true
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

  const jobUpd = normalizeArrayWith(tags.targetJobType, normalizeJobType)
  const roleUpd = normalizeArrayWith(tags.targetRoleFunction, normalizeRoleFunction)

  if (!jobUpd.changed && !roleUpd.changed) {
    return { mode: "skip-clean", userId }
  }

  const before = {}
  const after = {}
  if (jobUpd.changed) {
    before.targetJobType = tags.targetJobType
    after.targetJobType = jobUpd.normalized
  }
  if (roleUpd.changed) {
    before.targetRoleFunction = tags.targetRoleFunction
    after.targetRoleFunction = roleUpd.normalized
  }

  if (opts.dryRun) {
    try {
      await db
        .collection("pa-users-vocab-normalize-audit")
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
    if (jobUpd.changed) update.tags.targetJobType = jobUpd.normalized
    if (roleUpd.changed) update.tags.targetRoleFunction = roleUpd.normalized
    await db.collection("pa-users").doc(userId).set(update, { merge: true })
    return { mode: "applied", userId, before, after }
  } catch (err) {
    return { mode: "error", userId, error: err?.message ?? String(err) }
  }
}

async function main() {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  console.log(
    `Phase 61 pa-users vocab normalize\n` +
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
    const snap = await db.collection("pa-users").doc(SINGLE_USER).get()
    if (snap.exists) {
      total = 1
      const res = await fixUser(db, runId, SINGLE_USER, snap.data(), { dryRun: DRY_RUN })
      console.log("result:", JSON.stringify(res, null, 2))
      if (res.mode === "applied" || res.mode === "dry-run-rewrite") rewritten++
      else if (res.mode === "error") {
        errored++
        errors.push(res)
      } else skipped++
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
        if (LIMIT > 0 && total >= LIMIT) break
        total++
        try {
          const res = await fixUser(db, runId, doc.id, doc.data(), { dryRun: DRY_RUN })
          if (res.mode === "applied" || res.mode === "dry-run-rewrite") {
            rewritten++
            if (sample.length < 5)
              sample.push({ userId: res.userId, before: res.before, after: res.after })
          } else if (res.mode === "error") {
            errored++
            errors.push(res)
          } else {
            skipped++
          }
        } catch (err) {
          errored++
          errors.push({ userId: doc.id, error: err?.message ?? String(err) })
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
    sample,
  }
  console.log("\nSUMMARY:", JSON.stringify(summary, null, 2))
  if (DRY_RUN) {
    console.log(
      `\nDry-run complete. Audit: pa-users-vocab-normalize-audit/${runId}/users/{userId}\n` +
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
