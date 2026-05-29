/**
 * Unit tests for the pure ranking metrics module.
 *
 * Run: `node --test apps/eval/ranking/metrics.test.mjs`
 * (also wired into the package `test` script).
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  precisionAtK,
  recallAtK,
  ndcgAtK,
  metricsForQuery,
  aggregateMetrics,
  mean,
  round4,
} from "./metrics.mjs"

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)

// ---------------------------------------------------------------------------
// precision@k
// ---------------------------------------------------------------------------

test("precision@k: perfect top-k → 1.0", () => {
  approx(precisionAtK(["a", "b", "c"], ["a", "b", "c"], 3), 1)
})

test("precision@k: half relevant → 0.5", () => {
  approx(precisionAtK(["a", "x", "b", "y"], ["a", "b"], 4), 0.5)
})

test("precision@k: denominator is k even when fewer results returned", () => {
  // only 1 result, 1 relevant, k=3 ⇒ 1/3 (penalise empty slots)
  approx(precisionAtK(["a"], ["a"], 3), 1 / 3)
})

test("precision@k: no overlap → 0", () => {
  approx(precisionAtK(["x", "y"], ["a", "b"], 2), 0)
})

test("precision@k: duplicate ids do not inflate", () => {
  approx(precisionAtK(["a", "a", "a"], ["a"], 3), 1 / 3)
})

test("precision@k: only top-k considered", () => {
  approx(precisionAtK(["x", "y", "a"], ["a"], 2), 0)
  approx(precisionAtK(["x", "y", "a"], ["a"], 3), 1 / 3)
})

test("precision@k: rejects non-positive k", () => {
  assert.throws(() => precisionAtK(["a"], ["a"], 0))
  assert.throws(() => precisionAtK(["a"], ["a"], -1))
  assert.throws(() => precisionAtK(["a"], ["a"], 1.5))
})

// ---------------------------------------------------------------------------
// recall@k
// ---------------------------------------------------------------------------

test("recall@k: all relevant retrieved → 1.0", () => {
  approx(recallAtK(["a", "b", "c"], ["a", "b"], 3), 1)
})

test("recall@k: half of relevant retrieved → 0.5", () => {
  approx(recallAtK(["a", "x"], ["a", "b"], 2), 0.5)
})

test("recall@k: empty relevant set → 1.0 (nothing to find)", () => {
  approx(recallAtK(["x", "y"], [], 3), 1)
})

test("recall@k: cut-off limits retrieved relevant", () => {
  // relevant {a,b}; a at rank3 is beyond k=2 ⇒ 0 found
  approx(recallAtK(["x", "y", "a", "b"], ["a", "b"], 2), 0)
  approx(recallAtK(["x", "y", "a", "b"], ["a", "b"], 4), 1)
})

test("recall@k: duplicate ids counted once", () => {
  approx(recallAtK(["a", "a"], ["a", "b"], 2), 0.5)
})

// ---------------------------------------------------------------------------
// NDCG@k
// ---------------------------------------------------------------------------

test("ndcg@k: ideal ranking → 1.0", () => {
  approx(ndcgAtK(["a", "b", "c"], ["a", "b", "c"], 3), 1)
})

test("ndcg@k: relevant items first beats relevant items last", () => {
  const first = ndcgAtK(["a", "x", "y"], ["a"], 3)
  const last = ndcgAtK(["x", "y", "a"], ["a"], 3)
  assert.ok(first > last, `${first} > ${last}`)
  // a at rank1: dcg=1/log2(2)=1, idcg=1 ⇒ ndcg=1
  approx(first, 1)
  // a at rank3: dcg=1/log2(4)=0.5, idcg=1 ⇒ ndcg=0.5
  approx(last, 0.5)
})

test("ndcg@k: known two-hit value", () => {
  // ranked [a, x, b], relevant {a, b}
  // dcg = 1/log2(2) + 1/log2(4) = 1 + 0.5 = 1.5
  // idcg (2 hits) = 1/log2(2) + 1/log2(3) = 1 + 0.6309297... = 1.6309297...
  const expected = 1.5 / (1 + 1 / Math.log2(3))
  approx(ndcgAtK(["a", "x", "b"], ["a", "b"], 3), expected)
})

test("ndcg@k: empty relevant set → 1.0", () => {
  approx(ndcgAtK([], [], 5), 1)
  approx(ndcgAtK(["x"], [], 5), 1)
})

test("ndcg@k: no hits in top-k → 0", () => {
  approx(ndcgAtK(["x", "y"], ["a"], 2), 0)
})

test("ndcg@k: ndcg is bounded in [0,1]", () => {
  for (const ranked of [["a", "b"], ["b", "a"], ["x", "a"], ["a", "x"]]) {
    const v = ndcgAtK(ranked, ["a", "b"], 2)
    assert.ok(v >= 0 && v <= 1, `${v} ∈ [0,1]`)
  }
})

// ---------------------------------------------------------------------------
// metricsForQuery + aggregateMetrics + helpers
// ---------------------------------------------------------------------------

test("metricsForQuery: computes all metrics at every k", () => {
  const m = metricsForQuery(["a", "x", "b"], ["a", "b"], [1, 3])
  approx(m.precision[1], 1) // a is relevant
  approx(m.precision[3], 2 / 3)
  approx(m.recall[1], 0.5)
  approx(m.recall[3], 1)
  approx(m.ndcg[1], 1)
})

test("aggregateMetrics: macro-averages over queries", () => {
  const q1 = metricsForQuery(["a"], ["a"], [1]) // precision@1 = 1
  const q2 = metricsForQuery(["x"], ["b"], [1]) // precision@1 = 0
  const agg = aggregateMetrics([q1, q2], [1])
  approx(agg.precision[1], 0.5)
  assert.equal(agg.queries, 2)
})

test("mean: empty → 0; otherwise arithmetic mean", () => {
  approx(mean([]), 0)
  approx(mean([1, 2, 3]), 2)
})

test("round4: rounds to 4 decimals", () => {
  approx(round4(0.123456), 0.1235)
  approx(round4(1), 1)
})
