import { test } from "node:test"
import assert from "node:assert/strict"

import { createLedger } from "./cost-ledger.mjs"
import {
  CLAIRE_STACK_ARM,
  createClaireStackAdapter,
  stripVerbMirrorEcho,
  stripLengthCap,
  buildDiversityRerollMessages,
} from "./claire-stack-adapter.mjs"

/**
 * @param {{
 *   text?: string,
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   responses?: Array<{ text: string, inputTokens?: number, outputTokens?: number }>
 * }} [opts]
 */
function makeMockChat(opts = {}) {
  const text = opts.text ?? "draft reply"
  const inputTokens = opts.inputTokens ?? 100
  const outputTokens = opts.outputTokens ?? 50
  const responses = opts.responses ?? []
  let n = 0
  /** @type {any} */
  const fn = async ({ messages, opts: chatOpts }) => {
    void messages
    const r = responses[n] || { text, inputTokens, outputTokens }
    n += 1
    return {
      text: r.text,
      usage: {
        inputTokens: r.inputTokens ?? inputTokens,
        outputTokens: r.outputTokens ?? outputTokens,
      },
      model: (chatOpts && chatOpts.model) || "Qwen/Qwen2.5-7B-Instruct",
    }
  }
  fn.callCount = () => n
  return fn
}

/**
 * @param {{
 *   detectorTriggered?: string[],
 *   injectorApplied?: boolean,
 *   uxState?: string,
 *   preferredNext?: string,
 *   repeatTriggered?: boolean,
 * }} [opts]
 */
function makeMockDeps(opts = {}) {
  const detectorTriggered = opts.detectorTriggered ?? []
  const injectorApplied = opts.injectorApplied ?? false
  const uxState = opts.uxState ?? "WarmCurious"
  const preferredNext = opts.preferredNext ?? "Question"
  const repeatTriggered = opts.repeatTriggered ?? false
  /** @type {any} */
  const runAllDetectors = async () => {
    return [
      { id: "f1_verb_mirror", triggered: detectorTriggered.includes("f1"), score: 0.5, reason: "test", suggested_action: detectorTriggered.includes("f1") ? "strip" : null, latencyMs: 1 },
      { id: "f2_length_cap", triggered: detectorTriggered.includes("f2"), score: 4, reason: "test", suggested_action: detectorTriggered.includes("f2") ? "strip" : null, latencyMs: 1 },
      { id: "f3_lang_lock", triggered: detectorTriggered.includes("f3"), score: 0.0, reason: "test", suggested_action: detectorTriggered.includes("f3") ? "regenerate" : null, latencyMs: 1 },
      { id: "f4_advice_repeat", triggered: detectorTriggered.includes("f4"), score: 0.5, reason: "test", suggested_action: detectorTriggered.includes("f4") ? "reject_resample" : null, latencyMs: 1 },
    ]
  }
  /** @type {any} */
  const injectImperfection = (ctx) => ({
    arm: "off",
    original: ctx.text,
    injected: ctx.text,
    applied: injectorApplied,
    injection_type: null,
    position: "none",
    reason: "test",
    latencyMs: 0,
  })
  /** @type {any} */
  const runFsm = () => ({
    uxState,
    uxStateConfidence: 1.0,
    stage: "Exploration",
    stageIndex: 0,
    allowedStrategies: ["Question", "Restatement"],
    preferredNext,
    directive: "test directive",
    latencyMs: 0,
    signals: {},
  })
  /** @type {any} */
  const runMemoryPolicy = async () => ({
    advice: {
      recent: [],
      repeatScore: { triggered: repeatTriggered, maxSim: repeatTriggered ? 0.9 : 0.1, mostSimilarIdx: -1, sims: [], threshold: 0.85, reason: "test", latencyMs: 0 },
      injection: "",
    },
    contradiction: { violated: false, type: null, violatedTerm: null, factSnippet: null, replySnippet: null, confidence: 0, latencyMs: 0 },
    latencyMs: 0,
  })
  return { runAllDetectors, injectImperfection, runFsm, runMemoryPolicy }
}

test("createClaireStackAdapter: throws without ledger", () => {
  assert.throws(
    () => createClaireStackAdapter(/** @type {any} */ ({})),
    /ledger required/i
  )
})

test("chat returns text + usage + meta with claire-stack arm", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const chatImpl = makeMockChat({ text: "hi", inputTokens: 100, outputTokens: 50 })
  const adapter = createClaireStackAdapter({
    ledger,
    chatImpl,
    deps: makeMockDeps(),
  })

  const result = await adapter.chat({
    messages: [{ role: "user", content: "hi there" }],
    opts: { benchmark: "botchat", userLang: "en" },
  })

  assert.equal(result.text, "hi")
  assert.equal(result.meta.arm, CLAIRE_STACK_ARM)
  assert.deepEqual(result.meta.pipeline, ["draft", "detector", "injector", "fsm", "memory"])
  assert.equal(result.meta.repeatTriggered, false)
  assert.equal(result.meta.reroll, false)
})

