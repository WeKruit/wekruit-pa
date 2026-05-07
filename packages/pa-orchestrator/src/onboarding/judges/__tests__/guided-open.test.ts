/**
 * GuidedOpenJudge unit tests — LLM stubbed via spec.llmCallFactory seam.
 *
 * Coverage matrix (per P7-2 task DOD):
 *   1. bloom hit → skip LLM (mock called 0 times)
 *   2. LLM "provided" + high conf → accept
 *   3. LLM "provided" + low conf → unclear
 *   4. LLM "unclear" → reason="unclear" with clarifyingQuestion
 *   5. LLM error (throw) → graceful reason="irrelevant"
 *   6. LLM "declined" → reason="declined"
 *   7. Adam pain point: "sfran or nYC works" + location hints → mock returns
 *      ["sf","nyc"] → accept=true with parsed array
 *   8. Noise/empty/__PA_RESET__ → irrelevant without LLM call
 *   9. parseValue returns null when value malformed → reason="unclear"
 *  10. Bloom bad config (parseValue rejects bloom value) → falls through to LLM
 *  11. Multi-bloom: first miss, second hit → still skips LLM
 *  12. Confidence threshold override
 */
import test from "node:test"
import assert from "node:assert/strict"

import { GuidedOpenJudge, type LlmCallFn } from "../guided-open.js"
import type { JudgeCtx } from "../../question.js"

// ── Test helpers ─────────────────────────────────────────────────────────
function makeCtx(): JudgeCtx & { events: Array<{ ev: string; payload: unknown }> } {
  const events: Array<{ ev: string; payload: unknown }> = []
  return {
    userId: "u-test",
    turnId: "t-test",
    log: (ev, payload) => events.push({ ev, payload }),
    events,
  }
}

interface StubResult {
  raw?: string
  throws?: Error
}
function makeStubLlm(result: StubResult): { fn: LlmCallFn; calls: number } {
  let calls = 0
  const fn: LlmCallFn = async () => {
    calls++
    if (result.throws) throw result.throws
    return result.raw ?? ""
  }
  return {
    fn,
    get calls() {
      return calls
    },
  } as { fn: LlmCallFn; calls: number }
}

// Cast helper to avoid deep ts intersection ambiguity around getter-only `calls`.
function callsOf(stub: { calls: number }): number {
  return stub.calls
}

// ── Test 1: bloom hit skips LLM ──────────────────────────────────────────
test("guided-open: bloom hit short-circuits LLM call", async () => {
  const stub = makeStubLlm({ raw: '{"intent":"provided","value":"never","confidence":0.99}' })
  const judge = new GuidedOpenJudge<string>({
    questionLabel: "yes/no test",
    hints: ["yes", "no"],
    examples: [{ reply: "yes", value: "yes" }],
    bloomRegex: [{ pattern: /^yes$/i, value: "yes" }],
    parseValue: (v) => (typeof v === "string" ? v : null),
    llmCallFactory: () => stub.fn,
  })
  const result = await judge.judge("yes", "en", makeCtx())
  assert.equal(callsOf(stub), 0, "LLM must not be called on bloom hit")
  assert.equal(result.accept, true)
  if (result.accept) assert.equal(result.value, "yes")
})

// ── Test 2: LLM provided + high conf → accept ────────────────────────────
test("guided-open: LLM provided high confidence → accept", async () => {
  const stub = makeStubLlm({
    raw: '{"intent":"provided","value":"swe","confidence":0.92}',
  })
  const judge = new GuidedOpenJudge<string>({
    questionLabel: "target role",
    hints: ["swe", "pm"],
    examples: [{ reply: "engineer", value: "swe" }],
    parseValue: (v) => (typeof v === "string" ? v : null),
    llmCallFactory: () => stub.fn,
  })
  const result = await judge.judge("software engineer at startup", "en", makeCtx())
  assert.equal(callsOf(stub), 1)
  assert.equal(result.accept, true)
  if (result.accept) {
    assert.equal(result.value, "swe")
    assert.equal(result.confidence, 0.92)
  }
})

// ── Test 3: LLM provided low conf → unclear ──────────────────────────────
test("guided-open: LLM provided low confidence → unclear", async () => {
  const stub = makeStubLlm({
    raw: '{"intent":"provided","value":"maybe","confidence":0.4}',
  })
  const judge = new GuidedOpenJudge<string>({
    questionLabel: "target role",
    hints: ["swe"],
    examples: [],
    parseValue: (v) => (typeof v === "string" ? v : null),
    llmCallFactory: () => stub.fn,
  })
  const result = await judge.judge("um something", "en", makeCtx())
  assert.equal(result.accept, false)
  if (!result.accept) assert.equal(result.reason, "unclear")
})

