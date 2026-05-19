import assert from "node:assert/strict"
import test from "node:test"
import { buildSlangInjection } from "./slang-injector.js"
import { EN_SLANG, ZH_SLANG } from "./slang-lexicon.js"

test("empty userMessage → directive null", () => {
  const r = buildSlangInjection({ userMessage: "", seed: "x" })
  assert.equal(r.directive, null)
  assert.deepEqual(r.picked, [])
})

test("zh user → zh slang palette (≥6 terms)", () => {
  const r = buildSlangInjection({
    userMessage: "我最近真的好崩溃啊 工作累死了",
    seed: "zh-test",
  })
  assert.equal(r.lang, "zh")
  assert.ok(r.directive && r.directive.length > 0)
  // Palette widened (Adam 2026-05-19): expect at least 6 candidate terms.
  assert.ok(r.picked.length >= 6, `expected ≥6 zh picks, got ${r.picked.length}`)
  assert.ok(r.picked.length <= 8, `expected ≤8 zh picks, got ${r.picked.length}`)
  for (const p of r.picked) {
    assert.match(p, /[一-鿿]|emo了|yyds|i人|e人/)
  }
})

test("en user → en slang palette (≥6 terms)", () => {
  const r = buildSlangInjection({
    userMessage: "i'm so done with this interview process",
    seed: "en-test",
  })
  assert.equal(r.lang, "en")
  assert.ok(r.directive && r.directive.length > 0)
  assert.ok(r.picked.length >= 6, `expected ≥6 en picks, got ${r.picked.length}`)
  assert.ok(r.picked.length <= 8, `expected ≤8 en picks, got ${r.picked.length}`)
  for (const p of r.picked) {
    assert.ok(p === p.toLowerCase() && /^[\x00-\x7f]+$/.test(p))
  }
})

test("mixed user → 4 zh + 2 en (palette ≥6, ≤6)", () => {
  const r = buildSlangInjection({
    userMessage: "我刚刚 burnt out 真的崩溃了",
    seed: "mixed-test",
  })
  assert.equal(r.lang, "mixed")
  assert.equal(r.picked.length, 6)
  const zhCount = r.picked.filter((p) =>
    /[一-鿿]|emo了|yyds|i人|e人/.test(p)
  ).length
  const enCount = r.picked.length - zhCount
  assert.equal(zhCount, 4, `expected 4 zh, got ${zhCount}`)
  assert.equal(enCount, 2, `expected 2 en, got ${enCount}`)
})

test("seed determinism — same seed → same palette", () => {
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

test("directive header references 'FRIEND SLANG PALETTE'", () => {
  const r = buildSlangInjection({ userMessage: "我好累", seed: "x" })
  assert.match(r.directive ?? "", /FRIEND SLANG PALETTE/i)
})

test("excludeTerms — recent picks are filtered out of palette", () => {
  // First call surfaces some palette
  const first = buildSlangInjection({
    userMessage: "i'm exhausted from interview prep",
    seed: "en-seed-1",
  })
  assert.equal(first.lang, "en")
  assert.ok(first.picked.length >= 6)

  // Pass the entire first pick as exclude → palette should rotate to terms not in exclude
  const second = buildSlangInjection({
    userMessage: "i'm exhausted from interview prep",
    seed: "en-seed-1",
    excludeTerms: first.picked,
  })
  for (const t of second.picked) {
    assert.ok(
      !first.picked.includes(t),
      `expected '${t}' to be excluded after appearing in prior turn`,
    )
  }
})

test("excludeTerms — when excludes drain the pool, returns null", () => {
  // Exclude every en term → empty pool → null directive
  const r = buildSlangInjection({
    userMessage: "hello there",
    seed: "x",
    excludeTerms: [...EN_SLANG],
  })
  assert.equal(r.directive, null)
  assert.deepEqual(r.picked, [])
})

test("excludeTerms — partial drain still surfaces remaining palette", () => {
  // Exclude half of the en pool → expect remaining to be surfaced (no overlap).
  const half = EN_SLANG.slice(0, Math.floor(EN_SLANG.length / 2))
  const r = buildSlangInjection({
    userMessage: "interview prep mode",
    seed: "x",
    excludeTerms: half,
  })
  assert.ok(r.picked.length > 0)
  for (const t of r.picked) {
    assert.ok(!half.includes(t), `expected '${t}' to be excluded`)
  }
})

test("excludeTerms — zh palette also honors excludes", () => {
  const r = buildSlangInjection({
    userMessage: "我累了今天加班",
    seed: "zh-exclude",
    excludeTerms: ZH_SLANG.slice(0, 5),
  })
  assert.equal(r.lang, "zh")
  for (const t of r.picked) {
    assert.ok(!ZH_SLANG.slice(0, 5).includes(t))
  }
})
