#!/usr/bin/env node
/**
 * Clear all PA memory for a single user — Qdrant semantic memory + Firestore
 * facts/messages/actions. Designed for harness re-runs and Phase 1/2
 * pollution-free verification.
 *
 * Phase 3 will wrap this in the Memory Admin dashboard. Keep CLI parity.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   QDRANT_URL=https://...:443 QDRANT_API_KEY=... \
 *   node scripts/pa-clear-user.mjs <userId> [--dry-run] [--keep-messages]
 *
 * Env:
 *   GOOGLE_APPLICATION_CREDENTIALS  Firebase service account
 *   QDRANT_URL                      e.g. https://your-qdrant.fly.dev:443
 *   QDRANT_API_KEY                  Qdrant API key
 *   QDRANT_COLLECTION               (optional, default pa_memory)
 *   FIREBASE_PROJECT_ID             (optional, default wekruit-5f89b)
 */
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const args = process.argv.slice(2)
const userId = args.find((a) => !a.startsWith("--"))
const DRY = args.includes("--dry-run")
const KEEP_MESSAGES = args.includes("--keep-messages")

if (!userId) {
  console.error("usage: node scripts/pa-clear-user.mjs <userId> [--dry-run] [--keep-messages]")
  process.exit(2)
}

const QDRANT_URL = process.env.QDRANT_URL?.replace(/\/+$/, "")
const QDRANT_API_KEY = process.env.QDRANT_API_KEY
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || "pa_memory"

if (!QDRANT_URL || !QDRANT_API_KEY) {
  console.error("[clear] QDRANT_URL and QDRANT_API_KEY required (Qdrant memory cannot be skipped)")
  process.exit(2)
}

function tag(s) { return DRY ? `[DRY] ${s}` : s }

async function clearQdrant() {
  // Delete all points where payload.user_id == userId. Qdrant supports
  // delete-by-filter directly — no need to scroll first.
  const url = `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/delete?wait=true`
  const body = {
    filter: {
      must: [{ key: "user_id", match: { value: userId } }],
    },
  }

  // First count what we're about to nuke (informational).
  const countUrl = `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/count`
  const countResp = await fetch(countUrl, {
    method: "POST",
    headers: { "api-key": QDRANT_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ filter: body.filter, exact: true }),
  })
  if (!countResp.ok) {
    throw new Error(`Qdrant count failed: ${countResp.status} ${await countResp.text()}`)
  }
  const countJson = await countResp.json()
  const count = countJson?.result?.count ?? "?"
  console.log(tag(`Qdrant ${QDRANT_COLLECTION}: ${count} memories for user_id=${userId}`))

  if (DRY || count === 0) return { count }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "api-key": QDRANT_API_KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    throw new Error(`Qdrant delete failed: ${resp.status} ${await resp.text()}`)
  }
  const j = await resp.json()
  console.log(`Qdrant deleted: status=${j?.status ?? j?.result?.status ?? "ok"}`)
  return { count }
}

async function clearFirestoreCollection(db, collection, where) {
  let q = db.collection(collection)
  for (const [field, op, val] of where) q = q.where(field, op, val)
  const snap = await q.get()
  console.log(tag(`Firestore ${collection}: ${snap.size} docs match`))
  if (DRY || snap.empty) return snap.size
  // Batched delete (Firestore caps batches at 500).
  let deleted = 0
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch()
    for (const doc of snap.docs.slice(i, i + 400)) batch.delete(doc.ref)
    await batch.commit()
    deleted += Math.min(400, snap.docs.length - i)
  }
  console.log(`Firestore ${collection}: deleted ${deleted}`)
  return snap.size
}

async function main() {
  if (!getApps().length) initializeApp({ credential: applicationDefault() })
  const db = getFirestore()
  console.log(`${DRY ? "[DRY-RUN] " : ""}Clearing memory for userId=${userId}`)
  console.log(`  KEEP_MESSAGES=${KEEP_MESSAGES}`)
  console.log("")

  const qd = await clearQdrant()
  await clearFirestoreCollection(db, "pa_memory_facts", [["userId", "==", userId]])
  await clearFirestoreCollection(db, "pa_memory_actions", [["userId", "==", userId]])
  await clearFirestoreCollection(db, "pa_memory_events", [["userId", "==", userId]])
  if (!KEEP_MESSAGES) {
    await clearFirestoreCollection(db, "pa_messages", [["userId", "==", userId]])
    await clearFirestoreCollection(db, "pa_agent_turns", [["userId", "==", userId]])
    await clearFirestoreCollection(db, "pa_turns", [["userId", "==", userId]])
  }

  console.log("")
  console.log(DRY ? "Dry-run complete (no writes)." : "Memory cleared.")
  console.log("Tip: send a fresh iMessage now — orchestrator will treat the user as cold.")
}

main().catch((e) => { console.error("[clear] fatal:", e); process.exit(1) })
