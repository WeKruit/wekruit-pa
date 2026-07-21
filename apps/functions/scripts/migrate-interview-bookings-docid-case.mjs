#!/usr/bin/env node
/**
 * L4 docId case-migration — `pa-interview-bookings` (Cal.com) booking docs.
 *
 * BACKGROUND: `interviewBookingDocId` (packages/core-types/src/interview-
 * bookings.ts) USED to LOWERCASE its id segments via `slugifySegment`, folding
 * the case-sensitive `pa-users` / `pa-jobs` id space onto a single doc. The
 * code now PRESERVES case. This one-shot rewrites every EXISTING `calbk-` doc
 * whose id was lowercased to the new case-preserving id, recomputed from the
 * doc's stored RAW-CASE `userId` / `jobId` fields (the doc BODY always stored
 * raw case; only the doc ID was lowercased — see scheduling-tools.ts).
 *
 * Per `calbk-` doc:
 *   newId = "calbk-" + slug(userId) + "__" + slug(jobId)   (CASE-PRESERVING)
 *     - newId === oldId             → noop (already case-correct)
 *     - newId !== oldId, target free → copy {…doc, id:newId} → newId, delete old
 *     - newId !== oldId, target busy → CONFLICT: NO destructive action (flag)
 *
 * SCOPE: ONLY `calbk-` prefixed docs. Legacy `booking-...` docs (subset schema,
 * different producer) are left untouched. Non-destructive on conflict.
 * IDEMPOTENT: after a move, the new doc recomputes to its own id → re-run = noop
 * sweep. Safe to run repeatedly (e.g. once before deploy, once after).
 *
 * Modes:
 *   --apply            actually write (default: DRY-RUN)
 *   --booking <id>     single doc (by current/old id)
 *   --limit <N>        stop after N docs
 *   --project <id>     Firebase project (default: wekruit-5f89b)
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS file OR FIREBASE_SERVICE_ACCOUNT_JSON env.
 *
 * Usage:
 *   node apps/functions/scripts/migrate-interview-bookings-docid-case.mjs            # dry-run
 *   node apps/functions/scripts/migrate-interview-bookings-docid-case.mjs --apply    # write
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

const COLLECTION = "pa-interview-bookings"
const AUDIT_COLLECTION = "pa-interview-bookings-docid-migration-audit"
const NS_PREFIX = "calbk-"

// ─── Pure logic (exported for unit tests) ────────────────────────────────────

/**
 * Case-PRESERVING segment slug — MUST stay byte-identical to `slugifySegment`
 * in packages/core-types/src/interview-bookings.ts.
 */
export function slugifySegment(value) {
  return String(value)
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
}

/** New case-preserving booking doc id from raw userId/jobId. */
export function interviewBookingDocId(userId, jobId) {
  return `${NS_PREFIX}${slugifySegment(userId)}__${slugifySegment(jobId)}`
}

/**
 * Decide the migration action for one doc. Pure — no IO.
 *   { action: "skip", reason }           not a calbk- doc / missing ids
 *   { action: "noop", oldId, newId }     already case-correct
 *   { action: "move", oldId, newId, data } rewrite oldId → newId
 */
export function planDocIdMigration(snapId, doc) {
  if (typeof snapId !== "string" || !snapId.startsWith(NS_PREFIX)) {
    return { action: "skip", reason: "not_calbk_namespace" }
  }
  const userId = doc && typeof doc.userId === "string" ? doc.userId.trim() : ""
  const jobId = doc && typeof doc.jobId === "string" ? doc.jobId.trim() : ""
  if (!userId || !jobId) {
    return { action: "skip", reason: "missing_userId_or_jobId" }
  }
  const newId = interviewBookingDocId(userId, jobId)
  if (newId === snapId) {
    return { action: "noop", oldId: snapId, newId }
  }
  return { action: "move", oldId: snapId, newId, data: { ...doc, id: newId } }
}

// ─── Runner (only invoked from CLI; isolated from tests) ─────────────────────

async function main() {
  const argv = process.argv.slice(2)
  const DRY_RUN = !argv.includes("--apply")
  const PROJECT = (() => {
    const idx = argv.indexOf("--project")
    return idx >= 0 ? argv[idx + 1] : "wekruit-5f89b"
  })()
  const SINGLE = (() => {
    const idx = argv.indexOf("--booking")
    return idx >= 0 ? argv[idx + 1] : null
  })()
  const LIMIT = (() => {
    const idx = argv.indexOf("--limit")
    return idx >= 0 ? Number(argv[idx + 1]) : null
  })()

  if (getApps().length === 0) {
    const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    if (saJson) {
      initializeApp({ credential: cert(JSON.parse(saJson)), projectId: PROJECT })
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))
      initializeApp({ credential: cert(sa), projectId: PROJECT })
    } else {
      initializeApp({ projectId: PROJECT })
    }
  }

  const db = getFirestore()
  const runId = `docid-case-${new Date().toISOString().replace(/[:.]/g, "-")}`
  console.log(JSON.stringify({ msg: "start", runId, dryRun: DRY_RUN, project: PROJECT }))

  let docs
  if (SINGLE) {
    const snap = await db.collection(COLLECTION).doc(SINGLE).get()
    docs = snap.exists ? [snap] : []
  } else {
    let q = db.collection(COLLECTION)
    if (LIMIT) q = q.limit(LIMIT)
    const snap = await q.get()
    docs = snap.docs
  }

  let skipped = 0
  let nooped = 0
  let moved = 0
  let conflicts = 0

  for (const snap of docs) {
    const plan = planDocIdMigration(snap.id, snap.data())

    if (plan.action === "skip") {
      skipped += 1
      continue
    }
    if (plan.action === "noop") {
      nooped += 1
      continue
    }

    // action === "move" — guard against clobbering a doc that already exists at
    // the target id (e.g. a fresh post-deploy write). Non-destructive on busy.
    const targetRef = db.collection(COLLECTION).doc(plan.newId)
    const targetSnap = await targetRef.get()
    if (targetSnap.exists) {
      conflicts += 1
      console.log(
        JSON.stringify({ msg: "conflict", oldId: plan.oldId, newId: plan.newId, dryRun: DRY_RUN }),
      )
      if (!DRY_RUN) {
        await db
          .collection(AUDIT_COLLECTION)
          .doc(plan.newId)
          .set(
            { oldId: plan.oldId, newId: plan.newId, runId, status: "conflict", at: new Date().toISOString() },
            { merge: true },
          )
      }
      continue
    }

    if (!DRY_RUN) {
      await targetRef.set(plan.data)
      await db.collection(COLLECTION).doc(plan.oldId).delete()
      await db
        .collection(AUDIT_COLLECTION)
        .doc(plan.newId)
        .set(
          { oldId: plan.oldId, newId: plan.newId, runId, status: "moved", at: new Date().toISOString() },
          { merge: true },
        )
    }
    moved += 1
    console.log(JSON.stringify({ msg: "move", oldId: plan.oldId, newId: plan.newId, dryRun: DRY_RUN }))
  }

  console.log(
    JSON.stringify({
      msg: "done",
      runId,
      scanned: docs.length,
      moved,
      nooped,
      skipped,
      conflicts,
      dryRun: DRY_RUN,
    }),
  )
}

// ESM main-module detection.
const isMain = (() => {
  try {
    const argv1 = process.argv[1] ?? ""
    return import.meta.url.endsWith(argv1) || argv1.endsWith("migrate-interview-bookings-docid-case.mjs")
  } catch {
    return false
  }
})()

if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
