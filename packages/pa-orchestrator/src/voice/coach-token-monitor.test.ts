/**
 * Phase 24 T1D — coach-token-monitor unit tests.
 *
 * behavior cases:
 *   pattern match (one per category)
 *   false-positive guard on clean Claire replies
 *   tapCoachTokens log invocation
 *   tapCoachTokens signature returns void (no mutation)
 *   token truncation ≤ 40 chars
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectCoachTokens, tapCoachTokens } from "./coach-token-monitor.js"

// --- Pattern match tests ---

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
    const hits = detectCoachTokens("do this, and then that, after that this, and then finally that")
    assert.ok(hits.length >= 1, `expected ≥1 hit, got ${hits.length}`)
    assert.ok(
      hits.some((h) => h.pattern === "subordinate_chain_4plus"),
      `expected pattern "subordinate_chain_4plus", got ${JSON.stringify(hits)}`
    )
  })
})

// --- False-positive guard on clean Claire replies ---

describe("detectCoachTokens — false-positive guard (clean Claire replies)", () => {
  it("Test 6: no hits on short reaction reply", () => {
    const hits = detectCoachTokens("quick reject means they weren't ready for you. next.")
    assert.equal(
      hits.length,
      0,
      `expected 0 hits on clean reply, got ${JSON.stringify(hits)}`
    )
  })

  it("Test 7: no hits on short emo reply", () => {
    const hits = detectCoachTokens("maybe they reply next week. or silent reject. don't emo first.")
    assert.equal(
      hits.length,
      0,
      `expected 0 hits on clean reply, got ${JSON.stringify(hits)}`
    )
  })

  it("Test 8: no hits on tiny reaction", () => {
    const hits = detectCoachTokens("come on. breathe.")
    assert.equal(
      hits.length,
      0,
      `expected 0 hits on clean reply, got ${JSON.stringify(hits)}`
    )
  })
})

// --- tapCoachTokens behavior ---

describe("tapCoachTokens — log invocation", () => {
  it("Test 9: invokes log with pa.voice.coach_token.observed when hits exist", () => {
    const calls: unknown[][] = []
    const mockLog = (...args: unknown[]) => calls.push(args)
    tapCoachTokens(
      "I suggest you make a plan",
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
      "come on. breathe.",
      { turnId: "t2", userId: "u2", replyLength: 7 },
      mockLog
    )
    assert.equal(calls.length, 0, `expected 0 log calls on clean reply, got ${calls.length}`)
  })

  it("Test 11: tapCoachTokens returns void and does not mutate reply", () => {
    const original = "I suggest you take a rest"
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

// --- Token truncation ---

describe("detectCoachTokens — token truncation", () => {
  it("Test 12: token property is truncated to ≤40 chars", () => {
    // Build a string where the match could be very long
    const longText = "I suggest " + "x".repeat(100)
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
