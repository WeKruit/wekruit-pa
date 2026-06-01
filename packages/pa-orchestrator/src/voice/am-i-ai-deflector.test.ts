/**
 * iter30 Wave 3 — am_i_ai-deflector unit tests.
 *
 * Coverage matrix:
 *   - EN flat-deny: "I'm a real person." / "Not an AI." / "I am real human"
 *   - Pass-through: legitimate replies that mention AI / real but aren't a
 *     flat-deny ("real talk: ...") should NOT trigger.
 *   - Idempotency: re-running on substitute output is a no-op.
 *   - Empty / whitespace input: no-op.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { deflectAmIAiFlatDeny, __substitutes } from "./am-i-ai-deflector.js"

// ─── EN flat-deny ──────────────────────────────────────────────────────────

test("en: \"I'm a real person.\" triggers", () => {
  const out = deflectAmIAiFlatDeny("I'm a real person.")
  assert.equal(out.applied, true)
  assert.equal(out.lang, "en")
  assert.equal(out.text, __substitutes.en)
})

test("en: \"I am a real human\" triggers", () => {
  const out = deflectAmIAiFlatDeny("I am a real human")
  assert.equal(out.applied, true)
  assert.equal(out.text, __substitutes.en)
})

test("en: 'Not an AI.' triggers", () => {
  const out = deflectAmIAiFlatDeny("Not an AI.")
  assert.equal(out.applied, true)
})

test("en: \"I'm not AI\" triggers", () => {
  const out = deflectAmIAiFlatDeny("I'm not AI")
  assert.equal(out.applied, true)
})

test("en: 'no, I am not an AI' triggers", () => {
  const out = deflectAmIAiFlatDeny("no, I am not an AI")
  assert.equal(out.applied, true)
})

// ─── Pass-through (must NOT trigger) ───────────────────────────────────────

test("en: 'real talk:' opener is not stripped", () => {
  const draft = "real talk: this is rough but you got this."
  const out = deflectAmIAiFlatDeny(draft)
  assert.equal(out.applied, false)
  assert.equal(out.text, draft)
})

test("en: substantive reply with 'real' word is not stripped", () => {
  const draft = "yeah, that's a real concern. did you ask the recruiter?"
  const out = deflectAmIAiFlatDeny(draft)
  assert.equal(out.applied, false)
})

// ─── Idempotency ──────────────────────────────────────────────────────────

test("idempotent: en substitute is a no-op", () => {
  const out = deflectAmIAiFlatDeny(__substitutes.en)
  assert.equal(out.applied, false)
})

// ─── Edge cases ───────────────────────────────────────────────────────────

test("empty input is no-op", () => {
  const out = deflectAmIAiFlatDeny("")
  assert.equal(out.applied, false)
  assert.equal(out.text, "")
})

test("whitespace input is no-op", () => {
  const out = deflectAmIAiFlatDeny("   \n  ")
  assert.equal(out.applied, false)
})

test("substitution preserves friend-tone (no claim of humanity)", () => {
  // The substitute must NOT contain the deceptive claim "I am human". Spec contract.
  assert.ok(!/real\s+(person|human)/i.test(__substitutes.en))
  assert.ok(!/not\s+an?\s+ai/i.test(__substitutes.en))
})
