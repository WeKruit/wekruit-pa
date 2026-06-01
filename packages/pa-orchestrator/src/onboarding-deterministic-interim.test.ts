/**
 * iter34 sprint A.7 — tests for composeInterimResumeAck.
 *
 * Adam directive: when the user uploads a resume the dispatcher fires
 * a SHORT human ack ("ok — give me a sec to read your resume...") right
 * away so the user knows Claire is reading, not ghosting. This file pins
 * variant shape, lang routing, length bounds, and forbidden-phrase safety.
 *
 * Product is English-only — every lang routes to the English variant set.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { composeInterimResumeAck } from "./onboarding-deterministic.js"

const EN_VARIANTS = [
  "ok lemme take a quick look at your resume, brb",
  "give me a sec to skim through",
  "hold on, reading now — a min or two",
  "alright lemme look at this real quick",
  "got it, scanning your resume now",
  "ok one sec, reading through",
]

// English-only product: zh / mixed resolve to the same English variant set.
const ZH_VARIANTS = EN_VARIANTS
const MIXED_VARIANTS = EN_VARIANTS

const FORBIDDEN_PHRASES = [
  "tomorrow",
  "9am",
  "9 am",
  "processing your resume",
  "please wait",
]

// ────────────────────────────────────────────────────────────────────
// Lang routing
// ────────────────────────────────────────────────────────────────────

test("composeInterimResumeAck('zh') returns a curated (English) variant", () => {
  for (let i = 0; i < 20; i++) {
    const out = composeInterimResumeAck("zh")
    assert.ok(
      EN_VARIANTS.includes(out),
      `expected English variant, got: ${out}`,
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

test("composeInterimResumeAck('mixed') returns a curated (English) variant", () => {
  for (let i = 0; i < 20; i++) {
    const out = composeInterimResumeAck("mixed")
    assert.ok(
      EN_VARIANTS.includes(out),
      `expected English variant, got: ${out}`,
    )
    assert.match(out, /[a-zA-Z]/, `should contain ASCII letters: ${out}`)
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

test("en variants are ≤80 chars", () => {
  for (const v of EN_VARIANTS) {
    assert.ok(v.length <= 80, `en variant too long (${v.length}): ${v}`)
  }
})

// ────────────────────────────────────────────────────────────────────
// Forbidden-phrase safety — no robot tone, no morning-job-rec phrasing
// ────────────────────────────────────────────────────────────────────

test("variants never contain forbidden robot/scheduling phrases", () => {
  for (const v of EN_VARIANTS) {
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
  for (const v of EN_VARIANTS) {
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
    EN_VARIANTS[0],
  )
  assert.equal(
    composeInterimResumeAck("en", () => 0),
    EN_VARIANTS[0],
  )
  assert.equal(
    composeInterimResumeAck("mixed", () => 0),
    EN_VARIANTS[0],
  )
  // rng=()=>0.999 → last variant
  assert.equal(
    composeInterimResumeAck("en", () => 0.999),
    EN_VARIANTS[EN_VARIANTS.length - 1],
  )
})

test("composeInterimResumeAck guards against rng() === 1 (no undefined return)", () => {
  // Math.random() spec is [0,1) but defensive guard means even rng()===1
  // returns a real string, not undefined.
  const out = composeInterimResumeAck("zh", () => 1)
  assert.equal(typeof out, "string")
  assert.ok(out.length > 0)
})
