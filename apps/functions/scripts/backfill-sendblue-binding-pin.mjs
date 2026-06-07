#!/usr/bin/env node
/**
 * Backfill the Sendblue user↔number binding PIN (2026-06-02).
 *
 * WHY THIS MUST RUN FIRST
 * ───────────────────────
 * The honor-binding fix (resolve-bound-from-number.ts) makes the send path
 * NEVER re-hash a user who already has `senderNumber`. But TODAY almost no
 * `pa-users` doc has `senderNumber` — the live line is re-derived every send by
 * `pickFromNumber(pool, uid)` = `hash(uid) % activeCount`. If we deploy the
 * honor-binding code with the base still unpinned, the reducer would MINT a
 * fresh capacity-aware binding for everyone at once → a ONE-TIME reshuffle of
 * the whole base (the exact thing we are preventing).
 *
 * This script FREEZES the status quo: for every pa-users doc WITHOUT
 * `senderNumber`, it computes the user's CURRENT hash-derived line — the EXACT
 * same `pickFromNumber(pool, uid)` call the live transport/send-reaction/
 * sendblue-client paths use TODAY (no options) — and writes it as `senderNumber`
 * with source='backfill_pin_2026_06'. After the pin, deploying the honor-binding
 * code is a NO-OP for every existing user (their bound line == their old hash
 * line), so nobody's thread moves.
 *
 * DEPLOY SEQUENCE (LOUD):
 *   1. node --import tsx apps/functions/scripts/backfill-sendblue-binding-pin.mjs           # DRY-RUN (default)
 *   2. node --import tsx apps/functions/scripts/backfill-sendblue-binding-pin.mjs --apply    # WRITE
 *   3. ONLY THEN deploy functions (the honor-binding code path).
 *
 * IDEMPOTENT: skips any doc that already has a non-empty `senderNumber`
 * (qr_scan / candidate_identity / inbound_first / a prior pin). Safe to re-run.
 *
 * Users for whom `pickFromNumber` returns null (no eligible active line for their
 * hash today — e.g. only admin lines, or empty pool) are left UNPINNED and
 * reported. They have no stable line today anyway; the send-path reducer will
 * mint one capacity-aware when they next message (no thread to preserve).
 *
 * SAFETY: writes ONLY `senderNumber` / `senderGroupId` / `senderAssignedAt` /
 * `senderAssignedSource` (merge:true). Never sends, never deploys, never touches
 * the pool config.
 *
 * Usage:
 *   node --import tsx apps/functions/scripts/backfill-sendblue-binding-pin.mjs [--apply] [--limit=50000] [--json]
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

import {
  loadSendbluePool,
  pickFromNumber,
  findSendbluePoolNumber,
  sendblueGroupId,
} from "../src/sendblue/pool.js"

const PROJECT_ID = "wekruit-5f89b"
const PIN_SOURCE = "backfill_pin_2026_06"

// ─────────────────────────────────────────────────────────────────────────────
// PURE PLAN BUILDER (unit-tested in scripts/__tests__/backfill-sendblue-binding-pin.test.mjs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide the pin for ONE user, mirroring the LIVE send path EXACTLY:
 *   pickFromNumber(pool, uid)  with NO options
 *   (transport.ts / send-reaction.ts / sendblue-client.ts all picked with no
 *    options TODAY → default includeInternal:false, requireNewUserCapacity:false).
 *
 * Returns:
 *   { action: "skip_already_bound", senderNumber }  — non-empty senderNumber present
 *   { action: "skip_unroutable" }                   — pickFromNumber returned null
 *   { action: "pin", senderNumber, senderGroupId }  — write this binding
 */
export function planUserPin(pool, uid, user) {
  const existing =
    typeof user?.senderNumber === "string" && user.senderNumber.trim() ? user.senderNumber.trim() : ""
  if (existing) return { action: "skip_already_bound", senderNumber: existing }

  // EXACT live pick: no options.
  const number = pickFromNumber(pool, uid)
  if (!number) return { action: "skip_unroutable" }

  const groupId = sendblueGroupId(findSendbluePoolNumber(pool, number) ?? { number, status: "active" })
  return { action: "pin", senderNumber: number, senderGroupId: groupId }
}

