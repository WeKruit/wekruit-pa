/**
 * iter34 followup G.4 / D.15 — llmRerank unit tests.
 *
 * Coverage:
 *   - 4-job happy path → ranked 1..4 with reasoning passthrough
 *   - invalid JSON from LLM → ranked = []
 *   - LLM emits jobId not in input → filtered out (hallucination guard)
 *   - duplicate / out-of-order ranks → re-sequenced
 *   - empty input.jobs → ranked = [] + NO LLM call (cost short-circuit)
 *   - score outside [0, 1] → clamped
 *   - reasoning > 200 chars → truncated
 *   - missing API key (no client + no env) → ranked = [] (graceful)
 *   - LLM throws → ranked = [] (caught, never propagates)
 *   - non-string score parses → coerced via Number()
 *   - non-string reasoning → "" placeholder
 *   - duplicate jobIds in LLM output → keep first
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { llmRerank, type RerankChatClient, type RerankInput } from "./llm-rerank.js"

/** Build a minimal RerankInput with N jobs (jobIds = "j1".."jN"). */
function makeInput(n: number): RerankInput {
  return {
    candidate: {
      targetRole: ["swe"],
      topSkills: ["typescript", "react"],
      yoeRange: [3, 5],
      visaStatus: "opt",
      cvSummary: "SWE with 4yo TS/React experience.",
    },
    jobs: Array.from({ length: n }, (_, i) => ({
      id: `j${i + 1}`,
      roleTitle: `Engineer ${i + 1}`,
      companyName: `Co${i + 1}`,
      requiredSkills: ["typescript"],
    })),
  }
}

/** Build a fake RerankChatClient that returns a fixed JSON content payload. */
function fakeClient(content: string, usage?: {
  prompt_tokens?: number
  completion_tokens?: number
}): RerankChatClient {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content } }],
          ...(usage ? { usage } : {}),
        }),
      },
    },
  }
}

/** Build a fake RerankChatClient that throws on every call. */
function throwingClient(message: string): RerankChatClient {
  return {
    chat: {
      completions: {
        create: async () => {
          throw new Error(message)
        },
      },
    },
  }
}

