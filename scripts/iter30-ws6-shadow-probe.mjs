#!/usr/bin/env node
/**
 * iter30 WS6 Wave 3 — INPUT_GUARDRAIL_CHAIN shadow probe.
 *
 * Drives ONE inbound containing a synthetic SSN through the deployed
 * orchestrator, then queries Cloud Logging for the
 * `pa.guardrails.input.shadow.result` entry and prints the parsed
 * payload — proves piiScanner trips in shadow telemetry without
 * gating the request (legacy path stays authoritative).
 *
 * Usage: node scripts/iter30-ws6-shadow-probe.mjs
 *
 * Pre-req:
 *   FIREBASE_SERVICE_ACCOUNT_JSON env var set (sourced from .env).
 *   gcloud CLI installed and authenticated for log read.
 */
import { initializeApp, getApps, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { randomUUID } from "node:crypto"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

const PA_INBOUND = "pa-inbound-events"
const PROJECT = "wekruit-5f89b"
// Allowlisted test phone — admin-only, scenario harness uses this.
const TEST_PARTICIPANT = "+19999998003"
const TEST_CHAT_ID = "+19999998003"
const PROBE_TEXT = "my SSN is 123-45-6789"

function nowIso() {
  return new Date().toISOString()
}

function getDb() {
  if (!getApps().length) {
    let serviceAccount
    const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (jsonEnv && jsonEnv.trim().length > 0) {
      serviceAccount = JSON.parse(jsonEnv)
    } else if (path) {
      serviceAccount = JSON.parse(readFileSync(path, "utf8"))
    } else {
      throw new Error("Need FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS")
    }
    initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id,
    })
  }
  return getFirestore()
}

function brokerEvent({ participant, chatId, text }) {
  const id = `ws6shadow_${randomUUID()}`
  const idempotencyKey = `ws6shadow:${id}`
  return {
    id,
    docData: {
      id,
      status: "pending",
      idempotencyKey,
      createdAt: nowIso(),
      attemptCount: 0,
      maxAttempts: 1,
      channel: "imessage",
      rawPayload: {
        kind: "imessage",
        participant,
        chatId,
        messageRowId: Date.now(),
        text,
        harness: {
          runner: "scripts/iter30-ws6-shadow-probe.mjs",
          suppressOutbound: true,
        },
      },
    },
  }
}

async function pollUntil(probe, { timeoutMs, intervalMs = 500, label }) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await probe()
    if (result) return result
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timeout after ${timeoutMs}ms waiting for: ${label}`)
}

async function main() {
  const db = getDb()
  const event = brokerEvent({
    participant: TEST_PARTICIPANT,
    chatId: TEST_CHAT_ID,
    text: PROBE_TEXT,
  })
  console.log(`[probe] writing inbound ${event.id} body="${PROBE_TEXT}"`)
  await db.collection(PA_INBOUND).doc(event.id).set(event.docData)

  const evRef = db.collection(PA_INBOUND).doc(event.id)
  const completed = await pollUntil(
    async () => {
      const snap = await evRef.get()
      const data = snap.data()
      if (!data) return false
      if (data.status === "succeeded" || data.status === "completed") return data
      if (data.status === "failed" || data.status === "dead_letter") {
        throw new Error(`Inbound failed: ${data.lastError ?? data.error ?? "unknown"}`)
      }
      return false
    },
    { timeoutMs: 60_000, label: `inbound ${event.id} completed` },
  )
  console.log(`[probe] inbound succeeded status=${completed.status}`)

  // Cloud Logs: filter for our event id and the shadow.result event.
  console.log(`[probe] sleeping 8s for log ingestion…`)
  await new Promise((r) => setTimeout(r, 8000))

  // store.log fans out as `console.log(ts, evt, payload)` → textPayload.
  // Filter by event id substring + the shadow event marker.
  const filter = [
    `resource.type="cloud_run_revision"`,
    `textPayload=~"pa.guardrails.input.shadow"`,
    `textPayload=~"${event.id}"`,
  ].join(" AND ")
  const cmd = [
    "gcloud", "logging", "read",
    `'${filter}'`,
    `--project=${PROJECT}`,
    `--limit=20`,
    `--format=json`,
    `--freshness=10m`,
  ].join(" ")
  console.log(`[probe] reading Cloud Logs:\n  ${cmd}`)
  const stdout = execSync(cmd, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  const entries = JSON.parse(stdout)
  console.log(`[probe] got ${entries.length} log entries\n`)
  for (const ent of entries) {
    console.log("---")
    console.log(`ts=${ent.timestamp}`)
    console.log(ent.textPayload ?? JSON.stringify(ent.jsonPayload ?? {}))
  }
  if (entries.length === 0) {
    console.log("[probe] NO shadow.result entries found. Possible causes:")
    console.log("  - PA_GUARDRAIL_INPUT_CHAIN_SHADOW env var not set on deployed runtime")
    console.log("  - log ingestion still pending (try again in 30s)")
    console.log("  - revision serving the inbound is older than this code change")
    process.exit(2)
  }
  // Verify piiScanner tripped — pattern-match in textPayload.
  const resultEntry = entries.find((e) =>
    (e.textPayload ?? "").includes("pa.guardrails.input.shadow.result"),
  )
  if (!resultEntry) {
    console.log("[probe] no shadow.result (only error entries). FAIL.")
    process.exit(3)
  }
  const text = resultEntry.textPayload ?? ""
  if (!/trippedBy:\s*'piiScanner'/.test(text)) {
    console.log("[probe] FAIL — expected trippedBy=piiScanner, got something else")
    process.exit(4)
  }
  console.log("\n[probe] PASS — piiScanner tripped in shadow telemetry, inbound succeeded (legacy authoritative).")
}

main().catch((err) => {
  console.error("[probe] FATAL", err)
  process.exit(1)
})