/** Build the full plan (pure) over an array of { uid, ...userData }. */
export function buildPinPlan(pool, users) {
  const plan = { pin: [], skipAlreadyBound: [], skipUnroutable: [] }
  for (const user of users) {
    const decision = planUserPin(pool, user.uid, user)
    if (decision.action === "pin") {
      plan.pin.push({ uid: user.uid, senderNumber: decision.senderNumber, senderGroupId: decision.senderGroupId })
    } else if (decision.action === "skip_already_bound") {
      plan.skipAlreadyBound.push({ uid: user.uid, senderNumber: decision.senderNumber })
    } else {
      plan.skipUnroutable.push({ uid: user.uid })
    }
  }
  return plan
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────────────────────────────────────

export async function runBackfill(db, { apply = false, limit = 50000, nowIso = new Date().toISOString() } = {}) {
  const pool = await loadSendbluePool(db)
  if (!pool) {
    return { poolConfigured: false, apply, scanned: 0, plan: { pin: [], skipAlreadyBound: [], skipUnroutable: [] }, wrote: 0 }
  }

  const snap = await db.collection("pa-users").limit(limit).get()
  const users = snap.docs.map((doc) => ({ uid: doc.id, ...(doc.data() ?? {}) }))
  const plan = buildPinPlan(pool, users)

  let wrote = 0
  if (apply) {
    for (const entry of plan.pin) {
      // eslint-disable-next-line no-await-in-loop
      await db.collection("pa-users").doc(entry.uid).set(
        {
          senderNumber: entry.senderNumber,
          senderGroupId: entry.senderGroupId,
          senderAssignedAt: nowIso,
          senderAssignedSource: PIN_SOURCE,
          updatedAt: nowIso,
        },
        { merge: true }
      )
      wrote++
    }
  }

  return { poolConfigured: true, apply, scanned: users.length, plan, wrote }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function isMainModule() {
  try {
    const thisFile = new URL(import.meta.url).pathname
    const invoked = process.argv[1] ? resolve(process.argv[1]) : ""
    if (!invoked) return false // imported (e.g. by the test runner) with no entry arg
    return thisFile === invoked || thisFile.endsWith(invoked)
  } catch {
    return false
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2)
  const apply = args.includes("--apply")
  const json = args.includes("--json")
  const limitArg = args.find((a) => a.startsWith("--limit="))
  const limit = limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : 50000

  const db = initDb()
  const report = await runBackfill(db, { apply, limit: Number.isFinite(limit) ? limit : 50000 })

  if (json) {
    console.log(JSON.stringify({ ...report, plan: { ...report.plan, pin: report.plan.pin.slice(0, 50) } }, null, 2))
  } else {
    printReport(report)
  }
  process.exit(0)
}

function printReport(r) {
  const L = (...a) => console.log(...a)
  L("═══ Sendblue binding PIN backfill ═══")
  L(`mode: ${r.apply ? "APPLY (writing)" : "DRY-RUN (no writes — pass --apply to write)"}`)
  L(`pool configured: ${r.poolConfigured}`)
  if (!r.poolConfigured) {
    L("  ✗ no pa-config/sendblue-pool — nothing to pin. Abort.")
    return
  }
  L(`scanned pa-users: ${r.scanned}`)
  L(`  → to PIN (no senderNumber today): ${r.plan.pin.length}`)
  L(`  · already bound (skip):           ${r.plan.skipAlreadyBound.length}`)
  L(`  · unroutable today (skip):        ${r.plan.skipUnroutable.length}`)
  if (r.apply) L(`  ✓ WROTE ${r.wrote} bindings (source=${PIN_SOURCE})`)
  if (r.plan.pin.length) {
    L("")
    L("  sample pins:")
    for (const p of r.plan.pin.slice(0, 10)) L(`    ${p.uid} → ${p.senderNumber} (${p.senderGroupId})`)
  }
  if (!r.apply) {
    L("")
    L("  DRY-RUN. Re-run with --apply to write. Deploy functions ONLY AFTER --apply completes.")
  }
}

function initDb() {
  if (!getApps().length) {
    const sa = loadServiceAccount()
    initializeApp({ credential: cert(sa), projectId: sa.project_id ?? PROJECT_ID })
  }
  return getFirestore()
}

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))
  }
  for (const candidate of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
    if (existsSync(candidate)) {
      const envText = readFileSync(candidate, "utf8")
      const match = envText.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
      if (match) return JSON.parse(match[1].replace(/^"/, "").replace(/"$/, ""))
    }
  }
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing. Export it or GOOGLE_APPLICATION_CREDENTIALS.")
}