describe("llmRerank", () => {
  it("happy path: 4-job input → ranked 1..4 with reasoning passthrough", async () => {
    const input = makeInput(4)
    const llmJson = JSON.stringify({
      ranked: [
        { jobId: "j2", rank: 1, score: 0.92, reasoning: "best skills overlap" },
        { jobId: "j1", rank: 2, score: 0.85, reasoning: "good seniority match" },
        { jobId: "j4", rank: 3, score: 0.6, reasoning: "ok industry fit" },
        { jobId: "j3", rank: 4, score: 0.4, reasoning: "weak overlap" },
      ],
    })
    const out = await llmRerank(input, { client: fakeClient(llmJson), now: () => 1000 })
    assert.equal(out.ranked.length, 4)
    assert.equal(out.ranked[0]!.jobId, "j2")
    assert.equal(out.ranked[0]!.rank, 1)
    assert.equal(out.ranked[1]!.jobId, "j1")
    assert.equal(out.ranked[1]!.rank, 2)
    assert.equal(out.ranked[2]!.jobId, "j4")
    assert.equal(out.ranked[3]!.jobId, "j3")
    assert.equal(out.ranked[0]!.reasoning, "best skills overlap")
    assert.equal(out.modelUsed, "Qwen/Qwen2.5-7B-Instruct")
  })

  it("invalid JSON from LLM → ranked = []", async () => {
    const input = makeInput(3)
    const out = await llmRerank(input, {
      client: fakeClient("not even close to json {{{{}}"),
    })
    assert.deepEqual(out.ranked, [])
    assert.equal(out.modelUsed, "Qwen/Qwen2.5-7B-Instruct")
  })

  it("LLM returns jobIds not in input → hallucinated entries filtered out", async () => {
    const input = makeInput(2)
    const llmJson = JSON.stringify({
      ranked: [
        { jobId: "j1", rank: 1, score: 0.9, reasoning: "real" },
        { jobId: "j999", rank: 2, score: 0.8, reasoning: "ghost" },
        { jobId: "j2", rank: 3, score: 0.5, reasoning: "real" },
      ],
    })
    const out = await llmRerank(input, { client: fakeClient(llmJson) })
    assert.equal(out.ranked.length, 2)
    const ids = out.ranked.map((r) => r.jobId)
    assert.deepEqual(ids, ["j1", "j2"])
    // After filter + re-sequence: rank 1 then 2.
    assert.equal(out.ranked[0]!.rank, 1)
    assert.equal(out.ranked[1]!.rank, 2)
  })

  it("duplicate ranks + reverse order → sanitize re-sequences 1..N by emitted rank", async () => {
    const input = makeInput(3)
    const llmJson = JSON.stringify({
      ranked: [
        { jobId: "j3", rank: 3, score: 0.3, reasoning: "third" },
        { jobId: "j1", rank: 1, score: 0.9, reasoning: "first" },
        { jobId: "j2", rank: 1, score: 0.8, reasoning: "dup-1" },
      ],
    })
    const out = await llmRerank(input, { client: fakeClient(llmJson) })
    assert.equal(out.ranked.length, 3)
    // After sort by emitted rank asc (1, 1, 3), order = [j1, j2, j3] (or [j2, j1, j3] —
    // the contract is rank 1..N final, not stable order between equal-emitted-ranks).
    // We assert ranks are 1..N exactly and that all three jobs survived.
    const ranks = out.ranked.map((r) => r.rank)
    assert.deepEqual(ranks, [1, 2, 3])
    const ids = out.ranked.map((r) => r.jobId).sort()
    assert.deepEqual(ids, ["j1", "j2", "j3"])
    // Final rank=3 must be j3 (it had the highest emitted rank).
    assert.equal(out.ranked[2]!.jobId, "j3")
  })

  it("empty input.jobs → ranked = [] and NO LLM call (short-circuit)", async () => {
    let called = 0
    const client: RerankChatClient = {
      chat: {
        completions: {
          create: async () => {
            called += 1
            return { choices: [{ message: { content: "{}" } }] }
          },
        },
      },
    }
    const out = await llmRerank(
      { candidate: {}, jobs: [] },
      { client }
    )
    assert.equal(called, 0, "empty input must short-circuit before client call")
    assert.deepEqual(out.ranked, [])
  })

  it("score out of [0, 1] → clamped", async () => {
    const input = makeInput(3)
    const llmJson = JSON.stringify({
      ranked: [
        { jobId: "j1", rank: 1, score: 1.7, reasoning: "over" },
        { jobId: "j2", rank: 2, score: -0.3, reasoning: "under" },
        { jobId: "j3", rank: 3, score: 0.55, reasoning: "ok" },
      ],
    })
    const out = await llmRerank(input, { client: fakeClient(llmJson) })
    assert.equal(out.ranked[0]!.score, 1)
    assert.equal(out.ranked[1]!.score, 0)
    assert.equal(out.ranked[2]!.score, 0.55)
  })

  it("reasoning > 200 chars → truncated to exactly 200", async () => {
    const input = makeInput(1)
    const longReason = "x".repeat(500)
    const llmJson = JSON.stringify({
      ranked: [{ jobId: "j1", rank: 1, score: 0.9, reasoning: longReason }],
    })
    const out = await llmRerank(input, { client: fakeClient(llmJson) })
    assert.equal(out.ranked[0]!.reasoning.length, 200)
    assert.ok(out.ranked[0]!.reasoning.startsWith("xxx"))
  })

  it("missing API key (no client + no env) → ranked = [] (graceful)", async () => {
    const original = process.env.SILICONFLOW_API_KEY
    delete process.env.SILICONFLOW_API_KEY
    try {
      const input = makeInput(2)
      const out = await llmRerank(input)
      assert.deepEqual(out.ranked, [])
    } finally {
      if (original !== undefined) process.env.SILICONFLOW_API_KEY = original
    }
  })

  it("LLM throws → ranked = [] (caught, never propagates)", async () => {
    const input = makeInput(3)
    const out = await llmRerank(input, {
      client: throwingClient("siliconflow 429"),
    })
    assert.deepEqual(out.ranked, [])
    // latencyMs still reported.
    assert.ok(typeof out.latencyMs === "number")
  })

  it("non-numeric score string → coerced via Number()", async () => {
    const input = makeInput(2)
    const llmJson = JSON.stringify({
      ranked: [
        { jobId: "j1", rank: 1, score: "0.7", reasoning: "ok" },
        { jobId: "j2", rank: 2, score: "abc", reasoning: "bad" },
      ],
    })
    const out = await llmRerank(input, { client: fakeClient(llmJson) })
    assert.equal(out.ranked[0]!.score, 0.7)
    // Unparsable string → falls back to default 0.5.
    assert.equal(out.ranked[1]!.score, 0.5)
  })

  it("non-string reasoning → coerced to empty string", async () => {
    const input = makeInput(1)
    const llmJson = JSON.stringify({
      ranked: [{ jobId: "j1", rank: 1, score: 0.8, reasoning: 12345 }],
    })
    const out = await llmRerank(input, { client: fakeClient(llmJson) })
    assert.equal(out.ranked[0]!.reasoning, "")
  })

  it("duplicate jobIds in LLM output → keep first occurrence", async () => {
    const input = makeInput(2)
    const llmJson = JSON.stringify({
      ranked: [
        { jobId: "j1", rank: 1, score: 0.9, reasoning: "first" },
        { jobId: "j1", rank: 2, score: 0.6, reasoning: "duplicate" },
        { jobId: "j2", rank: 3, score: 0.5, reasoning: "second-real" },
      ],
    })
    const out = await llmRerank(input, { client: fakeClient(llmJson) })
    assert.equal(out.ranked.length, 2)
    assert.equal(out.ranked[0]!.jobId, "j1")
    assert.equal(out.ranked[0]!.reasoning, "first")
    assert.equal(out.ranked[1]!.jobId, "j2")
  })

  it("malformed `ranked` (missing key / not array) → ranked = []", async () => {
    const input = makeInput(2)
    const out1 = await llmRerank(input, {
      client: fakeClient(JSON.stringify({})),
    })
    assert.deepEqual(out1.ranked, [])
    const out2 = await llmRerank(input, {
      client: fakeClient(JSON.stringify({ ranked: "not an array" })),
    })
    assert.deepEqual(out2.ranked, [])
  })

  it("entry without jobId / non-string jobId → dropped", async () => {
    const input = makeInput(2)
    const llmJson = JSON.stringify({
      ranked: [
        { rank: 1, score: 0.9, reasoning: "no jobId" },
        { jobId: 42, rank: 2, score: 0.5, reasoning: "numeric jobId" },
        { jobId: "j1", rank: 3, score: 0.7, reasoning: "good one" },
      ],
    })
    const out = await llmRerank(input, { client: fakeClient(llmJson) })
    assert.equal(out.ranked.length, 1)
    assert.equal(out.ranked[0]!.jobId, "j1")
    assert.equal(out.ranked[0]!.rank, 1)
  })

  it("latencyMs reflects injected clock", async () => {
    const input = makeInput(1)
    const llmJson = JSON.stringify({
      ranked: [{ jobId: "j1", rank: 1, score: 0.5, reasoning: "" }],
    })
    let calls = 0
    const out = await llmRerank(input, {
      client: fakeClient(llmJson),
      now: () => {
        calls += 1
        return calls === 1 ? 1000 : 1342
      },
    })
    assert.equal(out.latencyMs, 342)
  })
})
