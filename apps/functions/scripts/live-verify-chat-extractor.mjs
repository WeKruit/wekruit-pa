#!/usr/bin/env node
/**
 * 2026-05-18 — live verify for the chat → tag + memory extractor.
 *
 * Done-criterion 4 of .planning/GOAL-chat-tag-memory-extraction.md:
 *   "After a 'I want fintech' message, user.tags.industrySector includes
 *    financial_technology within 1 extraction cycle, AND Qdrant
 *    pa_memory_entities has a new point with the matching payload."
 *
 * What it does:
 *   1. Reset admin1's pa-users.tags.industrySector to [] (clean slate)
 *   2. Reset extractionState so the turn-count trigger fires
 *   3. Call maybeRunExtractor with a "I want fintech" transcript
 *   4. Read pa-users.tags.industrySector → assert it now contains
 *      "financial_technology"
 *   5. Query Qdrant pa_memory_entities → assert a new point exists with
 *      payload.user_id = admin1 uid
 *
 * Env required:
 *   GOOGLE_APPLICATION_CREDENTIALS   service account JSON path
 *   PA_OPENAI_AGENT_API_KEY          OpenAI key (gpt-5.4-nano)
 *   ANTHROPIC_API_KEY                optional fallback
 *   QDRANT_URL + QDRANT_API_KEY      Qdrant endpoint
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   PA_OPENAI_AGENT_API_KEY=... \
 *   QDRANT_URL=... QDRANT_API_KEY=... \
 *   PA_CHAT_EXTRACTOR_ENABLED=true \
 *   node apps/functions/scripts/live-verify-chat-extractor.mjs
 */
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import {
  maybeRunExtractor,
  readExtractionState,
} from "@pa/pa-orchestrator"

const TARGET_UID = "itYEwzaJjVPjWbN01fzk" // admin1@wekruit.com (no phone, dev shell)
const TARGET_LABEL = "admin1"

if (!getApps().length) initializeApp({ credential: applicationDefault() })
const db = getFirestore()

const QDRANT_URL = (process.env.QDRANT_URL ?? "").trim().replace(/\/+$/, "")
const QDRANT_API_KEY = (process.env.QDRANT_API_KEY ?? "").trim()

function log(event, payload) {
  console.log(`  log: ${event}${payload ? " " + JSON.stringify(payload) : ""}`)
}

async function step(label, fn) {
  console.log(`\n--- ${label} ---`)
  return fn()
}

async function qdrantCountForUser(userId) {
  if (!QDRANT_URL || !QDRANT_API_KEY) return null
  const r = await fetch(
    `${QDRANT_URL}/collections/pa_memory_entities/points/count`,
    {
      method: "POST",
      headers: { "api-key": QDRANT_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        filter: { must: [{ key: "user_id", match: { value: userId } }] },
        exact: true,
      }),
    },
  )
  if (!r.ok) {
    console.log(`  qdrant count failed: ${r.status} ${await r.text()}`)
    return null
  }
  const j = await r.json()
  return j.result?.count ?? 0
}

async function qdrantScrollForUser(userId, limit = 5) {
  if (!QDRANT_URL || !QDRANT_API_KEY) return []
  const r = await fetch(
    `${QDRANT_URL}/collections/pa_memory_entities/points/scroll`,
    {
      method: "POST",
      headers: { "api-key": QDRANT_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        filter: { must: [{ key: "user_id", match: { value: userId } }] },
        limit,
        with_payload: true,
      }),
    },
  )
  if (!r.ok) return []
  const j = await r.json()
  return j.result?.points ?? []
}

