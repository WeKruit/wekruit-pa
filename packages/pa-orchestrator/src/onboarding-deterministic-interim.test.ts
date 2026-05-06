/**
 * iter34 sprint A.7 — tests for composeInterimResumeAck.
 *
 * Adam directive: when the user uploads a resume the dispatcher fires
 * a SHORT human ack ("OK 让我看一下你简历...") right away so the user
 * knows Claire is reading, not ghosting. This file pins variant
 * shape, lang routing, length bounds, and forbidden-phrase safety.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { composeInterimResumeAck } from "./onboarding-deterministic.js"

const ZH_VARIANTS = [
  "OK 让我看一下你简历, 等我一下下",
  "稍等啊我快速过一下",
  "嗯 我读一下, 一两分钟的事",
  "好的 我先看看, 完了就给你推",
  "收到, 我扫一眼简历",
  "嗯嗯 给我一两分钟看下",
]

const EN_VARIANTS = [
  "ok lemme take a quick look at your resume, brb",
  "give me a sec to skim through",
  "hold on, reading now — a min or two",
  "alright lemme look at this real quick",
  "got it, scanning your resume now",
  "ok one sec, reading through",
]

const MIXED_VARIANTS = [
  "OK 让我 quick look 一下你简历 — 一两分钟",
  "稍等 lemme skim through",
  "好的 reading now, 完了推几个 jobs 给你",
  "嗯 give me a sec — 看完就来",
  "收到 scanning 一下, 一两分钟",
  "ok 让我 skim 一下简历, brb",
]

const FORBIDDEN_PHRASES = [
  "tomorrow",
  "9am",
  "9 am",
  "挂了",
  "processing your resume",
  "please wait",
  "正在处理",
]

// ────────────────────────────────────────────────────────────────────
// Lang routing
// ────────────────────────────────────────────────────────────────────

test("composeInterimResumeAck('zh') returns a curated zh variant", () => {
  for (let i = 0; i < 20; i++) {
    const out = composeInterimResumeAck("zh")
    assert.ok(
      ZH_VARIANTS.includes(out),
      `expected zh variant, got: ${out}`,
    )
  }
})

test("composeInterimResumeAck('en') returns a curated en variant", () => {
  for (let i = 0; i < 20; i++) {
    const out = composeInterimResumeAck("en")
    assert.ok(
      EN_VARIANTS.includes(out),
      `expected en variant, got: ${out}`,
    )
  }
})

test("composeInterimResumeAck('mixed') returns a curated mixed variant containing zh + en chars", () => {
  for (let i = 0; i < 20; i++) {
    const out = composeInterimResumeAck("mixed")
    assert.ok(
      MIXED_VARIANTS.includes(out),
      `expected mixed variant, got: ${out}`,
    )
    assert.match(out, /[一-鿿]/, `mixed should contain CJK: ${out}`)
    assert.match(out, /[a-zA-Z]/, `mixed should contain ASCII letters: ${out}`)
  }
})

// ────────────────────────────────────────────────────────────────────
// Variant distribution — not strict-random, just sanity ≥2 distinct
// ────────────────────────────────────────────────────────────────────

test("composeInterimResumeAck cycles variants — ≥2 distinct outputs over 20 calls", () => {
  for (const lang of ["zh", "en", "mixed"] as const) {
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      seen.add(composeInterimResumeAck(lang))
    }
    assert.ok(
      seen.size >= 2,
      `lang=${lang}: expected ≥2 distinct variants over 20 calls, got ${seen.size}`,
    )
  }
})

// ────────────────────────────────────────────────────────────────────
// Length bounds — short messages only, no robot speeches
// ────────────────────────────────────────────────────────────────────

test("zh variants are ≤60 chars (code-points)", () => {
  for (const v of ZH_VARIANTS) {
    assert.ok(
      [...v].length <= 60,
      `zh variant too long (${[...v].length}): ${v}`,
    )
  }
})

test("en variants are ≤80 chars", () => {
  for (const v of EN_VARIANTS) {
    assert.ok(v.length <= 80, `en variant too long (${v.length}): ${v}`)
  }
})

test("mixed variants are ≤60 chars (code-points)", () => {
  for (const v of MIXED_VARIANTS) {
    assert.ok(
      [...v].length <= 60,
      `mixed variant too long (${[...v].length}): ${v}`,
    )
  }
})

// ────────────────────────────────────────────────────────────────────
// Forbidden-phrase safety — no robot tone, no morning-job-rec phrasing
// ────────────────────────────────────────────────────────────────────

test("variants never contain forbidden robot/scheduling phrases", () => {
  const all = [...ZH_VARIANTS, ...EN_VARIANTS, ...MIXED_VARIANTS]
  for (const v of all) {
    const lower = v.toLowerCase()
    for (const bad of FORBIDDEN_PHRASES) {
      assert.ok(
        !lower.includes(bad.toLowerCase()),
        `variant contains forbidden phrase "${bad}": ${v}`,
      )
    }
  }
})

test("variants never contain emojis", () => {
  // Conservative emoji range — covers most pictographs we'd accidentally
  // include. Onboarding voice is plain-text friend-tone, no emojis.
  const emojiRe =
    /[\u{1F300}-\u{1FAFF}\u{1F600}-\u{1F64F}\u{2600}-\u{27BF}]/u
  const all = [...ZH_VARIANTS, ...EN_VARIANTS, ...MIXED_VARIANTS]
  for (const v of all) {
    assert.ok(!emojiRe.test(v), `variant contains emoji: ${v}`)
  }
})

// ────────────────────────────────────────────────────────────────────
// Deterministic-rng injection (for tests / replay)
// ────────────────────────────────────────────────────────────────────

test("composeInterimResumeAck honors injected rng (deterministic)", () => {
  // rng=()=>0 → first variant
  assert.equal(
    composeInterimResumeAck("zh", () => 0),
    ZH_VARIANTS[0],
  )
  assert.equal(
    composeInterimResumeAck("en", () => 0),
    EN_VARIANTS[0],
  )
  assert.equal(
    composeInterimResumeAck("mixed", () => 0),
    MIXED_VARIANTS[0],
  )
  // rng=()=>0.999 → last variant
  assert.equal(
    composeInterimResumeAck("zh", () => 0.999),
    ZH_VARIANTS[ZH_VARIANTS.length - 1],
  )
})

test("composeInterimResumeAck guards against rng() === 1 (no undefined return)", () => {
  // Math.random() spec is [0,1) but defensive guard means even rng()===1
  // returns a real string, not undefined.
  const out = composeInterimResumeAck("zh", () => 1)
  assert.equal(typeof out, "string")
  assert.ok(out.length > 0)
})
