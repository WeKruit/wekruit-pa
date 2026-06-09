#!/usr/bin/env node
/**
 * Two-tier backfill — repair stranded prescreen sessions in
 * `pa-prescreen-sessions` that reached a Claire terminal (PASS / FAIL /
 * HARD_STOP) but never entered the human-review queue (missing
 * `terminalActionPendingReview` + `review`). Idempotent. Default mode is
 * read-only (dry-run); pass `--apply` to actually write.
 *
 * Founder-approved semantics (locked):
 *   - Tier 1 ("tier1_stranded") — the candidate was NEVER messaged a
 *     decision (`terminalActionFiredAt` unset). Replicate the
 *     finalizePrescreenForHumanReview write shape MINUS the pending-ack
 *     SMS: build + save the evaluation attempt (deterministic sha256
 *     attempt id ⇒ re-runs idempotent), then flag the session
 *     `terminalActionPendingReview: true` + `review.status: "pending"`.
 *     NO SMS, no outbound writes of any kind — silent queue entry.
 *   - Tier 2 ("tier2_auto_finalized") — thin-Claire auto-finalized and the
 *     candidate ALREADY received a decision message (marker:
 *     `terminalActionFiredAt` set). Mark `review.status:
 *     "legacy_unreviewed"`, NOT queued, so operators cannot fire a second
 *     contradictory decision message.
 *   - Everything else (terminal null, PAUSE, existing review / pending
 *     flag) is skipped — that is the idempotency guard.
 *
 * Tier 1 sessions whose docs lack the fields the evaluation-attempt
 * converter needs are logged as "tier1_unconvertible" and NOT flagged
 * pending — a flag-only backfill would create dead queue rows because
 * reviewEvaluationAttempt / draftPrescreenReviewMessages hard-require a
 * resolvable evaluationAttemptId.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   node scripts/backfill-prescreen-review-flags.mjs                # dry-run (default)
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   node scripts/backfill-prescreen-review-flags.mjs --apply        # writes
 *
 *   --page-size N      override the page size (default 200)
 *   --limit M          stop after scanning M sessions (smoke testing)
 */
import { initializeApp, getApps, applicationDefault, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

const args = process.argv.slice(2)
const APPLY = args.includes("--apply")
const DRY = !APPLY // default
const pageArg = args.find((a) => a.startsWith("--page-size="))
const limitArg = args.find((a) => a.startsWith("--limit="))
const PAGE_SIZE = pageArg ? Math.max(1, Math.min(1000, Number(pageArg.split("=")[1]) || 200)) : 200
const LIMIT = limitArg ? Math.max(0, Number(limitArg.split("=")[1]) || 0) : 0

const ACTIONABLE_TERMINALS = new Set(["PASS", "FAIL", "HARD_STOP"])
const SAMPLE_CAP = 10

function nowIso() {
  return new Date().toISOString()
}

function initAdmin() {
  if (getApps().length) return
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (jsonEnv && jsonEnv.trim().length > 0) {
    const sa = JSON.parse(jsonEnv)
    initializeApp({ credential: cert(sa), projectId: sa.project_id })
    return
  }
  if (path) {
    const sa = JSON.parse(readFileSync(path, "utf8"))
    initializeApp({ credential: cert(sa), projectId: sa.project_id })
    return
  }
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
  })
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v)
}

/**
 * `terminalActionFiredAt` is written as an ISO string by
 * prescreen-terminal-action.ts, but legacy readers tolerate a Firestore
 * Timestamp — treat either as "set".
 */
function isTimestampLikeSet(v) {
  if (isNonEmptyString(v)) return true
  return isPlainObject(v)
}

/**
 * Classify one `pa-prescreen-sessions` doc for the backfill.
 *
 * Returns { tier, reason } where tier is one of:
 *   - "tier1_stranded"        — terminal ∈ {PASS,FAIL,HARD_STOP}, no pending
 *                               flag, no review, no terminalActionFiredAt
 *   - "tier2_auto_finalized"  — terminal ∈ {PASS,FAIL,HARD_STOP},
 *                               terminalActionFiredAt set, no review
 *   - "skip"                  — everything else (idempotency guard)
 */
