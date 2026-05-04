#!/usr/bin/env node
/**
 * iter30 WS2 P3 (Day 6) — Backfill tag events from existing PA data.
 *
 * Sources:
 *   1. pa-users.statedPreferences.{targetRole, targetLocations, prefersStartup, researchOriented}
 *   2. pa-candidate-resumes.skills[]
 *   3. pa-job-profiles preferences
 *
 * Each row emits one or more `pa-tag-events` via recordTagEvent with
 * source="manual-backfill". Idempotent via sha256 — re-running produces
 * the same eventIds and the .create() call returns ALREADY_EXISTS (no dup).
 *
 * Throttle: 100 events/sec to avoid Qwen-7B free-tier 429s.
 *
 * Usage:
 *   node apps/functions/scripts/backfill-tags-from-existing.mjs [--dry-run] [--limit 100]
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS from env or gcloud ADC.
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

// ─── CLI flags ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const DRY_RUN = args.includes("--dry-run")
const PROJECT = (() => {
  const idx = args.indexOf("--project")
  return idx >= 0 ? args[idx + 1] : "wekruit-5f89b"
})()
const LIMIT = (() => {
  const idx = args.indexOf("--limit")
  return idx >= 0 ? parseInt(args[idx + 1], 10) : 0
})()
const THROTTLE_MS = 10 // ~100 events/sec

// ─── Firebase init ────────────────────────────────────────────────────────────

function initFirebase() {
  if (getApps().length > 0) return
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (credPath) {
    try {
      const cred = JSON.parse(readFileSync(credPath, "utf8"))
      initializeApp({ credential: cert(cred), projectId: PROJECT })
      return
    } catch { /* fall through to ADC */ }
  }
  initializeApp({ projectId: PROJECT })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

function buildEventId(source, sourceDocId, rawText, entityKind, entityId) {
  const input = [source, sourceDocId, rawText.toLowerCase().trim(), entityKind, entityId].join("|")
  return sha256Hex(input).slice(0, 32)
}

