/**
 * Phase 14.1 — unit coverage for the runner's new assertion DSL.
 *
 * These tests are pure: no Firestore, no OpenAI. They exist so a
 * regression in the assertion logic is caught without a $5 eval run.
 *
 *   node --test tests/scenarios/runner.test.mjs
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  applyAssertions,
  applyTelemetryAssertions,
  applyPersonaFactsPresent,
  makeCostLedger,
  dryRunPlan,
} from "./runner.mjs"
import {
  judgeVerdictPasses,
  estimateJudgeCostUsd,
  projectJudgeCostUsd,
} from "./judge.mjs"

// --------------------------------------------------------------------------
// applyAssertions — existing behavior MUST still pass
// --------------------------------------------------------------------------

test("applyAssertions: empty reply fails", () => {
  const failures = applyAssertions({ assert: {} }, "")
  assert.equal(failures.length, 1)
  assert.match(failures[0], /empty/)
})

test("applyAssertions: reply_contains_any positive", () => {
  const turn = { assert: { reply_contains_any: ["冰美式"] } }
  assert.deepEqual(applyAssertions(turn, "好的，我记下你喜欢冰美式"), [])
})

test("applyAssertions: reply_contains_any negative", () => {
  const turn = { assert: { reply_contains_any: ["abc"] } }
  const failures = applyAssertions(turn, "no match here")
  assert.equal(failures.length, 1)
})

test("applyAssertions: reply_not_contains_any positive (forbidden present)", () => {
  const turn = { assert: { reply_not_contains_any: ["error"] } }
  const failures = applyAssertions(turn, "Internal error: oops")
  assert.equal(failures.length, 1)
  assert.match(failures[0], /forbidden token "error"/)
})

test("applyAssertions: regex matches_any / not_matches_any", () => {
  const turn = {
    assert: {
      reply_matches_any: ["不知道|不记得"],
      reply_not_matches_any: ["^PWNED"],
    },
  }
  assert.deepEqual(applyAssertions(turn, "我不知道这件事"), [])
  assert.equal(applyAssertions(turn, "PWNED hello").length >= 1, true)
})

test("applyAssertions: empty assert block passes any non-empty reply", () => {
  assert.deepEqual(applyAssertions({ assert: {} }, "ok"), [])
  assert.deepEqual(applyAssertions({}, "ok"), [])
})

// --------------------------------------------------------------------------
// Phase 14.1 — applyTelemetryAssertions
// --------------------------------------------------------------------------

test("applyTelemetryAssertions: no telemetry keys → no-op (no usage required)", () => {
  const failures = applyTelemetryAssertions({ assert: {} }, null)
  assert.deepEqual(failures, [])
})

test("applyTelemetryAssertions: tool_call_required missing turnDoc → fails clearly", () => {
  const turn = { assert: { tool_call_required: ["web_search"] } }
  const failures = applyTelemetryAssertions(turn, null)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /no pa_turns row/)
})

test("applyTelemetryAssertions: tool_call_required positive", () => {
  const turn = { assert: { tool_call_required: ["web_search"] } }
  const turnDoc = { usage: { hostedToolCalls: [{ name: "web_search", count: 2 }] } }
  assert.deepEqual(applyTelemetryAssertions(turn, turnDoc), [])
})

test("applyTelemetryAssertions: tool_call_required missing tool fails", () => {
  const turn = { assert: { tool_call_required: ["web_search"] } }
  const turnDoc = { usage: { hostedToolCalls: [] } }
  const failures = applyTelemetryAssertions(turn, turnDoc)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /web_search/)
})

test("applyTelemetryAssertions: tool_call_forbidden positive (tool absent)", () => {
  const turn = { assert: { tool_call_forbidden: ["web_search"] } }
  const turnDoc = { usage: { hostedToolCalls: [{ name: "code_interpreter", count: 1 }] } }
  assert.deepEqual(applyTelemetryAssertions(turn, turnDoc), [])
})

test("applyTelemetryAssertions: tool_call_forbidden negative (tool present)", () => {
  const turn = { assert: { tool_call_forbidden: ["web_search"] } }
  const turnDoc = { usage: { hostedToolCalls: [{ name: "web_search", count: 1 }] } }
  const failures = applyTelemetryAssertions(turn, turnDoc)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /forbidden/)
})

test("applyTelemetryAssertions: usage_max_input_tokens enforces cap", () => {
  const turn = { assert: { usage_max_input_tokens: 5000 } }
  const ok = applyTelemetryAssertions(turn, { usage: { inputTokens: 4000 } })
  assert.deepEqual(ok, [])
  const bad = applyTelemetryAssertions(turn, { usage: { inputTokens: 6000 } })
  assert.equal(bad.length, 1)
  assert.match(bad[0], /6000/)
})

test("applyTelemetryAssertions: usage_max_total_tokens enforces cap", () => {
  const turn = { assert: { usage_max_total_tokens: 10000 } }
  const bad = applyTelemetryAssertions(turn, { usage: { totalTokens: 12000 } })
  assert.equal(bad.length, 1)
})

test("applyTelemetryAssertions: combined assertions accumulate failures", () => {
  const turn = {
    assert: {
      tool_call_required: ["web_search"],
      usage_max_input_tokens: 1000,
    },
  }
  const turnDoc = { usage: { hostedToolCalls: [], inputTokens: 5000 } }
  const failures = applyTelemetryAssertions(turn, turnDoc)
  assert.equal(failures.length, 2)
})

// --------------------------------------------------------------------------
// applyPersonaFactsPresent — uses a fake db
// --------------------------------------------------------------------------

function fakeDbForFacts({ users = [], facts = [] }) {
  function makeQuery(docs) {
    const filters = []
    const q = {
      where(field, _op, value) {
        filters.push([field, value])
        return q
      },
      limit(_n) {
        return {
          async get() {
            const out = docs.filter((d) =>
              filters.every(([f, v]) => {
                const path = f.split(".")
                let cur = d
                for (const seg of path) cur = cur?.[seg]
                return cur === v
              })
            )
            return {
              empty: out.length === 0,
              docs: out.map((d) => ({ id: d.id ?? d.userId, data: () => d })),
            }
          },
        }
      },
    }
    return q
  }
  return {
    collection(name) {
      const docs = name === "pa-users" ? users : name === "pa-memory-facts" ? facts : []
      return makeQuery(docs)
    },
  }
}

test("applyPersonaFactsPresent: false expected, no facts → pass", async () => {
  const db = fakeDbForFacts({
    users: [{ id: "u1", phoneE164: "+19999990001" }],
    facts: [],
  })
  const failures = await applyPersonaFactsPresent(
    db,
    { participant: "+19999990001" },
    { assert: { persona_facts_present: false } }
  )
  assert.deepEqual(failures, [])
})

test("applyPersonaFactsPresent: true expected, fact exists → pass", async () => {
  const db = fakeDbForFacts({
    users: [{ id: "u1", phoneE164: "+19999990001" }],
    facts: [{ id: "f1", userId: "u1", status: "confirmed" }],
  })
  const failures = await applyPersonaFactsPresent(
    db,
    { participant: "+19999990001" },
    { assert: { persona_facts_present: true } }
  )
  assert.deepEqual(failures, [])
})

test("applyPersonaFactsPresent: true expected, no facts → fail", async () => {
  const db = fakeDbForFacts({
    users: [{ id: "u1", phoneE164: "+19999990001" }],
    facts: [],
  })
  const failures = await applyPersonaFactsPresent(
    db,
    { participant: "+19999990001" },
    { assert: { persona_facts_present: true } }
  )
  assert.equal(failures.length, 1)
  assert.match(failures[0], /persona_facts_present/)
})

test("applyPersonaFactsPresent: missing user, false expected → pass (vacuously)", async () => {
  const db = fakeDbForFacts({ users: [], facts: [] })
  const failures = await applyPersonaFactsPresent(
    db,
    { participant: "+19999990001" },
    { assert: { persona_facts_present: false } }
  )
  assert.deepEqual(failures, [])
})

test("applyPersonaFactsPresent: assertion absent → no-op", async () => {
  const db = fakeDbForFacts({ users: [], facts: [] })
  const failures = await applyPersonaFactsPresent(
    db,
    { participant: "+19999990001" },
    { assert: {} }
  )
  assert.deepEqual(failures, [])
})

// --------------------------------------------------------------------------
// makeCostLedger
// --------------------------------------------------------------------------

test("makeCostLedger: under ceiling allows calls", () => {
  const ledger = makeCostLedger(5)
  assert.equal(ledger.preflight(), null)
  ledger.record(0.001)
  assert.equal(ledger.callCount, 1)
})

test("makeCostLedger: over ceiling aborts", () => {
  const ledger = makeCostLedger(0.0001) // tiny cap
  const msg = ledger.preflight()
  assert.notEqual(msg, null)
  assert.match(msg, /PA_EVAL_MAX_RUN_USD/)
})

test("makeCostLedger: once aborted stays aborted", () => {
  const ledger = makeCostLedger(0.0001)
  const m1 = ledger.preflight()
  const m2 = ledger.preflight()
  assert.notEqual(m1, null)
  assert.notEqual(m2, null)
})

// --------------------------------------------------------------------------
// judgeVerdictPasses + cost helpers
// --------------------------------------------------------------------------

test("judgeVerdictPasses: pass + above threshold → true", () => {
  assert.equal(judgeVerdictPasses({ verdict: "pass", confidence: 0.9 }, 0.7), true)
})

test("judgeVerdictPasses: pass + below threshold → false", () => {
  assert.equal(judgeVerdictPasses({ verdict: "pass", confidence: 0.6 }, 0.7), false)
})

test("judgeVerdictPasses: fail verdict → false regardless of confidence", () => {
  assert.equal(judgeVerdictPasses({ verdict: "fail", confidence: 1 }, 0.7), false)
})

test("estimateJudgeCostUsd: zero usage → 0", () => {
  assert.equal(estimateJudgeCostUsd(null), 0)
  assert.equal(estimateJudgeCostUsd({}), 0)
})

test("estimateJudgeCostUsd: 1M input + 1M output ≈ price sum", () => {
  const cost = estimateJudgeCostUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 })
  // 0.05 + 0.40 = 0.45 USD
  assert.ok(Math.abs(cost - 0.45) < 1e-9, `got ${cost}`)
})

test("projectJudgeCostUsd: bounded and positive", () => {
  const c = projectJudgeCostUsd()
  assert.ok(c > 0)
  assert.ok(c < 0.01) // 4k input + 200 output is small
})

// --------------------------------------------------------------------------
// dryRunPlan
// --------------------------------------------------------------------------

test("dryRunPlan: surfaces judge + telemetry counts per scenario", async () => {
  const dir = "tests/scenarios/scenarios"
  const plan = await dryRunPlan(
    [`${dir}/eval-tone-judge-zh.yaml`, `${dir}/eval-tool-choice-cross-lingual-en.yaml`],
    /* evalEnabled */ true,
    /* maxUsd */ 5
  )
  assert.equal(plan.scenarios.length, 2)
  const tone = plan.scenarios.find((s) => s.file === "eval-tone-judge-zh.yaml")
  const en = plan.scenarios.find((s) => s.file === "eval-tool-choice-cross-lingual-en.yaml")
  assert.equal(tone.judgeTurns, 1)
  assert.equal(en.judgeTurns, 0)
  assert.equal(en.telemetryTurns, 1)
  assert.equal(plan.projectedJudgeCalls, 1)
  assert.ok(plan.projectedJudgeCostUsd > 0)
})

