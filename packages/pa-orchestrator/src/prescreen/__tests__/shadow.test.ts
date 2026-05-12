/**
 * v1.8 Phase 81 — onboarding migration shadow framework tests.
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  DIFF_JACCARD_THRESHOLD,
  buildShadowDiff,
  evaluateShadowGate,
  jaccardSimilarity,
  normalizeReplyForDiff,
  resolveEngineVersion,
  tokenizeForJaccard,
  userIdToCohortBucket,
  type OnboardingShadowDiff,
} from "../shadow.js"

// ════════════════════════════════════════════════════════════════════════════
// Feature flag
// ════════════════════════════════════════════════════════════════════════════

test("Phase 81: resolveEngineVersion respects explicit users[uid]", () => {
  const flag = { default: "v1" as const, users: { adam: "v2" as const } }
  assert.equal(resolveEngineVersion(flag, "adam"), "v2")
  assert.equal(resolveEngineVersion(flag, "other"), "v1")
})

test("Phase 81: resolveEngineVersion falls through to cohort", () => {
  // adam → bucket 31 (deterministic). cohortPct=50 → < 50 → v2_shadow.
  const flag = { default: "v1" as const, cohortPct: 50 }
  const bucket = userIdToCohortBucket("adam")
  assert.ok(bucket >= 0 && bucket < 100)
  const expected = bucket < 50 ? "v2_shadow" : "v1"
  assert.equal(resolveEngineVersion(flag, "adam"), expected)
})

test("Phase 81: resolveEngineVersion defaults when no users + no cohort", () => {
  assert.equal(resolveEngineVersion({ default: "v1" }, "x"), "v1")
  assert.equal(resolveEngineVersion({ default: "v2" }, "x"), "v2")
})

test("Phase 81: userIdToCohortBucket is deterministic", () => {
  assert.equal(userIdToCohortBucket("adam"), userIdToCohortBucket("adam"))
  assert.equal(userIdToCohortBucket(""), 0)
})

// ════════════════════════════════════════════════════════════════════════════
// Normalize + tokenize
// ════════════════════════════════════════════════════════════════════════════

test("Phase 81: normalizeReplyForDiff strips punctuation + lowercases", () => {
  assert.equal(normalizeReplyForDiff("Hello, World!"), "hello world")
  assert.equal(normalizeReplyForDiff("你好，世界！"), "你好 世界")
})

test("Phase 81: tokenizeForJaccard splits CJK per-char + non-CJK whitespace-words", () => {
  const t = tokenizeForJaccard("hello 你好 world")
  assert.ok(t.has("hello"))
  assert.ok(t.has("world"))
  assert.ok(t.has("你"))
  assert.ok(t.has("好"))
})

// ════════════════════════════════════════════════════════════════════════════
// Jaccard
// ════════════════════════════════════════════════════════════════════════════

test("Phase 81: jaccardSimilarity = 1 for identical replies", () => {
  assert.equal(jaccardSimilarity("hello there", "hello there"), 1)
})

test("Phase 81: jaccardSimilarity = 1 for both empty", () => {
  assert.equal(jaccardSimilarity("", ""), 1)
})

test("Phase 81: jaccardSimilarity = 0 for disjoint vocab", () => {
  assert.equal(jaccardSimilarity("alpha beta", "gamma delta"), 0)
})

test("Phase 81: jaccardSimilarity tolerates punctuation differences", () => {
  const j = jaccardSimilarity("hello, world!", "hello world")
  assert.equal(j, 1)
})

test("Phase 81: jaccardSimilarity computes partial overlap correctly", () => {
  // sets {a,b,c} vs {b,c,d} → intersection=2, union=4 → 0.5
  const j = jaccardSimilarity("a b c", "b c d")
  assert.equal(j, 0.5)
})

// ════════════════════════════════════════════════════════════════════════════
// Build shadow diff
// ════════════════════════════════════════════════════════════════════════════

test("Phase 81: buildShadowDiff marks isDiff=false when jaccard ≥ threshold", () => {
  const d = buildShadowDiff({
    userId: "u1",
    turnId: "t1",
    ts: "2026-05-12T00:00:00Z",
    prompt: "test",
    v1Reply: "hello there",
    v2Reply: "hello there",
    v1StateAdvanced: true,
    v2StateAdvanced: true,
  })
  assert.equal(d.jaccard, 1)
  assert.equal(d.isDiff, false)
  assert.equal(d.stateAgreed, true)
})

test("Phase 81: buildShadowDiff marks isDiff=true when jaccard < threshold", () => {
  const d = buildShadowDiff({
    userId: "u1",
    turnId: "t1",
    ts: "2026-05-12T00:00:00Z",
    prompt: "test",
    v1Reply: "wholly different reply alpha",
    v2Reply: "completely separate beta gamma",
    v1StateAdvanced: true,
    v2StateAdvanced: true,
  })
  assert.ok(d.jaccard < DIFF_JACCARD_THRESHOLD)
  assert.equal(d.isDiff, true)
})

test("Phase 81: buildShadowDiff marks stateAgreed=false on advance disagreement", () => {
  const d = buildShadowDiff({
    userId: "u1",
    turnId: "t1",
    ts: "2026-05-12T00:00:00Z",
    prompt: "test",
    v1Reply: "ok",
    v2Reply: "ok",
    v1StateAdvanced: true,
    v2StateAdvanced: false,
  })
  assert.equal(d.stateAgreed, false)
})

// ════════════════════════════════════════════════════════════════════════════
// Shadow gate
// ════════════════════════════════════════════════════════════════════════════

function fakeDiffs(n: number, fillerOpts: Partial<OnboardingShadowDiff> = {}): OnboardingShadowDiff[] {
  return Array.from({ length: n }, (_, i) => ({
    userId: `u${i}`,
    turnId: `t${i}`,
    ts: "2026-05-12T00:00:00Z",
    prompt: "p",
    v1Reply: "ok",
    v2Reply: "ok",
    jaccard: 1,
    isDiff: false,
    stateAgreed: true,
    ...fillerOpts,
  }))
}

test("Phase 81: evaluateShadowGate fails when turns < minTurns", () => {
  const r = evaluateShadowGate(fakeDiffs(50))
  assert.equal(r.gatePassed, false)
  assert.ok(r.reason?.includes("not enough turns"))
})

test("Phase 81: evaluateShadowGate passes when diff rate < 1%", () => {
  const diffs = fakeDiffs(1000)
  // Inject 5 diffs out of 1000 = 0.5% < 1%
  for (let i = 0; i < 5; i++) {
    diffs[i].isDiff = true
    diffs[i].jaccard = 0.4
  }
  const r = evaluateShadowGate(diffs)
  assert.equal(r.gatePassed, true)
  assert.equal(r.diffRate, 0.005)
  assert.ok(r.meanJaccard < 1)
})

test("Phase 81: evaluateShadowGate fails when diff rate ≥ 1%", () => {
  const diffs = fakeDiffs(1000)
  for (let i = 0; i < 15; i++) {
    diffs[i].isDiff = true
    diffs[i].jaccard = 0.4
  }
  const r = evaluateShadowGate(diffs)
  assert.equal(r.gatePassed, false)
  assert.ok(r.reason?.includes("1.50%"))
})

test("Phase 81: evaluateShadowGate fails on state disagreement ≥ 0.5%", () => {
  const diffs = fakeDiffs(1000)
  // No reply diff, but state disagreement
  for (let i = 0; i < 10; i++) {
    diffs[i].stateAgreed = false
  }
  const r = evaluateShadowGate(diffs)
  assert.equal(r.gatePassed, false)
  assert.ok(r.reason?.includes("state-disagreement"))
})
