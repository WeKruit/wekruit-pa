#!/usr/bin/env node
/**
 * Scenario runner — drives the production PA stack via Firestore broker
 * inbound events, then verifies replies and (optionally) Qdrant memories.
 *
 * Per P10 Phase 2 contract:
 *   - DOES NOT write to ~/Library/Messages/chat.db (worker-only territory).
 *   - DOES write a synthetic broker iMessage event to pa_inbound_events,
 *     which is exactly what the real worker produces.
 *   - Polls pa_outbound for the assistant reply, applies assertions.
 *   - Optionally polls Qdrant for semantic memory presence (Phase 3).
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=... \
 *   node tests/scenarios/runner.mjs tests/scenarios/scenarios/memory-recall-zh.yaml
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=... \
 *   node tests/scenarios/runner.mjs tests/scenarios/scenarios/   # whole dir
 */
import { readFile, readdir, stat } from "node:fs/promises"
import { resolve, join, basename } from "node:path"
import { randomUUID } from "node:crypto"
import { parse as parseYaml } from "yaml"
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app"
import { getFirestore, FieldValue } from "firebase-admin/firestore"

const PA_INBOUND = "pa_inbound_events"
const PA_OUTBOUND = "pa_outbound"
const PA_MESSAGES = "pa_messages"

function nowIso() {
  return new Date().toISOString()
}

function getDb() {
  if (!getApps().length) initializeApp({ credential: applicationDefault() })
  return getFirestore()
}

/** Build a broker-shaped iMessage inbound event. CF detects via rawPayload.kind. */
function brokerEvent({ participant, chatId, text }) {
  const id = `harness_${randomUUID()}`
  const idempotencyKey = `harness:${id}`
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
      },
    },
  }
}

/** Wait until a Firestore predicate is true or timeout fires. */
async function pollUntil(probe, { timeoutMs, intervalMs = 500, label }) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await probe()
    if (result) return result
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timeout after ${timeoutMs}ms waiting for: ${label}`)
}

async function runTurn(db, scenario, turnIdx) {
  const turn = scenario.turns[turnIdx]
  const event = brokerEvent({
    participant: scenario.participant,
    chatId: scenario.chatId,
    text: turn.user,
  })
  await db.collection(PA_INBOUND).doc(event.id).set(event.docData)

  // Wait for orchestrator to mark inbound completed.
  const evRef = db.collection(PA_INBOUND).doc(event.id)
  await pollUntil(
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
    { timeoutMs: scenario.turnTimeoutMs ?? 30000, label: `inbound ${event.id} completed` }
  )

  // Find the assistant reply. Search recent pa_messages OR pa_outbound for
  // anything written after this event id.
  const reply = await pollUntil(
    async () => {
      // pa_messages is the canonical transcript per pa-orchestrator.
      const msgs = await db
        .collection(PA_MESSAGES)
        .where("idempotencyKey", "==", `out-${event.id}`)
        .limit(1)
        .get()
      if (!msgs.empty) {
        const d = msgs.docs[0].data()
        return d.body
      }
      return false
    },
    { timeoutMs: 5000, intervalMs: 500, label: `reply for event ${event.id}` }
  ).catch(() => null)

  return { event, reply }
}

function applyAssertions(turn, reply) {
  const a = turn.assert ?? {}
  const failures = []
  if (typeof reply !== "string" || reply.length === 0) {
    failures.push("reply was empty or missing")
    return failures
  }
  if (a.reply_min_length && reply.length < a.reply_min_length) {
    failures.push(`reply length ${reply.length} < min ${a.reply_min_length}`)
  }
  if (Array.isArray(a.reply_contains_any) && a.reply_contains_any.length > 0) {
    if (!a.reply_contains_any.some((needle) => reply.includes(needle))) {
      failures.push(`reply does not contain any of [${a.reply_contains_any.join(", ")}]`)
    }
  }
  if (Array.isArray(a.reply_not_contains_any)) {
    for (const needle of a.reply_not_contains_any) {
      if (reply.toLowerCase().includes(needle.toLowerCase())) {
        failures.push(`reply contains forbidden token "${needle}"`)
      }
    }
  }
  return failures
}

async function runScenario(db, scenarioPath) {
  const raw = await readFile(scenarioPath, "utf8")
  const scenario = parseYaml(raw)
  const result = {
    id: scenario.id,
    file: basename(scenarioPath),
    turns: [],
    pass: true,
  }
  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i]
    try {
      const { event, reply } = await runTurn(db, scenario, i)
      const failures = applyAssertions(turn, reply)
      result.turns.push({
        idx: i,
        user: turn.user,
        reply,
        eventId: event.id,
        pass: failures.length === 0,
        failures,
      })
      if (failures.length > 0) result.pass = false
    } catch (err) {
      result.turns.push({
        idx: i,
        user: turn.user,
        pass: false,
        failures: [`runner error: ${err.message}`],
      })
      result.pass = false
      break
    }
  }
  return result
}

async function expandTargets(targetPath) {
  const abs = resolve(targetPath)
  const s = await stat(abs)
  if (s.isFile()) return [abs]
  if (s.isDirectory()) {
    const entries = await readdir(abs)
    return entries.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).map((f) => join(abs, f))
  }
  throw new Error(`Not a file or directory: ${abs}`)
}

async function main() {
  const target = process.argv[2]
  if (!target) {
    console.error("usage: node tests/scenarios/runner.mjs <scenario.yaml | scenarios-dir>")
    process.exit(2)
  }
  const files = await expandTargets(target)
  if (files.length === 0) {
    console.error(`No scenarios found at ${target}`)
    process.exit(2)
  }
  const db = getDb()
  const results = []
  for (const f of files) {
    console.error(`▶ running ${basename(f)}`)
    const r = await runScenario(db, f)
    results.push(r)
    console.error(`  ${r.pass ? "✓ pass" : "✗ fail"} (${r.turns.length} turns)`)
  }
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    results,
  }
  console.log(JSON.stringify(summary, null, 2))
  process.exit(summary.failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("[runner] fatal:", err)
  process.exit(1)
})
