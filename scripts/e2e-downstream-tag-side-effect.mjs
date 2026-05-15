#!/usr/bin/env node
/**
 * E2E — full downstream connector path against prod Firestore.
 *
 * Seeds a temp `mentioned_layoff` trigger as `enabled:true`, posts a
 * laid-off user turn into `runDownstreamConnector` with a stubbed
 * llmJudge that returns "yes", asserts the FULL chain wrote
 * pa-users/{uid}.tags.urgentlySeeking === true.
 *
 * Restores the production trigger state on exit (re-disables if it was
 * disabled before).
 */
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { assertProductionPaUserCreationAllowed } from "../apps/functions/scripts/lib/prod-test-user-guard.mjs"

function bootstrapCreds() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const env = readFileSync(".env", "utf8")
      const m = env.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
      if (m) process.env.FIREBASE_SERVICE_ACCOUNT_JSON = m[1].trim()
    } catch {}
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const tmp = join(tmpdir(), `e2e-downstream-${Date.now()}.json`)
    writeFileSync(tmp, process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmp
  }
}

bootstrapCreds()
if (!getApps().length) {
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (p) initializeApp({ credential: cert(JSON.parse(readFileSync(p, "utf8"))) })
  else initializeApp({ credential: applicationDefault() })
}
const db = getFirestore()

const USER_ID = `e2e-downstream-${Date.now()}`
const TRIGGER_ID = "mentioned_layoff"

assertProductionPaUserCreationAllowed({
  scriptName: "scripts/e2e-downstream-tag-side-effect.mjs",
  userId: USER_ID,
  reason: "downstream connector E2E creates a fresh synthetic pa-users row",
})

const { runDownstreamConnector } = await import(
  "../packages/pa-orchestrator/dist/downstream.js"
)

// --- 1. Snapshot current trigger doc, force enabled=true, ensure proper shape.
const triggerRef = db.collection("pa-downstream-triggers").doc(TRIGGER_ID)
const before = await triggerRef.get()
const wasPresent = before.exists
const wasEnabled = before.exists ? before.data()?.enabled === true : false
console.log(`pre: trigger ${TRIGGER_ID} present=${wasPresent} enabled=${wasEnabled}`)

await triggerRef.set(
  {
    triggerId: TRIGGER_ID,
    name: "Mentioned layoff",
    description: "E2E test seed",
    enabled: true,
    condition: {
      kind: "llm-judge",
      config: { judgePrompt: "Did the user mention being laid off?" },
    },
    endpoint: {
      url: "https://example.invalid/layoff",
      method: "POST",
      hmacSecretRef: "PA_TRIGGER_HMAC_LAYOFF",
    },
    payloadTemplate: '{"event":"mentioned_layoff","userId":"{{userId}}"}',
    cooldownSec: 0,
  },
  { merge: true },
)

// --- 2. Pre-seed user with urgentlySeeking=false.
await db.collection("pa-users").doc(USER_ID).set(
  {
    tags: { urgentlySeeking: false, skills: [], industryEnum: [], schemaVersion: 1 },
    displayName: "e2e-downstream synthetic",
    createdAt: new Date().toISOString(),
  },
  { merge: true },
)
console.log(`seeded pa-users/${USER_ID} urgentlySeeking=false`)

// --- 3. Fire the connector with skipFlagCheck so we don't depend on
//        the global evalConnectorsEnabled flag for this E2E.
const fakeFetch = async () => new Response("ok", { status: 200 })
let result
try {
  result = await runDownstreamConnector(
    db,
    {
      userId: USER_ID,
      conversationId: `e2e-conv-${Date.now()}`,
      lastUserTurn: "I just got laid off from my last job, the layoff is rough.",
      lastAssistantTurn: "Sorry to hear that.",
    },
    {
      llmJudge: async () => "yes",
      resolveSecret: async () => "fake",
      fetchImpl: fakeFetch,
      skipFlagCheck: true,
      log: (m, f) => console.log(`[downstream] ${m}`, f ?? ""),
    },
  )
  console.log("connector result:", JSON.stringify(result, null, 2))
} catch (err) {
  console.error("connector threw:", err)
  result = null
}

// --- 4. Read back tags.
const snap = await db.collection("pa-users").doc(USER_ID).get()
const tags = (snap.data() ?? {}).tags ?? {}
console.log("\npost-state tags:")
console.log("  urgentlySeeking:", tags.urgentlySeeking)

// --- 5. Restore trigger state.
if (!wasEnabled) {
  if (wasPresent) {
    await triggerRef.set({ enabled: false }, { merge: true })
    console.log("restored: trigger enabled=false")
  } else {
    await triggerRef.delete()
    console.log("restored: trigger deleted (was absent)")
  }
}

// --- 6. Verdict.
const matched = result && result.matched > 0
const fired = result && result.fired > 0
const tagFlipped = tags.urgentlySeeking === true

console.log("\nE2E verdict:")
console.log(`  trigger matched: ${matched}`)
console.log(`  webhook fired:   ${fired}`)
console.log(`  tag flipped:     ${tagFlipped}`)

if (matched && fired && tagFlipped) {
  console.log("\nPASS — full broker→connector→tag-side-effect chain wrote urgentlySeeking=true")
  process.exit(0)
} else {
  console.log("\nFAIL")
  process.exit(1)
}
