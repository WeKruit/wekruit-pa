/**
 * Tests for context-window.ts — long-context humanize control.
 * Covers token estimation heuristic + sliding-window truncation contract.
 */
import assert from "node:assert/strict"
import test, { describe } from "node:test"

import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_TURNS,
  estimateHistoryTokens,
  estimateTokens,
  truncateHistoryByTokens,
} from "./context-window.js"

// ────────── helpers ──────────

function makeMessage(body: string) {
  return { body }
}

function makeHistory(n: number, bodyFor: (i: number) => string) {
  return Array.from({ length: n }, (_, i) => makeMessage(bodyFor(i)))
}

// ────────── estimateTokens ──────────

describe("estimateTokens", () => {
  test("empty / null / undefined → 0", () => {
    assert.equal(estimateTokens(""), 0)
    assert.equal(estimateTokens(null), 0)
    assert.equal(estimateTokens(undefined), 0)
  })

  test("pure CJK — '我想找工作' → 5 tokens (1 per char)", () => {
    assert.equal(estimateTokens("我想找工作"), 5)
  })

  test("CJK punctuation counts as CJK token — '今晚先睡吧。' → 6", () => {
    assert.equal(estimateTokens("今晚先睡吧。"), 6)
  })

  test("pure ASCII — 'hello world how are you' (5 words) → ceil(5*1.3) = 7", () => {
    assert.equal(estimateTokens("hello world how are you"), 7)
  })

  test("mixed CJK + ASCII — 'AI工程师 swe role' → 3 CJK + ceil(3*1.3)=4 = 7", () => {
    // CJK: 工 程 师 = 3
    // ASCII words after CJK strip: AI swe role = 3 → ceil(3*1.3) = 4
    assert.equal(estimateTokens("AI工程师 swe role"), 7)
  })

  test("Korean syllables count as CJK — '안녕하세요' → 5", () => {
    assert.equal(estimateTokens("안녕하세요"), 5)
  })

  test("Japanese hiragana counts as CJK — 'こんにちは' → 5", () => {
    assert.equal(estimateTokens("こんにちは"), 5)
  })
})

// ────────── estimateHistoryTokens ──────────

describe("estimateHistoryTokens", () => {
  test("empty array → 0", () => {
    assert.equal(estimateHistoryTokens([]), 0)
  })

  test("3-message history adds per-message overhead (4 each)", () => {
    const h = [
      makeMessage("我想找工作"), // 5 tokens
      makeMessage("好的"), // 2 tokens
      makeMessage("你想找什么类型的"), // 8 tokens
    ]
    // 5 + 2 + 8 = 15 content + 3 messages * 4 overhead = 27
    assert.equal(estimateHistoryTokens(h), 27)
  })
})

// ────────── truncateHistoryByTokens ──────────

