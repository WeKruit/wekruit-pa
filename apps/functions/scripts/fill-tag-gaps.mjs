#!/usr/bin/env node
/**
 * Phase 71 (QADATA-02) — Fill missing pa-users.tags axes via auto-derive.
 *
 * Phase 61's `paQaEvaluatorWeekly` filters by
 * `tags.targetRoleFunction.length > 0`. Today only ~5 users qualify; the
 * sampleSize is below the 50-user statistical floor. This script scans
 * pa-users, computes auto-derive defaults from CV signals
 * (`tags.skills` buckets + `parsedCandidateResumes.workHistory[0].title`)
 * for axes that are MISSING ON THE EXISTING TAGS DOC, and writes them via
 * `applyPartialUserTags` (USER-TAG-05 sole-writer invariant).
 *
 * Crucially:
 *   - DRY-RUN by default (writes nothing)
 *   - --apply is required to actually mutate pa-users
 *   - ONLY fills missing axes — never overwrites admin-set values (tests
 *     `targetRoleFunction == null OR targetRoleFunction.length === 0`)
 *
 * Audit collection (always-on, even in --apply):
 *   pa-users-tag-gaps-audit/{runId}                 — run summary
 *   pa-users-tag-gaps-audit/{runId}/users/{userId}  — per-user diff
 *
 * Modes:
 *   --apply               actually write pa-users.tags (default: report only)
 *   --write-audit         write audit docs in report mode (apply always audits)
 *   --include-demo        include demo/test/internal/external rows (debug only)
 *   --user <uid>          single-user testing
 *   --limit <N>           stop after N users
 *   --project <id>        Firebase project (default: wekruit-5f89b)
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON env.
 *
 * Usage:
 *   node apps/functions/scripts/fill-tag-gaps.mjs --limit 50      # dry-run sample
 *   node apps/functions/scripts/fill-tag-gaps.mjs --apply         # write
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

// Workspace import — auto-derive helpers (source TS resolves via tsx hooks
// when invoked as `node --import tsx scripts/fill-tag-gaps.mjs`; falls back
// to compiled `lib/` when run after build).
import {
  classifyCandidateProfile,
  deriveCandidateSource,
} from "@pa/core-types"
import { computeResumeBaselineTagPatch } from "../src/lib/resume-baseline-tags.js"

// ─── CLI flags ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const DRY_RUN = !argv.includes("--apply")
const WRITE_AUDIT = argv.includes("--write-audit") || !DRY_RUN
const INCLUDE_DEMO = argv.includes("--include-demo")
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Tests whether an axis is "missing" on the existing tags doc.
 * Missing = key absent OR value is null/undefined OR (for arrays) length 0.
 */
export function isAxisMissing(tags, axis) {
  if (!tags || typeof tags !== "object") return true
  const v = tags[axis]
  if (v == null) return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === "string") return v.trim().length === 0
  return false
}

const STATED_ROLE_TO_FUNCTION = {
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
  other: null,
}

/**
 * Project `statedPreferences.targetRole[]` → `targetRoleFunction[]`. Used
 * as a parallel source to skill-bucket vote when CV signals are absent.
 */
function statedRolesToFunctions(targetRole) {
  if (!Array.isArray(targetRole)) return []
  const out = []
  for (const r of targetRole) {
    if (typeof r !== "string") continue
    const fn = STATED_ROLE_TO_FUNCTION[r.toLowerCase()]
    if (fn && !out.includes(fn)) out.push(fn)
  }
  return out
}

