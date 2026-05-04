/**
 * iter30 WS6 Wave 3 — INPUT_GUARDRAIL_CHAIN shadow-mode wire-up.
 *
 * Background: V5 QA Agent-E found that `INPUT_GUARDRAIL_CHAIN` (PII
 * scanner / length cap / prompt-injection v2 / crisis-detector) was
 * DEFINED but NEVER CALLED in production. Legacy `checkInboundSafety`
 * covers crisis + injection but PII enforcement is a hidden gap (SSN
 * / CC regex never runs).
 *
 * This test verifies:
 *   1. Shadow chain DOES run when `PA_GUARDRAIL_INPUT_CHAIN_SHADOW=true`
 *      and emits `pa.guardrails.input.shadow.result` with the per-
 *      guardrail hits payload.
 *   2. Shadow chain DOES NOT gate the request — legacy safety remains
 *      authoritative.
 *   3. PII trips (SSN regex) appear in shadow telemetry but do NOT
 *      block the inbound (since legacy doesn't enforce PII yet).
 *   4. Shadow is OFF by default — no telemetry when env unset.
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { AgentDef, InboundEvent, MemoryFact } from "@pa/core-types"
import { processInboundEvent, type OrchestratorStore } from "../index.js"

// ---------- Test agent + base event ----------

const agent: AgentDef = {
  id: "default",
  name: "Default",
  systemPrompt: "You are concise.",
  provider: "openai",
  model: "gpt-4o-mini",
  temperature: 0.7,
  memoryMode: "firestore_only",
  toolPolicy: "none",
  version: "1",
  isDefault: true,
}

const baseEvent: InboundEvent = {
  id: "evt-shadow-input",
  userId: "u-shadow",
  sessionId: "s-shadow",
  channel: "imessage",
  externalChatId: "+19999991046",
  from: "+19999991046",
  body: "placeholder",
  status: "pending",
  createdAt: "2026-05-03T12:00:00.000Z",
  idempotencyKey: "imessage-in-shadow",
}

interface Captures {
  llmCalls: number
  outboundBodies: string[]
  appendedAssistantBodies: string[]
  logs: Array<{ evt: string; payload?: Record<string, unknown> }>
}

function makeStore(captures: Captures, opts: { allowSafety: boolean }): OrchestratorStore {
  const facts: MemoryFact[] = []
  return {
    markEventRunning: async () => undefined,
    markEventSucceeded: async () => undefined,
    markEventFailed: async () => undefined,
    createTurn: async () => "turn-shadow",
    updateTurn: async () => undefined,
    appendMessage: async (m) => {
      if (m.role === "assistant") captures.appendedAssistantBodies.push(m.body)
    },
    getAgentForUser: async () => agent,
    getMem0UserId: async () => undefined,
    loadHistory: async () => [],
    enqueueOutbound: async (_uid, _to, body) => {
      captures.outboundBodies.push(body)
    },
    listMemoryFacts: async () => facts,
    createMemoryFact: async () => "f1",
    deleteMemoryFacts: async () => undefined,
    recordMemoryAction: async () => undefined,
    loadPersonalizationContext: async () => ({
      memoryBlock: null,
      mem0Degraded: false,
      mem0SearchResultCount: 0,
      mem0DegradedReason: null,
    }),
    createSession: () => ({
      async getSessionId() {
        return "s-shadow"
      },
      async getItems() {
        return []
      },
      async addItems() {
        /* no-op */
      },
      async popItem() {
        return undefined
      },
      async clearSession() {
        /* no-op */
      },
    }),
    runAgentTurn: async () => {
      captures.llmCalls++
      return { text: "benign reply" }
    },
    afterAssistantTurn: async () => ({ writebackRan: false, writebackSkipReason: "memory_mode" }),
    maybeHandleResetCommand: async () => ({ handled: false }),
    buildTurnTools: async () => [],
    recordHostedToolCalls: async () => undefined,
    nowIso: () => "2026-05-03T12:00:00.000Z",
    log: (evt, payload) => {
      captures.logs.push({ evt, payload })
    },
    // Toggle legacy safety pass/block at the test seam.
    checkInboundSafety: async () =>
      opts.allowSafety ? { allow: true } : { allow: false, reason: "test_block" },
    cancelAllPendingProactiveJobs: async () => 0,
    writeProactiveCancelAudit: async () => undefined,
    getOnboardingUser: async () => null, // bypass onboarding to isolate
    applyOnboarding: async () => undefined,
  }
}