// ── Test 4: LLM unclear with clarifyingQuestion ──────────────────────────
test("guided-open: LLM unclear surfaces clarifyingQuestion", async () => {
  const stub = makeStubLlm({
    raw: '{"intent":"unclear","clarifyingQuestion":"What city are you in?"}',
  })
  const judge = new GuidedOpenJudge<string>({
    questionLabel: "target work location",
    hints: ["sf", "nyc"],
    examples: [],
    parseValue: (v) => (typeof v === "string" ? v : null),
    llmCallFactory: () => stub.fn,
  })
  const result = await judge.judge("看机会吧", "en", makeCtx())
  assert.equal(result.accept, false)
  if (!result.accept) {
    assert.equal(result.reason, "unclear")
    assert.equal(result.clarifyingQuestion, "What city are you in?")
  }
})

// ── Test 5: LLM throws → graceful irrelevant ─────────────────────────────
test("guided-open: LLM throw → graceful reason=irrelevant", async () => {
  const stub = makeStubLlm({ throws: new Error("network timeout") })
  const judge = new GuidedOpenJudge<string>({
    questionLabel: "target role",
    hints: [],
    examples: [],
    parseValue: (v) => (typeof v === "string" ? v : null),
    llmCallFactory: () => stub.fn,
  })
  const ctx = makeCtx()
  const result = await judge.judge("engineer", "en", ctx)
  assert.equal(result.accept, false)
  if (!result.accept) assert.equal(result.reason, "irrelevant")
  // ensure error event logged
  const errEv = ctx.events.find((e) => e.ev === "pa.onboarding.judge.guided_open.error")
  assert.ok(errEv, "error event must be logged on LLM throw")
})

// ── Test 6: LLM declined ─────────────────────────────────────────────────
test("guided-open: LLM declined → reason=declined", async () => {
  const stub = makeStubLlm({ raw: '{"intent":"declined"}' })
  const judge = new GuidedOpenJudge<string>({
    questionLabel: "tos",
    hints: [],
    examples: [],
    parseValue: (v) => (typeof v === "string" ? v : null),
    llmCallFactory: () => stub.fn,
  })
  const result = await judge.judge("no thanks", "en", makeCtx())
  assert.equal(result.accept, false)
  if (!result.accept) assert.equal(result.reason, "declined")
})

// ── Test 7: Adam pain point — "sfran or nYC works" → ["sf","nyc"] ────────
test("guided-open: pain point 'sfran or nYC works' → multi-city accept", async () => {
  const stub = makeStubLlm({
    raw: '{"intent":"provided","value":["sf","nyc"],"confidence":0.85}',
  })
  type LocAnswer = string[]
  const judge = new GuidedOpenJudge<LocAnswer>({
    questionLabel: "target work location",
    hints: ["sf", "nyc", "bay area", "remote", "boston", "seattle", "la"],
    examples: [
      { reply: "Bay Area", value: ["sf"] },
      { reply: "NYC or remote", value: ["nyc", "remote"] },
    ],
    bloomRegex: [
      // Strict word-boundary patterns — typo'd "sfran" must miss bloom and
      // hit the LLM.
      { pattern: /^\s*sf\s*$/i, value: ["sf"] },
      { pattern: /^\s*nyc\s*$/i, value: ["nyc"] },
    ],
    parseValue: (v) => {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[]
      if (typeof v === "string") return [v]
      return null
    },
    llmCallFactory: () => stub.fn,
  })
  const result = await judge.judge("sfran or nYC works", "en", makeCtx())
  assert.equal(callsOf(stub), 1, "typo bypasses bloom → must call LLM")
  assert.equal(result.accept, true)
  if (result.accept) {
    assert.deepEqual(result.value, ["sf", "nyc"])
    assert.equal(result.confidence, 0.85)
  }
})

// ── Test 8: Noise/empty/__PA_RESET__ → irrelevant without LLM ────────────
test("guided-open: empty reply → irrelevant, no LLM", async () => {
  const stub = makeStubLlm({ raw: '{"intent":"provided","value":"x","confidence":0.99}' })
  const judge = new GuidedOpenJudge<string>({
    questionLabel: "x",
    hints: [],
    examples: [],
    parseValue: (v) => (typeof v === "string" ? v : null),
    llmCallFactory: () => stub.fn,
  })
  for (const reply of ["", "   ", "...", "!!!", "__PA_RESET__"]) {
    const r = await judge.judge(reply, "en", makeCtx())
    assert.equal(r.accept, false, `reply=${JSON.stringify(reply)} must be rejected`)
    if (!r.accept) assert.equal(r.reason, "irrelevant")
  }
  assert.equal(callsOf(stub), 0, "noise replies must never call LLM")
})