async function emitTagEvent(db, { source, sourceDocId, sourceField, rawText, type, entityKind, entityId, context }) {
  const eventId = buildEventId(source, sourceDocId, rawText, entityKind, entityId)
  const now = new Date().toISOString()

  if (DRY_RUN) {
    return { eventId, created: false, dryRun: true }
  }

  const ref = db.collection("pa-tag-events").doc(eventId)
  try {
    await ref.create({
      id: eventId,
      source,
      sourceDocId,
      sourceField,
      rawText: rawText.slice(0, 500),
      type,
      entityRef: { kind: entityKind, id: entityId },
      context: context ? context.slice(0, 500) : undefined,
      status: "pending",
      normalizedTo: null,
      decision: null,
      workerConfidence: null,
      schemaVersion: "v1",
      createdAt: now,
      processedAt: null,
      processingDurationMs: null,
    })
    return { eventId, created: true }
  } catch (err) {
    const code = err?.code
    if (code === 6 || code === "already-exists" || code === "ALREADY_EXISTS") {
      return { eventId, created: false, reason: "duplicate" }
    }
    throw err
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── Backfill: pa-users preferences ──────────────────────────────────────────

async function backfillUserPreferences(db) {
  let totalEmitted = 0
  let totalSkipped = 0
  let pageCount = 0
  let lastDoc = null

  console.log("  Scanning pa-users...")

  while (true) {
    let q = db.collection("pa-users").orderBy("__name__").limit(100)
    if (lastDoc) q = q.startAfter(lastDoc)

    const snap = await q.get()
    if (snap.empty) break
    pageCount++
    lastDoc = snap.docs[snap.docs.length - 1]

    for (const doc of snap.docs) {
      if (LIMIT > 0 && totalEmitted >= LIMIT) {
        console.log(`  Reached --limit ${LIMIT}, stopping.`)
        return { emitted: totalEmitted, skipped: totalSkipped }
      }

      const data = doc.data()
      const userId = doc.id
      const prefs = data.statedPreferences ?? {}

      const events = []

      // targetRole
      if (Array.isArray(prefs.targetRole)) {
        for (const role of prefs.targetRole) {
          if (typeof role === "string" && role.trim()) {
            events.push({ rawText: role, type: "role", sourceField: "statedPreferences.targetRole" })
          }
        }
      } else if (typeof prefs.targetRole === "string" && prefs.targetRole.trim()) {
        events.push({ rawText: prefs.targetRole, type: "role", sourceField: "statedPreferences.targetRole" })
      }

      // targetLocations
      if (Array.isArray(prefs.targetLocations)) {
        for (const loc of prefs.targetLocations) {
          if (typeof loc === "string" && loc.trim()) {
            events.push({ rawText: loc, type: "location", sourceField: "statedPreferences.targetLocations" })
          }
        }
      }

      // prefersStartup (boolean → preference tag)
      if (prefs.prefersStartup === true) {
        events.push({ rawText: "prefers-startup", type: "preference", sourceField: "statedPreferences.prefersStartup" })
      }

      // researchOriented (boolean → preference tag)
      if (prefs.researchOriented === true) {
        events.push({ rawText: "research-oriented", type: "preference", sourceField: "statedPreferences.researchOriented" })
      }

      for (const ev of events) {
        const result = await emitTagEvent(db, {
          source: "manual-backfill",
          sourceDocId: userId,
          sourceField: ev.sourceField,
          rawText: ev.rawText,
          type: ev.type,
          entityKind: "pa-user",
          entityId: userId,
        })
        if (result.created || result.dryRun) totalEmitted++
        else totalSkipped++
        await sleep(THROTTLE_MS)
      }
    }
    console.log(`  Page ${pageCount}: ${snap.docs.length} users processed (emitted=${totalEmitted}, skipped=${totalSkipped})`)
    if (snap.docs.length < 100) break
  }

  return { emitted: totalEmitted, skipped: totalSkipped }
}

// ─── Backfill: pa-candidate-resumes skills ────────────────────────────────────

async function backfillCvSkills(db) {
  let totalEmitted = 0
  let totalSkipped = 0
  let pageCount = 0
  let lastDoc = null

  console.log("  Scanning pa-candidate-resumes...")

  while (true) {
    let q = db.collection("pa-candidate-resumes").orderBy("__name__").limit(100)
    if (lastDoc) q = q.startAfter(lastDoc)

    const snap = await q.get()
    if (snap.empty) break
    pageCount++
    lastDoc = snap.docs[snap.docs.length - 1]

    for (const doc of snap.docs) {
      if (LIMIT > 0 && totalEmitted >= LIMIT) {
        return { emitted: totalEmitted, skipped: totalSkipped }
      }

      const data = doc.data()
      const userId = data.userId ?? doc.id
      const skills = Array.isArray(data.skills) ? data.skills : []

      for (const skill of skills) {
        if (typeof skill !== "string" || !skill.trim()) continue
        const result = await emitTagEvent(db, {
          source: "manual-backfill",
          sourceDocId: doc.id,
          sourceField: "skills",
          rawText: skill,
          type: "skill",
          entityKind: "pa-user",
          entityId: userId,
        })
        if (result.created || result.dryRun) totalEmitted++
        else totalSkipped++
        await sleep(THROTTLE_MS)
      }
    }
    console.log(`  Page ${pageCount}: ${snap.docs.length} resumes processed (emitted=${totalEmitted}, skipped=${totalSkipped})`)
    if (snap.docs.length < 100) break
  }

  return { emitted: totalEmitted, skipped: totalSkipped }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Backfill tags from existing PA data (project=${PROJECT}, dry-run=${DRY_RUN}, limit=${LIMIT || "none"})`)

  initFirebase()
  const db = getFirestore()

  console.log("\n─── User preferences ─────────────────────────────────────────")
  const userResult = await backfillUserPreferences(db)
  console.log(`Users:   emitted=${userResult.emitted}, skipped=${userResult.skipped}`)

  console.log("\n─── CV skills ────────────────────────────────────────────────")
  const cvResult = await backfillCvSkills(db)
  console.log(`CV:      emitted=${cvResult.emitted}, skipped=${cvResult.skipped}`)

  console.log(`\n✓ Backfill complete:`)
  console.log(`  Total emitted: ${userResult.emitted + cvResult.emitted}`)
  console.log(`  Total skipped (idempotent): ${userResult.skipped + cvResult.skipped}`)
  if (DRY_RUN) {
    console.log("\n(DRY RUN — no Firestore writes performed)")
  }

  process.exit(0)
}

main().catch((err) => {
  console.error("backfill-tags-from-existing failed:", err)
  process.exit(1)
})
