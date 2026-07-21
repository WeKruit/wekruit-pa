/**
 * v1.8 Phase 75 — KeywordSetJudge tests.
 *
 * Covers:
 *   - validateLlmOutput: shape errors, unknown-keyword dropping, clamping
 *   - computeAggregate: weighted-mean formulas, missing-keyword → (0, 1)
 *   - computeSummary: top-weighted fallback
 *   - inferAbortHint: low_confidence / off_topic / explicit pass-through
 *   - KeywordSetJudge.judgeScored: full happy path + abort routing
 *   - KeywordSetJudge.judge (binary compat shim): accept threshold, decline
 *     route, irrelevant fallback
 *   - LLM error / invalid output → scored result with abortHint
 *   - constructor rejects empty keyword[]
 *   - buildKeywordSetPrompt: deterministic structure
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  KeywordSetJudge,
  buildKeywordSetPrompt,
  computeAggregate,
  computeSummary,
  inferAbortHint,
  validateLlmOutput,
  type KeywordSetLlmCaller,
  type KeywordSetLlmOutput,
  type KeywordSpec,
} from "../keyword-set.js"
import { isScoredJudgeResult, type JudgeCtx } from "../../question.js"

const ctx: JudgeCtx = { userId: "u1", turnId: "t1" }

// ════════════════════════════════════════════════════════════════════════════
// validateLlmOutput
// ════════════════════════════════════════════════════════════════════════════

const kw: KeywordSpec[] = [
  { keyword: "react", weight: 2 },
  { keyword: "kubernetes", weight: 1 },
]

test("Phase 75: validateLlmOutput throws on non-object", () => {
  assert.throws(() => validateLlmOutput(null, kw))
  assert.throws(() => validateLlmOutput("not json", kw))
})

test("Phase 75: validateLlmOutput throws when perKeyword[] missing", () => {
  assert.throws(() => validateLlmOutput({ summary: "x" }, kw))
})

test("Phase 75: validateLlmOutput drops unknown-keyword cells", () => {
  const out = validateLlmOutput(
    {
      perKeyword: [
        { keyword: "react", match: 0.9, confidence: 0.8, evidence: "e", reasoning: "r" },
        { keyword: "made_up", match: 0.7, confidence: 0.6, evidence: "x", reasoning: "y" },
      ],
    },
    kw
  )
  assert.equal(out.perKeyword.length, 1)
  assert.equal(out.perKeyword[0].keyword, "react")
})

test("Phase 75: validateLlmOutput clamps match/confidence to [0,1]", () => {
  const out = validateLlmOutput(
    {
      perKeyword: [
        { keyword: "react", match: 1.5, confidence: -0.5, evidence: "", reasoning: "" },
      ],
    },
    kw
  )
  assert.equal(out.perKeyword[0].match, 1)
  assert.equal(out.perKeyword[0].confidence, 0)
})

test("Phase 75: validateLlmOutput truncates evidence ≤60 + reasoning ≤80", () => {
  const out = validateLlmOutput(
    {
      perKeyword: [
        {
          keyword: "react",
          match: 0.9,
          confidence: 0.9,
          evidence: "x".repeat(100),
          reasoning: "y".repeat(120),
        },
      ],
    },
    kw
  )
  assert.equal(out.perKeyword[0].evidence.length, 60)
  assert.equal(out.perKeyword[0].reasoning.length, 80)
})

test("Phase 75: validateLlmOutput accepts valid abortHint, drops invalid kind", () => {
  const valid = validateLlmOutput(
    {
      perKeyword: [],
      abortHint: { kind: "off_topic", reason: "asked about salary" },
    },
    kw
  )
  assert.equal(valid.abortHint?.kind, "off_topic")

  const invalid = validateLlmOutput(
    {
      perKeyword: [],
      abortHint: { kind: "totally_made_up", reason: "x" },
    },
    kw
  )
  assert.equal(invalid.abortHint, undefined)
})

// ════════════════════════════════════════════════════════════════════════════
// computeAggregate
// ════════════════════════════════════════════════════════════════════════════

test("Phase 75: computeAggregate weighted-mean formula matches spec", () => {
  // react weight=2, m=0.8, c=0.9; kubernetes weight=1, m=0.4, c=0.6
  // W = 3
  // s = (2*0.8 + 1*0.4) / 3 = 2.0 / 3 ≈ 0.6667
  // c = (2*0.9 + 1*0.6) / 3 = 2.4 / 3 = 0.8
  const agg = computeAggregate(
    [
      { keyword: "react", match: 0.8, confidence: 0.9, evidence: "", reasoning: "" },
      { keyword: "kubernetes", match: 0.4, confidence: 0.6, evidence: "", reasoning: "" },
    ],
    kw
  )
  assert.ok(Math.abs(agg.s - 0.6667) < 0.001)
  assert.ok(Math.abs(agg.c - 0.8) < 0.001)
})

test("Phase 75: computeAggregate missing keyword counts as (match=0, conf=1)", () => {
  // Only react cell present. kubernetes missing → contributes 0*1 to match
  // (weighted) + 1*1 to confidence (weighted).
  // W = 3. s = (2*0.5)/3 ≈ 0.333. c = (2*0.9 + 1*1)/3 ≈ 0.933.
  const agg = computeAggregate(
    [{ keyword: "react", match: 0.5, confidence: 0.9, evidence: "", reasoning: "" }],
    kw
  )
  assert.ok(Math.abs(agg.s - 0.333) < 0.001)
  assert.ok(Math.abs(agg.c - 0.933) < 0.001)
})

test("Phase 75: computeAggregate handles zero total weight gracefully", () => {
  const agg = computeAggregate([], [])
  assert.deepEqual(agg, { s: 0, c: 0 })
})

test("Phase 75: computeAggregate default weight is 1.0 when omitted", () => {
  const noWeight: KeywordSpec[] = [{ keyword: "a" }, { keyword: "b" }]
  // Both weight=1, both match=0.5, conf=1
  // W=2, s = (0.5+0.5)/2 = 0.5
  const agg = computeAggregate(
    [
      { keyword: "a", match: 0.5, confidence: 1, evidence: "", reasoning: "" },
      { keyword: "b", match: 0.5, confidence: 1, evidence: "", reasoning: "" },
    ],
    noWeight
  )
  assert.equal(agg.s, 0.5)
})

// ════════════════════════════════════════════════════════════════════════════
// computeSummary + inferAbortHint
// ════════════════════════════════════════════════════════════════════════════

test("Phase 75: computeSummary ranks by weight × match", () => {
  const cells = [
    { keyword: "kubernetes", match: 0.9, confidence: 0.8, evidence: "", reasoning: "" },
    { keyword: "react", match: 0.9, confidence: 0.8, evidence: "", reasoning: "" },
  ]
  // react has weight 2 → should rank first
  const sum = computeSummary(cells, kw)
  assert.ok(sum.includes("react"))
  assert.ok(sum.startsWith("top keywords"))
})

test("Phase 75: computeSummary handles empty perKeyword", () => {
  assert.equal(computeSummary([], kw), "no keywords matched in reply")
})

test("Phase 75: inferAbortHint passes through explicit hint", () => {
  const explicit = inferAbortHint(
    {
      perKeyword: [{ keyword: "react", match: 0.9, confidence: 0.9, evidence: "", reasoning: "" }],
      abortHint: { kind: "decline", reason: "candidate said no" },
    },
    { s: 0.9, c: 0.9 }
  )
  assert.equal(explicit?.kind, "decline")
})

test("Phase 75: inferAbortHint flags low_confidence when c < 0.5", () => {
  const hint = inferAbortHint({ perKeyword: [] }, { s: 0.9, c: 0.3 })
  assert.equal(hint?.kind, "low_confidence")
})

test("Phase 75: inferAbortHint flags off_topic when perKeyword empty + high c", () => {
  const hint = inferAbortHint({ perKeyword: [] }, { s: 0, c: 0.9 })
  assert.equal(hint?.kind, "off_topic")
})

test("Phase 75: inferAbortHint returns undefined for healthy scored result", () => {
  const hint = inferAbortHint(
    {
      perKeyword: [{ keyword: "react", match: 0.9, confidence: 0.9, evidence: "", reasoning: "" }],
    },
    { s: 0.9, c: 0.9 }
  )
  assert.equal(hint, undefined)
})

// ════════════════════════════════════════════════════════════════════════════
// KeywordSetJudge — full pipeline
// ════════════════════════════════════════════════════════════════════════════

function makeStubCaller(canned: KeywordSetLlmOutput | Error): KeywordSetLlmCaller {
  return {
    async score() {
      if (canned instanceof Error) throw canned
      return canned
    },
  }
}

test("Phase 75: KeywordSetJudge constructor rejects empty keywords", () => {
  assert.throws(
    () =>
      new KeywordSetJudge({
        questionId: "x",
        keywords: [],
        llmCaller: makeStubCaller({ perKeyword: [] }),
      })
  )
})

test("Phase 75: KeywordSetJudge.judgeScored emits ScoredJudgeResult shape", async () => {
  const judge = new KeywordSetJudge({
    questionId: "ps_q1",
    keywords: kw,
    llmCaller: makeStubCaller({
      perKeyword: [
        { keyword: "react", match: 0.9, confidence: 0.95, evidence: "3 prod apps", reasoning: "explicit ship history" },
        { keyword: "kubernetes", match: 0.5, confidence: 0.7, evidence: "ran on gke", reasoning: "partial" },
      ],
      summary: "strong react, partial k8s",
      answered: true,
    }),
  })
  const result = await judge.judgeScored("I shipped 3 react apps; ran them on gke", "en", ctx)
  assert.equal(isScoredJudgeResult(result), true)
  assert.equal(result.kind, "scored")
  assert.equal(result.perKeyword.length, 2)
  // s = (2*0.9 + 1*0.5)/3 ≈ 0.7667
  assert.ok(Math.abs(result.aggregate.s - 0.7667) < 0.001)
  assert.equal(result.aggregate.summary, "strong react, partial k8s")
  assert.equal(result.abortHint, undefined)
  assert.equal(result.answered, true)
})

test("Phase 75: KeywordSetJudge.judgeScored returns abortHint on LLM throw", async () => {
  const judge = new KeywordSetJudge({
    questionId: "ps_q1",
    keywords: kw,
    llmCaller: makeStubCaller(new Error("upstream 500")),
  })
  const result = await judge.judgeScored("hi", "en", ctx)
  assert.equal(result.kind, "scored")
  assert.equal(result.abortHint?.kind, "ambiguous")
  assert.equal(result.abortHint?.reason, "upstream 500")
  assert.equal(result.perKeyword.length, 0)
  assert.equal(result.aggregate.s, 0)
})

test("Phase 75: KeywordSetJudge.judgeScored returns abortHint on malformed LLM output", async () => {
  const badCaller: KeywordSetLlmCaller = {
    async score() {
      // Caller is supposed to return KeywordSetLlmOutput but lies — we
      // simulate by casting through unknown.
      return { perKeyword: "not-an-array" } as unknown as KeywordSetLlmOutput
    },
  }
  const judge = new KeywordSetJudge({ questionId: "ps_q1", keywords: kw, llmCaller: badCaller })
  const result = await judge.judgeScored("hi", "en", ctx)
  assert.equal(result.abortHint?.kind, "ambiguous")
})

// ── binary-compat shim ──────────────────────────────────────────────────────

test("Phase 75: KeywordSetJudge.judge (binary) accepts when s>=0.6", async () => {
  const judge = new KeywordSetJudge({
    questionId: "ps_q1",
    keywords: [{ keyword: "react" }],
    llmCaller: makeStubCaller({
      perKeyword: [{ keyword: "react", match: 0.9, confidence: 0.9, evidence: "", reasoning: "" }],
    }),
  })
  const result = await judge.judge("yes", "en", ctx)
  assert.equal(result.accept, true)
})

test("Phase 75: KeywordSetJudge.judge (binary) returns declined when abortHint.kind=decline", async () => {
  const judge = new KeywordSetJudge({
    questionId: "ps_q1",
    keywords: [{ keyword: "react" }],
    llmCaller: makeStubCaller({
      perKeyword: [{ keyword: "react", match: 0, confidence: 0.9, evidence: "", reasoning: "" }],
      abortHint: { kind: "decline", reason: "user said no" },
    }),
  })
  const result = await judge.judge("no", "en", ctx)
  assert.equal(result.accept, false)
  if (!result.accept) {
    assert.equal(result.reason, "declined")
  }
})

test("Phase 75: KeywordSetJudge.judge (binary) returns unclear when low_confidence", async () => {
  const judge = new KeywordSetJudge({
    questionId: "ps_q1",
    keywords: [{ keyword: "react" }],
    llmCaller: makeStubCaller({
      perKeyword: [{ keyword: "react", match: 0.2, confidence: 0.2, evidence: "", reasoning: "" }],
    }),
  })
  const result = await judge.judge("maybe", "en", ctx)
  assert.equal(result.accept, false)
  if (!result.accept) {
    assert.equal(result.reason, "unclear")
  }
})

// ════════════════════════════════════════════════════════════════════════════
// Prompt template
// ════════════════════════════════════════════════════════════════════════════

test("Phase 75: buildKeywordSetPrompt includes keywords + weights", () => {
  const { system, user } = buildKeywordSetPrompt({
    reply: "I love react",
    lang: "en",
    keywords: [{ keyword: "react", weight: 2 }, { keyword: "vue", weight: 1, hint: "synonyms: vue.js" }],
    questionPrompt: "tell me about your react experience",
  })
  assert.ok(system.includes("top-5% hiring-calibration evaluator"))
  assert.ok(system.includes("Temperature is fixed at 0"))
  assert.ok(user.includes("react"))
  assert.ok(user.includes("vue"))
  assert.ok(user.includes("synonyms: vue.js"))
  assert.ok(user.includes("tell me about your react"))
  assert.ok(user.includes('"""I love react"""'))
})

test("Phase 75: buildKeywordSetPrompt uses strict prescreen calibration anchors", () => {
  const { system } = buildKeywordSetPrompt({
    reply: "I helped the team with marketing and learned a lot",
    lang: "en",
    keywords: [{ keyword: "growth_or_marketing_campaign", weight: 1 }],
    questionPrompt: "Tell me about a growth campaign you owned",
  })

  assert.match(system, /top-5% hiring-calibration evaluator/i)
  assert.match(system, /top-5/i)
  assert.match(system, /0\.95/)
  assert.match(system, /direct ownership/i)
  assert.match(system, /cap .*team-only/i)
  assert.match(system, /cap .*adjacent/i)
  assert.match(system, /cap .*no measurable/i)
})

test("buildKeywordSetPrompt: candidate-context block appears when provided", () => {
  const { user, system } = buildKeywordSetPrompt({
    reply: "I shipped a payments API",
    lang: "en",
    keywords: [{ keyword: "payments", weight: 1 }],
    questionPrompt: "Tell me about payments work",
    candidateContext: "Current/recent: Staff SWE @ Stripe",
  })
  assert.ok(user.includes("Candidate context"))
  assert.ok(user.includes("Current/recent: Staff SWE @ Stripe"))
  // System encourages crediting context + decline detection.
  assert.ok(system.includes("candidate-context block"))
})

test("buildKeywordSetPrompt: no candidate-context block when omitted (back-compat)", () => {
  const { user } = buildKeywordSetPrompt({
    reply: "I shipped a payments API",
    lang: "en",
    keywords: [{ keyword: "payments", weight: 1 }],
    questionPrompt: "Tell me about payments work",
  })
  assert.ok(!user.includes("Candidate context"))
})
