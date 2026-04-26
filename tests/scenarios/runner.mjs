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
import { readFileSync } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { resolve, join, basename } from "node:path"
import { randomUUID } from "node:crypto"
import { parse as parseYaml } from "yaml"
import { initializeApp, getApps, applicationDefault, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const PA_INBOUND = "pa_inbound_events"
const PA_OUTBOUND = "pa_outbound"
const PA_MESSAGES = "pa_messages"
const generatedParticipants = new Set()

function nowIso() {
  return new Date().toISOString()
}

function normalizeE164(phone) {
  const d = phone.replace(/\D/g, "")
  if (phone.trim().startsWith("+")) return `+${d}`
  return d.length === 10 ? `+1${d}` : `+${d}`
}

function normalizeImessageParticipant(participant) {
  const value = participant.trim()
  if (!value) return ""
  if (value.includes("@")) return value.toLowerCase()
  return normalizeE164(value)
}

function getDb() {
  if (!getApps().length) {
    const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (jsonEnv && jsonEnv.trim().length > 0) {
      const serviceAccount = JSON.parse(jsonEnv)
      initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id,
      })
    } else if (path) {
      const serviceAccount = JSON.parse(readFileSync(path, "utf8"))
      initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id,
      })
    } else {
      initializeApp({
        credential: applicationDefault(),
        projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
      })
    }
  }
  return getFirestore()
}

async function findScenarioUser(db, participant) {
  const normalized = normalizeImessageParticipant(participant)
  if (!normalized) return null
  const query = normalized.includes("@")
    ? db.collection("pa_users").where("channels.imessageHandle", "==", normalized)
    : db.collection("pa_users").where("phoneE164", "==", normalized)
  const snap = await query.limit(1).get()
  if (snap.empty) return null
  return { id: snap.docs[0].id, data: snap.docs[0].data() }
}

async function ensureScenarioTestUser(db, scenario) {
  if (scenario.testMode !== true) return null
  const normalized = normalizeImessageParticipant(scenario.participant)
  if (!normalized) throw new Error(`Invalid participant for testMode scenario: ${scenario.participant}`)

  const existing = await findScenarioUser(db, scenario.participant)
  if (existing) {
    await db.collection("pa_users").doc(existing.id).set(
      { testMode: true, updatedAt: nowIso() },
      { merge: true }
    )
    return existing.id
  }

  const id = randomUUID()
  const doc = {
    id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    onboardingStatus: "provisional",
    channels: { imessageHandle: normalized },
    testMode: true,
  }
  if (!normalized.includes("@")) doc.phoneE164 = normalized
  await db.collection("pa_users").doc(id).set(doc)
  return id
}

function assertScenarioParticipant(scenario) {
  const allowed = (process.env.PA_SCENARIO_ALLOWED_PARTICIPANTS ?? "")
    .split(",")
    .map((s) => normalizeImessageParticipant(s))
    .filter(Boolean)
  const participant = normalizeImessageParticipant(scenario.participant ?? "")
  if (!participant) throw new Error(`Scenario ${scenario.id ?? "<unknown>"} is missing participant`)
  const isReservedHarnessNumber = /^\+1999999\d{4}$/.test(participant)
  if (!isReservedHarnessNumber && !allowed.includes(participant)) {
    throw new Error(
      [
        `Refusing to run scenario ${scenario.id ?? "<unknown>"} for non-harness participant ${participant}.`,
        "Use the reserved +1999999xxxx test range, or set PA_SCENARIO_ALLOWED_PARTICIPANTS for an intentional real test handle.",
      ].join(" ")
    )
  }
}

function generateReservedHarnessParticipant() {
  for (let i = 0; i < 20; i++) {
    const suffix = String(Math.floor(Math.random() * 10000)).padStart(4, "0")
    const participant = `+1999999${suffix}`
    if (!generatedParticipants.has(participant)) {
      generatedParticipants.add(participant)
      return participant
    }
  }
  throw new Error("Unable to allocate a fresh reserved harness participant")
}

function materializeScenario(rawScenario) {
  const scenario = structuredClone(rawScenario)
  const participant = normalizeImessageParticipant(scenario.participant ?? "")
  const isReservedHarnessNumber = /^\+1999999\d{4}$/.test(participant)
  if (isReservedHarnessNumber && process.env.PA_SCENARIO_KEEP_PARTICIPANTS !== "1") {
    const fresh = generateReservedHarnessParticipant()
    scenario.participant = fresh
    scenario.chatId = `iMessage;${fresh}`
  }
  return scenario
}