test("pipeline runs in order: draft → detector → injector → fsm → memory", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  /** @type {string[]} */
  const order = []
  /** @type {any} */
  const chatImpl = async ({ opts }) => {
    order.push("draft")
    return { text: "draft", usage: { inputTokens: 100, outputTokens: 50 }, model: opts.model }
  }
  const baseDeps = makeMockDeps()
  /** @type {any} */
  const deps = {
    runAllDetectors: async (...args) => {
      order.push("detector")
      return baseDeps.runAllDetectors(...args)
    },
    injectImperfection: (...args) => {
      order.push("injector")
      return baseDeps.injectImperfection(...args)
    },
    runFsm: (...args) => {
      order.push("fsm")
      return baseDeps.runFsm(...args)
    },
    runMemoryPolicy: async (...args) => {
      order.push("memory")
      return baseDeps.runMemoryPolicy(...args)
    },
  }
  const adapter = createClaireStackAdapter({ ledger, chatImpl, deps })
  await adapter.chat({
    messages: [{ role: "user", content: "x" }],
    opts: { userId: "u1" },
  })
  assert.deepEqual(order, ["draft", "detector", "injector", "fsm", "memory"])
})

test("F1 verb-mirror trigger applies strip on output", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  // Output that mirrors user input
  const chatImpl = makeMockChat({ text: "我要走了。是的我也累了。", inputTokens: 100, outputTokens: 50 })
  const adapter = createClaireStackAdapter({
    ledger,
    chatImpl,
    deps: makeMockDeps({ detectorTriggered: ["f1"] }),
  })
  const result = await adapter.chat({
    messages: [{ role: "user", content: "我要走了" }],
    opts: { userLang: "zh" },
  })
  assert.ok(result.meta.detectorTriggered.includes("f1_verb_mirror"))
  // F1 strip removed mirror sentence (first one matched user)
  assert.notEqual(result.text, "我要走了。是的我也累了。")
})

test("F2 length cap trigger truncates to 3 sentences", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const longReply = "First. Second. Third. Fourth. Fifth."
  const chatImpl = makeMockChat({ text: longReply })
  const adapter = createClaireStackAdapter({
    ledger,
    chatImpl,
    deps: makeMockDeps({ detectorTriggered: ["f2"] }),
  })
  const result = await adapter.chat({
    messages: [{ role: "user", content: "hi" }],
    opts: { userLang: "en" },
  })
  assert.ok(result.meta.detectorTriggered.includes("f2_length_cap"))
  // After strip — only 3 sentences remain
  const sentenceCount = result.text.split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length
  assert.ok(sentenceCount <= 3, `expected ≤3 sentences, got ${sentenceCount}: ${result.text}`)
})

test("F4 advice-repeat trigger causes single re-roll (chat called twice)", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const chatImpl = makeMockChat({
    responses: [
      { text: "first reply", inputTokens: 100, outputTokens: 50 },
      { text: "diverse reply", inputTokens: 110, outputTokens: 60 },
    ],
  })
  const adapter = createClaireStackAdapter({
    ledger,
    chatImpl,
    deps: makeMockDeps({ detectorTriggered: ["f4"] }),
  })
  const result = await adapter.chat({
    messages: [{ role: "user", content: "hi" }],
    opts: { userLang: "en" },
  })
  assert.equal(chatImpl.callCount(), 2, "expected re-roll = 2 chat calls")
  assert.equal(result.meta.reroll, true)
  // 2nd reply text wins
  assert.equal(result.text, "diverse reply")
  // Ledger charged twice
  assert.equal(ledger.callCount, 2)
})

test("F4 + F3 second re-roll NOT attempted (max 1)", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const chatImpl = makeMockChat({
    responses: [
      { text: "first", inputTokens: 100, outputTokens: 50 },
      { text: "second", inputTokens: 100, outputTokens: 50 },
    ],
  })
  // memory always says triggered AND f4 triggered → still only 2 chat calls
  const adapter = createClaireStackAdapter({
    ledger,
    chatImpl,
    deps: makeMockDeps({ detectorTriggered: ["f4"], repeatTriggered: true }),
  })
  const result = await adapter.chat({
    messages: [{ role: "user", content: "hi" }],
    opts: { userId: "u1" },
  })
  assert.equal(chatImpl.callCount(), 2)
  assert.equal(result.meta.reroll, true)
})

