import assert from "node:assert/strict"
import test from "node:test"
import { buildSlangInjection } from "./slang-injector.js"

test("empty userMessage → directive null", () => {
  const r = buildSlangInjection({ userMessage: "", seed: "x" })
  assert.equal(r.directive, null)
  assert.deepEqual(r.picked, [])
})

test("zh user → zh slang directive", () => {
  const r = buildSlangInjection({
    userMessage: "我最近真的好崩溃啊 工作累死了",
    seed: "zh-test",
  })
  assert.equal(r.lang, "zh")
  assert.ok(r.directive && r.directive.length > 0)
  assert.equal(r.picked.length, 3)
  // All 3 must be zh terms
  for (const p of r.picked) {
    assert.match(p, /[一-鿿]|emo了|yyds|i人|e人/)
  }
})

test("en user → en slang directive", () => {
  const r = buildSlangInjection({
    userMessage: "i'm so done with this interview process",
    seed: "en-test",
  })
  assert.equal(r.lang, "en")
  assert.ok(r.directive && r.directive.length > 0)
  assert.equal(r.picked.length, 3)
  for (const p of r.picked) {
    // EN_SLANG entries are all-ASCII / lowercase
    assert.ok(p === p.toLowerCase() && /^[\x00-\x7f]+$/.test(p))
  }
})

test("mixed user → 2 zh + 1 en", () => {
  const r = buildSlangInjection({
    userMessage: "我刚刚 burnt out 真的崩溃了",
    seed: "mixed-test",
  })
  assert.equal(r.lang, "mixed")
  assert.equal(r.picked.length, 3)
  const zhCount = r.picked.filter((p) =>
    /[一-鿿]|emo了|yyds|i人|e人/.test(p)
  ).length
  const enCount = r.picked.length - zhCount
  assert.equal(zhCount, 2, `expected 2 zh, got ${zhCount}`)
  assert.equal(enCount, 1, `expected 1 en, got ${enCount}`)
})

test("seed determinism — same seed → same pick", () => {
  const a = buildSlangInjection({ userMessage: "我好烦啊", seed: "deterministic" })
  const b = buildSlangInjection({ userMessage: "我好烦啊", seed: "deterministic" })
  assert.deepEqual(a.picked, b.picked)
  assert.equal(a.directive, b.directive)
})

test("rollback flag PA_SLANG_INJECTOR_DISABLED=true → null", () => {
  const original = process.env.PA_SLANG_INJECTOR_DISABLED
  process.env.PA_SLANG_INJECTOR_DISABLED = "true"
  try {
    const r = buildSlangInjection({ userMessage: "hi", seed: "x" })
    assert.equal(r.directive, null)
  } finally {
    if (original === undefined) delete process.env.PA_SLANG_INJECTOR_DISABLED
    else process.env.PA_SLANG_INJECTOR_DISABLED = original
  }
})

test("directive header references 'FRIEND SLANG'", () => {
  const r = buildSlangInjection({ userMessage: "我好累", seed: "x" })
  assert.match(r.directive ?? "", /FRIEND SLANG/i)
})
