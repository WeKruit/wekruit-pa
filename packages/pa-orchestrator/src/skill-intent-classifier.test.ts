/**
 * iter30 WS4-A — SkillIntentClassifier unit tests.
 *
 * Test gates (per ws-4a-detail.md §10.1):
 *   (a) cache hit on same-msg-hash
 *   (b) cache miss → llmCall invoked
 *   (c) timeout 800ms → empty array (fail-open)
 *   (d) 429 from llmCall → empty + rateLimited=true
 *   (e) confidence <0.6 filtered out
 *   (f) result respects llmInvokable=false (excluded from candidates)
 *   (g) malformed JSON → empty array (fail-open)
 *   (h) Top-K=3 enforced
 *   (i) prompt building is stable + ≤500 token budget
 *   (j) 50-msg fixture: ≥80% top-1 accuracy with mocked LLM (sanity, not full eval)
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  classifySkills,
  buildSystemPrompt,
  parseClassifierJson,
  buildCacheKey,
  DEFAULT_SKILL_CATALOG,
  _clearClassifierCache,
  type ClassifyResult,
  type ClassifyDeps,
} from "./skill-intent-classifier.js"
import { createMockContext } from "./run-context.js"

// ---------------------------------------------------------------------------
// (a, b) cache behavior
// ---------------------------------------------------------------------------

test("(a) cache hit on same-msg-hash", async () => {
  _clearClassifierCache()
  let llmCalls = 0
  const llmCall = async () => {
    llmCalls++
    return JSON.stringify({
      skills: [{ key: "vent_support", confidence: 0.9 }],
      reason: "ok",
    })
  }
  const ctx = createMockContext({ userId: "user1" })
  const r1 = await classifySkills({ messageBody: "我崩溃了", ctx }, { llmCall })
  const r2 = await classifySkills({ messageBody: "我崩溃了", ctx }, { llmCall })
  assert.equal(llmCalls, 1, "second call should hit cache")
  assert.equal(r1.cacheHit, false)
  assert.equal(r2.cacheHit, true)
  assert.equal(r2.skills.length, 1)
  assert.equal(r2.skills[0].key, "vent_support")
})

test("(b) different userId → cache miss", async () => {
  _clearClassifierCache()
  let llmCalls = 0
  const llmCall = async () => {
    llmCalls++
    return JSON.stringify({
      skills: [{ key: "vent_support", confidence: 0.9 }],
    })
  }
  const ctx1 = createMockContext({ userId: "user1" })
  const ctx2 = createMockContext({ userId: "user2" })
  await classifySkills({ messageBody: "我崩溃了", ctx: ctx1 }, { llmCall })
  await classifySkills({ messageBody: "我崩溃了", ctx: ctx2 }, { llmCall })
  assert.equal(llmCalls, 2, "different userId triggers two LLM calls")
})

// ---------------------------------------------------------------------------
// (c) timeout fail-open
// ---------------------------------------------------------------------------

test("(c) timeout 800ms → empty array fail-open", async () => {
  _clearClassifierCache()
  const llmCall = (_p: unknown, signal: AbortSignal): Promise<string> =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")))
    })
  const ctx = createMockContext()
  const result = await classifySkills(
    { messageBody: "test message", ctx },
    { llmCall, timeoutMs: 50 }
  )
  assert.deepEqual(result.skills, [])
  assert.equal(result.rateLimited, false)
  assert.equal(result.reason, "timeout")
})

// ---------------------------------------------------------------------------
// (d) 429 → rateLimited=true, empty array
// ---------------------------------------------------------------------------

test("(d) 429 rate-limited → rateLimited=true, empty skills", async () => {
  _clearClassifierCache()
  const llmCall = async () => {
    throw new Error("429 Too Many Requests")
  }
  const ctx = createMockContext()
  const result = await classifySkills({ messageBody: "test", ctx }, { llmCall })
  assert.deepEqual(result.skills, [])
  assert.equal(result.rateLimited, true)
  assert.equal(result.reason, "rate-limited")
})

test("(d2) 429 result NOT cached (retry-after-recovery)", async () => {
  _clearClassifierCache()
  let calls = 0
  const llmCall = async () => {
    calls++
    if (calls === 1) throw new Error("429 Too Many Requests")
    return JSON.stringify({ skills: [{ key: "vent_support", confidence: 0.9 }] })
  }
  const ctx = createMockContext()
  const r1 = await classifySkills({ messageBody: "x", ctx }, { llmCall })
  const r2 = await classifySkills({ messageBody: "x", ctx }, { llmCall })
  assert.equal(r1.rateLimited, true)
  assert.equal(r2.rateLimited, false)
  assert.equal(r2.skills.length, 1, "second call recovered")
  assert.equal(calls, 2)
})

// ---------------------------------------------------------------------------
// (e, h) parse — confidence threshold, Top-K=3
// ---------------------------------------------------------------------------

test("(e) confidence < 0.6 filtered out", () => {
  const raw = JSON.stringify({
    skills: [
      { key: "vent_support", confidence: 0.9 },
      { key: "motivation_nudge", confidence: 0.5 }, // below threshold
      { key: "interview_prep", confidence: 0.7 },
    ],
    reason: "test",
  })
  const parsed = parseClassifierJson(raw)
  assert.equal(parsed.skills.length, 2)
  assert.deepEqual(
    parsed.skills.map((s) => s.key).sort(),
    ["interview_prep", "vent_support"]
  )
})

test("(h) Top-K=3 enforced", () => {
  const raw = JSON.stringify({
    skills: [
      { key: "vent_support", confidence: 0.9 },
      { key: "motivation_nudge", confidence: 0.85 },
      { key: "interview_prep", confidence: 0.8 },
      { key: "headhunter", confidence: 0.75 }, // 4th — should be dropped
    ],
  })
  const parsed = parseClassifierJson(raw)
  assert.equal(parsed.skills.length, 3)
})

test("parser: invalid skill key dropped", () => {
  const raw = JSON.stringify({
    skills: [
      { key: "vent_support", confidence: 0.9 },
      { key: "fake_skill", confidence: 0.95 }, // invalid
    ],
  })
  const parsed = parseClassifierJson(raw)
  assert.equal(parsed.skills.length, 1)
  assert.equal(parsed.skills[0].key, "vent_support")
})

// ---------------------------------------------------------------------------
// (f) llmInvokable=false excluded from prompt
// ---------------------------------------------------------------------------

test("(f) llmInvokable=false excluded from system prompt", () => {
  const customCatalog = [
    {
      key: "vent_support" as const,
      intentDescription: "vent stuff",
      llmInvokable: true,
    },
    {
      key: "headhunter" as const,
      intentDescription: "headhunter stuff",
      llmInvokable: false, // excluded
    },
  ]
  const prompt = buildSystemPrompt(customCatalog)
  assert.match(prompt, /vent_support/)
  assert.doesNotMatch(prompt, /headhunter/)
  assert.match(prompt, /1 total/) // count reflects filtered set
})

// ---------------------------------------------------------------------------
// (g) malformed JSON → empty array fail-open
// ---------------------------------------------------------------------------

test("(g) malformed JSON → empty array", () => {
  const parsed = parseClassifierJson("not json")
  assert.deepEqual(parsed.skills, [])
  assert.equal(parsed.reason, "json-parse-error")
})

test("parser: array-shaped JSON rejected", () => {
  const parsed = parseClassifierJson("[1,2,3]")
  assert.deepEqual(parsed.skills, [])
})

test("parser: missing skills field rejected", () => {
  const parsed = parseClassifierJson(JSON.stringify({ reason: "no skills field" }))
  assert.deepEqual(parsed.skills, [])
})

test("parser: empty model output → empty result", () => {
  const parsed = parseClassifierJson("")
  assert.deepEqual(parsed.skills, [])
  assert.equal(parsed.reason, "empty-output")
})

// ---------------------------------------------------------------------------
// (i) prompt token budget
// ---------------------------------------------------------------------------

test("(i) buildSystemPrompt: ≤2500 chars (token budget proxy)", () => {
  const prompt = buildSystemPrompt(DEFAULT_SKILL_CATALOG)
  assert.ok(prompt.length < 2500, `prompt length ${prompt.length} should be < 2500`)
  assert.match(prompt, /skill-intent classifier/)
  assert.match(prompt, /Max 3 skills/)
  assert.match(prompt, /Confidence below 0.6/)
})

// ---------------------------------------------------------------------------
// Cache key — sha256 + userId scoping
// ---------------------------------------------------------------------------

test("buildCacheKey: stable across whitespace + case normalization", () => {
  const a = buildCacheKey("Hello World", "user1")
  const b = buildCacheKey("  hello world  ", "user1")
  assert.equal(a, b, "cache key normalizes whitespace + case")
  const c = buildCacheKey("Hello World", "user2")
  assert.notEqual(a, c, "different user → different key")
})

// ---------------------------------------------------------------------------
// (j) Mocked-LLM 50-msg fixture — top-1 accuracy ≥80% sanity
// ---------------------------------------------------------------------------

test("(j) mocked-LLM 50-msg fixture: top-1 accuracy ≥80%", async () => {
  // We can't run the live Qwen-7B model in unit tests; instead we mock the
  // LLM call with a deterministic regex-based router that mirrors the
  // intentDescription bullets. This test gates the *plumbing* (input → cache
  // → parse → output), not the LLM accuracy.
  //
  // Production accuracy is measured separately via tests/scenarios LLM-judge
  // YAMLs (see ws-4a-detail.md §10.4). 80% threshold here is the plumbing
  // floor — if the wired-up classifier round-trips fixtures cleanly, we're
  // green.
  _clearClassifierCache()

  type Fixture = { msg: string; expected: string }
  const fixtures: Fixture[] = [
    // vent (15)
    { msg: "我崩溃了 真的撑不住", expected: "vent_support" },
    { msg: "今天 emo 到不行", expected: "vent_support" },
    { msg: "I'm so burnt out, can't keep going", expected: "vent_support" },
    { msg: "我焦虑死了 睡不着", expected: "vent_support" },
    { msg: "feel hopeless", expected: "vent_support" },
    { msg: "崩溃 心情真不好", expected: "vent_support" },
    { msg: "I'm overwhelmed", expected: "vent_support" },
    { msg: "我裂开了 真的累", expected: "vent_support" },
    { msg: "anxiety attack happening now", expected: "vent_support" },
    { msg: "spiraling hard tonight", expected: "vent_support" },
    { msg: "I can't do this anymore", expected: "vent_support" },
    { msg: "破防了 真的", expected: "vent_support" },
    { msg: "exhausted to the bone", expected: "vent_support" },
    { msg: "心慌得很", expected: "vent_support" },
    { msg: "我 emo 透了", expected: "vent_support" },
    // motivation (8)
    { msg: "deadline 还有 2 天 我一个字都没写", expected: "motivation_nudge" },
    { msg: "我盯着屏幕一上午 没动", expected: "motivation_nudge" },
    { msg: "can't get started on this", expected: "motivation_nudge" },
    { msg: "procrastinating again", expected: "motivation_nudge" },
    { msg: "no motivation today", expected: "motivation_nudge" },
    { msg: "卡住了 一行没写", expected: "motivation_nudge" },
    { msg: "stuck on this paper", expected: "motivation_nudge" },
    { msg: "我懒得动 deadline 明天", expected: "motivation_nudge" },
    // interview (8)
    { msg: "明天 onsite Meta L5", expected: "interview_prep" },
    { msg: "system design 那轮我没扛住", expected: "interview_prep" },
    { msg: "interview tomorrow at Stripe", expected: "interview_prep" },
    { msg: "behavioral round 怎么准备", expected: "interview_prep" },
    { msg: "下周 onsite 怕翻车", expected: "interview_prep" },
    { msg: "phone screen tomorrow morning", expected: "interview_prep" },
    { msg: "coding interview prep advice", expected: "interview_prep" },
    { msg: "面试紧张得不行", expected: "interview_prep" },
    // jd_roast (6)
    { msg: "帮我看这个 JD", expected: "jd_roast" },
    { msg: "should I apply to this role", expected: "jd_roast" },
    { msg: "thoughts on this opportunity?", expected: "jd_roast" },
    { msg: "这个公司怎么样", expected: "jd_roast" },
    { msg: "review this listing", expected: "jd_roast" },
    { msg: "is this a good fit", expected: "jd_roast" },
    // negotiation (5)
    { msg: "他们给了 250k 还能再加吗", expected: "negotiation" },
    { msg: "counter offer advice", expected: "negotiation" },
    { msg: "比 offer 应该 ask 多少", expected: "negotiation" },
    { msg: "salary negotiation tips", expected: "negotiation" },
    { msg: "谈薪谈钱怎么聊", expected: "negotiation" },
    // headhunter (8)
    { msg: "我想换工作", expected: "headhunter" },
    { msg: "在看工作", expected: "headhunter" },
    { msg: "looking for a new role", expected: "headhunter" },
    { msg: "on the market again", expected: "headhunter" },
    { msg: "在面 Meta 和 Stripe", expected: "headhunter" },
    { msg: "ready to switch jobs", expected: "headhunter" },
    { msg: "想跳槽", expected: "headhunter" },
    { msg: "exploring new opportunities", expected: "headhunter" },
  ]

  // Deterministic mocked classifier — uses simple keyword heuristics that
  // mirror the intentDescription cues. NOT production accuracy proxy; just
  // plumbing test.
  const llmCall = async (prompt: { userMessage: string }): Promise<string> => {
    const m = prompt.userMessage.toLowerCase()
    const candidates: { key: string; score: number }[] = []
    if (
      /崩溃|焦虑|emo|烦死|exhausted|burnt|burned|hopeless|overwhelm|spiral|anxiety|心慌|心情|裂开|破防|撑不住|心情真不好|can't do this/.test(
        m
      )
    )
      candidates.push({ key: "vent_support", score: 0.92 })
    if (
      /deadline|没写|拖延|没动|stuck on|procrastinat|no motivation|懒得|卡住|盯着|没动力|can't get started/.test(
        m
      )
    )
      candidates.push({ key: "motivation_nudge", score: 0.88 })
    if (
      /onsite|interview tomorrow|明天面|下周面|phone screen|behavioral|system design|coding interview|面试|onsite tomorrow|怕翻车|prep/.test(
        m
      )
    )
      candidates.push({ key: "interview_prep", score: 0.85 })
    if (
      /jd|应该投|这个公司|这个岗位|这个职位|should i apply|review this listing|thoughts on this|帮我看|good fit/.test(
        m
      )
    )
      candidates.push({ key: "jd_roast", score: 0.85 })
    if (
      /counter|negoti|谈薪|谈钱|总包|加点|压价|比 offer|how much should/.test(m)
    )
      candidates.push({ key: "negotiation", score: 0.85 })
    if (
      /换工作|在看工作|new role|on the market|new opportunit|跳槽|switch job|exploring|在面/.test(
        m
      )
    )
      candidates.push({ key: "headhunter", score: 0.82 })
    candidates.sort((a, b) => b.score - a.score)
    return JSON.stringify({
      skills: candidates.slice(0, 3).map((c) => ({ key: c.key, confidence: c.score })),
      reason: "test",
    })
  }

  let correct = 0
  for (const f of fixtures) {
    _clearClassifierCache()
    const ctx = createMockContext({ userId: `u-${Math.random()}` })
    const result = await classifySkills({ messageBody: f.msg, ctx }, { llmCall })
    if (result.skills[0]?.key === f.expected) correct++
  }
  const accuracy = correct / fixtures.length
  assert.ok(
    accuracy >= 0.8,
    `top-1 accuracy ${(accuracy * 100).toFixed(1)}% should be ≥80% (${correct}/${fixtures.length})`
  )
})

// ---------------------------------------------------------------------------
// Empty / edge cases
// ---------------------------------------------------------------------------

test("classifySkills: empty messageBody → empty skills, no llm call", async () => {
  _clearClassifierCache()
  let calls = 0
  const llmCall = async () => {
    calls++
    return ""
  }
  const ctx = createMockContext()
  const result = await classifySkills({ messageBody: "", ctx }, { llmCall })
  assert.equal(calls, 0)
  assert.deepEqual(result.skills, [])
  assert.equal(result.reason, "empty-message")
})

// ---------------------------------------------------------------------------
// ClassifyResult type-shape sanity (tested implicitly above)
// ---------------------------------------------------------------------------

test("ClassifyResult shape: skills + rateLimited + cacheHit + latencyMs + reason", async () => {
  _clearClassifierCache()
  const llmCall = async () => JSON.stringify({ skills: [], reason: "ambiguous" })
  const ctx = createMockContext()
  const result: ClassifyResult = await classifySkills(
    { messageBody: "abc", ctx },
    { llmCall } as ClassifyDeps
  )
  assert.ok(typeof result.rateLimited === "boolean")
  assert.ok(typeof result.cacheHit === "boolean")
  assert.ok(typeof result.latencyMs === "number")
  assert.ok(typeof result.reason === "string")
})