test("memory repeatTriggered without detector trigger still causes re-roll", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const chatImpl = makeMockChat({
    responses: [
      { text: "first", inputTokens: 100, outputTokens: 50 },
      { text: "diverse", inputTokens: 100, outputTokens: 50 },
    ],
  })
  const adapter = createClaireStackAdapter({
    ledger,
    chatImpl,
    deps: makeMockDeps({ detectorTriggered: [], repeatTriggered: true }),
  })
  const result = await adapter.chat({
    messages: [{ role: "user", content: "hi" }],
    opts: { userId: "u1" },
  })
  assert.equal(chatImpl.callCount(), 2)
  assert.equal(result.meta.repeatTriggered, true)
})

test("no triggers → chat called once, no re-roll", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const chatImpl = makeMockChat()
  const adapter = createClaireStackAdapter({
    ledger,
    chatImpl,
    deps: makeMockDeps(),
  })
  await adapter.chat({
    messages: [{ role: "user", content: "hi" }],
    opts: { userId: "u1" },
  })
  assert.equal(chatImpl.callCount(), 1)
  assert.equal(ledger.callCount, 1)
})

test("ledger charged for both draft + re-roll calls", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const chatImpl = makeMockChat({
    responses: [
      { text: "first", inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { text: "second", inputTokens: 1_000_000, outputTokens: 1_000_000 },
    ],
  })
  const adapter = createClaireStackAdapter({
    ledger,
    chatImpl,
    deps: makeMockDeps({ detectorTriggered: ["f4"] }),
  })
  const result = await adapter.chat({
    messages: [{ role: "user", content: "hi" }],
  })
  assert.equal(result.usage.inputTokens, 2_000_000)
  assert.equal(result.usage.outputTokens, 2_000_000)
  // 2 charges of $0.21 = $0.42
  assert.ok(Math.abs(result.usage.costUSD - 0.42) < 1e-9)
  assert.ok(Math.abs(ledger.totalUsd - 0.42) < 1e-9)
})

test("meta.uxState + meta.strategy populated from FSM result", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const chatImpl = makeMockChat()
  const adapter = createClaireStackAdapter({
    ledger,
    chatImpl,
    deps: makeMockDeps({ uxState: "SoftConcerned", preferredNext: "Reflection" }),
  })
  const result = await adapter.chat({
    messages: [{ role: "user", content: "hi" }],
  })
  assert.equal(result.meta.uxState, "SoftConcerned")
  assert.equal(result.meta.strategy, "Reflection")
})

test("stripVerbMirrorEcho: drops mirror sentence", () => {
  const out = stripVerbMirrorEcho("我要走了。我也累了。", "我要走了")
  assert.notEqual(out, "我要走了。我也累了。")
  assert.ok(!out.includes("我要走了"))
})

test("stripVerbMirrorEcho: fail-open when no input", () => {
  assert.equal(stripVerbMirrorEcho("", "x"), "")
  assert.equal(stripVerbMirrorEcho("text", ""), "text")
})

test("stripLengthCap: truncates to N sentences", () => {
  const out = stripLengthCap("a. b. c. d. e.", 3)
  const count = out.split(/(?<=[.])\s+/).filter((s) => s.trim()).length
  assert.equal(count, 3)
})

test("stripLengthCap: under cap → no change", () => {
  const out = stripLengthCap("a. b.", 3)
  assert.equal(out, "a. b.")
})

test("buildDiversityRerollMessages prepends nudge with prior replies", () => {
  const orig = [{ role: "user", content: "hi" }]
  const out = buildDiversityRerollMessages(/** @type {any} */ (orig), ["prior 1", "prior 2"])
  assert.equal(out.length, 2)
  assert.equal(out[0].role, "system")
  assert.match(out[0].content, /prior 1/)
})

test("buildDiversityRerollMessages no priors → unchanged", () => {
  const orig = [{ role: "user", content: "hi" }]
  const out = buildDiversityRerollMessages(/** @type {any} */ (orig), [])
  assert.equal(out.length, 1)
  assert.equal(out, orig)
})

test("graceful degrade when userId not provided: skip memory-policy", async () => {
  const ledger = createLedger({ maxBudgetUsd: 25 })
  const chatImpl = makeMockChat()
  const baseDeps = makeMockDeps()
  let memCalled = 0
  /** @type {any} */
  const deps = {
    ...baseDeps,
    runMemoryPolicy: async (...args) => {
      memCalled += 1
      return baseDeps.runMemoryPolicy(...args)
    },
  }
  const adapter = createClaireStackAdapter({ ledger, chatImpl, deps })
  await adapter.chat({
    messages: [{ role: "user", content: "hi" }],
    opts: {}, // no userId
  })
  assert.equal(memCalled, 0)
})
