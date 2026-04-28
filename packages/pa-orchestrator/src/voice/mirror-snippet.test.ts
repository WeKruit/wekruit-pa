import assert from "node:assert/strict"
import test from "node:test"
import { buildMirrorSnippet } from "./mirror-snippet.js"
import type { StyleSnapshot } from "./style-analyzer.js"

function snap(o: Partial<StyleSnapshot>): StyleSnapshot {
  return {
    register_score: 0.5,
    zh_char_ratio: 0.5,
    emoji_freq: 0,
    avg_sentence_len: 12,
    slang_hits: 0,
    sample_size: 3,
    ...o,
  }
}

test("buildMirrorSnippet returns null when sample_size === 0", () => {
  assert.equal(buildMirrorSnippet(snap({ sample_size: 0 })), null)
})

test("buildMirrorSnippet returns string when sample_size > 0", () => {
  const out = buildMirrorSnippet(snap({}))
  assert.equal(typeof out, "string")
  assert.ok(out!.length > 0)
})

test("formal snapshot mentions formal register and complete sentences", () => {
  const out = buildMirrorSnippet(
    snap({ register_score: 0.85, slang_hits: 0, emoji_freq: 0, avg_sentence_len: 30 })
  )!
  assert.match(out, /formal/i)
})

test("slangy snapshot mentions short / casual / code-switch", () => {
  const out = buildMirrorSnippet(
    snap({ register_score: 0.2, slang_hits: 3, emoji_freq: 1.5, avg_sentence_len: 6 })
  )!
  // Casual descriptor present.
  assert.match(out, /short|casual|slang/i)
})

test("high zh_char_ratio (>=0.8) labels primary language as 中文", () => {
  const out = buildMirrorSnippet(snap({ zh_char_ratio: 0.9 }))!
  assert.match(out, /中文|zh/i)
})

test("low zh_char_ratio (<=0.2) labels primary language as English", () => {
  const out = buildMirrorSnippet(snap({ zh_char_ratio: 0.05 }))!
  assert.match(out, /English|en\b/i)
})

test("mixed (0.05-0.5) labels code-switch ok", () => {
  // Phase 19 thresholds: zh >= 0.5 → "zh"; zh <= 0.05 → "en"; else "mix"
  const out = buildMirrorSnippet(snap({ zh_char_ratio: 0.3 }))!
  assert.match(out, /code-switch|zh-en|mix/i)
})

test("no emoji snapshot says no emoji", () => {
  const out = buildMirrorSnippet(snap({ emoji_freq: 0 }))!
  assert.match(out, /no emoji/i)
})

test("emoji-heavy snapshot says emoji 1 per turn ok", () => {
  const out = buildMirrorSnippet(snap({ emoji_freq: 3 }))!
  assert.match(out, /emoji/i)
  // Positive framing only — should NOT say "don't" or "avoid".
  assert.doesNotMatch(out, /don'?t|avoid|never/i)
})

test("LOAD-BEARING: snippet contains NO negative-instruction tokens (D-03)", () => {
  // 20 varied snapshots covering register × language × emoji buckets.
  const variants: Partial<StyleSnapshot>[] = []
  for (const reg of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    for (const zh of [0.0, 0.5, 1.0]) {
      for (const em of [0, 2.5]) {
        variants.push({ register_score: reg, zh_char_ratio: zh, emoji_freq: em, slang_hits: reg < 0.4 ? 3 : 0 })
      }
    }
  }
  // Trim to 20.
  const sample = variants.slice(0, 20)
  const negative = /\b(don'?t|never|avoid|do not)\b|不要|别(?!的)|禁止|严禁/i
  for (const v of sample) {
    const out = buildMirrorSnippet(snap(v))
    assert.ok(out, `expected non-null snippet for ${JSON.stringify(v)}`)
    assert.doesNotMatch(out!, negative, `negative phrasing in: ${out}`)
  }
})

test("snippet length is between 30 and 400 chars (compact, signal-bearing)", () => {
  const out = buildMirrorSnippet(snap({ register_score: 0.2, slang_hits: 3 }))!
  assert.ok(out.length >= 30, `too short: ${out.length}`)
  assert.ok(out.length <= 400, `too long: ${out.length}`)
})

test("snippet opens with Meta-AI-style 'User is currently'", () => {
  const out = buildMirrorSnippet(snap({}))!
  assert.match(out, /^User is currently/i)
})