// ── Test 9: parseValue null on malformed value → unclear ─────────────────
test("guided-open: parseValue rejects malformed value → unclear", async () => {
  const stub = makeStubLlm({
    // LLM returned a number where we expected a string — parseValue returns null.
    raw: '{"intent":"provided","value":42,"confidence":0.95}',
  })
  const judge = new GuidedOpenJudge<string>({
    questionLabel: "x",
    hints: [],
    examples: [],
    parseValue: (v) => (typeof v === "string" ? v : null),
    llmCallFactory: () => stub.fn,
  })
  const result = await judge.judge("answer", "en", makeCtx())
  assert.equal(result.accept, false)
  if (!result.accept) assert.equal(result.reason, "unclear")
})

// ── Test 10: bloom mismatch (parseValue rejects bloom value) → falls to LLM
test("guided-open: bloom matches but parseValue null → fall through to LLM", async () => {
  const stub = makeStubLlm({
    raw: '{"intent":"provided","value":"good","confidence":0.9}',
  })
  const judge = new GuidedOpenJudge<string>({
    questionLabel: "x",
    hints: [],
    examples: [],
    bloomRegex: [
      // Bloom returns null-typed value (config bug surface) — must not block.
      { pattern: /^x$/i, value: null as unknown as string },
    ],
    parseValue: (v) => (typeof v === "string" ? v : null),
    llmCallFactory: () => stub.fn,
  })
  const result = await judge.judge("x", "en", makeCtx())
  assert.equal(callsOf(stub), 1, "bad bloom value must fall through to LLM")
  assert.equal(result.accept, true)
  if (result.accept) assert.equal(result.value, "good")
})

// ── Test 11: multiple blooms — second hit wins ───────────────────────────
test("guided-open: multi-bloom — second pattern matches → still skip LLM", async () => {
  const stub = makeStubLlm({ raw: "" })
  const judge = new GuidedOpenJudge<string>({
    questionLabel: "x",
    hints: [],
    examples: [],
    bloomRegex: [
      { pattern: /^aaa$/i, value: "aaa" },
      { pattern: /^bbb$/i, value: "bbb" },
    ],
    parseValue: (v) => (typeof v === "string" ? v : null),
    llmCallFactory: () => stub.fn,
  })
  const result = await judge.judge("bbb", "en", makeCtx())
  assert.equal(callsOf(stub), 0)
  assert.equal(result.accept, true)
  if (result.accept) assert.equal(result.value, "bbb")
})

// ── Test 12: confidence threshold override ───────────────────────────────
test("guided-open: confidenceThreshold override accepts mid-confidence", async () => {
  const stub = makeStubLlm({
    raw: '{"intent":"provided","value":"swe","confidence":0.4}',
  })
  const judge = new GuidedOpenJudge<string>({
    questionLabel: "role",
    hints: [],
    examples: [],
    parseValue: (v) => (typeof v === "string" ? v : null),
    confidenceThreshold: 0.3,
    llmCallFactory: () => stub.fn,
  })
  const result = await judge.judge("engineer", "en", makeCtx())
  assert.equal(result.accept, true)
  if (result.accept) assert.equal(result.value, "swe")
})

// ── Test 13: bad JSON from LLM → irrelevant ─────────────────────────────
test("guided-open: malformed JSON output → irrelevant", async () => {
  const stub = makeStubLlm({ raw: "this is not json {{" })
  const judge = new GuidedOpenJudge<string>({
    questionLabel: "x",
    hints: [],
    examples: [],
    parseValue: (v) => (typeof v === "string" ? v : null),
    llmCallFactory: () => stub.fn,
  })
  const result = await judge.judge("anything", "en", makeCtx())
  assert.equal(result.accept, false)
  if (!result.accept) assert.equal(result.reason, "irrelevant")
})

// ── Test 14: kind property ──────────────────────────────────────────────
test("guided-open: kind is 'guided-open'", () => {
  const judge = new GuidedOpenJudge<string>({
    questionLabel: "x",
    hints: [],
    examples: [],
    parseValue: (v) => (typeof v === "string" ? v : null),
    llmCallFactory: () => async () => "",
  })
  assert.equal(judge.kind, "guided-open")
})
