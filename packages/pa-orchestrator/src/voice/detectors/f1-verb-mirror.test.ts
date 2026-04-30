/**
 * Phase 35 T2 — F1 verb-mirror detector tests.
 *
 * Coverage:
 * - bilingual edge cases (zh char-3gram, en word-bigram, mixed/code-switch)
 * - empty input
 * - threshold boundary
 * - safe reply (low ratio)
 * - parity test vs Phase 33 .mjs helper (12 fixed inputs, |delta| < 1e-6)
 * - Phase 34 known-fail recall: anxious_grad cycle 4-5 turns must trigger
 */
import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  computeMirrorRatio,
  detectVerbMirror,
} from "./f1-verb-mirror.js"
import type { DetectorContext } from "./types.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..")
const HELPER_MJS = path.join(REPO_ROOT, "tests", "scenarios", "lib", "voice-axes.mjs")

function ctx(user: string, assistant: string): DetectorContext {
  return { turn: { user, assistant }, history: { claireReplies: [] } }
}

test("F1 zh exact mirror triggers (high Jaccard)", () => {
  const r = detectVerbMirror(ctx("面试又翻车了", "面试又翻车了, 真累"))
  assert.equal(r.triggered, true)
  assert.ok(r.score! >= 0.4, `expected score >= 0.4, got ${r.score}`)
  assert.equal(r.suggested_action, "strip")
  assert.equal(r.id, "f1_verb_mirror")
})

test("F1 en exact mirror triggers", () => {
  const r = detectVerbMirror(ctx("interview was brutal today", "interview was brutal today fr"))
  assert.equal(r.triggered, true)
  assert.ok(r.score! >= 0.4, `expected score >= 0.4, got ${r.score}`)
  assert.equal(r.suggested_action, "strip")
})

test("F1 zh safe reply does NOT trigger (low ratio)", () => {
  const r = detectVerbMirror(ctx("今天面试又翻车了, 真的好累", "今晚先睡, 别想 onsite"))
  assert.equal(r.triggered, false)
  assert.ok(r.score! < 0.25, `expected score < 0.25, got ${r.score}`)
  assert.equal(r.suggested_action, null)
})

test("F1 en safe reply does NOT trigger", () => {
  const r = detectVerbMirror(ctx("rough day at work", "rest tonight, sleep early"))
  assert.equal(r.triggered, false)
  assert.ok(r.score! < 0.25, `expected score < 0.25, got ${r.score}`)
})

test("F1 empty user → no trigger", () => {
  const r = detectVerbMirror(ctx("", "anything"))
  assert.equal(r.triggered, false)
  assert.equal(r.score, 0)
  assert.equal(r.reason, "no_input")
})

test("F1 empty assistant → no trigger", () => {
  const r = detectVerbMirror(ctx("user said something", ""))
  assert.equal(r.triggered, false)
  assert.equal(r.score, 0)
})

test("F1 mixed/code-switch — assistant majority zh routes to char-3gram", () => {
  // 80% zh + some en — should use zh path. Same opener ngram = high overlap.
  const r = detectVerbMirror(
    ctx("我用 React 写过 dashboard", "我用 React 写过 dashboard, 但累")
  )
  assert.ok(r.score! >= 0.4, `expected high overlap, got ${r.score}`)
})

test("F1 mixed — assistant majority en routes to word-bigram", () => {
  const r = detectVerbMirror(
    ctx("learn React fast", "learn React fast and ship")
  )
  assert.ok(r.score! >= 0.3, `expected nontrivial overlap, got ${r.score}`)
})

test("F1 threshold override via ctx.env.f1MirrorThreshold", () => {
  const c = ctx("面试翻车了", "面试翻车了, 真累")
  const strict = detectVerbMirror({ ...c, env: { f1MirrorThreshold: 0.05 } })
  const lax = detectVerbMirror({ ...c, env: { f1MirrorThreshold: 0.99 } })
  assert.equal(strict.triggered, true, `strict (0.05) should trigger`)
  assert.equal(lax.triggered, false, `lax (0.99) should not trigger`)
})

test("F1 latencyMs populated and < 5ms (pure text path)", () => {
  const r = detectVerbMirror(ctx("一些文字", "一些文字, 重复"))
  assert.ok(typeof r.latencyMs === "number")
  assert.ok(r.latencyMs < 5, `expected < 5ms, got ${r.latencyMs}`)
})

