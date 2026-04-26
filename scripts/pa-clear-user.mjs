#!/usr/bin/env node
/**
 * Clear all PA memory for a single user — wraps the shared
 * `clearUserMemory` interface from `@pa/memory`. The same code path is
 * used by:
 *   - This CLI (harness re-runs)
 *   - `pa-orchestrator.maybeHandleResetCommand` (in-band magic-string trigger)
 *   - Phase 3 Memory Admin dashboard
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   QDRANT_URL=https://...:443 QDRANT_API_KEY=... \
 *   node scripts/pa-clear-user.mjs <userId> [--dry-run] [--keep-messages]
 *
 * Optional helpers:
 *   --set-test-mode     also flip pa_users/{userId}.testMode = true so the
 *                       in-band __PA_RESET__ magic string works for them.
 */
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { clearUserMemory, summarizeClearResult } from "@pa/memory"

const args = process.argv.slice(2)
const userId = args.find((a) => !a.startsWith("--"))
const DRY = args.includes("--dry-run")
const KEEP_MESSAGES = args.includes("--keep-messages")
const SET_TEST_MODE = args.includes("--set-test-mode")

if (!userId) {
  console.error([
    "usage: node scripts/pa-clear-user.mjs <userId> [flags]",
    "  --dry-run         count without deleting",
    "  --keep-messages   leave pa_messages / pa_*turns alone",
    "  --set-test-mode   also set pa_users/{userId}.testMode = true",
  ].join("\n"))
  process.exit(2)
}

const QDRANT_URL = process.env.QDRANT_URL?.replace(/\/+$/, "")
const QDRANT_API_KEY = process.env.QDRANT_API_KEY
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION

if (!QDRANT_URL || !QDRANT_API_KEY) {
  console.error("[clear] QDRANT_URL and QDRANT_API_KEY required (Qdrant memory cannot be skipped)")
  process.exit(2)
}

async function main() {
  if (!getApps().length) initializeApp({ credential: applicationDefault() })
  const db = getFirestore()

  if (SET_TEST_MODE) {
    await db.collection("pa_users").doc(userId).set(
      { testMode: true, updatedAt: new Date().toISOString() },
      { merge: true }
    )
    console.log(`[clear] pa_users/${userId}.testMode = true`)
  }

  const result = await clearUserMemory(
    userId,
    {
      db,
      qdrantUrl: QDRANT_URL,
      qdrantApiKey: QDRANT_API_KEY,
      qdrantCollection: QDRANT_COLLECTION,
      logger: (...args) => console.log("[clear]", ...args),
    },
    { dryRun: DRY, keepMessages: KEEP_MESSAGES }
  )
  console.log("")
  console.log(summarizeClearResult(result))
  console.log(DRY ? "Dry-run complete (no writes)." : "Memory cleared.")
}

main().catch((e) => { console.error("[clear] fatal:", e); process.exit(1) })