describe("truncateHistoryByTokens", () => {
  test("empty history returns empty result with no-op flags", () => {
    const r = truncateHistoryByTokens([])
    assert.equal(r.kept.length, 0)
    assert.equal(r.droppedCount, 0)
    assert.equal(r.truncated, false)
    assert.equal(r.keptTokens, 0)
    assert.equal(r.originalTokens, 0)
  })

  test("history shorter than minTurns is returned unchanged", () => {
    const h = makeHistory(5, (i) => `turn-${i} 你好`)
    const r = truncateHistoryByTokens(h)
    assert.equal(r.kept.length, 5)
    assert.equal(r.droppedCount, 0)
    assert.equal(r.truncated, false)
  })

  test("20-turn long history truncates and keeps recent tail (Adam spec)", () => {
    // Each turn ~120 CJK tokens → 20 turns ~ 2400 + 80 overhead = 2480 tokens
    const h = makeHistory(20, (i) => "好的我明白你的感受这是一段很长的回复".repeat(8) + `idx${i}`)
    const r = truncateHistoryByTokens(h, { maxTokens: 1500, minTurns: DEFAULT_MIN_TURNS })
    assert.ok(r.truncated, "should have truncated")
    assert.ok(r.kept.length <= 20, "kept ≤ original")
    assert.ok(r.kept.length >= DEFAULT_MIN_TURNS, "kept ≥ minTurns floor")
    assert.ok(r.keptTokens <= r.originalTokens, "kept tokens ≤ original")
    // Most-recent turn (idx19) MUST be in the kept slice.
    assert.ok(r.kept[r.kept.length - 1]!.body.includes("idx19"))
  })

  test("when minTurns tail itself exceeds budget, still keep minTurns (most-recent inviolable)", () => {
    // 8 turns each 1000 CJK tokens → 8000 tokens >> 1500 budget.
    const h = makeHistory(8, (i) => "字".repeat(1000) + `i${i}`)
    const r = truncateHistoryByTokens(h, { maxTokens: 1500, minTurns: 8 })
    assert.equal(r.kept.length, 8, "minTurns floor honored even when over budget")
    assert.equal(r.droppedCount, 0)
    // truncated flag is false because no turn was dropped (floor protects them).
    assert.equal(r.truncated, false)
  })

  test("default budget keeps tail under DEFAULT_MAX_TOKENS when possible", () => {
    // 20 small CJK turns of ~10 tokens each → total ≈ 200 + 80 overhead = 280
    const h = makeHistory(20, (i) => `第${i}轮回复`)
    const r = truncateHistoryByTokens(h)
    assert.equal(r.kept.length, 20)
    assert.equal(r.truncated, false)
    assert.ok(r.keptTokens <= DEFAULT_MAX_TOKENS)
  })

  test("contiguous tail invariant — no gaps in the kept slice", () => {
    const h = makeHistory(15, (i) => `unique-${i} 你好你好你好你好你好你好你好你好你好你好你好你好`)
    const r = truncateHistoryByTokens(h, { maxTokens: 600, minTurns: 4 })
    // Whatever k turns are kept, they must be the LAST k of the input.
    const expectedTail = h.slice(h.length - r.kept.length)
    assert.deepEqual(r.kept, expectedTail)
  })

  test("Adam spec — 20-turn ~5000-token history truncates to ≤ ~1500-token estimate", () => {
    // 20 turns averaging 250 CJK chars each → ~5000 raw + 80 overhead.
    const h = makeHistory(20, (i) => "好的".repeat(125) + `i${i}`)
    const before = estimateHistoryTokens(h)
    assert.ok(before >= 4000, `precondition: history should be heavy (got ${before})`)
    const r = truncateHistoryByTokens(h)
    // Kept slice should fit within budget OR be exactly the minTurns floor.
    assert.ok(
      r.keptTokens <= DEFAULT_MAX_TOKENS || r.kept.length === DEFAULT_MIN_TURNS,
      `keptTokens=${r.keptTokens} kept=${r.kept.length}`
    )
    assert.ok(r.droppedCount > 0, "long history should drop at least one turn")
  })

  test("recent user message preserved — last entry is always kept", () => {
    const h = makeHistory(30, (i) => "字".repeat(200) + `idx${i}`)
    const r = truncateHistoryByTokens(h, { maxTokens: 1500, minTurns: 8 })
    assert.ok(r.kept.length > 0)
    // Last kept message is the same object as the last input message.
    assert.equal(r.kept[r.kept.length - 1], h[h.length - 1])
  })

  test("custom maxTokens and minTurns are honored", () => {
    const h = makeHistory(20, (i) => "你好".repeat(50) + `i${i}`) // ~100 CJK tokens each
    const r = truncateHistoryByTokens(h, { maxTokens: 500, minTurns: 3 })
    assert.ok(r.kept.length >= 3, "minTurns honored")
    // 500 token budget cannot fit many ~104-token turns; truncation expected.
    assert.ok(r.truncated, "should truncate under tight budget")
  })

  test("non-array input (defensive) returns empty result, no throw", () => {
    // Cast to avoid TS — mirrors a defensive runtime call from JS.
    const r = truncateHistoryByTokens(null as unknown as Array<{ body: string }>)
    assert.equal(r.kept.length, 0)
    assert.equal(r.truncated, false)
  })
})
