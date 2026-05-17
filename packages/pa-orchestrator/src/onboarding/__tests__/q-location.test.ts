/**
 * Layer 1 unit tests — q_location (V2 GuidedOpenJudge — ADAM PAIN POINTS).
 *
 * Mirrors makeLocationQuestion's spec but with stubbed LLM. Hard-required
 * Adam-verified cases (per .planning/GOAL-onboarding-refactor.md G6 + Wave 2
 * task prompt):
 *
 *   - "Bay Area"            → ["sf"]                        (LLM)
 *   - "sfran or nYC works"  → ["sf","nyc"]   typo + multi    (LLM)
 *   - "Everywhere is fine"  → ["anywhere"]                   (LLM)
 *   - "都行"                → ["anywhere"]                   (bloom)
 *   - "SF or NYC or remote" → ["sf","nyc","remote"]           (LLM)
 *   - "看机会"              → unclear                        (LLM)
 */
import test from "node:test"
import assert from "node:assert/strict"
import { GuidedOpenJudge, type LlmCallFn } from "../judges/guided-open.js"
import type { JudgeCtx } from "../question.js"
import { makeLocationQuestion, type LocationAnswer } from "../questions.js"

function ctx(): JudgeCtx {
  return { userId: "u", turnId: "t" }
}

const LOCATION_HINTS = [
  "sf",
  "bay_area",
  "nyc",
  "seattle",
  "los_angeles",
  "boston",
  "chicago",
  "austin",
  "remote",
  "anywhere",
  "shanghai",
  "beijing",
  "hangzhou",
  "shenzhen",
  "guangzhou",
  "london",
  "berlin",
  "paris",
  "amsterdam",
  "toronto",
  "vancouver",
] as const

const LOCATION_BLOOM = [
  { pattern: /^\s*(remote|远程|远端)\s*$/i, value: ["remote"] as LocationAnswer },
  { pattern: /^\s*(anywhere|都行|无所谓|哪都行|都可以)\s*$/i, value: ["anywhere"] as LocationAnswer },
]

function parseLocation(raw: unknown): LocationAnswer | null {
  if (typeof raw === "string") {
    const t = raw.trim().toLowerCase()
    return t ? [t] : null
  }
  if (Array.isArray(raw)) {
    const items = raw
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length > 0)
    return items.length ? items : null
  }
  return null
}

function makeJudge(rawJson: string): { J: GuidedOpenJudge<LocationAnswer>; calls: () => number } {
  let calls = 0
  const fn: LlmCallFn = async () => {
    calls++
    return rawJson
  }
  const J = new GuidedOpenJudge<LocationAnswer>({
    questionLabel: "target work city / region",
    hints: LOCATION_HINTS,
    examples: [],
    bloomRegex: LOCATION_BLOOM,
    parseValue: parseLocation,
    llmCallFactory: () => fn,
  })
  return { J, calls: () => calls }
}

// ── Adam pain points (REQUIRED) ─────────────────────────────────────────────

test("q-location: PAIN POINT 'Bay Area' → ['sf'] (LLM)", async () => {
  const { J, calls } = makeJudge(
    JSON.stringify({ intent: "provided", value: ["sf"], confidence: 0.95 })
  )
  const r = await J.judge("Bay Area", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["sf"])
  assert.equal(calls(), 1)
})

test("q-location: PAIN POINT 'sfran or nYC works' → ['sf','nyc'] (typo + multi)", async () => {
  const { J, calls } = makeJudge(
    JSON.stringify({ intent: "provided", value: ["sf", "nyc"], confidence: 0.9 })
  )
  const r = await J.judge("sfran or nYC works", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["sf", "nyc"])
  assert.equal(calls(), 1, "typo must hit LLM (no clean bloom)")
})

test("q-location: PAIN POINT 'Everywhere is fine' → ['anywhere'] (LLM)", async () => {
  const { J } = makeJudge(
    JSON.stringify({ intent: "provided", value: ["anywhere"], confidence: 1.0 })
  )
  const r = await J.judge("Everywhere is fine", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["anywhere"])
})

test("q-location: PAIN POINT '都行' → ['anywhere'] (bloom)", async () => {
  const { J, calls } = makeJudge("")
  const r = await J.judge("都行", "zh", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["anywhere"])
  assert.equal(calls(), 0, "都行 must bloom-hit, no LLM call")
})