export function classifySessionForBackfill(doc) {
  const terminal = doc?.terminal
  if (!ACTIONABLE_TERMINALS.has(terminal)) {
    if (terminal === "PAUSE") return { tier: "skip", reason: "terminal_pause" }
    if (terminal === null || terminal === undefined) return { tier: "skip", reason: "terminal_null" }
    return { tier: "skip", reason: "terminal_not_actionable" }
  }
  if (isPlainObject(doc.review)) return { tier: "skip", reason: "review_exists" }
  if (doc.terminalActionPendingReview === true) return { tier: "skip", reason: "already_pending" }
  if (isTimestampLikeSet(doc.terminalActionFiredAt)) {
    return { tier: "tier2_auto_finalized", reason: "auto_finalized_no_review" }
  }
  return { tier: "tier1_stranded", reason: "stranded_terminal_no_review" }
}

/**
 * Build the prescreenSessionToEvaluationAttempt input from a session doc.
 * The session doc IS the persisted PreScreenState (FirestorePreScreenStore
 * saves the whole state with merge:true), so the converter input is
 * reconstructable directly — but legacy docs can be missing the fields the
 * converter iterates. Those are unconvertible (no dead queue rows).
 *
 * Returns { ok: true, input } or { ok: false, reason }.
 */
export function buildTier1ConverterInput(docId, doc, runNowIso) {
  if (!isNonEmptyString(doc?.userId)) return { ok: false, reason: "missing_user_id" }
  if (!isNonEmptyString(doc?.jobId)) return { ok: false, reason: "missing_job_id" }
  if (!Array.isArray(doc?.qOrder)) return { ok: false, reason: "missing_q_order" }
  if (!isPlainObject(doc?.questions)) return { ok: false, reason: "missing_questions" }
  const state = { ...doc, sessionId: docId }
  return {
    ok: true,
    input: {
      state,
      cfgSnapshot: isPlainObject(doc.cfgSnapshot) ? doc.cfgSnapshot : undefined,
      terminal: doc.terminal,
      // Mirror finalizePrescreenForHumanReview: attempt timestamps anchor on
      // the session's terminal time when available.
      nowIso: isNonEmptyString(doc.updatedAt) ? doc.updatedAt : runNowIso,
      evaluator: { kind: "hybrid", promptVersion: "prescreen-keyword-set-v2-strict" },
    },
  }
}

function tier1ReviewMerge(attemptId, terminal, writeAt) {
  return {
    evaluationAttemptId: attemptId,
    terminalActionPendingReview: true,
    review: {
      status: "pending",
      evaluationAttemptId: attemptId,
      proposedTerminal: terminal,
      pendingAt: writeAt,
      updatedAt: writeAt,
      backfill: { reason: "stranded_terminal_no_review", at: writeAt },
    },
  }
}

function tier2ReviewMerge(terminal, writeAt) {
  return {
    review: {
      status: "legacy_unreviewed",
      proposedTerminal: terminal,
      updatedAt: writeAt,
      backfill: { reason: "auto_finalized_no_review", at: writeAt },
    },
  }
}

function bumpHistogram(map, jobId) {
  const key = isNonEmptyString(jobId) ? jobId : "(no jobId)"
  map.set(key, (map.get(key) ?? 0) + 1)
}

function printHistogram(label, map) {
  if (map.size === 0) return
  console.log(`  ${label} per-job histogram:`)
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1])
  for (const [jobId, count] of rows) console.log(`    ${jobId}: ${count}`)
}

function printSamples(label, ids) {
  if (ids.length === 0) return
  console.log(`  ${label} sample doc ids (first ${SAMPLE_CAP}):`)
  for (const id of ids) console.log(`    ${id}`)
}

async function loadApplyDeps() {
  const [orchestrator, persistence, coreTypes] = await Promise.all([
    import(new URL("../packages/pa-orchestrator/dist/index.js", import.meta.url).href),
    import(new URL("../packages/pa-persistence/dist/index.js", import.meta.url).href),
    import(new URL("../packages/core-types/dist/index.js", import.meta.url).href),
  ])
  return {
    prescreenSessionToEvaluationAttempt: orchestrator.prescreenSessionToEvaluationAttempt,
    saveEvaluationAttempt: persistence.saveEvaluationAttempt,
    EvaluationAttemptSchema: coreTypes.EvaluationAttemptSchema,
  }
}

async function processPage(db, lastSnapshot) {
  let q = db.collection("pa-prescreen-sessions").orderBy("__name__").limit(PAGE_SIZE)
  if (lastSnapshot) q = q.startAfter(lastSnapshot)
  const snap = await q.get()
  return snap
}

