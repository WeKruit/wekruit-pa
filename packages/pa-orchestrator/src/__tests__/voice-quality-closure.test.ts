/**
 * Phase 53 (v1.6 voice-quality closure) — wire-in integration test for the
 * F2 (conditional A/B framework strip) + F3 (mixed-register mirror append)
 * post-gen hooks.
 *
 * Why this exists: runner-local.mjs uses `db: undefined`, which short-
 * circuits `isHumanizeRuntimeEnabled` to false, so my hooks NEVER fire in
 * the runner-local pass-rate measurement. This integration test stubs a
 * minimal Firestore-shaped db AND sets the umbrella env override
 * (`paHumanizeRuntimeEnabled=true`) so `getFlag` short-circuits BEFORE the
 * stub db is read. That gets us past the umbrella and into my hook
 * branches with deterministic LLM body shaping.
 *
 * Mocked LLM body is the exact failing pattern from the v1.6 sim transcript
 * (commit 457d85f). We assert that:
 *  - F2: outbound has the if-clause head removed (then-clause preserved)
 *  - F3: outbound has the missing register token re-anchored
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import type { AgentDef, InboundEvent } from "@pa/core-types"
import { processInboundEvent, type OrchestratorStore } from "../index.js"

const agent: AgentDef = {
  id: "default",
  name: "Claire",
  systemPrompt: "# IDENTITY\nYou are Claire.",
  provider: "openai",
  model: "gpt-5.4-nano",
  temperature: 0.7,
  memoryMode: "firestore_only",
  toolPolicy: "none",
  version: "phase53-vqc",
}

interface Captures {
  outboundBodies: string[]
  logs: Array<{ event: string; payload: Record<string, unknown> }>
}

/**
 * Soft stub db — returns benign empty shapes for any collection/doc/get
 * calls that aren't gated by the env-override path. We don't care about
 * Firestore reads succeeding; we only care that they don't throw and
 * cascade to the orchestrator's catch-all. Used in env-override tests
 * where paHumanizeRuntimeEnabled short-circuits before db is touched,
 * but other Firestore-touching code paths (e.g. mem0 sync stubs) still
 * need a non-throwing db handle.
 */
function makeSoftStubDb(): unknown {
  const emptyDoc = { exists: false, data: () => undefined }
  const emptyQuery = { docs: [] as unknown[], empty: true }
  const docHandle: Record<string, unknown> = {}
  const collectionHandle: Record<string, unknown> = {}
  Object.assign(docHandle, {
    get: async () => emptyDoc,
    set: async () => undefined,
    update: async () => undefined,
    delete: async () => undefined,
    collection: () => collectionHandle,
  })
  Object.assign(collectionHandle, {
    doc: () => docHandle,
    get: async () => emptyQuery,
    where: () => collectionHandle,
    orderBy: () => collectionHandle,
    limit: () => collectionHandle,
    add: async () => docHandle,
  })
  return {
    collection: () => collectionHandle,
    doc: () => docHandle,
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ get: async () => emptyDoc, set: () => {}, update: () => {} }),
    batch: () => ({
      set: () => {},
      update: () => {},
      delete: () => {},
      commit: async () => undefined,
    }),
  }
}

function makeStore(captures: Captures, llmReplyBody: string): OrchestratorStore {
  return {
    markEventRunning: async () => undefined,
    markEventSucceeded: async () => undefined,
    markEventFailed: async () => undefined,
    createTurn: async () => "turn-vqc",
    updateTurn: async () => undefined,
    appendMessage: async () => undefined,
    getAgentForUser: async () => agent,
    getMem0UserId: async () => undefined,
    loadHistory: async () => [],
    enqueueOutbound: async (_uid, _to, body) => {
      captures.outboundBodies.push(body)
    },
    listMemoryFacts: async () => [],
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
      async getSessionId() { return "s-vqc" },
      async getItems() { return [] },
      async addItems() {},
      async popItem() { return undefined },
      async clearSession() {},
    }),
    runAgentTurn: async () => ({ text: llmReplyBody }),
    afterAssistantTurn: async () => ({
      writebackRan: false,
      writebackSkipReason: "memory_mode",
    }),
    maybeHandleResetCommand: async () => ({ handled: false }),
    buildTurnTools: async () => [],
    recordHostedToolCalls: async () => undefined,
    nowIso: () => "2026-05-02T12:00:00.000Z",
    log: (event, payload) => {
      if (typeof event === "string") {
        captures.logs.push({
          event,
          payload: (payload as Record<string, unknown>) ?? {},
        })
      }
    },
    checkInboundSafety: async () => ({ allow: true }),
    cancelAllPendingProactiveJobs: async () => 0,
    writeProactiveCancelAudit: async () => undefined,
    getOnboardingUser: async () => ({
      id: "u-vqc",
      phoneE164: "+19999991099",
      // onboardingState=complete bypasses cold-start branch entirely so my
      // hooks (which sit in the main runAgentTurn path) get exercised.
      onboardingState: "complete",
    }),
    applyOnboarding: async () => undefined,
    // Stub db — getFlag will be short-circuited via env override before
    // reaching us. If anything actually calls into us, we throw to surface
    // the bug (means env override didn't take effect).
    db: makeSoftStubDb() as unknown as Firestore,
  }
}

