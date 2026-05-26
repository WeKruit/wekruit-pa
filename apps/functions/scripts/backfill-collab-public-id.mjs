#!/usr/bin/env node
/**
 * Backfill `publicId` on every WeKruit-collaborated pa-jobs doc that powers
 * the hiring-board (https://wekruit.github.io/hiring-board/).
 *
 * Why: the hiring-board's URL slug is currently the Firestore doc id
 * (e.g. `helium-product-engineer-fullstack`), which bakes the real company
 * name into a publicly-shareable URL. The board, in turn, also returns
 * `recruiterBoard.label.company` (real name) to unauthenticated viewers.
 *
 * Step 1 (this script): mint an opaque `publicId = randomUUID()` on every
 * collab pa-jobs doc. Idempotent: docs that already have `publicId` are
 * skipped.
 *
 * Step 2 (`recruiter-board.ts`): the public list endpoint exposes `publicId`
 * as the `jobId` field for non-admin callers, so the URL never leaks the
 * real doc id / company slug.
 *
 * Selection criteria:
 *   - `wekruitCollaborationStatus == "collaborated"`
 *   - `recruiterBoard` field present (non-null)
 *
 * Auth:
 *   - GOOGLE_APPLICATION_CREDENTIALS (path to JSON)
 *   - or FIREBASE_SERVICE_ACCOUNT_JSON (inline JSON in .env)
 *
 * Usage:
 *   node apps/functions/scripts/backfill-collab-public-id.mjs              # dry-run
 *   node apps/functions/scripts/backfill-collab-public-id.mjs --apply      # actually write
 *   node apps/functions/scripts/backfill-collab-public-id.mjs --apply --project wekruit-5f89b
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore, FieldValue } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

// ─── CLI flags ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const DRY_RUN = !argv.includes("--apply")
const PROJECT = (() => {
  const idx = argv.indexOf("--project")
  return idx >= 0 ? argv[idx + 1] : "wekruit-5f89b"
})()

const COLLECTION = "pa-jobs"

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
      // fall through to inline JSON
    }
  }
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (inlineJson) {
    try {
      const cred = JSON.parse(inlineJson)
      initializeApp({ credential: cert(cred), projectId: PROJECT })
      return
    } catch (err) {
      console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:", err)
      process.exit(2)
    }
  }
  console.error(
    "No Firebase credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path,",
  )
  console.error("or set FIREBASE_SERVICE_ACCOUNT_JSON in .env to the inline JSON.")
  process.exit(2)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  initFirebase()
  const db = getFirestore()

  const snap = await db
    .collection(COLLECTION)
    .where("wekruitCollaborationStatus", "==", "collaborated")
    .get()

  let docsScanned = 0
  let docsAlreadySet = 0
  let docsUpdated = 0
  let docsSkippedNoBoard = 0

  for (const doc of snap.docs) {
    docsScanned += 1
    const data = doc.data() ?? {}

    const recruiterBoard = data.recruiterBoard
    if (recruiterBoard == null) {
      // wekruitCollaborationStatus == collaborated but no recruiterBoard
      // payload — out of scope for the hiring-board URL leak.
      docsSkippedNoBoard += 1
      continue
    }

    const existing = data.publicId
    if (typeof existing === "string" && existing.length > 0) {
      docsAlreadySet += 1
      continue
    }

    const publicId = randomUUID()
    docsUpdated += 1

    if (DRY_RUN) {
      console.log(`[dry-run] would set publicId on ${doc.id} → ${publicId}`)
    } else {
      await doc.ref.update({
        publicId,
        publicIdBackfilledAt: FieldValue.serverTimestamp(),
      })
      console.log(`updated ${doc.id} → publicId=${publicId}`)
    }
  }

  // Structured log line — matches the convention requested in the spec.
  console.log("")
  console.log(
    JSON.stringify({
      event: "pa.recruiter_board.public_id_backfill",
      docsScanned,
      docsUpdated,
      docsAlreadySet,
      docsSkippedNoBoard,
      dryRun: DRY_RUN,
      project: PROJECT,
    }),
  )

  if (DRY_RUN && docsUpdated > 0) {
    console.log("")
    console.log(`Dry-run: ${docsUpdated} doc(s) would be updated. Re-run with --apply to write.`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
