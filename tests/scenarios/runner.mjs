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
 *
 *   PA_RUN_EVAL=1 PA_OPENAI_AGENT_API_KEY=... \
 *     GOOGLE_APPLICATION_CREDENTIALS=... \
 *     node tests/scenarios/runner.mjs tests/scenarios/scenarios/  # +judge
 *
 *   node tests/scenarios/runner.mjs tests/scenarios/scenarios/ --dry-run
 *     # Phase 14.4: lists scenarios, judge plan, projected cost. No
 *     # Firestore writes, no judge calls, no OpenAI calls.
 */
import { readFileSync, mkdirSync } from "node:fs"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { resolve, join, basename } from "node:path"
import { randomUUID } from "node:crypto"
import { parse as parseYaml } from "yaml"
import { initializeApp, getApps, applicationDefault, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

import {
  runJudge,
  judgeVerdictPasses,
  projectJudgeCostUsd,
  JUDGE_MODEL,
} from "./judge.mjs"

const PA_INBOUND = "pa_inbound_events"
const PA_OUTBOUND = "pa_outbound"
const PA_MESSAGES = "pa_messages"
const PA_TURNS = "pa_turns"
const PA_USERS = "pa_users"
const PA_MEMORY_FACTS = "pa_memory_facts"
const generatedParticipants = new Set()

// Phase 14.4 — cost ceiling. Defaults to $5 per run unless the operator
// dials it down (used by the eval test "abort on tiny ceiling").
const DEFAULT_EVAL_MAX_RUN_USD = 5

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
    ? db.collection(PA_USERS).where("channels.imessageHandle", "==", normalized)
    : db.collection(PA_USERS).where("phoneE164", "==", normalized)
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
    await db.collection(PA_USERS).doc(existing.id).set(
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
  await db.collection(PA_USERS).doc(id).set(doc)
  return id
}

/**
 * Phase 11.3 — apply an allowlisted patch to the resolved test user's
 * Firestore document. Restricted to a hard-coded set of safe fields to
 * keep the harness from being weaponized into a generic write API.
 *
 * Allowed fields: `mem0UserId` (string|null) — set the Mem0/Qdrant
 * partition key, or null to clear it. Anything else throws.
 *
 * Scenarios MUST also have `testMode: true`. Refuses to run otherwise.
 */
const ALLOWED_USER_PATCH_FIELDS = new Set(["mem0UserId"])

async function applyUserPatch(db, userId, patchSpec, label) {
  if (!patchSpec || typeof patchSpec !== "object") return
  const patch = { updatedAt: nowIso() }
  for (const [key, value] of Object.entries(patchSpec)) {
    if (!ALLOWED_USER_PATCH_FIELDS.has(key)) {
      throw new Error(
        `[runner] ${label}.userPatch field "${key}" is not in the allowlist (${[...ALLOWED_USER_PATCH_FIELDS].join(", ")})`
      )
    }
    if (value === null || value === undefined) {
      // Use FieldValue.delete()? Simpler: write empty string, which the
      // resolver treats as unset.
      patch[key] = ""
    } else if (typeof value !== "string") {
      throw new Error(`[runner] ${label}.userPatch.${key} must be string|null`)
    } else {
      patch[key] = value
    }
  }
  await db.collection(PA_USERS).doc(userId).set(patch, { merge: true })
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

  // Find the assistant reply. Phase 10.5 changed idempotencyKey from the
  // legacy "out-${eventId}" string to a hash of (sessionId, role, body) so
  // that SDK FirestoreSession.addItems and orchestrator.appendMessage
  // converge on the same row. Look up by rawMeta.eventId, which the
  // orchestrator merges into the row even on idempotency-collision.
  const replyTimeoutMs = Number(scenario.replyTimeoutMs ?? 120_000)
  const reply = await pollUntil(
    async () => {
      // pa_messages is the canonical transcript per pa-orchestrator.
      const byMeta = await db
        .collection(PA_MESSAGES)
        .where("rawMeta.eventId", "==", event.id)
        .limit(5)
        .get()
      if (!byMeta.empty) {
        const assistant = byMeta.docs
          .map((d) => d.data())
          .find((d) => d.role === "assistant" && typeof d.body === "string" && d.body.length > 0)
        if (assistant) return assistant.body
      }
      // Fallback: pre-Phase-10.5 idempotency-key shape.
      const legacy = await db
        .collection(PA_MESSAGES)
        .where("idempotencyKey", "==", `out-${event.id}`)
        .limit(1)
        .get()
      if (!legacy.empty) {
        const d = legacy.docs[0].data()
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

// ---------------------------------------------------------------------------
// Phase 14.1 — telemetry-backed assertions.
//
// `pa_turns` rows are written by pa-orchestrator (`createTurn` →
// `updateTurn { usage }` after `runAgentTurn` resolves). We fetch by
// `eventId == event.id` and surface the usage block to the assertion
// helpers below. The 10.5 carry-over about deferred `pa_tool_calls`
// audits does NOT block this — `usage.hostedToolCalls` is the
// authoritative source per Phase 10.5 T9 in
// packages/agent-runtime/src/types.ts.
// ---------------------------------------------------------------------------

async function fetchTurnByEventId(db, eventId, { timeoutMs = 8000, intervalMs = 250 } = {}) {
  return pollUntil(
    async () => {
      const snap = await db
        .collection(PA_TURNS)
        .where("eventId", "==", eventId)
        .limit(1)
        .get()
      if (snap.empty) return false
      // Wait until usage has been merged in (Phase 10.5 T9 writes it after
      // appendMessage resolves, which is what the runner just polled for —
      // so this is usually a single fetch, but we tolerate ~ms ordering).
      const data = snap.docs[0].data()
      if (!data) return false
      return data
    },
    { timeoutMs, intervalMs, label: `pa_turns row for event ${eventId}` }
  ).catch(() => null)
}

export function applyTelemetryAssertions(turn, turnDoc) {
  const a = turn.assert ?? {}
  const failures = []
  const hasTelemetryKey =
    Array.isArray(a.tool_call_required) ||
    Array.isArray(a.tool_call_forbidden) ||
    typeof a.usage_max_input_tokens === "number" ||
    typeof a.usage_max_total_tokens === "number"
  if (!hasTelemetryKey) return failures
  if (!turnDoc) {
    failures.push("telemetry assertion requested but no pa_turns row was found for this event")
    return failures
  }
  const usage = turnDoc.usage ?? {}
  const hostedCalls = Array.isArray(usage.hostedToolCalls) ? usage.hostedToolCalls : []
  const calledNames = new Set(
    hostedCalls
      .map((c) => (c && typeof c.name === "string" ? c.name : null))
      .filter(Boolean)
  )

  if (Array.isArray(a.tool_call_required)) {
    for (const tool of a.tool_call_required) {
      if (!calledNames.has(tool)) {
        failures.push(
          `tool_call_required: "${tool}" not in pa_turns.usage.hostedToolCalls (saw [${[...calledNames].join(", ") || "none"}])`
        )
      }
    }
  }
  if (Array.isArray(a.tool_call_forbidden)) {
    for (const tool of a.tool_call_forbidden) {
      if (calledNames.has(tool)) {
        failures.push(`tool_call_forbidden: "${tool}" was called`)
      }
    }
  }
  if (typeof a.usage_max_input_tokens === "number") {
    const v = Number(usage.inputTokens)
    if (Number.isFinite(v) && v > a.usage_max_input_tokens) {
      failures.push(`usage_max_input_tokens: inputTokens=${v} exceeds cap ${a.usage_max_input_tokens}`)
    }
  }
  if (typeof a.usage_max_total_tokens === "number") {
    const v = Number(usage.totalTokens)
    if (Number.isFinite(v) && v > a.usage_max_total_tokens) {
      failures.push(`usage_max_total_tokens: totalTokens=${v} exceeds cap ${a.usage_max_total_tokens}`)
    }
  }
  return failures
}

/** Phase 14.1 — pre-turn `persona_facts_present` probe. Looks up the
 *  user by participant, then queries `pa_memory_facts` for confirmed
 *  rows. This intentionally runs BEFORE the turn fires so it tests
 *  seeded state, not what the turn just produced. */
export async function applyPersonaFactsPresent(db, scenario, turn) {
  const a = turn.assert ?? {}
  if (typeof a.persona_facts_present !== "boolean") return []
  const user = await findScenarioUser(db, scenario.participant)
  if (!user) {
    return a.persona_facts_present
      ? [`persona_facts_present: true expected but no pa_users row for ${scenario.participant}`]
      : []
  }
  const snap = await db
    .collection(PA_MEMORY_FACTS)
    .where("userId", "==", user.id)
    .where("status", "==", "confirmed")
    .limit(1)
    .get()
  const present = !snap.empty
  if (present !== a.persona_facts_present) {
    return [
      `persona_facts_present: expected ${a.persona_facts_present} but found ${present} confirmed pa_memory_facts for userId=${user.id}`,
    ]
  }
  return []
}

export function applyAssertions(turn, reply) {
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

// ---------------------------------------------------------------------------
// Phase 14.2/14.4 — judge call site + cost ledger.
// ---------------------------------------------------------------------------

/** Per-run cost ledger. Lives on a closure inside `main` and is passed
 *  through `runScenario` → `applyJudge`. Hard-stops the run before any
 *  judge call that would push the cumulative spend past the ceiling. */
export function makeCostLedger(maxUsd) {
  const state = { totalUsd: 0, callCount: 0, aborted: false }
  return {
    get totalUsd() {
      return state.totalUsd
    },
    get callCount() {
      return state.callCount
    },
    /** Returns `null` if a call may proceed, otherwise an error message. */
    preflight() {
      if (state.aborted) return "cost ceiling already exceeded"
      const projected = state.totalUsd + projectJudgeCostUsd()
      if (projected > maxUsd) {
        state.aborted = true
        return `PA_EVAL_MAX_RUN_USD ceiling ${maxUsd.toFixed(4)} would be exceeded (current=${state.totalUsd.toFixed(4)} + projected=${projectJudgeCostUsd().toFixed(4)})`
      }
      return null
    },
    record(costUsd) {
      state.totalUsd += Number.isFinite(costUsd) ? costUsd : 0
      state.callCount += 1
    },
  }
}

async function applyJudgeAssertion({ scenario, turn, reply, runStamp, ledger, evalEnabled }) {
  const judgeAssert = turn.assert?.judge
  if (!judgeAssert) return { failures: [], judgeRecord: null, skipped: false }
  if (!evalEnabled) {
    console.error(
      `  [judge] SKIPPED for ${scenario.id ?? "<unknown>"} — set PA_RUN_EVAL=1 to enable judge assertions`
    )
    return { failures: [], judgeRecord: null, skipped: true }
  }
  const ceilingMessage = ledger.preflight()
  if (ceilingMessage) {
    return {
      failures: [`judge skipped: ${ceilingMessage}`],
      judgeRecord: null,
      skipped: false,
      aborted: true,
    }
  }

  const logPath = join(
    process.cwd(),
    "eval-runs",
    runStamp,
    "judge.jsonl"
  )
  const transcript = [{ role: "user", content: turn.user }]
  try {
    const result = await runJudge({
      criterion: judgeAssert.criterion,
      threshold: judgeAssert.threshold ?? 0.7,
      reply,
      transcript,
      logPath,
      metadata: {
        scenarioId: scenario.id ?? null,
        scenarioFile: scenario.__sourceFile ?? null,
        turnUserPreview: turn.user?.slice(0, 80) ?? null,
      },
    })
    ledger.record(result.costUsd)
    const failures = []
    const threshold = judgeAssert.threshold ?? 0.7
    if (!judgeVerdictPasses(result, threshold)) {
      failures.push(
        `judge verdict=${result.verdict} confidence=${result.confidence.toFixed(2)} threshold=${threshold} rationale="${result.rationale}"`
      )
    }
    return { failures, judgeRecord: result, skipped: false }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { failures: [`judge call failed: ${msg}`], judgeRecord: null, skipped: false }
  }
}

async function runScenario(db, scenarioPath, ctx) {
  const raw = await readFile(scenarioPath, "utf8")
  const parsed = parseYaml(raw)
  parsed.__sourceFile = basename(scenarioPath)
  const scenario = materializeScenario(parsed)
  scenario.__sourceFile = parsed.__sourceFile
  const result = {
    id: scenario.id,
    file: basename(scenarioPath),
    turns: [],
    pass: true,
  }
  assertScenarioParticipant(scenario)
  const userId = await ensureScenarioTestUser(db, scenario)
  // Phase 11.3 — apply scenario-level setup patch (e.g. set mem0UserId
  // BEFORE the first turn so the orchestrator picks up the alt partition).
  if (scenario.setup?.userPatch) {
    if (scenario.testMode !== true || !userId) {
      throw new Error(`[runner] setup.userPatch requires testMode: true and a resolved test user`)
    }
    await applyUserPatch(db, userId, scenario.setup.userPatch, "setup")
  }
  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i]
    try {
      // Phase 14.1 — pre-turn persona-fact probe (seeded state).
      const personaFailures = await applyPersonaFactsPresent(db, scenario, turn)

      const { event, reply } = await runTurnWithRetry(db, scenario, i)
      const replyFailures = applyAssertions(turn, reply)

      // Phase 14.1 — fetch pa_turns row for telemetry assertions.
      const needsTelemetry =
        Array.isArray(turn.assert?.tool_call_required) ||
        Array.isArray(turn.assert?.tool_call_forbidden) ||
        typeof turn.assert?.usage_max_input_tokens === "number" ||
        typeof turn.assert?.usage_max_total_tokens === "number"
      const turnDoc = needsTelemetry ? await fetchTurnByEventId(db, event.id) : null
      const telemetryFailures = applyTelemetryAssertions(turn, turnDoc)

      // Phase 14.2 — judge.
      const judgeOutcome = await applyJudgeAssertion({
        scenario,
        turn,
        reply,
        runStamp: ctx.runStamp,
        ledger: ctx.ledger,
        evalEnabled: ctx.evalEnabled,
      })

      const failures = [
        ...personaFailures,
        ...replyFailures,
        ...telemetryFailures,
        ...judgeOutcome.failures,
      ]
      result.turns.push({
        idx: i,
        user: turn.user,
        reply,
        eventId: event.id,
        pass: failures.length === 0,
        failures,
        judge: judgeOutcome.judgeRecord
          ? {
              verdict: judgeOutcome.judgeRecord.verdict,
              confidence: judgeOutcome.judgeRecord.confidence,
              costUsd: judgeOutcome.judgeRecord.costUsd,
            }
          : judgeOutcome.skipped
            ? { skipped: true }
            : null,
        usage: turnDoc?.usage ?? null,
      })
      if (failures.length > 0) result.pass = false
      if (judgeOutcome.aborted) {
        // Hard stop: cost ceiling. Surface a top-level abort signal so
        // the outer loop can stop iterating the directory.
        result.aborted = "cost_ceiling_exceeded"
        break
      }
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
  // Phase 11.3 — restore via cleanup.userPatch if requested. Best-effort;
  // never overrides a test failure.
  if (scenario.cleanup?.userPatch && userId && scenario.testMode === true) {
    try {
      await applyUserPatch(db, userId, scenario.cleanup.userPatch, "cleanup")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.cleanupError = msg
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

// ---------------------------------------------------------------------------
// Phase 14.4 — `--dry-run` planner. Lists the scenarios that would run, the
// judge calls each would issue, and the projected cost. Does NOT touch
// Firestore or OpenAI. Useful as a CI sanity gate ("is the eval still cheap
// enough?") and for `npm run eval -- --dry-run` smoke tests.
// ---------------------------------------------------------------------------
export async function dryRunPlan(files, evalEnabled, maxUsd) {
  const plan = { evalEnabled, maxRunUsd: maxUsd, scenarios: [] }
  let projectedJudgeCalls = 0
  for (const f of files) {
    let parsed = null
    try {
      parsed = parseYaml(await readFile(f, "utf8"))
    } catch (err) {
      plan.scenarios.push({ file: basename(f), parseError: String(err.message ?? err) })
      continue
    }
    const turns = Array.isArray(parsed?.turns) ? parsed.turns : []
    const judgeTurns = turns.filter((t) => t?.assert?.judge).length
    const telemetryTurns = turns.filter(
      (t) =>
        Array.isArray(t?.assert?.tool_call_required) ||
        Array.isArray(t?.assert?.tool_call_forbidden) ||
        typeof t?.assert?.usage_max_input_tokens === "number" ||
        typeof t?.assert?.usage_max_total_tokens === "number"
    ).length
    if (evalEnabled) projectedJudgeCalls += judgeTurns
    plan.scenarios.push({
      file: basename(f),
      id: parsed?.id ?? null,
      turns: turns.length,
      judgeTurns,
      telemetryTurns,
      participant: parsed?.participant ?? null,
    })
  }
  plan.projectedJudgeCalls = projectedJudgeCalls
  plan.projectedJudgeCostUsd = Number(
    (projectedJudgeCalls * projectJudgeCostUsd()).toFixed(6)
  )
  plan.judgeModel = JUDGE_MODEL
  return plan
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== "--")
  const dryRun = argv.includes("--dry-run")
  const target = argv.find((a) => !a.startsWith("--"))
  if (!target) {
    console.error("usage: node tests/scenarios/runner.mjs <scenario.yaml | scenarios-dir> [--dry-run]")
    process.exit(2)
  }
  const files = (await expandTargets(target)).sort((a, b) => basename(a).localeCompare(basename(b)))
  if (files.length === 0) {
    console.error(`No scenarios found at ${target}`)
    process.exit(2)
  }

  const evalEnabled = process.env.PA_RUN_EVAL === "1"
  const maxUsd = Number(process.env.PA_EVAL_MAX_RUN_USD ?? DEFAULT_EVAL_MAX_RUN_USD)
  if (!Number.isFinite(maxUsd) || maxUsd < 0) {
    console.error(`[runner] invalid PA_EVAL_MAX_RUN_USD=${process.env.PA_EVAL_MAX_RUN_USD}`)
    process.exit(2)
  }

  if (dryRun) {
    const plan = await dryRunPlan(files, evalEnabled, maxUsd)
    console.log(JSON.stringify(plan, null, 2))
    process.exit(0)
  }

  const db = getDb()
  try {
    await db.collection(PA_INBOUND).limit(1).get()
  } catch (e) {
    const hint = e instanceof Error ? e.message : String(e)
    console.error(`[runner] Firestore unreachable (${hint}). Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON.`)
    process.exit(2)
  }

  const runStamp = new Date().toISOString().replace(/[:.]/g, "-")
  const evalRunDir = join(process.cwd(), "eval-runs", runStamp)
  if (evalEnabled) {
    mkdirSync(evalRunDir, { recursive: true })
    console.error(`[runner] PA_RUN_EVAL=1 → judge enabled (model=${JUDGE_MODEL}, ceilingUsd=${maxUsd})`)
    console.error(`[runner] eval artifacts: ${evalRunDir}`)
  }

  const ledger = makeCostLedger(maxUsd)
  const ctx = { runStamp, evalEnabled, ledger }

  const results = []
  let aborted = null
  for (const f of files) {
    console.error(`▶ running ${basename(f)}`)
    const r = await runScenario(db, f, ctx)
    results.push(r)
    console.error(`  ${r.pass ? "✓ pass" : "✗ fail"} (${r.turns.length} turns)`)
    if (r.aborted === "cost_ceiling_exceeded") {
      aborted = r.aborted
      console.error(`[runner] aborting run: ${r.aborted}`)
      break
    }
  }
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    judgeCallCount: ledger.callCount,
    judgeCostUsd: Number(ledger.totalUsd.toFixed(6)),
    aborted,
    runStamp: evalEnabled ? runStamp : null,
    results,
  }
  if (evalEnabled) {
    try {
      await writeFile(
        join(evalRunDir, "summary.json"),
        JSON.stringify(summary, null, 2),
        "utf8"
      )
    } catch (err) {
      console.error(`[runner] failed to write summary.json: ${err.message ?? err}`)
    }
  }
  console.log(JSON.stringify(summary, null, 2))
  process.exit(summary.failed > 0 || aborted ? 1 : 0)
}

// Only run main() when invoked as a script. Importing from tests should
// not start a Firestore session.
import { fileURLToPath } from "node:url"
const __isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (__isMain) {
  main().catch((err) => {
    console.error("[runner] fatal:", err)
    process.exit(1)
  })
}