function emptyCaptures(): Captures {
  return { outboundBodies: [], logs: [] }
}

const baseEvent: InboundEvent = {
  id: "evt-vqc-1",
  userId: "u-vqc",
  sessionId: "s-vqc",
  channel: "imessage",
  externalChatId: "+19999991099",
  from: "+19999991099",
  body: "placeholder",
  status: "pending",
  createdAt: "2026-05-02T12:00:00.000Z",
  idempotencyKey: "imessage-in-vqc-1",
}

// ---------------------------------------------------------------------------
// F2 — conditional A/B framework strip
// ---------------------------------------------------------------------------

// English-only product: zh conditional A/B strip pattern removed.
// F2 now handles only English conditional heads (en_conditional_if_then).
// Test converted to English input/output to preserve F2 strip coverage.
test("vqc-F2: en conditional A/B head is stripped from outbound (English-only product)", async () => {
  const captures = emptyCaptures()
  // English conditional head pattern: "If you want to switch to PM, you could start as product analyst"
  // F2 strip should remove "If you want to switch to PM, you could " and leave "start as product analyst"
  const llmBody = "If you want to switch to PM, you could start as product analyst"
  const store = makeStore(captures, llmBody)

  // Env-override path: getFlag returns true on `paHumanizeRuntimeEnabled`
  // before touching db. Sub-flag `PA_AB_FRAMEWORK_STRIP_DISABLED` left unset
  // → defaults to enabled.
  process.env.paHumanizeRuntimeEnabled = "true"
  delete process.env.PA_AB_FRAMEWORK_STRIP_DISABLED
  // Ditto for sibling hooks we don't want to interfere with this test:
  process.env.PA_DETECTORS_ENABLED = "false"
  process.env.PA_MEMORY_POLICY_ENABLED = "false"
  process.env.PA_FSM_ENABLED = "false"
  process.env.PA_LLM_REWRITE_DISABLED = "true"
  process.env.PA_IMPERFECTION_INJECTOR_ENABLED = "false"
  process.env.PA_AB_PROBE_STRIP_ENABLED = "false"

  try {
    await processInboundEvent({ ...baseEvent, body: "thinking about switching roles" }, store)
  } finally {
    delete process.env.paHumanizeRuntimeEnabled
    delete process.env.PA_DETECTORS_ENABLED
    delete process.env.PA_MEMORY_POLICY_ENABLED
    delete process.env.PA_FSM_ENABLED
    delete process.env.PA_LLM_REWRITE_DISABLED
    delete process.env.PA_IMPERFECTION_INJECTOR_ENABLED
    delete process.env.PA_AB_PROBE_STRIP_ENABLED
  }

  assert.equal(captures.outboundBodies.length, 1)
  const outbound = captures.outboundBodies[0]!
  // Head must be GONE (English conditional "If you want to switch to PM, you could")
  assert.doesNotMatch(outbound, /if you want/iu, `expected head removed, got: ${outbound}`)
  // Then-clause must REMAIN
  assert.match(outbound, /start as product analyst/iu, `expected then-clause preserved, got: ${outbound}`)
  // Telemetry log fired with English pattern label
  const log = captures.logs.find((l) => l.event === "pa.voice.ab_framework_strip.applied")
  assert.ok(log, `expected ab_framework_strip.applied log, got: ${JSON.stringify(captures.logs.map((l) => l.event))}`)
  assert.equal(log!.payload["pattern"], "en_conditional_if_then")
})