async function main() {
  initAdmin()
  const db = getFirestore()
  console.log(
    `[backfill] mode=${DRY ? "dry-run" : "apply"} pageSize=${PAGE_SIZE}` +
      (LIMIT > 0 ? ` limit=${LIMIT}` : "")
  )

  const deps = APPLY ? await loadApplyDeps() : null

  let scanned = 0
  let tier1 = 0
  let tier2 = 0
  let skipped = 0
  let tier1Unconvertible = 0
  let tier1Applied = 0
  let tier2Applied = 0
  let writeFailures = 0
  const skipReasons = new Map()
  const tier1ByJob = new Map()
  const tier2ByJob = new Map()
  const tier1Samples = []
  const tier2Samples = []
  let lastDoc = null
  const writeAt = nowIso()

  scan: while (true) {
    const snap = await processPage(db, lastDoc)
    if (snap.empty) break
    for (const docSnap of snap.docs) {
      scanned++
      const data = docSnap.data() ?? {}
      const verdict = classifySessionForBackfill(data)
      if (verdict.tier === "skip") {
        skipped++
        skipReasons.set(verdict.reason, (skipReasons.get(verdict.reason) ?? 0) + 1)
      } else if (verdict.tier === "tier1_stranded") {
        tier1++
        bumpHistogram(tier1ByJob, data.jobId)
        if (tier1Samples.length < SAMPLE_CAP) tier1Samples.push(docSnap.id)
        const built = buildTier1ConverterInput(docSnap.id, data, writeAt)
        if (!built.ok) {
          tier1Unconvertible++
          console.log(`  tier1_unconvertible session=${docSnap.id} reason=${built.reason}`)
        } else if (APPLY) {
          let attempt = null
          try {
            const candidate = deps.prescreenSessionToEvaluationAttempt(built.input)
            const parsed = deps.EvaluationAttemptSchema.safeParse(candidate)
            if (!parsed.success) {
              tier1Unconvertible++
              console.log(
                `  tier1_unconvertible session=${docSnap.id} reason=attempt_schema_invalid ${parsed.error.issues?.[0]?.message ?? ""}`
              )
            } else {
              attempt = parsed.data
            }
          } catch (err) {
            tier1Unconvertible++
            console.log(
              `  tier1_unconvertible session=${docSnap.id} reason=converter_threw ${err instanceof Error ? err.message : String(err)}`
            )
          }
          if (attempt) {
            try {
              await deps.saveEvaluationAttempt(db, attempt)
              await docSnap.ref.set(tier1ReviewMerge(attempt.attemptId, data.terminal, writeAt), { merge: true })
              tier1Applied++
            } catch (err) {
              writeFailures++
              console.error(
                `  write_failed tier=tier1 session=${docSnap.id}: ${err instanceof Error ? err.message : String(err)}`
              )
            }
          }
        }
      } else if (verdict.tier === "tier2_auto_finalized") {
        tier2++
        bumpHistogram(tier2ByJob, data.jobId)
        if (tier2Samples.length < SAMPLE_CAP) tier2Samples.push(docSnap.id)
        if (APPLY) {
          try {
            await docSnap.ref.set(tier2ReviewMerge(data.terminal, writeAt), { merge: true })
            tier2Applied++
          } catch (err) {
            writeFailures++
            console.error(
              `  write_failed tier=tier2 session=${docSnap.id}: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }
      }
      if (LIMIT > 0 && scanned >= LIMIT) break scan
    }
    lastDoc = snap.docs[snap.docs.length - 1]
    if (snap.size < PAGE_SIZE) break
  }

  console.log(
    `scanned=${scanned} tier1_stranded=${tier1} tier2_auto_finalized=${tier2} skipped=${skipped} tier1_unconvertible=${tier1Unconvertible}`
  )
  if (skipReasons.size > 0) {
    const detail = [...skipReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ")
    console.log(`  skip reasons: ${detail}`)
  }
  printHistogram("tier1_stranded", tier1ByJob)
  printHistogram("tier2_auto_finalized", tier2ByJob)
  printSamples("tier1_stranded", tier1Samples)
  printSamples("tier2_auto_finalized", tier2Samples)
  if (APPLY) {
    console.log(`[apply] tier1_applied=${tier1Applied} tier2_applied=${tier2Applied} write_failures=${writeFailures}`)
    if (writeFailures > 0) {
      console.error("[backfill] one or more writes failed")
      process.exit(1)
    }
  } else {
    console.log("(no writes performed; re-run with --apply to persist)")
  }
}

// Allow `import` from tests without auto-running main.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[backfill] fatal:", e)
    process.exit(1)
  })
}
