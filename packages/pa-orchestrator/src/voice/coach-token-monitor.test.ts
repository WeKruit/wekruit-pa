/**
 * Phase 24 T1D — coach-token-monitor unit tests.
 *
 * 12 behavior cases:
 *   1-5:  pattern match (one per category)
 *   6-8:  false-positive guard on clean Claire replies
 *   9-10: tapCoachTokens log invocation
 *   11:   tapCoachTokens signature returns void (no mutation)
 *   12:   token truncation ≤ 40 chars
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectCoachTokens, tapCoachTokens } from "./coach-token-monitor.js"

// --- Pattern match tests (1-5) ---

describe("detectCoachTokens — zh_coach_verb", () => {
  it("Test 1: matches 我建议你", () => {
    const hits = detectCoachTokens("我建议你把投递时间记一下")
    assert.ok(hits.length >= 1, `expected ≥1 hit, got ${hits.length}`)
    assert.ok(
      hits.some((h) => h.pattern === "zh_coach_verb"),
      `expected pattern "zh_coach_verb", got ${JSON.stringify(hits)}`
    )
  })
})

describe("detectCoachTokens — en_coach_verb", () => {
  it("Test 2: matches 'I suggest'", () => {
    const hits = detectCoachTokens("I suggest you take a break")
    assert.ok(hits.length >= 1, `expected ≥1 hit, got ${hits.length}`)
    assert.ok(
      hits.some((h) => h.pattern === "en_coach_verb"),
      `expected pattern "en_coach_verb", got ${JSON.stringify(hits)}`
    )
  })
})

describe("detectCoachTokens — bullet_list", () => {
  it("Test 3: matches bullet list", () => {
    const hits = detectCoachTokens("- step 1\n- step 2")
    assert.ok(hits.length >= 1, `expected ≥1 hit, got ${hits.length}`)
    assert.ok(
      hits.some((h) => h.pattern === "bullet_list"),
      `expected pattern "bullet_list", got ${JSON.stringify(hits)}`
    )
  })
})

describe("detectCoachTokens — numbered_list", () => {
  it("Test 4: matches numbered list", () => {
    const hits = detectCoachTokens("1. first\n2. second")
    assert.ok(hits.length >= 1, `expected ≥1 hit, got ${hits.length}`)
    assert.ok(
      hits.some((h) => h.pattern === "numbered_list"),
      `expected pattern "numbered_list", got ${JSON.stringify(hits)}`
    )
  })
})

describe("detectCoachTokens — subordinate_chain_4plus", () => {
  it("Test 5: matches 3+ connectives (subordinate chain)", () => {
    const hits = detectCoachTokens("先这样, 然后那样, 接着再这样, 然后最后那样")
    assert.ok(hits.length >= 1, `expected ≥1 hit, got ${hits.length}`)
    assert.ok(
      hits.some((h) => h.pattern === "subordinate_chain_4plus"),
      `expected pattern "subordinate_chain_4plus", got ${JSON.stringify(hits)}`
    )
  })
})

// --- False-positive guard on clean Claire replies (6-8) ---

describe("detectCoachTokens — false-positive guard (clean Claire replies)", () => {
  it("Test 6: no hits on 拒得快说明他们没准备好你", () => {
    const hits = detectCoachTokens("拒得快说明他们没准备好你. next.")
    assert.equal(
      hits.length,
      0,
      `expected 0 hits on clean reply, got ${JSON.stringify(hits)}`
    )
  })

  it("Test 7: no hits on 可能下周回 emo reply", () => {
    const hits = detectCoachTokens("可能下周回. 也可能默拒. 别先 emo.")
    assert.equal(
      hits.length,
      0,
      `expected 0 hits on clean reply, got ${JSON.stringify(hits)}`
    )
  })

  it("Test 8: no hits on 来. 喘一下.", () => {
    const hits = detectCoachTokens("来. 喘一下.")
    assert.equal(
      hits.length,
      0,
      `expected 0 hits on clean reply, got ${JSON.stringify(hits)}`
    )
  })
})

// --- tapCoachTokens behavior (9-11) ---

describe("tapCoachTokens — log invocation", () => {
  it("Test 9: invokes log with pa.voice.coach_token.observed when hits exist", () => {
    const calls: unknown[][] = []
    const mockLog = (...args: unknown[]) => calls.push(args)
    tapCoachTokens(
      "我建议你做个计划",
      { turnId: "t1", userId: "u1", replyLength: 10 },
      mockLog
    )
    assert.equal(calls.length, 1, `expected 1 log call, got ${calls.length}`)
    assert.equal(
      calls[0]?.[0],
      "pa.voice.coach_token.observed",
      `expected event name "pa.voice.coach_token.observed", got ${calls[0]?.[0]}`
    )
    const payload = calls[0]?.[1] as Record<string, unknown>
    assert.ok(Array.isArray(payload?.tokens), "expected tokens array in payload")
    assert.equal(payload?.turnId, "t1")
    assert.equal(payload?.userId, "u1")
  })

  it("Test 10: does NOT invoke log when no hits", () => {
    const calls: unknown[][] = []
    const mockLog = (...args: unknown[]) => calls.push(args)
    tapCoachTokens(
      "来. 喘一下.",
      { turnId: "t2", userId: "u2", replyLength: 7 },
      mockLog
    )
    assert.equal(calls.length, 0, `expected 0 log calls on clean reply, got ${calls.length}`)
  })

  it("Test 11: tapCoachTokens returns void and does not mutate reply", () => {
    const original = "我建议你休息一下"
    const reply = original
    const result = tapCoachTokens(
      reply,
      { turnId: "t3", userId: "u3", replyLength: reply.length },
      () => undefined
    )
    // Return value is void (undefined)
    assert.equal(result, undefined, "expected tapCoachTokens to return void")
    // reply variable still has original value (strings are immutable in JS)
    assert.equal(reply, original, "reply should be unchanged")
  })
})

// --- Token truncation (12) ---

describe("detectCoachTokens — token truncation", () => {
  it("Test 12: token property is truncated to ≤40 chars", () => {
    // Build a string where the match could be very long
    const longText = "我建议你" + "x".repeat(100)
    const hits = detectCoachTokens(longText)
    assert.ok(hits.length >= 1, "expected at least 1 hit")
    for (const hit of hits) {
      assert.ok(
        hit.token.length <= 40,
        `expected token ≤40 chars, got "${hit.token}" (${hit.token.length} chars)`
      )
    }
  })
})