/** After a suppressed harness turn, pa_outbound must not enqueue worker-visible jobs. */
async function assertNoOutboundWhenSuppressed(db, eventId, suppressOutbound) {
  if (!suppressOutbound) return
  const key = `outbound-${eventId}`
  const snap = await db.collection(PA_OUTBOUND).where("idempotencyKey", "==", key).limit(1).get()
  if (!snap.empty) {
    throw new Error(
      `Harness safety: suppressOutbound was true but pa_outbound has idempotencyKey ${key} (doc ${snap.docs[0].id})`
    )
  }
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
        harness: {
          runner: "tests/scenarios/runner.mjs",
          suppressOutbound: true,
        },
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
  const replyTimeoutMs = Number(scenario.replyTimeoutMs ?? 120_000)
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
    {
      timeoutMs: Number.isFinite(replyTimeoutMs) && replyTimeoutMs > 0 ? replyTimeoutMs : 120_000,
      intervalMs: 500,
      label: `reply for event ${event.id}`,
    }
  ).catch(() => null)

  const harness = event.docData?.rawPayload?.harness
  const suppressOutbound = Boolean(harness && harness.suppressOutbound === true)
  const verifyOutbound = scenario.verifySuppressOutbound !== false
  if (verifyOutbound) {
    await assertNoOutboundWhenSuppressed(db, event.id, suppressOutbound)
  }

  return { event, reply }
}

function isRetryableRunnerError(err) {
  const message = err instanceof Error ? err.message : String(err)
  return /\b429\b|rate.?limit|resource exhausted/i.test(message)
}

async function runTurnWithRetry(db, scenario, turnIdx) {
  const retries = Number(scenario.turnRetries ?? 2)
  const baseBackoffMs = Number(scenario.retryBackoffMs ?? 30000)
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await runTurn(db, scenario, turnIdx)
    } catch (err) {
      lastErr = err
      if (attempt >= retries || !isRetryableRunnerError(err)) throw err
      const delay = baseBackoffMs * (attempt + 1)
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  retrying turn ${turnIdx + 1} after transient error in ${delay}ms: ${message}`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
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
  if (Array.isArray(a.reply_matches_any) && a.reply_matches_any.length > 0) {
    if (!a.reply_matches_any.some((pattern) => new RegExp(pattern, "iu").test(reply))) {
      failures.push(`reply does not match any of [${a.reply_matches_any.join(", ")}]`)
    }
  }
  if (Array.isArray(a.reply_not_contains_any)) {
    for (const needle of a.reply_not_contains_any) {
      if (reply.toLowerCase().includes(needle.toLowerCase())) {
        failures.push(`reply contains forbidden token "${needle}"`)
      }
    }
  }
  if (Array.isArray(a.reply_not_matches_any)) {
    for (const pattern of a.reply_not_matches_any) {
      if (new RegExp(pattern, "iu").test(reply)) {
        failures.push(`reply matches forbidden pattern "${pattern}"`)
      }
    }
  }
  return failures
}

async function runScenario(db, scenarioPath) {
  const raw = await readFile(scenarioPath, "utf8")
  const scenario = materializeScenario(parseYaml(raw))
  const result = {
    id: scenario.id,
    file: basename(scenarioPath),
    turns: [],
    pass: true,
  }
  assertScenarioParticipant(scenario)
  await ensureScenarioTestUser(db, scenario)
  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i]
    try {
      const { event, reply } = await runTurnWithRetry(db, scenario, i)
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
      const msg = err instanceof Error ? err.message : String(err)
      result.turns.push({
        idx: i,
        user: turn.user,
        pass: false,
        failures: [`runner error: ${msg}`],
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
  const files = (await expandTargets(target)).sort((a, b) => basename(a).localeCompare(basename(b)))
  if (files.length === 0) {
    console.error(`No scenarios found at ${target}`)
    process.exit(2)
  }
  const db = getDb()
  try {
    await db.collection(PA_INBOUND).limit(1).get()
  } catch (e) {
    const hint = e instanceof Error ? e.message : String(e)
    console.error(`[runner] Firestore unreachable (${hint}). Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON.`)
    process.exit(2)
  }
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