function skillNamesFromTags(skills) {
  if (!Array.isArray(skills)) return []
  const out = []
  const seen = new Set()
  for (const raw of skills) {
    const name =
      typeof raw === "string"
        ? raw.trim()
        : raw && typeof raw === "object" && typeof raw.name === "string"
          ? raw.name.trim()
          : ""
    const key = name.toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

export function isEligibleTagGapBackfillUser(userDoc, linkedSource) {
  if (!userDoc || typeof userDoc !== "object") return false
  const doc = { ...userDoc, id: String(userDoc.id ?? "") }
  const source = deriveCandidateSource(doc, linkedSource)
  return classifyCandidateProfile(source, doc) === "candidate_account"
}

/**
 * Given existing tags + CV signals, compute the set of "fill" updates that
 * would close gaps. Returns ONLY axes that are currently missing AND for
 * which auto-derive produced a value. Never overwrites admin-set values.
 *
 * Inputs:
 *   - tags: existing pa-users.tags blob (may be {} or null)
 *   - resumeDoc: the latest parsedCandidateResumes (for workHistory + CV-side
 *     skill fallback when tags.skills is empty)
 *   - statedPreferences: optional pa-users.statedPreferences (fallback for
 *     targetRole when CV signals absent)
 *
 * Output: { proposed: PartialUserTags, sources: { axis: source }, reasoning }
 */
export function computeTagGapFill(tags, resumeDoc, statedPreferences, opts = {}) {
  const proposed = {}
  const sources = {}
  const reasoning = {}

  const tagSkillNames = skillNamesFromTags(tags?.skills)
  const parsedResume =
    resumeDoc ??
    (tagSkillNames.length > 0 || tags?.yoeRange || statedPreferences?.yoeRange
      ? { candidateProfile: { skills: tagSkillNames } }
      : null)
  const baseline = computeResumeBaselineTagPatch({
    existingTags: tags,
    mergedTags: {},
    statedPreferences,
    parsedResume,
    nowYear: opts.nowYear,
  })
  Object.assign(proposed, baseline.proposed)
  Object.assign(sources, baseline.sources)
  Object.assign(reasoning, baseline.reasoning)
  if (!resumeDoc) {
    delete proposed.targetJobType
    delete sources.targetJobType
    delete reasoning.targetJobType
  }
  const resumeSkillNames = Array.isArray(resumeDoc?.candidateProfile?.skills)
    ? resumeDoc.candidateProfile.skills
    : Array.isArray(resumeDoc?.skills)
      ? resumeDoc.skills
      : []
  if (proposed.targetRoleFunction && (tagSkillNames.length > 0 || resumeSkillNames.length > 0)) {
    sources.targetRoleFunction = "auto-derive-skill-bucket"
  }

  if (isAxisMissing(tags, "targetRoleFunction") && !proposed.targetRoleFunction && statedPreferences && Array.isArray(statedPreferences.targetRole)) {
    const fromStated = statedRolesToFunctions(statedPreferences.targetRole)
    if (fromStated.length > 0) {
      proposed.targetRoleFunction = fromStated
      sources.targetRoleFunction = "auto-derive-stated-preferences"
      reasoning.targetRoleFunction = `statedRoles=${JSON.stringify(statedPreferences.targetRole)} → ${JSON.stringify(fromStated)}`
    }
  }

  return { proposed, sources, reasoning }
}

// ─── Per-user processor ───────────────────────────────────────────────────────

async function getLatestParsedResume(db, userId) {
  try {
    const snap = await db
      .collection("parsedCandidateResumes")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get()
    if (snap.empty) return null
    return snap.docs[0].data()
  } catch {
    return null
  }
}

/**
 * Apply the gap fill to pa-users.tags via merge-set. The mergeUserTags lib is
 * the canonical sole-writer (USER-TAG-05); we mirror its semantics here
 * (read-merge-set with `merge: true`) since we only fill missing axes.
 *
 * Future: swap this to import `applyPartialUserTags` once apps/functions is
 * built. For the standalone .mjs script we use the same Firestore call shape
 * to avoid pulling in the workspace.
 */
async function writeFillToPaUsers(db, userId, partial, nowIso) {
  const tagsToMerge = { ...partial }
  // Stamp lastUpdatedFromMigration so we can audit when auto-derive ran.
  tagsToMerge.lastUpdatedFromMigration = nowIso
  await db
    .collection("pa-users")
    .doc(userId)
    .set({ tags: tagsToMerge }, { merge: true })
}

/**
 * Process one user. Always writes a per-user audit row; in --apply mode also
 * mutates pa-users.tags (only if there are changes).
 *
 * Idempotency: re-running on a user whose targetRoleFunction is now set
 * produces `proposed = {}` (`isAxisMissing` returns false).
 */
export async function processUser(db, userId, userData, opts = {}) {
  const {
    dryRun = true,
    runId,
    log = () => {},
    nowIso = new Date().toISOString(),
    writeAudit = true,
    filterRealCandidates = false,
    includeDemo = false,
  } = opts
  if (filterRealCandidates && !includeDemo && !isEligibleTagGapBackfillUser({ ...userData, id: userId })) {
    return {
      mode: "skipped",
      userId,
      hasChanges: false,
      skippedReason: "not_candidate_account",
      proposedKeys: [],
    }
  }
  const tags = userData?.tags ?? {}
  const statedPreferences = userData?.statedPreferences ?? null
  const resumeDoc = await getLatestParsedResume(db, userId)
  const { proposed, sources, reasoning } = computeTagGapFill(tags, resumeDoc, statedPreferences)
  const hasChanges = Object.keys(proposed).length > 0

  // Audit per-user (always written, even in --apply, for traceability).
  if (runId && writeAudit) {
    try {
      await db
        .collection("pa-users-tag-gaps-audit")
        .doc(runId)
        .collection("users")
        .doc(userId)
        .set({
          userId,
          ts: nowIso,
          mode: dryRun ? "dry-run" : "apply",
          proposed,
          currentTags: {
            targetRoleFunction: tags?.targetRoleFunction ?? null,
            careerStage: tags?.careerStage ?? null,
            yoeRange: tags?.yoeRange ?? null,
            targetJobType: tags?.targetJobType ?? null,
            skillsCount: Array.isArray(tags?.skills) ? tags.skills.length : 0,
          },
          sources,
          reasoning,
          hasChanges,
          cvSourceFound: resumeDoc != null,
        })
    } catch (err) {
      log(`AUDIT-WRITE-FAIL ${userId}: ${err?.message ?? String(err)}`)
    }
  }

  if (dryRun || !hasChanges) {
    return {
      mode: dryRun ? "dry-run" : "apply-noop",
      userId,
      hasChanges,
      proposedKeys: Object.keys(proposed),
    }
  }

  // APPLY mode + has changes.
  try {
    await writeFillToPaUsers(db, userId, proposed, nowIso)
    return {
      mode: "applied",
      userId,
      hasChanges,
      proposedKeys: Object.keys(proposed),
    }
  } catch (err) {
    return { mode: "error", userId, error: err?.message ?? String(err) }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const startedAt = new Date().toISOString()

  console.log(
    `Phase 71 fill-tag-gaps (project=${PROJECT}, mode=${DRY_RUN ? "REPORT" : "APPLY"}, user=${SINGLE_USER ?? "all"}, limit=${LIMIT || "none"}, writeAudit=${WRITE_AUDIT}, includeDemo=${INCLUDE_DEMO}, runId=${runId})`
  )
  initFirebase()
  const db = getFirestore()

  if (WRITE_AUDIT) {
    try {
      await db
        .collection("pa-users-tag-gaps-audit")
        .doc(runId)
        .set({
          runId,
          startedAt,
          mode: DRY_RUN ? "report" : "apply",
          project: PROJECT,
          limit: LIMIT || null,
          includeDemo: INCLUDE_DEMO,
          status: "in-progress",
        })
    } catch {
      // non-fatal
    }
  }

  const log = (...args) => console.log(...args)
  let processed = 0
  let withChanges = 0
  let errored = 0
  const errors = []

  if (SINGLE_USER) {
    const snap = await db.collection("pa-users").doc(SINGLE_USER).get()
    if (!snap.exists) {
      console.error(`User not found: ${SINGLE_USER}`)
      process.exit(1)
    }
    const res = await processUser(db, SINGLE_USER, snap.data(), {
      dryRun: DRY_RUN,
      runId,
      log,
      writeAudit: WRITE_AUDIT,
      filterRealCandidates: true,
      includeDemo: INCLUDE_DEMO,
    })
    console.log(JSON.stringify(res, null, 2))
    return
  }

  // Page through all pa-users.
  let lastDoc = null
  while (true) {
    let q = db.collection("pa-users").orderBy("__name__").limit(100)
    if (lastDoc) q = q.startAfter(lastDoc)
    const snap = await q.get()
    if (snap.empty) break
    lastDoc = snap.docs[snap.docs.length - 1]
    for (const doc of snap.docs) {
      if (LIMIT > 0 && processed >= LIMIT) break
      const userId = doc.id
      const userData = doc.data()
      try {
        const res = await processUser(db, userId, userData, {
          dryRun: DRY_RUN,
          runId,
          log,
          writeAudit: WRITE_AUDIT,
          filterRealCandidates: true,
          includeDemo: INCLUDE_DEMO,
        })
        processed++
        if (res.hasChanges) withChanges++
        if (res.mode === "error") {
          errored++
          errors.push({ userId, error: res.error })
        }
        if (processed % 25 === 0) console.log(`  ${processed} processed...`)
      } catch (err) {
        errored++
        errors.push({ userId, error: err?.message ?? String(err) })
      }
    }
    if (LIMIT > 0 && processed >= LIMIT) break
    if (snap.docs.length < 100) break
  }

  const finishedAt = new Date().toISOString()
  const summary = {
    runId,
    project: PROJECT,
    mode: DRY_RUN ? "dry-run" : "apply",
    startedAt,
    finishedAt,
    total: processed,
    withChanges,
    errored,
    errors: errors.slice(0, 20),
  }

  if (WRITE_AUDIT) {
    try {
      await db
        .collection("pa-users-tag-gaps-audit")
        .doc(runId)
        .set({
          ...summary,
          status: "complete",
        })
    } catch {
      // non-fatal
    }
  }

  console.log("SUMMARY:", JSON.stringify(summary, null, 2))
  if (DRY_RUN) {
    if (WRITE_AUDIT) console.log(`\nReport complete. Audit collection: pa-users-tag-gaps-audit/${runId}`)
    console.log(`Report complete. Re-run with --apply to write only eligible real candidate pa-users.tags.`)
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