test("q-location: PAIN POINT 'SF or NYC or remote' → ['sf','nyc','remote'] (LLM)", async () => {
  const { J } = makeJudge(
    JSON.stringify({ intent: "provided", value: ["sf", "nyc", "remote"], confidence: 0.92 })
  )
  const r = await J.judge("SF or NYC or remote", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["sf", "nyc", "remote"])
})

test("q-location: PAIN POINT '看机会' → unclear (LLM)", async () => {
  const { J } = makeJudge(
    JSON.stringify({
      intent: "unclear",
      clarifyingQuestion: "城市说一下: 湾区 / NYC / Seattle / 上海 — 一个或多个",
    })
  )
  const r = await J.judge("看机会", "zh", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) {
    assert.equal(r.reason, "unclear")
    assert.match(r.clarifyingQuestion ?? "", /城市|湾区|nyc/i)
  }
})

// ── Additional cases ─────────────────────────────────────────────────────

test("q-location: 'remote' → bloom hit ['remote']", async () => {
  const { J, calls } = makeJudge("")
  const r = await J.judge("remote", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["remote"])
  assert.equal(calls(), 0)
})

test("q-location: '远程' → bloom hit ['remote']", async () => {
  const { J } = makeJudge("")
  const r = await J.judge("远程", "zh", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["remote"])
})

test("q-location: 'NYC, Boston, or remote' → ['nyc','boston','remote']", async () => {
  const { J } = makeJudge(
    JSON.stringify({ intent: "provided", value: ["nyc", "boston", "remote"], confidence: 0.9 })
  )
  const r = await J.judge("NYC, Boston, or remote", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["nyc", "boston", "remote"])
})

test("q-location: '上海或北京' → ['shanghai','beijing']", async () => {
  const { J } = makeJudge(
    JSON.stringify({ intent: "provided", value: ["shanghai", "beijing"], confidence: 0.95 })
  )
  const r = await J.judge("上海或北京", "zh", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["shanghai", "beijing"])
})

test("q-location: '杭州' → ['hangzhou']", async () => {
  const { J } = makeJudge(
    JSON.stringify({ intent: "provided", value: ["hangzhou"], confidence: 1.0 })
  )
  const r = await J.judge("杭州", "zh", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["hangzhou"])
})

test("q-location: 'Seattle' → ['seattle']", async () => {
  const { J } = makeJudge(
    JSON.stringify({ intent: "provided", value: ["seattle"], confidence: 1.0 })
  )
  const r = await J.judge("Seattle", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["seattle"])
})

test("q-location: 'In USA is good' → ['anywhere'] or fall through", async () => {
  // GOAL doc lists 'In USA is good' as historic pain point. After q_country
  // is locked to USA, this should resolve to anywhere within USA. We accept
  // either ['usa_anywhere'] (legacy) or ['anywhere'] (LLM canonical).
  const { J } = makeJudge(
    JSON.stringify({ intent: "provided", value: ["anywhere"], confidence: 0.85 })
  )
  const r = await J.judge("In USA is good", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["anywhere"])
})

test("q-location: 'pizza' (nonsense) → unclear", async () => {
  const { J } = makeJudge(
    JSON.stringify({ intent: "unclear", clarifyingQuestion: "city or 'remote' is fine" })
  )
  const r = await J.judge("pizza", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})

test("q-location: live layoff answer accepts NYC, remote, and San Francisco without LLM", async () => {
  const q = makeLocationQuestion(["usa", "canada"])
  const r = await q.judge.judge(
    "NYC or remote is best. I’m also open to San Francisco for the right early-stage role.",
    "en",
    ctx()
  )

  assert.equal(r.accept, true)
  if (r.accept) assert.deepEqual(r.value, ["nyc", "remote", "sf"])
})

test("q-location: empty → irrelevant (no LLM)", async () => {
  const { J, calls } = makeJudge("")
  const r = await J.judge("   ", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
  assert.equal(calls(), 0)
})

test("q-location: low confidence → unclear", async () => {
  const { J } = makeJudge(
    JSON.stringify({ intent: "provided", value: ["sf"], confidence: 0.4 })
  )
  const r = await J.judge("maybe sf, idk", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "unclear")
})