// ---------- Tests ----------

test("WS6 input shadow — runs and emits pa.guardrails.input.shadow.result when env=true", async () => {
  const prev = process.env.PA_GUARDRAIL_INPUT_CHAIN_SHADOW
  process.env.PA_GUARDRAIL_INPUT_CHAIN_SHADOW = "true"
  try {
    const captures: Captures = {
      llmCalls: 0,
      outboundBodies: [],
      appendedAssistantBodies: [],
      logs: [],
    }
    const store = makeStore(captures, { allowSafety: true })
    await processInboundEvent(
      { ...baseEvent, id: "evt-shadow-1", body: "hi just a friendly hello" },
      store,
    )
    const shadowLogs = captures.logs.filter(
      (l) => l.evt === "pa.guardrails.input.shadow.result",
    )
    assert.equal(shadowLogs.length, 1, "exactly one shadow.result log")
    const payload = shadowLogs[0]!.payload!
    assert.equal(payload.allowed, true, "benign hello passes shadow chain")
    assert.equal(payload.trippedBy, null)
    assert.ok(Array.isArray(payload.hits), "hits is an array")
    const names = (payload.hits as Array<{ name: string }>).map((h) => h.name)
    assert.deepEqual(
      names,
      ["crisisDetector", "promptInjectionDetector", "piiScanner", "lengthInputCheck"],
      "all 4 input guardrails ran in locked order",
    )
  } finally {
    if (prev === undefined) delete process.env.PA_GUARDRAIL_INPUT_CHAIN_SHADOW
    else process.env.PA_GUARDRAIL_INPUT_CHAIN_SHADOW = prev
  }
})

test("WS6 input shadow — PII (SSN) trips piiScanner in telemetry but does NOT block (legacy authoritative)", async () => {
  const prev = process.env.PA_GUARDRAIL_INPUT_CHAIN_SHADOW
  process.env.PA_GUARDRAIL_INPUT_CHAIN_SHADOW = "true"
  try {
    const captures: Captures = {
      llmCalls: 0,
      outboundBodies: [],
      appendedAssistantBodies: [],
      logs: [],
    }
    const store = makeStore(captures, { allowSafety: true })
    await processInboundEvent(
      { ...baseEvent, id: "evt-shadow-pii", body: "my SSN is 123-45-6789" },
      store,
    )
    const shadowLogs = captures.logs.filter(
      (l) => l.evt === "pa.guardrails.input.shadow.result",
    )
    assert.equal(shadowLogs.length, 1)
    const payload = shadowLogs[0]!.payload!
    assert.equal(payload.allowed, false, "shadow chain trips on SSN")
    assert.equal(payload.trippedBy, "piiScanner")
    // CRITICAL: legacy still let it through → LLM ran. Shadow is telemetry-only.
    assert.equal(captures.llmCalls, 1, "legacy authoritative — LLM still ran")
  } finally {
    if (prev === undefined) delete process.env.PA_GUARDRAIL_INPUT_CHAIN_SHADOW
    else process.env.PA_GUARDRAIL_INPUT_CHAIN_SHADOW = prev
  }
})

test("WS6 input shadow — OFF by default (no env) emits NO shadow telemetry", async () => {
  const prev = process.env.PA_GUARDRAIL_INPUT_CHAIN_SHADOW
  delete process.env.PA_GUARDRAIL_INPUT_CHAIN_SHADOW
  try {
    const captures: Captures = {
      llmCalls: 0,
      outboundBodies: [],
      appendedAssistantBodies: [],
      logs: [],
    }
    const store = makeStore(captures, { allowSafety: true })
    await processInboundEvent(
      { ...baseEvent, id: "evt-shadow-off", body: "my SSN is 123-45-6789" },
      store,
    )
    const shadowLogs = captures.logs.filter(
      (l) => l.evt === "pa.guardrails.input.shadow.result",
    )
    assert.equal(shadowLogs.length, 0, "no shadow.result emitted when flag off")
  } finally {
    if (prev !== undefined) process.env.PA_GUARDRAIL_INPUT_CHAIN_SHADOW = prev
  }
})
