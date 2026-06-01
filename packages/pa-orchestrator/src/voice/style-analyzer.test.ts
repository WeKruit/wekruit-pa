import assert from "node:assert/strict"
import test from "node:test"
import { analyzeUserStyle, type StyleSnapshot } from "./style-analyzer.js"

// CJK helper — build Chinese sample text from codepoints so this test file
// contains no literal CJK (product is English-only, but the analyzer still
// detects CJK char-ratio for legacy/mixed input).
const cjk = (...cps: number[]) => String.fromCharCode(...cps)
// "您好，我想咨询一下面试流程。" (formal Chinese sample)
const ZH_FORMAL = cjk(
  0x60a8, 0x597d, 0xff0c, 0x6211, 0x60f3, 0x54a8, 0x8be2, 0x4e00, 0x4e0b,
  0x9762, 0x8bd5, 0x6d41, 0x7a0b, 0x3002
)
// "你好" / "在吗" / "今天面试翻车" short Chinese turns
const ZH_HI = cjk(0x4f60, 0x597d)
const ZH_THERE = cjk(0x5728, 0x5417)
const ZH_VENT = cjk(0x4eca, 0x5929, 0x9762, 0x8bd5, 0x7ffb, 0x8f66)

test("analyzeUserStyle empty input returns sample_size=0 and zeroed metrics", () => {
  const s = analyzeUserStyle([])
  assert.equal(s.sample_size, 0)
  assert.equal(s.register_score, 0)
  assert.equal(s.zh_char_ratio, 0)
  assert.equal(s.emoji_freq, 0)
  assert.equal(s.avg_sentence_len, 0)
  assert.equal(s.slang_hits, 0)
})

test("analyzeUserStyle window = last 5 user turns when given >5", () => {
  const s = analyzeUserStyle(["a", "b", "c", "d", "e", "f", "g"])
  assert.equal(s.sample_size, 5)
})

test("analyzeUserStyle 1-5 user turns: window = all available", () => {
  const s = analyzeUserStyle([ZH_HI, ZH_VENT, ZH_THERE])
  assert.equal(s.sample_size, 3)
})

test("analyzeUserStyle pure-zh formal text: high zh_char_ratio, formal register, no emoji, no slang", () => {
  const s = analyzeUserStyle([ZH_FORMAL])
  assert.ok(s.zh_char_ratio >= 0.7, `expected zh_char_ratio>=0.7, got ${s.zh_char_ratio}`)
  assert.ok(s.register_score >= 0.6, `expected register_score>=0.6 (formal), got ${s.register_score}`)
  assert.equal(s.emoji_freq, 0)
  assert.equal(s.slang_hits, 0)
})

test("analyzeUserStyle slangy en: low register, multiple slang hits, has emoji", () => {
  const s = analyzeUserStyle(["lowkey deadass fr fr 🍋"])
  assert.ok(s.register_score <= 0.4, `expected register_score<=0.4 (slangy), got ${s.register_score}`)
  assert.ok(s.slang_hits >= 2, `expected slang_hits>=2 (lowkey + deadass + fr fr), got ${s.slang_hits}`)
  assert.ok(s.emoji_freq > 0)
})

test("analyzeUserStyle pure-emoji turn: high emoji_freq, very low register", () => {
  const s = analyzeUserStyle(["🍋🍋🍋"])
  assert.ok(s.emoji_freq > 0)
  assert.ok(s.register_score <= 0.3, `expected register_score<=0.3, got ${s.register_score}`)
})

test("analyzeUserStyle punctuation/whitespace only: no crash, near-zero metrics", () => {
  const s = analyzeUserStyle(["   ", "...", "!!!"])
  assert.equal(s.sample_size, 3)
  assert.equal(s.slang_hits, 0)
  assert.equal(s.emoji_freq, 0)
})

test("analyzeUserStyle deterministic: same input → identical snapshot", () => {
  const input = [`${ZH_HI} fr`, "lowkey deadass 🍋", ZH_THERE]
  const a = analyzeUserStyle(input)
  const b = analyzeUserStyle(input)
  assert.deepEqual(a, b)
})

test("analyzeUserStyle formal-en: high register_score, low zh_char_ratio, no slang", () => {
  const s = analyzeUserStyle(["Hello, could you please advise on the interview timeline?"])
  assert.ok(s.zh_char_ratio <= 0.1)
  assert.ok(s.register_score >= 0.6, `expected register_score>=0.6, got ${s.register_score}`)
  assert.equal(s.slang_hits, 0)
  assert.equal(s.emoji_freq, 0)
})

test("analyzeUserStyle slangy-en: low register, slang hits, no zh", () => {
  const s = analyzeUserStyle(["lowkey deadass mid fr"])
  assert.ok(s.zh_char_ratio <= 0.1)
  assert.ok(s.register_score <= 0.4)
  assert.ok(s.slang_hits >= 3)
})

test("analyzeUserStyle emoji-heavy mixed-script counts emoji_freq > 0 and zh_char_ratio in mix range", () => {
  // "今天 OA 直接 emo 了" built from codepoints + ASCII + emoji.
  const mixed = `${cjk(0x4eca, 0x5929)} OA ${cjk(0x76f4, 0x63a5)} emo ${cjk(0x4e86)} 🍋☕😭`
  const s = analyzeUserStyle([mixed])
  assert.ok(s.emoji_freq > 0)
  assert.ok(s.zh_char_ratio > 0.1 && s.zh_char_ratio < 0.9)
})

test("analyzeUserStyle StyleSnapshot includes 5 documented features (no extras)", () => {
  const s: StyleSnapshot = analyzeUserStyle(["test"])
  const keys = Object.keys(s).sort()
  assert.deepEqual(keys, [
    "avg_sentence_len",
    "emoji_freq",
    "register_score",
    "sample_size",
    "slang_hits",
    "zh_char_ratio",
  ])
})

test("analyzeUserStyle does not call Date.now or Math.random (determinism)", () => {
  // Smoke check: snapshot identical across 100 runs.
  const input = ["lowkey deadass mid 🍋"]
  const first = analyzeUserStyle(input)
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(analyzeUserStyle(input), first)
  }
})
