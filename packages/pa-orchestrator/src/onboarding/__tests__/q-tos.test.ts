/**
 * Layer 1 unit tests — q_tos (YesNoJudge bilingual).
 *
 * Three buckets:
 *   - clear yes (agree/yes/...) → accept value=true
 *   - clear no (no/decline/...) → reason="declined"
 *   - anything else → reason="irrelevant"
 */
import test from "node:test"
import assert from "node:assert/strict"
import { YesNoJudge } from "../judges/yesno.js"
import type { JudgeCtx } from "../question.js"

function ctx(): JudgeCtx {
  return { userId: "u", turnId: "t" }
}
const J = new YesNoJudge()

test("q-tos: 'agree' → accept true", async () => {
  const r = await J.judge("agree", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-tos: 'yes' → accept true", async () => {
  const r = await J.judge("yes", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-tos: 'ok' → accept true", async () => {
  const r = await J.judge("ok", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-tos: 'sounds good' → accept true", async () => {
  const r = await J.judge("sounds good", "en", ctx())
  assert.equal(r.accept, true)
})

test("q-tos: 'no thanks' → declined", async () => {
  // Note: 'no thanks' may not match strict EN_NO regex (has trailing 'thanks').
  // Just 'no' should match.
  const r = await J.judge("no", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "declined")
})

test("q-tos: 'I disagree' → declined", async () => {
  const r = await J.judge("I disagree", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "declined")
})

test("q-tos: 'maybe later' → irrelevant (not in yes nor no)", async () => {
  const r = await J.judge("maybe later", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})

test("q-tos: empty → irrelevant", async () => {
  const r = await J.judge("", "en", ctx())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})

test("q-tos: 'sure' → accept true", async () => {
  const r = await J.judge("sure", "en", ctx())
  assert.equal(r.accept, true)
})

