#!/usr/bin/env tsx
/**
 * Stream H4 D1 — one-shot cleanup of stuck pa-outbound rows.
 *
 * Background: paSendblueOutbox CF claims rows transactionally
 * (status: pending → sending) before POST. If the CF crashes mid-flight
 * (OOM, timeout, deploy mid-tick), the row is marooned in "sending" with
 * no terminal state. The onDocumentCreated trigger never re-fires for
 * status mutations, so the row is permanently stuck.
 *
 * P10 audit (2026-05-01) found row a986f683-0b66-403f-987b-f298a391c49e
 * (Adam, Meta-layoff body) stuck in "sending" since 2026-05-01T01:10:17Z.
 *
 * Behavior:
 *   --dry-run (default): prints stuck rows, no writes
 *   --apply: resets status=sending → status=pending and stamps
 *            requeuedReason="stuck_sweep_2026-05-01"
 *
 * IMPORTANT: just resetting status does NOT auto-refire the
 * onDocumentCreated trigger. The follow-up auto-sweeper added in D2
 * (paSendblueOutboxHandler top-of-tick sweep) is what will rescue these
 * rows when ANY new pa-outbound row is created. Until D2 deploys, this
 * script's reset is a flag-of-readiness — the row will resume processing
 * on next tick after D2 deploy.
 *
 * Usage:
 *   tsx apps/functions/scripts/cleanup-stuck-outbound.ts             # dry-run
 *   tsx apps/functions/scripts/cleanup-stuck-outbound.ts --apply     # live
 *
 * Auth: same pattern as run-daily-now-debug.mjs — reads
 * FIREBASE_SERVICE_ACCOUNT_JSON from .env.
 *
 * Note: query uses single-field filter `status == "sending"` to avoid the
 * composite (status, updatedAt) index that is being added in D3 but not
 * yet deployed. Stale-detection happens client-side.
 */

import admin from "firebase-admin"
import fs from "fs"

const STUCK_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes
const REQUEUED_REASON = "stuck_sweep_2026-05-01"
const SCAN_LIMIT = 500

function parseFlags() {
  const args = process.argv.slice(2)
  const apply = args.includes("--apply")
  const dryRun = !apply
  return { dryRun, apply }
}

function ageHours(iso: string, now: number): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return -1
  return (now - t) / (1000 * 60 * 60)
}

async function main() {
  const { dryRun, apply } = parseFlags()
  console.log(`[cleanup-stuck-outbound] mode=${apply ? "APPLY" : "DRY-RUN"}`)

  const envPath = "/Users/adam/Desktop/WeKruit/wekruit-pa/.env"
  const saLine = fs
    .readFileSync(envPath, "utf8")
    .split("\n")
    .find((l) => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="))
  if (!saLine) {
    console.error("[cleanup-stuck-outbound] FIREBASE_SERVICE_ACCOUNT_JSON missing from .env")
    process.exit(2)
  }
  const sa = JSON.parse(saLine.slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length))
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: "wekruit-5f89b" })
  const db = admin.firestore()

  const now = Date.now()
  const cutoff = now - STUCK_THRESHOLD_MS
  const cutoffIso = new Date(cutoff).toISOString()

  // ---- Scan 1: status="sending" — filter stale client-side ----
  console.log(`[cleanup-stuck-outbound] scanning status=sending (client-filtered updatedAt<${cutoffIso})`)
  const sendingSnap = await db
    .collection("pa-outbound")
    .where("status", "==", "sending")
    .limit(SCAN_LIMIT)
    .get()

  console.log(`[cleanup-stuck-outbound] total sending rows: ${sendingSnap.size}`)
  const stuckSending = sendingSnap.docs.filter((doc) => {
    const d = doc.data() as { updatedAt?: string }
    const t = Date.parse(String(d.updatedAt ?? ""))
    if (Number.isNaN(t)) return true // no updatedAt → consider stale
    return t < cutoff
  })
  console.log(`[cleanup-stuck-outbound] stuck-sending hits (>10min): ${stuckSending.length}`)
  let resetCount = 0
  for (const doc of stuckSending) {
    const d = doc.data() as Record<string, unknown>
    const ageH = ageHours(String(d.updatedAt ?? ""), now).toFixed(1)
    const userId = String(d.userId ?? "?")
    const body = String(d.body ?? "").slice(0, 80)
    console.log(`  - id=${doc.id} userId=${userId} age_h=${ageH} body="${body}"`)

    if (apply) {
      // Idempotent transactional reset: only flip if still in "sending"
      const ok = await db.runTransaction(async (t) => {
        const cur = await t.get(doc.ref)
        if (!cur.exists) return false
        const curData = cur.data() as { status?: string }
        if (curData.status !== "sending") return false
        t.update(doc.ref, {
          status: "pending",
          requeuedReason: REQUEUED_REASON,
          requeuedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          // attemptCount unchanged per brief
        })
        return true
      })
      if (ok) {
        resetCount++
        console.log(`    -> reset to pending`)
      } else {
        console.log(`    -> no-op (status changed concurrently)`)
      }
    }
  }

  // ---- Scan 2: status="pending" — filter stale client-side (read-only) ----
  console.log(`[cleanup-stuck-outbound] scanning status=pending (client-filtered createdAt<${cutoffIso}, read-only)`)
  const pendingSnap = await db
    .collection("pa-outbound")
    .where("status", "==", "pending")
    .limit(SCAN_LIMIT)
    .get()
  const orphanPending = pendingSnap.docs.filter((doc) => {
    const d = doc.data() as { createdAt?: string }
    const t = Date.parse(String(d.createdAt ?? ""))
    return !Number.isNaN(t) && t < cutoff
  })

  console.log(`[cleanup-stuck-outbound] orphan-pending hits (>10min): ${orphanPending.length}`)
  for (const doc of orphanPending) {
    const d = doc.data() as Record<string, unknown>
    const ageH = ageHours(String(d.createdAt ?? ""), now).toFixed(1)
    const userId = String(d.userId ?? "?")
    const body = String(d.body ?? "").slice(0, 80)
    const attempts = Number(d.attemptCount ?? 0)
    console.log(`  - id=${doc.id} userId=${userId} age_h=${ageH} attempts=${attempts} body="${body}"`)
    // DO NOT auto-promote — paSendblueOutbox owns retry semantics (per brief)
  }

  console.log(`[cleanup-stuck-outbound] DONE — apply=${apply} reset=${resetCount}`)
  if (dryRun) console.log("[cleanup-stuck-outbound] dry-run; re-run with --apply to write")
  process.exit(0)
}

main().catch((err) => {
  console.error("[cleanup-stuck-outbound] FATAL", err)
  process.exit(1)
})