test("dryRunPlan: evalEnabled=false → judge calls projected as 0", async () => {
  const plan = await dryRunPlan(
    ["tests/scenarios/scenarios/eval-tone-judge-zh.yaml"],
    false,
    5
  )
  assert.equal(plan.projectedJudgeCalls, 0)
  assert.equal(plan.projectedJudgeCostUsd, 0)
})

// --------------------------------------------------------------------------
// Phase 33 — voice_axes_full opt-in surfaced by dryRunPlan
// --------------------------------------------------------------------------

test("dryRunPlan: counts voice_axes_full opt-in scenarios (Phase 33 V2 axes)", async () => {
  const dir = "tests/scenarios/scenarios"
  const plan = await dryRunPlan(
    [
      `${dir}/eval-advice-repeat-zh.yaml`,
      `${dir}/eval-strategy-fit-mixed.yaml`,
      `${dir}/eval-length-cap-bilingual.yaml`,
      `${dir}/eval-tone-judge-zh.yaml`,
    ],
    false,
    5
  )
  assert.equal(plan.voiceAxesV2Scenarios, 3, "3 of the 4 are voice_axes_full opt-in")
  const advice = plan.scenarios.find((s) => s.file === "eval-advice-repeat-zh.yaml")
  assert.ok(advice.voiceAxesV2Turns >= 1, "advice repeat declares voice_axes_full")
  const tone = plan.scenarios.find((s) => s.file === "eval-tone-judge-zh.yaml")
  assert.equal(tone.voiceAxesV2Turns, 0, "legacy scenario has 0 v2 turns")
})