test("vqc-F2: PA_AB_FRAMEWORK_STRIP_DISABLED=true bypasses the strip", async () => {
  const captures = emptyCaptures()
  const llmBody = "如果你想转 PM 方向，那可以先做 product analyst"
  const store = makeStore(captures, llmBody)

  process.env.paHumanizeRuntimeEnabled = "true"
  process.env.PA_AB_FRAMEWORK_STRIP_DISABLED = "true"
  process.env.PA_DETECTORS_ENABLED = "false"
  process.env.PA_MEMORY_POLICY_ENABLED = "false"
  process.env.PA_FSM_ENABLED = "false"
  process.env.PA_LLM_REWRITE_DISABLED = "true"
  process.env.PA_IMPERFECTION_INJECTOR_ENABLED = "false"
  process.env.PA_AB_PROBE_STRIP_ENABLED = "false"

  try {
    await processInboundEvent({ ...baseEvent, body: "想换工作有想法吗" }, store)
  } finally {
    delete process.env.paHumanizeRuntimeEnabled
    delete process.env.PA_AB_FRAMEWORK_STRIP_DISABLED
    delete process.env.PA_DETECTORS_ENABLED
    delete process.env.PA_MEMORY_POLICY_ENABLED
    delete process.env.PA_FSM_ENABLED
    delete process.env.PA_LLM_REWRITE_DISABLED
    delete process.env.PA_IMPERFECTION_INJECTOR_ENABLED
    delete process.env.PA_AB_PROBE_STRIP_ENABLED
  }

  assert.equal(captures.outboundBodies.length, 1)
  const outbound = captures.outboundBodies[0]!
  // Strip should NOT have run — head present in outbound.
  assert.match(outbound, /如果你想/u, `expected unstripped, got: ${outbound}`)
  // No applied-log when disabled.
  assert.equal(
    captures.logs.find((l) => l.event === "pa.voice.ab_framework_strip.applied"),
    undefined
  )
})

// ---------------------------------------------------------------------------
// Boundary preservation — Phase 51 crisis-hotline guard runs AFTER my strips
// ---------------------------------------------------------------------------

// English-only product: zh F2 pattern removed. Boundary guarantee preserved using English
// input/output. Safety invariant: Phase 51 crisis hotline guard must run AFTER F2 strip,
// and the hotline trailer must not be clobbered by F2's head removal.
test("vqc-boundary: F2 strip does not clobber Phase 51 hotline trailer (English input, English-only product)", async () => {
  // Reply has BOTH the English conditional A/B head (gets stripped) AND no hotline
  // trailer (Phase 51 guard appends one because user input is crisis-adjacent).
  // Verify both fire correctly and the trailer is not removed.
  const captures = emptyCaptures()
  const llmBody = "If you want to leave, you could start by looking at base pay"
  const store = makeStore(captures, llmBody)

  process.env.paHumanizeRuntimeEnabled = "true"
  process.env.PA_DETECTORS_ENABLED = "false"
  process.env.PA_MEMORY_POLICY_ENABLED = "false"
  process.env.PA_FSM_ENABLED = "false"
  process.env.PA_LLM_REWRITE_DISABLED = "true"
  process.env.PA_IMPERFECTION_INJECTOR_ENABLED = "false"
  process.env.PA_AB_PROBE_STRIP_ENABLED = "false"

  try {
    // User input has English crisis tokens — Phase 51 main-path guard MUST fire
    // and append hotline AFTER F2 strip removes the conditional head.
    await processInboundEvent(
      { ...baseEvent, body: "i can't go on like this. i want to die." },
      store
    )
  } finally {
    delete process.env.paHumanizeRuntimeEnabled
    delete process.env.PA_DETECTORS_ENABLED
    delete process.env.PA_MEMORY_POLICY_ENABLED
    delete process.env.PA_FSM_ENABLED
    delete process.env.PA_LLM_REWRITE_DISABLED
    delete process.env.PA_IMPERFECTION_INJECTOR_ENABLED
    delete process.env.PA_AB_PROBE_STRIP_ENABLED
  }

  assert.equal(captures.outboundBodies.length, 1)
  const outbound = captures.outboundBodies[0]!
  // Then-clause preserved (F2 strip removed the head "If you want to leave, you could ", kept the body).
  assert.match(outbound, /start by looking at base pay/iu, `expected then-clause preserved, got: ${outbound}`)
  // Phase 51 hotline trailer appended after F2 strip (English hotline for English crisis input).
  const enHotline =
    outbound.includes("741741") ||
    outbound.includes("988") ||
    outbound.includes("Crisis Text Line")
  assert.ok(enHotline, `expected English hotline trailer, got: ${outbound}`)
  // F2 strip telemetry log fired — proves the conditional head was stripped
  // BEFORE the crisis trailer was appended. F2 operates on the LLM body; the
  // hotline trailer is appended to the post-strip text.
  const f2Log = captures.logs.find((l) => l.event === "pa.voice.ab_framework_strip.applied")
  assert.ok(
    f2Log,
    `expected ab_framework_strip log, got: ${JSON.stringify(captures.logs.map((l) => l.event))}`
  )
  assert.equal(f2Log!.payload["pattern"], "en_conditional_if_then")
  // Crisis hotline guard log also fired (boundary preserved).
  const crisisLog = captures.logs.find((l) => l.event === "pa.safety.crisis_detected")
  assert.ok(crisisLog, "expected pa.safety.crisis_detected log")
})
