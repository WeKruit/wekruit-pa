/**
 * Phase 18 — pairwise harness unit tests (mocked judge + runReply).
 *
 *   node --test tests/scenarios/lib/pairwise.test.mjs
 */
import test from "node:test"
import assert from "node:assert/strict"

import { runPairwise, summarizePairwise } from "./pairwise.mjs"

const SCEN = {
  id: "test-scenario",
  turns: [{ user: "我喜欢喝柠檬茶" }],
}

function makeReplyStub(map) {
  return async ({ systemPrompt }) => {
    if (map[systemPrompt] === undefined) {
      throw new Error(`stub: unexpected systemPrompt: ${systemPrompt.slice(0, 50)}`)
    }
    return map[systemPrompt]
  }
}

function makeJudgeStub(seq) {
  let i = 0
  return async () => {
    if (i >= seq.length) throw new Error("judge stub exhausted")
    return { ...seq[i++] }
  }
}

test("runPairwise: returns documented shape", async () => {
  const runReply = makeReplyStub({ baseline: "ok记下了", candidate: "柠檬茶女孩 🍋" })
  const judge = makeJudgeStub([
    { winner: "B", rationale: "candidate is more in-character", costUsd: 0.001 },
    { winner: "A", rationale: "candidate is more in-character (swapped)", costUsd: 0.001 },
  ])
  const out = await runPairwise({
    scenario: SCEN,
    baselinePrompt: "baseline",
    candidatePrompt: "candidate",
    runReply,
    judge,
  })
  assert.equal(out.winner, "candidate")
  assert.equal(out.baselineReply, "ok记下了")
  assert.equal(out.candidateReply, "柠檬茶女孩 🍋")
  assert.equal(out.judgeCalls.length, 2)
  assert.equal(out.judgeCalls[0].swap, false)
  assert.equal(out.judgeCalls[1].swap, true)
  assert.ok(out.costUsd > 0)
})

test("runPairwise: position-bias swap — disagreement → tie", async () => {
  const runReply = makeReplyStub({ baseline: "X", candidate: "Y" })
  // First call says A wins (= baseline). Second (swapped) says A wins
  // (= candidate). Disagreement → tie.
  const judge = makeJudgeStub([
    { winner: "A", rationale: "", costUsd: 0.001 },
    { winner: "A", rationale: "", costUsd: 0.001 },
  ])
  const out = await runPairwise({
    scenario: SCEN,
    baselinePrompt: "baseline",
    candidatePrompt: "candidate",
    runReply,
    judge,
  })
  assert.equal(out.winner, "tie")
})

test("runPairwise: candidate filler hit → baseline wins, no judge calls", async () => {
  const runReply = makeReplyStub({
    baseline: "你好",
    candidate: "好的，我记住了 next time",
  })
  const judge = makeJudgeStub([]) // should not be called
  const out = await runPairwise({
    scenario: SCEN,
    baselinePrompt: "baseline",
    candidatePrompt: "candidate",
    runReply,
    judge,
  })
  assert.equal(out.winner, "baseline")
  assert.equal(out.judgeCalls.length, 0)
  assert.match(out.autoFail ?? "", /^candidate_filler:zh:/)
  assert.equal(out.costUsd, 0)
})

test("runPairwise: baseline filler hit → candidate wins (and skips judge)", async () => {
  const runReply = makeReplyStub({
    baseline: "It's important to keep in mind your goals",
    candidate: "Bro, you got this",
  })
  const judge = makeJudgeStub([])
  const out = await runPairwise({
    scenario: SCEN,
    baselinePrompt: "baseline",
    candidatePrompt: "candidate",
    runReply,
    judge,
  })
  assert.equal(out.winner, "candidate")
  assert.match(out.autoFail ?? "", /^baseline_filler:en:/)
})

test("runPairwise: cost ledger preflight aborts before judge call", async () => {
  const runReply = makeReplyStub({ baseline: "X", candidate: "Y" })
  const judge = makeJudgeStub([])
  const preflight = () => "ceiling exceeded"
  const out = await runPairwise({
    scenario: SCEN,
    baselinePrompt: "baseline",
    candidatePrompt: "candidate",
    runReply,
    judge,
    preflight,
  })
  assert.equal(out.winner, "tie")
  assert.equal(out.aborted, "ceiling exceeded")
  assert.equal(out.judgeCalls.length, 0)
})

test("runPairwise: agreement A=baseline both calls → baseline wins", async () => {
  const runReply = makeReplyStub({ baseline: "X", candidate: "Y" })
  // Call1 (A=baseline,B=candidate): winner=A → baseline
  // Call2 (A=candidate,B=baseline, swap): winner=B → baseline
  const judge = makeJudgeStub([
    { winner: "A", rationale: "", costUsd: 0.001 },
    { winner: "B", rationale: "", costUsd: 0.001 },
  ])
  const out = await runPairwise({
    scenario: SCEN,
    baselinePrompt: "baseline",
    candidatePrompt: "candidate",
    runReply,
    judge,
  })
  assert.equal(out.winner, "baseline")
})

test("runPairwise: tie + non-tie → non-tie wins", async () => {
  const runReply = makeReplyStub({ baseline: "X", candidate: "Y" })
  const judge = makeJudgeStub([
    { winner: "tie", rationale: "", costUsd: 0.001 },
    { winner: "A", rationale: "", costUsd: 0.001 }, // swap=true → A=candidate → candidate
  ])
  const out = await runPairwise({
    scenario: SCEN,
    baselinePrompt: "baseline",
    candidatePrompt: "candidate",
    runReply,
    judge,
  })
  assert.equal(out.winner, "candidate")
})

test("summarizePairwise: 5/6 candidate wins → 83% gate met (≥0.7)", () => {
  const results = [
    { winner: "candidate" },
    { winner: "candidate" },
    { winner: "candidate" },
    { winner: "candidate" },
    { winner: "candidate" },
    { winner: "tie" },
  ]
  const s = summarizePairwise(results)
  assert.equal(s.candidateWins, 5)
  assert.equal(s.ties, 1)
  assert.equal(s.baselineWins, 0)
  assert.equal(s.total, 6)
  assert.ok(Math.abs(s.winRate - 5 / 6) < 1e-9)
  assert.equal(s.gateMet, true)
})

test("summarizePairwise: 4/6 candidate (66%) → gate NOT met", () => {
  const results = [
    { winner: "candidate" },
    { winner: "candidate" },
    { winner: "candidate" },
    { winner: "candidate" },
    { winner: "baseline" },
    { winner: "baseline" },
  ]
  const s = summarizePairwise(results)
  assert.ok(Math.abs(s.winRate - 4 / 6) < 1e-9)
  assert.equal(s.gateMet, false)
})
