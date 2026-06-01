/**
 * Layer 1 unit tests — q_country (V2 GuidedOpenJudge).
 *
 * Mirrors Q_COUNTRY's spec (hints, bloom, parseValue) but with stubbed
 * LLM. Tests bloom hits + LLM fallback for multi-country / typo / nuanced.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { GuidedOpenJudge, type LlmCallFn } from "../judges/guided-open.js"
import type { JudgeCtx } from "../question.js"
import type { CountryAnswer } from "../questions.js"

function ctx(): JudgeCtx {
  return { userId: "u", turnId: "t" }
}

const COUNTRY_HINTS = ["usa", "china", "canada", "europe", "anywhere"] as const

const COUNTRY_BLOOM = [
  { pattern: /^\s*(usa|us|america)\s*$/i, value: ["usa"] as CountryAnswer },
  { pattern: /^\s*(china|prc)\s*$/i, value: ["china"] as CountryAnswer },
  { pattern: /^\s*(canada)\s*$/i, value: ["canada"] as CountryAnswer },
  { pattern: /^\s*(europe)\s*$/i, value: ["europe"] as CountryAnswer },
  { pattern: /^\s*(anywhere)\s*$/i, value: ["anywhere"] as CountryAnswer },
]

function parseCountry(raw: unknown): CountryAnswer | null {
  if (typeof raw === "string") {
    const t = raw.trim().toLowerCase()
    if (/^(usa|us|america)$/.test(t)) return ["usa"]
    if (/^(china|prc)$/.test(t)) return ["china"]
    if (/^(canada)$/.test(t)) return ["canada"]
    if (/^(europe)$/.test(t)) return ["europe"]
    if (/^(anywhere)$/.test(t)) return ["anywhere"]
    return t ? [t] : null
  }
  if (Array.isArray(raw)) {
    const items = raw
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length > 0)
    if (items.length === 0) return null
    return items
  }
  return null
}

function makeJudge(rawJson: string): { J: GuidedOpenJudge<CountryAnswer>; calls: () => number } {
  let calls = 0
  const fn: LlmCallFn = async () => {
    calls++
    return rawJson
  }
  const J = new GuidedOpenJudge<CountryAnswer>({
    questionLabel: "target country / region",
    hints: COUNTRY_HINTS,
    examples: [],
    bloomRegex: COUNTRY_BLOOM,
    parseValue: parseCountry,
    llmCallFactory: () => fn,
  })
  return { J, calls: () => calls }
}

test("q-country: 'USA' → bloom hit usa", async () => {
  const { J, calls } = makeJudge("")
  const r = await J.judge("USA", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["usa"])
  assert.equal(calls(), 0)
})

test("q-country: 'usa' → bloom hit usa", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("usa", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["usa"])
})

test("q-country: 'china' → bloom hit china", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("china", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["china"])
})

test("q-country: 'China' → bloom hit china", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("China", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["china"])
})

test("q-country: 'anywhere' → bloom hit anywhere", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("anywhere", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["anywhere"])
})

test("q-country: 'anywhere' → bloom hit anywhere", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("anywhere", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["anywhere"])
})

test("q-country: 'anywhere (2)' → bloom hit anywhere", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("anywhere", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["anywhere"])
})

test("q-country: 'Canada' → bloom hit canada", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("Canada", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["canada"])
})

test("q-country: multi-country 'either USA or China' → LLM array", async () => {
  const { J, calls } = makeJudge(
    JSON.stringify({ intent: "provided", value: ["usa", "china"], confidence: 0.9 })
  )
  const r = await J.judge("either USA or China", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["usa", "china"])
  assert.equal(calls(), 1)
})

test("q-country: 'in north america' → LLM array usa+canada", async () => {
  const { J } = makeJudge(
    JSON.stringify({ intent: "provided", value: ["usa", "canada"], confidence: 0.9 })
  )
  const r = await J.judge("in north america", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["usa", "canada"])
})

test("q-country: 'typed amerca' (typo) → LLM usa", async () => {
  const { J } = makeJudge(
    JSON.stringify({ intent: "provided", value: "usa", confidence: 0.85 })
  )
  const r = await J.judge("amerca", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["usa"])
})

test("q-country: 'australia' (free-form) → LLM free-form value", async () => {
  const { J } = makeJudge(
    JSON.stringify({ intent: "provided", value: "australia", confidence: 0.92 })
  )
  const r = await J.judge("australia mostly", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["australia"])
})

test("q-country: 'I dunno' → unclear", async () => {
  const { J } = makeJudge(
    JSON.stringify({
      intent: "unclear",
      clarifyingQuestion: "USA / China / anywhere — pick one?",
    })
  )
  const r = await J.judge("I dunno", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})
