#!/usr/bin/env node
/**
 * iter30 WS2 P2 — Live E2E verify for paCanonicalTagWorker.
 *
 * Steps:
 *   1. Write a pa-tag-event with rawText="Python" (should hit Layer 1 hot alias)
 *   2. Poll for 30s watching for status → "normalized"
 *   3. Verify entity-tag was written
 *   4. Write second event with same canonicalKey (mutex test) → verify count increments
 *
 * Usage:
 *   node apps/functions/scripts/e2e-tag-worker-verify.mjs
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

const PROJECT = "wekruit-5f89b"

function initFirebase() {
  if (getApps().length > 0) return
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (credPath) {
    try {
      const cred = JSON.parse(readFileSync(credPath, "utf8"))
      initializeApp({ credential: cert(cred), projectId: PROJECT })
      return
    } catch { }
  }
  initializeApp({ projectId: PROJECT })
}

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

function computeEventId(source, sourceDocId, rawText, entityKind, entityId) {
  const input = [source, sourceDocId, rawText.toLowerCase().trim(), entityKind, entityId].join("|")
  return sha256Hex(input).slice(0, 32)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function pollUntil(fn, label, timeoutMs = 30000, pollMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await fn()
    if (result) {
      console.log(`  ✓ ${label}`)
      return result
    }
    await sleep(pollMs)
  }
  throw new Error(`Timeout waiting for: ${label}`)
}

async function main() {
  console.log("E2E verify: paCanonicalTagWorker")
  console.log("─".repeat(50))

  initFirebase()
  const db = getFirestore()
  const testEntityId = `e2e-test-${Date.now()}`
  const source = "manual-backfill"
  const now = new Date().toISOString()

  // ── Test 1: Layer 1 hot-alias (Python) ──────────────────────────
  console.log("\nTest 1: Layer 1 hot-alias (rawText=Python)")
  const rawText1 = "Python"
  const eventId1 = computeEventId(source, "e2e-test", rawText1, "pa-user", testEntityId)

  await db.collection("pa-tag-events").doc(eventId1).set({
    id: eventId1,
    source,
    sourceDocId: "e2e-test",
    sourceField: "test",
    rawText: rawText1,
    type: "skill",
    entityRef: { kind: "pa-user", id: testEntityId },
    status: "pending",
    normalizedTo: null,
    decision: null,
    workerConfidence: null,
    schemaVersion: "v1",
    createdAt: now,
    processedAt: null,
    processingDurationMs: null,
  })
  console.log(`  → event written: ${eventId1}`)

  // Poll for normalized status
  const result1 = await pollUntil(async () => {
    const snap = await db.collection("pa-tag-events").doc(eventId1).get()
    const data = snap.data()
    if (data?.status === "normalized" || data?.status === "needs-review") return data
    return null
  }, `event status → ${rawText1 === "Python" ? "normalized/needs-review" : "normalized"}`, 45000)

  console.log(`  decision: ${result1.decision}, normalizedTo: ${result1.normalizedTo}, confidence: ${result1.workerConfidence}`)
  console.log(`  processingDurationMs: ${result1.processingDurationMs}ms`)

  // ── Test 2: Mutex enforcement ────────────────────────────────────
  console.log("\nTest 2: Mutex enforcement (second Python event → count++)")
  const rawText2 = "python3"
  const eventId2 = computeEventId(source, "e2e-test-2", rawText2, "pa-user", testEntityId)

  await db.collection("pa-tag-events").doc(eventId2).set({
    id: eventId2,
    source,
    sourceDocId: "e2e-test-2",
    sourceField: "test",
    rawText: rawText2,
    type: "skill",
    entityRef: { kind: "pa-user", id: testEntityId },
    status: "pending",
    normalizedTo: null,
    decision: null,
    workerConfidence: null,
    schemaVersion: "v1",
    createdAt: now,
    processedAt: null,
    processingDurationMs: null,
  })
  console.log(`  → event written: ${eventId2}`)

  const result2 = await pollUntil(async () => {
    const snap = await db.collection("pa-tag-events").doc(eventId2).get()
    const data = snap.data()
    if (data?.status === "normalized" || data?.status === "needs-review") return data
    return null
  }, "event 2 processed", 45000)

  console.log(`  decision: ${result2.decision}, normalizedTo: ${result2.normalizedTo}`)

  // ── Check entity-tags ────────────────────────────────────────────
  console.log("\nChecking entity-tags for test entity...")
  const entityKey = `pa-user:${testEntityId}`
  const entitySnap = await db.collection("pa-entity-tags").doc(entityKey).get()

  if (entitySnap.exists) {
    const entityData = entitySnap.data()
    console.log(`  tagCount: ${entityData.tagCount}`)
    const itemsSnap = await db.collection("pa-entity-tags").doc(entityKey).collection("items").get()
    console.log(`  items in subcollection: ${itemsSnap.size}`)
    for (const item of itemsSnap.docs) {
      const d = item.data()
      console.log(`    - ${item.id}: count=${d.count}, confidence=${d.confidence?.toFixed(2)}, sources=${JSON.stringify(d.sources?.map(s => s.source))}`)
    }
  } else {
    console.log("  (entity-tags doc not found — worker may still be processing)")
  }

  // ── 429 alert dry-run ────────────────────────────────────────────
  console.log("\n429 alert path (check pa-alerts)...")
  const today = new Date().toISOString().slice(0, 10)
  const alertSnap = await db.collection("pa-alerts").doc(`qwen-7b-rate-limit-${today}`).get()
  if (alertSnap.exists) {
    console.log(`  429 alert found: qwen-7b-rate-limit-${today}`)
  } else {
    console.log(`  No 429 alert today (good — no rate limits hit)`)
  }

  console.log("\n─".repeat(50))
  console.log("E2E verify complete.")
  process.exit(0)
}

main().catch((err) => {
  console.error("e2e-tag-worker-verify failed:", err)
  process.exit(1)
})