async function main() {
  console.log("=".repeat(78))
  console.log("Live verify — chat → tag + memory extractor")
  console.log(`Target user: ${TARGET_UID} (${TARGET_LABEL})`)
  console.log("=".repeat(78))

  // Pre-flight: target user exists, onboardingState=complete, source set.
  await step("Pre-flight: seed user to a clean post-onboarding state", async () => {
    const ref = db.collection("pa-users").doc(TARGET_UID)
    await ref.set(
      {
        onboardingState: "complete",
        source: "admin",
        // Wipe industrySector so we can assert the extractor populated it.
        tags: { industrySector: [], schemaVersion: 1 },
        // Reset extractionState so the turn-count trigger fires this run.
        extractionState: null,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    )
    const snap = await ref.get()
    const d = snap.data()
    console.log(`  user.onboardingState = ${d?.onboardingState}`)
    console.log(`  user.source           = ${d?.source}`)
    console.log(`  user.tags.industrySector (before) = ${JSON.stringify(d?.tags?.industrySector ?? [])}`)
  })

  // Snapshot Qdrant count BEFORE so we can prove the new point appeared.
  let qdrantBefore = 0
  await step("Pre-flight: Qdrant pa_memory_entities count for this user", async () => {
    qdrantBefore = (await qdrantCountForUser(TARGET_UID)) ?? 0
    console.log(`  count(before) = ${qdrantBefore}`)
  })

  // Run the extractor. Use a transcript whose last user turn is the signal.
  await step("Run maybeRunExtractor with 'I want fintech' transcript", async () => {
    const outcome = await maybeRunExtractor({
      db,
      userId: TARGET_UID,
      // 11 user messages → turn_count trigger fires (≥10).
      userMsgsThisBatch: 11,
      enabled: true,
      onboardingState: "complete",
      existingTags: { industrySector: [], schemaVersion: 1 },
      recentMessages: [
        { role: "assistant", body: "hey, how's the search going?", createdAt: "2026-05-18T20:00:00Z" },
        { role: "user", body: "it's been a slog tbh", createdAt: "2026-05-18T20:00:10Z" },
        { role: "assistant", body: "yeah I hear that — what's been hardest?", createdAt: "2026-05-18T20:00:20Z" },
        { role: "user", body: "the role types I'm targeting feel scattered", createdAt: "2026-05-18T20:00:30Z" },
        { role: "assistant", body: "wanna narrow it down a bit?", createdAt: "2026-05-18T20:00:40Z" },
        { role: "user", body: "I think I've been too broad", createdAt: "2026-05-18T20:00:50Z" },
        { role: "assistant", body: "ok what direction feels right?", createdAt: "2026-05-18T20:01:00Z" },
        { role: "user", body: "honestly I keep coming back to finance and crypto stuff", createdAt: "2026-05-18T20:01:10Z" },
        { role: "assistant", body: "interesting — any specific subdomain?", createdAt: "2026-05-18T20:01:20Z" },
        { role: "user", body: "lending, payments, that kind of fintech", createdAt: "2026-05-18T20:01:30Z" },
        { role: "user", body: "I want fintech roles — that's the direction", createdAt: "2026-05-18T20:01:40Z" },
      ],
      log,
    })
    console.log(`\n  outcome:`, JSON.stringify(outcome, null, 2))
  })

  // Verify pa-users.tags.industrySector now includes financial_technology.
  let firestorePass = false
  await step("Assert pa-users.tags.industrySector includes financial_technology", async () => {
    const snap = await db.collection("pa-users").doc(TARGET_UID).get()
    const d = snap.data()
    const indust = d?.tags?.industrySector ?? []
    console.log(`  user.tags.industrySector (after) = ${JSON.stringify(indust)}`)
    firestorePass = Array.isArray(indust) && indust.includes("financial_technology")
    console.log(`  result: ${firestorePass ? "✓ PASS" : "✗ FAIL"}`)
  })

  // Verify extractionState persisted.
  await step("Assert extractionState persisted", async () => {
    const state = await readExtractionState(db, TARGET_UID)
    console.log(`  extractionState =`, JSON.stringify(state, null, 2))
  })

  // Verify a new Qdrant point landed for the user.
  let qdrantPass = false
  await step("Assert Qdrant pa_memory_entities has new point(s) for the user", async () => {
    const qdrantAfter = (await qdrantCountForUser(TARGET_UID)) ?? 0
    console.log(`  count(after) = ${qdrantAfter}  delta = ${qdrantAfter - qdrantBefore}`)
    const points = await qdrantScrollForUser(TARGET_UID, 5)
    for (const p of points) {
      console.log(`    point id=${p.id}  payload=`, JSON.stringify(p.payload))
    }
    qdrantPass = qdrantAfter > qdrantBefore
    console.log(`  result: ${qdrantPass ? "✓ PASS" : "✗ FAIL (no delta)"}`)
  })

  console.log("\n" + "=".repeat(78))
  if (firestorePass && qdrantPass) {
    console.log("✓ Live verify: both Firestore tag write and Qdrant memory write succeeded")
    process.exit(0)
  }
  console.log(`✗ Live verify failed — firestore=${firestorePass} qdrant=${qdrantPass}`)
  process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
