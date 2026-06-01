/**
 * Layer 1 unit tests — q_lang (LangJudge regex; no LLM).
 *
 * P7-5 Wave 2 — Adam directive: each Q its own test file. q_lang uses
 * LangJudge (deterministic regex), so no LLM stub needed. Product is
 * English-only, so the judge resolves meaningful replies to en / mixed.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { LangJudge } from "../judges/lang.js"
import type { JudgeCtx } from "../question.js"

function ctx(): JudgeCtx {
  return { userId: "u", turnId: "t" }
}
const J = new LangJudge()

test("q-lang: 'English' → en", async () => {
  const r = await J.judge("English", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "en")
})

test("q-lang: 'mixed' → mixed", async () => {
  const r = await J.judge("mixed", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "mixed")
})

test("q-lang: 'EN' (uppercase) → en", async () => {
  const r = await J.judge("EN", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "en")
})

test("q-lang: empty reply → irrelevant", async () => {
  const r = await J.judge("   ", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})

test("q-lang: nonsense 'pizza' → irrelevant", async () => {
  const r = await J.judge("pizza is fine", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})

test("q-lang: 'both' → mixed", async () => {
  const r = await J.judge("both", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "mixed")
})
