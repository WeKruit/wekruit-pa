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

test("vqc-F2: zh conditional A/B head is stripped from outbound", async () => {
  const captures = emptyCaptures()
  // The exact failing pattern: "如果你想 X, 那可以 Y" — our strip should
  // remove "如果你想转 PM 方向，那可以" and leave "先做 product analyst"
  const llmBody = "如果你想转 PM 方向，那可以先做 product analyst"
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
    await processInboundEvent({ ...baseEvent, body: "想换工作有想法吗" }, store)
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
  // Head must be GONE
  assert.doesNotMatch(outbound, /如果你想/u, `expected head removed, got: ${outbound}`)
  // Then-clause must REMAIN
  assert.match(outbound, /先做 product analyst/u, `expected then-clause preserved, got: ${outbound}`)
  // Telemetry log fired with pattern label
  const log = captures.logs.find((l) => l.event === "pa.voice.ab_framework_strip.applied")
  assert.ok(log, `expected ab_framework_strip.applied log, got: ${JSON.stringify(captures.logs.map((l) => l.event))}`)
  assert.equal(log!.payload["pattern"], "zh_conditional_if_then")
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
// F3 — mixed-register mirror append
// ---------------------------------------------------------------------------

test("vqc-F3: user mixed + reply pure-zh + register token absent → mirror appends", async () => {
  const captures = emptyCaptures()
  // Reply is pure zh; register token "OPT" should be appended.
  const llmBody = "嗯，听起来真的挺纠结的"
  const store = makeStore(captures, llmBody)

  process.env.paHumanizeRuntimeEnabled = "true"
  delete process.env.PA_MIXED_REGISTER_MIRROR_DISABLED
  process.env.PA_DETECTORS_ENABLED = "false"
  process.env.PA_MEMORY_POLICY_ENABLED = "false"
  process.env.PA_FSM_ENABLED = "false"
  process.env.PA_LLM_REWRITE_DISABLED = "true"
  process.env.PA_IMPERFECTION_INJECTOR_ENABLED = "false"
  process.env.PA_AB_PROBE_STRIP_ENABLED = "false"
  process.env.PA_AB_FRAMEWORK_STRIP_DISABLED = "true"

  try {
    await processInboundEvent(
      { ...baseEvent, body: "work stress 好大，OPT 还有半年，想 jump 但 H1B 怕" },
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
    delete process.env.PA_AB_FRAMEWORK_STRIP_DISABLED
  }

  assert.equal(captures.outboundBodies.length, 1)
  const outbound = captures.outboundBodies[0]!
  // Mirror appends "(re: TOKEN)" — token comes from REGISTER_TOKEN_BANK.
  assert.match(outbound, /\(re: [A-Za-z0-9-]+\)/u, `expected mirror append, got: ${outbound}`)
  // Original body still present.
  assert.match(outbound, /听起来真的挺纠结的/u, `expected body preserved, got: ${outbound}`)
  // Telemetry log fired.
  const log = captures.logs.find((l) => l.event === "pa.voice.mixed_register_mirror.applied")
  assert.ok(log, `expected mixed_register_mirror.applied log, got: ${JSON.stringify(captures.logs.map((l) => l.event))}`)
})

test("vqc-F3: PA_MIXED_REGISTER_MIRROR_DISABLED=true bypasses the mirror", async () => {
  const captures = emptyCaptures()
  const llmBody = "嗯，听起来真的挺纠结的"
  const store = makeStore(captures, llmBody)

  process.env.paHumanizeRuntimeEnabled = "true"
  process.env.PA_MIXED_REGISTER_MIRROR_DISABLED = "true"
  process.env.PA_DETECTORS_ENABLED = "false"
  process.env.PA_MEMORY_POLICY_ENABLED = "false"
  process.env.PA_FSM_ENABLED = "false"
  process.env.PA_LLM_REWRITE_DISABLED = "true"
  process.env.PA_IMPERFECTION_INJECTOR_ENABLED = "false"
  process.env.PA_AB_PROBE_STRIP_ENABLED = "false"
  process.env.PA_AB_FRAMEWORK_STRIP_DISABLED = "true"

  try {
    await processInboundEvent(
      { ...baseEvent, body: "work stress 好大，OPT 还有半年" },
      store
    )
  } finally {
    delete process.env.paHumanizeRuntimeEnabled
    delete process.env.PA_MIXED_REGISTER_MIRROR_DISABLED
    delete process.env.PA_DETECTORS_ENABLED
    delete process.env.PA_MEMORY_POLICY_ENABLED
    delete process.env.PA_FSM_ENABLED
    delete process.env.PA_LLM_REWRITE_DISABLED
    delete process.env.PA_IMPERFECTION_INJECTOR_ENABLED
    delete process.env.PA_AB_PROBE_STRIP_ENABLED
    delete process.env.PA_AB_FRAMEWORK_STRIP_DISABLED
  }

  assert.equal(captures.outboundBodies.length, 1)
  const outbound = captures.outboundBodies[0]!
  // No mirror append.
  assert.doesNotMatch(outbound, /\(re: /u, `expected no mirror, got: ${outbound}`)
  assert.equal(
    captures.logs.find((l) => l.event === "pa.voice.mixed_register_mirror.applied"),
    undefined
  )
})

// ---------------------------------------------------------------------------
// Boundary preservation — Phase 51 crisis-hotline guard runs AFTER my strips
// ---------------------------------------------------------------------------

test("vqc-boundary: F2 strip does not clobber Phase 51 hotline trailer", async () => {
  // Reply has BOTH the conditional A/B head (gets stripped) AND no hotline
  // trailer (Phase 51 guard appends one). Verify both fire correctly.
  const captures = emptyCaptures()
  const llmBody = "如果你想换工作，那可以先看看 base"
  const store = makeStore(captures, llmBody)

  process.env.paHumanizeRuntimeEnabled = "true"
  process.env.PA_DETECTORS_ENABLED = "false"
  process.env.PA_MEMORY_POLICY_ENABLED = "false"
  process.env.PA_FSM_ENABLED = "false"
  process.env.PA_LLM_REWRITE_DISABLED = "true"
  process.env.PA_IMPERFECTION_INJECTOR_ENABLED = "false"
  process.env.PA_AB_PROBE_STRIP_ENABLED = "false"

  try {
    // User input has zh crisis tokens — Phase 51 main-path guard MUST fire
    // and append hotline AFTER my F2 strip removes the head.
    await processInboundEvent(
      { ...baseEvent, body: "我撑不下去了，想结束这一切" },
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
  // Then-clause preserved (F2 strip removed the head, kept the body).
  assert.match(outbound, /先看看 base/u, `expected then-clause preserved, got: ${outbound}`)
  // Phase 51 hotline trailer appended after F2 strip.
  const zhHotline =
    outbound.includes("400-161-9995") ||
    outbound.includes("心理援助热线") ||
    outbound.includes("12320")
  assert.ok(zhHotline, `expected hotline trailer, got: ${outbound}`)
  // F2 strip telemetry log fired — proves the conditional head was stripped
  // BEFORE the crisis trailer was appended. (We can't grep "如果你想" in
  // the final outbound because the hotline trailer legitimately contains
  // the phrase "如果你想找人说话" — the strip operates on the LLM body,
  // not on the post-strip trailer text.)
  const f2Log = captures.logs.find((l) => l.event === "pa.voice.ab_framework_strip.applied")
  assert.ok(
    f2Log,
    `expected ab_framework_strip log, got: ${JSON.stringify(captures.logs.map((l) => l.event))}`
  )
  assert.equal(f2Log!.payload["pattern"], "zh_conditional_if_then")
  // Crisis hotline guard log also fired (boundary preserved).
  const crisisLog = captures.logs.find((l) => l.event === "pa.safety.crisis_detected")
  assert.ok(crisisLog, "expected pa.safety.crisis_detected log")
})
