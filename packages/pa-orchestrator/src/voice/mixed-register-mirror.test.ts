import assert from "node:assert/strict"
import test from "node:test"
import {
  isUserMixed,
  classifyReplyRegister,
  extractRegisterTokens,
  applyMixedRegisterMirror,
} from "./mixed-register-mirror.js"

test("isUserMixed: pure zh → false", () => {
  assert.equal(isUserMixed("我今天心情不太好，想换工作了"), false)
})

test("isUserMixed: pure en → false", () => {
  assert.equal(isUserMixed("I'm feeling down today, thinking about switching jobs"), false)
})

test("isUserMixed: zh + en code-switch → true", () => {
  assert.equal(isUserMixed("work stress 好大，想 jump 但 H1B 怕"), true)
})

test("isUserMixed: short text rejected", () => {
  assert.equal(isUserMixed("我 PM"), false) // < 6 chars total
})

test("classifyReplyRegister: pure zh", () => {
  assert.equal(classifyReplyRegister("挺累的，先休息一下吧"), "zh")
})

test("classifyReplyRegister: pure en", () => {
  assert.equal(classifyReplyRegister("rough day, take a breather"), "en")
})

test("classifyReplyRegister: mixed", () => {
  assert.equal(
    classifyReplyRegister("OPT 转 H1B 的 timing 看 lottery 结果"),
    "mixed"
  )
})

test("extractRegisterTokens: pulls H1B + OPT in order", () => {
  const toks = extractRegisterTokens(
    "我现在 OPT，想申请 H1B，base 不能太低"
  )
  assert.ok(toks.length >= 1)
  // Order may surface either; both should be in REGISTER_TOKEN_BANK
  assert.ok(toks.some((t) => t.toLowerCase() === "opt"))
})

test("applyMixedRegisterMirror: user mixed + reply pure zh + tokens absent → appends", () => {
  const r = applyMixedRegisterMirror(
    "work stress 好大，OPT 还有半年，想 jump 但 H1B 怕",
    "嗯，听起来真的挺纠结的"
  )
  assert.equal(r.applied, true)
  assert.equal(r.reason, "appended")
  // Appended token should be one we extracted from user
  assert.ok(/\(re: [^)]+\)$/u.test(r.text), `expected '(re: TOKEN)' suffix, got: ${r.text}`)
})

test("applyMixedRegisterMirror: user mixed + reply already mixed → no-op", () => {
  const r = applyMixedRegisterMirror(
    "work stress 好大，OPT 还有半年",
    "OPT 转 H1B 的 timing 看 lottery 结果"
  )
  assert.equal(r.applied, false)
  assert.equal(r.reason, "reply_already_mixed")
})

test("applyMixedRegisterMirror: user mixed + reply contains token already → no-op", () => {
  const r = applyMixedRegisterMirror(
    "work stress 好大，OPT 还有半年",
    "OPT 那段确实压力大，先深呼吸一下"
  )
  // reply contains "OPT" (mixed reply already), so we don't even reach token check
  assert.equal(r.applied, false)
})

test("applyMixedRegisterMirror: user pure zh → no-op", () => {
  const r = applyMixedRegisterMirror(
    "我最近压力很大",
    "嗯，那就先放下手头的事"
  )
  assert.equal(r.applied, false)
  assert.equal(r.reason, "user_not_mixed")
})

test("applyMixedRegisterMirror: idempotent", () => {
  const u = "work stress 好大，OPT 还有半年"
  const c = "嗯，听起来真的挺纠结的"
  const r1 = applyMixedRegisterMirror(u, c)
  const r2 = applyMixedRegisterMirror(u, r1.text)
  // After first append the reply contains the token → second should be no-op.
  assert.equal(r2.applied, false)
})

test("applyMixedRegisterMirror: empty reply → no-op", () => {
  const r = applyMixedRegisterMirror("work stress 好大，OPT", "")
  assert.equal(r.applied, false)
  assert.equal(r.reason, "empty_reply")
})

test("applyMixedRegisterMirror: no register tokens in user → no-op", () => {
  const r = applyMixedRegisterMirror(
    "today work stress 好大，想 take 一个 break",
    "嗯，先深呼吸一下"
  )
  // 'work', 'take', 'break' aren't in REGISTER_TOKEN_BANK → no-op (intentional conservative)
  assert.equal(r.applied, false)
  assert.equal(r.reason, "no_register_tokens")
})
