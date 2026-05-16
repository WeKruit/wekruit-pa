#!/usr/bin/env node
/**
 * S3 (v2.1) — outbound-bookings voice-fields migration.
 *
 * Adds v2.1 voice-state schema to each `outbound-bookings/{id}` document.
 * Idempotent: running twice produces the same result; never overwrites an
 * existing value.
 *
 * Fields added (defaults applied ONLY when the field is undefined):
 *
 *   voiceState        = "queued"
 *   voiceCallSid      = null
 *   voiceRoomName     = null
 *   voiceStartedAt    = null
 *   voiceEndedAt      = null
 *   voiceOutcome      = null
 *   voiceLastError    = null
 *   voiceCallerId     = null
 *
 * `paUserId` and `paJobId` are NOT modified — the booker is responsible for
 * those. The migration only AUDITS missing identity fields (writes to
 * `outbound-bookings-voice-migration-audit/{bookingId}`) and reports the
 * count.
 *
 * Modes:
 *   --apply               actually write defaults (default: dry-run)
 *   --booking <id>        single-booking testing
 *   --limit <N>           stop after N bookings
 *   --project <id>        Firebase project (default: wekruit-5f89b)
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON env.
 *
 * Usage:
 *   node apps/functions/scripts/migrate-outbound-bookings-voice-fields.mjs                # dry-run
 *   node apps/functions/scripts/migrate-outbound-bookings-voice-fields.mjs --apply        # write
 *   node apps/functions/scripts/migrate-outbound-bookings-voice-fields.mjs --booking B-1  # single
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

// ─── Pure logic (exported for unit tests) ────────────────────────────────────

/**
 * The defaults this migration plants. Object spread guards iteration order
 * stability across re-runs.
 */
export const VOICE_FIELD_DEFAULTS = Object.freeze({
  voiceState: "queued",
  voiceCallSid: null,
  voiceRoomName: null,
  voiceStartedAt: null,
  voiceEndedAt: null,
  voiceOutcome: null,
  voiceLastError: null,
  voiceCallerId: null,
})

/**
 * Computes the minimal update for one booking. Returns:
 *   - `update`: object of fields to write (empty if no-op)
 *   - `addedFields`: list of field names that would be added
 *   - `missingIdentity`: list of {paUserId, paJobId} field names that are
 *     absent on the row (for audit; not modified)
 *
 * Pure — no Firestore IO, fully unit-testable.
 */
export function computeMigrationUpdate(doc) {
  if (!doc || typeof doc !== "object") {
    return { update: {}, addedFields: [], missingIdentity: ["paUserId", "paJobId"] }
  }
  const update = {}
  const addedFields = []
  for (const [key, defaultVal] of Object.entries(VOICE_FIELD_DEFAULTS)) {
    if (doc[key] === undefined) {
      update[key] = defaultVal
      addedFields.push(key)
    }
  }
  const missingIdentity = []
  for (const key of ["paUserId", "paJobId"]) {
    const v = doc[key]
    if (v === undefined || v === null || (typeof v === "string" && v.length === 0)) {
      missingIdentity.push(key)
    }
  }
  return { update, addedFields, missingIdentity }
}

// ─── Runner (only invoked when run from CLI; isolated from tests) ────────────

async function main() {
  const argv = process.argv.slice(2)
  const DRY_RUN = !argv.includes("--apply")
  const PROJECT = (() => {
    const idx = argv.indexOf("--project")
    return idx >= 0 ? argv[idx + 1] : "wekruit-5f89b"
  })()
  const SINGLE_BOOKING = (() => {
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
  const runId = `voice-fields-${new Date().toISOString().replace(/[:.]/g, "-")}`
  console.log(JSON.stringify({ msg: "start", runId, dryRun: DRY_RUN, project: PROJECT }))

  let bookings
  if (SINGLE_BOOKING) {
    const snap = await db.collection("outbound-bookings").doc(SINGLE_BOOKING).get()
    bookings = snap.exists ? [snap] : []
  } else {
    let q = db.collection("outbound-bookings")
    if (LIMIT) q = q.limit(LIMIT)
    const snap = await q.get()
    bookings = snap.docs
  }

  let touched = 0
  let nooped = 0
  let missingIdentityCount = 0

  for (const snap of bookings) {
    const data = snap.data()
    const { update, addedFields, missingIdentity } = computeMigrationUpdate(data)

    if (missingIdentity.length > 0) missingIdentityCount += 1

    if (addedFields.length === 0) {
      nooped += 1
      continue
    }

    if (!DRY_RUN) {
      await snap.ref.set(update, { merge: true })
      await db
        .collection("outbound-bookings-voice-migration-audit")
        .doc(snap.id)
        .set(
          {
            bookingId: snap.id,
            runId,
            addedFields,
            missingIdentity,
            wroteAt: new Date().toISOString(),
          },
          { merge: true },
        )
    }
    touched += 1
    console.log(
      JSON.stringify({
        msg: "row",
        bookingId: snap.id,
        addedFields,
        missingIdentity,
        dryRun: DRY_RUN,
      }),
    )
  }

  console.log(
    JSON.stringify({
      msg: "done",
      runId,
      scanned: bookings.length,
      touched,
      nooped,
      missingIdentityCount,
      dryRun: DRY_RUN,
    }),
  )
}

// ESM main-module detection.
const isMain = (() => {
  try {
    const argv1 = process.argv[1] ?? ""
    return import.meta.url.endsWith(argv1) || argv1.endsWith("migrate-outbound-bookings-voice-fields.mjs")
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