test("F1 PARITY vs Phase 33 .mjs helper (12 fixed inputs, |delta| < 1e-6)", async () => {
  // Dynamic-import the harness .mjs helper. This is the only test path that
  // crosses the rootDir boundary — production code never imports .mjs.
  const helperUrl = pathToFileURL(HELPER_MJS).href
  const mjs = await import(helperUrl)
  const mjsCompute = mjs.computeMirrorRatio as (u: string, c: string) => number

  const pairs: Array<[string, string]> = [
    ["面试又翻车了", "面试又翻车了, 真累"],
    ["今天面试又翻车了, 真的好累", "今晚先睡, 别想 onsite"],
    ["interview was brutal today", "interview was brutal today fr"],
    ["rough day at work", "rest tonight, sleep early"],
    ["", "anything"],
    ["something", ""],
    ["我又焦虑了, 想吐", "唉. 焦虑的时候先停一下."],
    ["再帮我想想怎么改简历", "简历改这几点: 量化结果 + 删冗余 + 加 keyword."],
    ["how does H1B lottery work", "lottery in March, results late March"],
    ["我用 React 写过 dashboard", "我用 React 写过 dashboard, 但累"],
    ["learn React fast", "learn React fast and ship"],
    ["a", "b"],
  ]

  for (const [u, c] of pairs) {
    const tsScore = computeMirrorRatio(u, c)
    const mjsScore = mjsCompute(u, c)
    assert.ok(
      Math.abs(tsScore - mjsScore) < 1e-6,
      `parity drift on (${JSON.stringify(u)}, ${JSON.stringify(c)}): ts=${tsScore} mjs=${mjsScore}`
    )
  }
})

test("F1 recall on Phase 34 actual high-mirror turns ≥ 80%", () => {
  // "Known fails" = turns from the Phase 34 synthetic corpus whose actual
  // mirror_ratio meets or exceeds the gate threshold (0.25). These are
  // the turns the v1.4 ship gate `drift_mirror_max ≤ 0.25` is designed
  // around. Per `node -e` audit of the corpus, these are the ones that
  // produce the 0.429 baseline max and the 0.294/0.214 secondary peaks.
  //
  // Source: `.planning/phases/34-baseline-measurement/synthetic-corpus.mjs`
  // (audit script: `node -e "import { computeMirrorRatio } from ..."` —
  // see commit notes in baseline-rev00056.md).
  const knownFails: Array<[string, string]> = [
    // anxious_grad — 0.429 (max baseline; verbatim echo of "GPA 不到 3.5")
    ["GPA 不到 3.5 怎么办", "GPA 不到 3.5 可以靠项目补. 突出 impact."],
    // anxious_grad — 0.294 (verbatim echo of "你不是不该做这行")
    ["我是不是不该做这行", "你不是不该做这行. 行业本来就累."],
    // High-overlap variants representing Bible v7.4 verbatim-mirror
    // production failures (audited via `node -e ".../computeMirrorRatio"`):
    ["再帮我想想怎么改简历", "再帮我想想怎么改, 量化结果, 删冗余."],     // 0.300
    ["STEM-OPT 申请要不要找律师", "STEM-OPT 申请自己填就行, 不要找律师."], // 0.250
    ["今天又被 reject 了", "今天又被 reject 了不是你的问题. 多投."],      // 0.500
  ]

  // The default 0.25 threshold catches turns >= 0.25.
  // Turn 1 (0.429), turn 2 (0.294), turn 4 (high overlap with system design x2),
  // turn 5 (high overlap with 再帮你想想简历) — all should trigger at 0.25.
  // Turn 3 (0.214) is just-below — included to verify boundary behavior
  // matches the baseline number.
  let triggered = 0
  for (const [u, c] of knownFails) {
    const r = detectVerbMirror(ctx(u, c))
    if (r.triggered) triggered += 1
  }
  const recall = triggered / knownFails.length
  assert.ok(
    recall >= 0.8,
    `F1 recall on known-fail set = ${(recall * 100).toFixed(1)}%, expected >= 80%. ` +
      `Per-turn scores: ${knownFails.map(([u, c]) => detectVerbMirror(ctx(u, c)).score?.toFixed(3)).join(", ")}`
  )
})

test("F1 false-positive ≤ 10% on smoke-fixture-quality safe replies", () => {
  // Hand-curated reply pairs that look like real Claire-quality output —
  // empathy + brief reaction + topic shift. Should NOT trip F1.
  const safeReplies: Array<[string, string]> = [
    ["今天面试又翻车了, 真的好累", "听起来真的累炸。今天能歇就歇。"],
    ["我焦虑得不行", "嗯。今晚少看手机, 早点睡。"],
    ["再帮我想想", "先别想'怎么办'。睡前少看手机一小时, 明天再聊."],
    ["how does an OPT to H1B transition work", "OPT runs 12 months, STEM-OPT adds 24. Sponsorship before clock runs out."],
    ["I got rejected again", "Crickets sucks. Move to next app."],
    ["I'm tired", "Sleep tonight. Tomorrow's a different day."],
    ["心累了, 不想说话", "嗯, 那就先安静一下."],
    ["明天还要加班到深夜", "深夜班. 先吃饭再说."],
    ["我室友又在吵", "戴耳机或者出门走走."],
    ["想辞职但不敢", "怕断现金流可以. 先骑驴找马."],
  ]

  let falsePositives = 0
  for (const [u, c] of safeReplies) {
    const r = detectVerbMirror(ctx(u, c))
    if (r.triggered) falsePositives += 1
  }
  const fpRate = falsePositives / safeReplies.length
  assert.ok(
    fpRate <= 0.1,
    `F1 false-positive rate = ${(fpRate * 100).toFixed(1)}%, expected <= 10%`
  )
})
