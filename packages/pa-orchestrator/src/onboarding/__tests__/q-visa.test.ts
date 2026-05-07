/**
 * Layer 1 unit tests — q_visa (V2 GuidedOpenJudge; D4 collapse verified).
 *
 * Per CLAUDE.md D4: OPT / CPT / H1B / "需要 sponsor" → "sponsorship_needed".
 * Bloom regex handles the canonical one-words; LLM stub fills typo / multi
 * / nuanced phrases.
 *
 * Test seam: rebuild a fresh GuidedOpenJudge mirroring Q_VISA's spec but
 * with a stub `llmCallFactory`. We verify D4 collapse end-to-end (bloom +
 * LLM both produce 'sponsorship_needed' for OPT/CPT/H1B variants).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { GuidedOpenJudge, type LlmCallFn } from "../judges/guided-open.js"
import type { JudgeCtx } from "../question.js"
import type { VisaAnswer } from "../questions.js"

function ctx(): JudgeCtx {
  return { userId: "u", turnId: "t" }
}

const VISA_HINTS = ["citizen", "permanent_resident", "sponsorship_needed", "other"] as const

const VISA_BLOOM = [
  { pattern: /^\s*(citizen|us citizen|公民|美国公民)\s*$/i, value: "citizen" as VisaAnswer },
  {
    pattern: /^\s*(gc|green card|permanent resident|绿卡|永久居民)\s*$/i,
    value: "permanent_resident" as VisaAnswer,
  },
  {
    pattern: /^\s*(opt|cpt|h1b|h-1b|need sponsor|need sponsorship|需要 sponsor|需要赞助|需要签证)\s*$/i,
    value: "sponsorship_needed" as VisaAnswer,
  },
]

function parseVisa(raw: unknown): VisaAnswer | null {
  if (typeof raw !== "string") return null
  const t = raw.trim().toLowerCase()
  if (t === "citizen") return "citizen"
  if (["permanent_resident", "permanent-resident", "gc", "green_card"].includes(t))
    return "permanent_resident"
  if (
    [
      "sponsorship_needed",
      "sponsorship-needed",
      "sponsor_needed",
      "need_sponsorship",
      "opt",
      "cpt",
      "h1b",
      "h-1b",
    ].includes(t)
  )
    return "sponsorship_needed"
  if (t === "other") return "other"
  return null
}

function makeJudge(rawJson: string, opts?: { throws?: Error }): { J: GuidedOpenJudge<VisaAnswer>; calls: () => number } {
  let calls = 0
  const fn: LlmCallFn = async () => {
    calls++
    if (opts?.throws) throw opts.throws
    return rawJson
  }
  const J = new GuidedOpenJudge<VisaAnswer>({
    questionLabel: "US work authorization status",
    hints: VISA_HINTS,
    examples: [],
    bloomRegex: VISA_BLOOM,
    parseValue: parseVisa,
    llmCallFactory: () => fn,
  })
  return { J, calls: () => calls }
}

test("q-visa: 'citizen' → bloom hit citizen", async () => {
  const { J, calls } = makeJudge("")
  const r = await J.judge("citizen", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "citizen")
  assert.equal(calls(), 0)
})

test("q-visa: '公民' → bloom hit citizen", async () => {
  const { J, calls } = makeJudge("")
  const r = await J.judge("公民", "zh", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "citizen")
  assert.equal(calls(), 0)
})

test("q-visa: 'GC' → bloom hit permanent_resident", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("GC", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "permanent_resident")
})

test("q-visa: '绿卡' → bloom hit permanent_resident", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("绿卡", "zh", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "permanent_resident")
})

test("q-visa: D4 — 'OPT' → bloom hit sponsorship_needed", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("OPT", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "sponsorship_needed")
})

test("q-visa: D4 — 'CPT' → bloom hit sponsorship_needed", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("CPT", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "sponsorship_needed")
})

test("q-visa: D4 — 'H1B' → bloom hit sponsorship_needed", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("H1B", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "sponsorship_needed")
})

test("q-visa: D4 — 'h-1b' (variant) → bloom sponsorship_needed", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("h-1b", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "sponsorship_needed")
})

test("q-visa: D4 — 'need sponsorship' → bloom sponsorship_needed", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("need sponsorship", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "sponsorship_needed")
})

test("q-visa: D4 — '需要 sponsor' → bloom sponsorship_needed", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("需要 sponsor", "zh", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "sponsorship_needed")
})

test("q-visa: 'I'm on F1 OPT this year' (LLM path) → sponsorship_needed", async () => {
  const { J, calls } = makeJudge(
    JSON.stringify({ intent: "provided", value: "sponsorship_needed", confidence: 0.92 })
  )
  const r = await J.judge("I'm on F1 OPT this year", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "sponsorship_needed")
  assert.equal(calls(), 1, "non-bloom phrase must hit LLM")
})

test("q-visa: 'declined to share' (LLM path) → declined", async () => {
  const { J } = makeJudge(JSON.stringify({ intent: "declined" }))
  const r = await J.judge("rather not say", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "declined")
})

test("q-visa: '其他特殊情况' (LLM path) → other", async () => {
  const { J } = makeJudge(
    JSON.stringify({ intent: "provided", value: "other", confidence: 0.85 })
  )
  const r = await J.judge("我有特殊身份", "zh", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "other")
})

test("q-visa: ambiguous 'I think I can work?' → unclear", async () => {
  const { J } = makeJudge(
    JSON.stringify({
      intent: "unclear",
      clarifyingQuestion: "citizen / GC / need sponsorship — pick one?",
    })
  )
  const r = await J.judge("I think I can work?", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})
