/**
 * Layer 1 unit tests — q_email_verify (CodeJudge: 6-digit regex).
 *
 * Without ctx.db, judge takes the "no_db_accept" test-friendly path so we
 * test pure 6-digit regex extraction.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { CodeJudge } from "../judges/code.js"
import type { JudgeCtx } from "../question.js"

function ctx(): JudgeCtx {
  return { userId: "u", turnId: "t" }
}
const J = new CodeJudge()

test("q-email-verify: '123456' → accept value=123456", async () => {
  const r = await J.judge("123456", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "123456")
})

test("q-email-verify: 'code is 987654' → accept value=987654", async () => {
  const r = await J.judge("code is 987654", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "987654")
})

test("q-email-verify: '验证码 482910' → accept value=482910", async () => {
  const r = await J.judge("验证码 482910", "zh", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "482910")
})

test("q-email-verify: '12345' (5 digits) → irrelevant", async () => {
  const r = await J.judge("12345", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})

test("q-email-verify: '1234567' (7 digits) → ambiguous, regex still matches first 6 NOT — boundary skips", async () => {
  // \b1234567\b matches the whole 7-digit run; \d{6} with \b on both sides
  // requires a 6-digit run bounded by non-digits. So '1234567' → no \b\d{6}\b.
  const r = await J.judge("1234567", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})

test("q-email-verify: 'abcdef' (no digits) → irrelevant", async () => {
  const r = await J.judge("abcdef", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})

test("q-email-verify: '  654321  ' (whitespace pad) → accept", async () => {
  const r = await J.judge("  654321  ", "en", ctx())
  assert.equal(r.accept, true)
  if (r.accept) assert.equal(r.value, "654321")
})

test("q-email-verify: empty → irrelevant", async () => {
  const r = await J.judge("", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})
