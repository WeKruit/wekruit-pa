/**
 * iter30 Wave 3 — am_i_ai-deflector unit tests.
 *
 * Coverage matrix:
 *   - ZH flat-deny: "我是真人。" / "嗯，我是真人朋友。" / "没有，不是AI"
 *   - EN flat-deny: "I'm a real person." / "Not an AI." / "I am real human"
 *   - Pass-through: legitimate replies that mention AI / real but aren't a
 *     flat-deny ("AI 也帮不了你" / "real talk: ...") should NOT trigger.
 *   - Idempotency: re-running on substitute output is a no-op.
 *   - Empty / whitespace input: no-op.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { deflectAmIAiFlatDeny, __substitutes } from "./am-i-ai-deflector.js"

// ─── ZH flat-deny ──────────────────────────────────────────────────────────

test("zh: '嗯，我是真人朋友。' triggers substitution", () => {
  const out = deflectAmIAiFlatDeny("嗯，我是真人朋友。")
  assert.equal(out.applied, true)
  assert.equal(out.lang, "zh")
  assert.equal(out.text, __substitutes.zh)
})

test("zh: '我是真人。' triggers substitution", () => {
  const out = deflectAmIAiFlatDeny("我是真人。")
  assert.equal(out.applied, true)
  assert.equal(out.text, __substitutes.zh)
})

test("zh: bare '我是真人' (no period) triggers", () => {
  const out = deflectAmIAiFlatDeny("我是真人")
  assert.equal(out.applied, true)
  assert.equal(out.text, __substitutes.zh)
})

test("zh: '嗯，我是真人。' (with reaction) triggers", () => {
  const out = deflectAmIAiFlatDeny("嗯，我是真人。")
  assert.equal(out.applied, true)
})

test("zh: '没有，我不是 AI' triggers", () => {
  const out = deflectAmIAiFlatDeny("没有，我不是 AI")
  assert.equal(out.applied, true)
  assert.equal(out.text, __substitutes.zh)
})

test("zh: '不是 AI。' triggers", () => {
  const out = deflectAmIAiFlatDeny("不是 AI。")
  assert.equal(out.applied, true)
})

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

test("zh: legitimate reply mentioning AI is not stripped", () => {
  // The user vented; Claire's reply mentions AI in passing. Should pass through.
  const draft = "嗯，AI 帮不上你这个忙的。下次面试我陪你聊。"
  const out = deflectAmIAiFlatDeny(draft)
  assert.equal(out.applied, false)
  assert.equal(out.text, draft)
})

test("en: 'real talk:' opener is not stripped", () => {
  const draft = "real talk: this is rough but you got this."
  const out = deflectAmIAiFlatDeny(draft)
  assert.equal(out.applied, false)
  assert.equal(out.text, draft)
})

test("zh: longer reply with embedded '我是真人' clause is not stripped", () => {
  // Only matches at start with no surrounding content; mid-sentence safe.
  const draft = "你这么问让我想笑，先说说你今天怎么了。"
  const out = deflectAmIAiFlatDeny(draft)
  assert.equal(out.applied, false)
})

test("en: substantive reply with 'real' word is not stripped", () => {
  const draft = "yeah, that's a real concern. did you ask the recruiter?"
  const out = deflectAmIAiFlatDeny(draft)
  assert.equal(out.applied, false)
})

// ─── Idempotency ──────────────────────────────────────────────────────────

test("idempotent: substitute string itself is a no-op", () => {
  const out = deflectAmIAiFlatDeny(__substitutes.zh)
  assert.equal(out.applied, false, "substitute should not re-match")
})

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
  // The substitute must NOT contain the deceptive claim "I am human" /
  // "我是真人". Spec contract.
  assert.ok(!__substitutes.zh.includes("我是真人"))
  assert.ok(!__substitutes.zh.includes("真人朋友"))
  assert.ok(!/real\s+(person|human)/i.test(__substitutes.en))
  assert.ok(!/not\s+an?\s+ai/i.test(__substitutes.en))
})
