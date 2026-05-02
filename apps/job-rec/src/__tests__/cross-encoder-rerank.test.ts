/**
 * Stream H10 D2 — cross-encoder rerank unit tests.
 *
 * Coverage:
 *   - happy path: SiliconFlow-shaped response is parsed & sorted desc
 *   - fail-open: 503 → returns input order with score=null
 *   - fail-open: missing API key → returns input order with score=null
 *   - fail-open: empty candidates → returns []
 *   - fail-open: missing fetch → returns input order with score=null
 *   - fail-open: malformed payload → returns input order with score=null
 *   - topN truncates input array before API call
 *   - buildRerankQuery composes profile signals into a short string
 *   - buildJobCandidateText composes job signals into a short string
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  rerankWithCrossEncoder,
  buildRerankQuery,
  buildJobCandidateText,
} from "../cross-encoder-rerank.js"

function makeFetchOk(payload: unknown): typeof fetch {
  return (async (_url: unknown, _init?: unknown) => {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
}

function makeFetchFail(status: number): typeof fetch {
  return (async (_url: unknown, _init?: unknown) => {
    return new Response(JSON.stringify({ error: "boom" }), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
}

describe("rerankWithCrossEncoder — happy path", () => {
  it("parses SiliconFlow-shaped response, sorted desc by score, original ids preserved", async () => {
    const fakeFetch = makeFetchOk({
      results: [
        { index: 1, relevance_score: 0.802 },
        { index: 0, relevance_score: 0.00005 },
        { index: 2, relevance_score: 0.00002 },
      ],
    })
    const out = await rerankWithCrossEncoder(
      "data analyst with python ml",
      [
        { id: "qc", text: "QC Quality Control Analyst" },
        { id: "ds", text: "Senior Data Scientist Python ML" },
        { id: "mk", text: "Marketing Manager" },
      ],
      { fetch: fakeFetch, apiKey: "test-key" }
    )
    assert.equal(out.length, 3)
    assert.equal(out[0]!.id, "ds", "data scientist must rank first")
    assert.equal(out[0]!.score, 0.802)
    assert.equal(out[1]!.id, "qc")
    assert.equal(out[2]!.id, "mk")
  })
})

describe("rerankWithCrossEncoder — fail-open semantics", () => {
  it("returns input order with score=null when API returns 503", async () => {
    const fakeFetch = makeFetchFail(503)
    const out = await rerankWithCrossEncoder(
      "q",
      [
        { id: "a", text: "alpha" },
        { id: "b", text: "beta" },
      ],
      { fetch: fakeFetch, apiKey: "k" }
    )
    assert.equal(out.length, 2)
    assert.equal(out[0]!.id, "a")
    assert.equal(out[1]!.id, "b")
    assert.equal(out[0]!.score, null)
    assert.equal(out[1]!.score, null)
  })

  it("returns input order with score=null when apiKey is empty", async () => {
    const out = await rerankWithCrossEncoder(
      "q",
      [{ id: "a", text: "alpha" }],
      { apiKey: "" }
    )
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, "a")
    assert.equal(out[0]!.score, null)
  })

  it("returns [] for empty candidates", async () => {
    const out = await rerankWithCrossEncoder("q", [], { apiKey: "k" })
    assert.deepEqual(out, [])
  })

  it("returns input order with score=null when fetch throws (network error)", async () => {
    const throwFetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const out = await rerankWithCrossEncoder(
      "q",
      [
        { id: "a", text: "alpha" },
        { id: "b", text: "beta" },
      ],
      { fetch: throwFetch, apiKey: "k" }
    )
    assert.equal(out.length, 2)
    assert.equal(out[0]!.id, "a")
    assert.equal(out[0]!.score, null)
  })

  it("returns input order with score=null when payload is malformed", async () => {
    const fakeFetch = makeFetchOk({ unexpected: "shape" })
    const out = await rerankWithCrossEncoder(
      "q",
      [{ id: "a", text: "alpha" }],
      { fetch: fakeFetch, apiKey: "k" }
    )
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, "a")
    assert.equal(out[0]!.score, null)
  })

  it("topN truncates input array before sending — only first N candidates considered", async () => {
    let capturedBody: unknown = null
    const fakeFetch = (async (_url: unknown, init?: unknown) => {
      const i = init as { body?: string }
      capturedBody = i?.body ? JSON.parse(i.body) : null
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch

    const cands = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, text: `text-${i}` }))
    await rerankWithCrossEncoder("q", cands, {
      fetch: fakeFetch,
      apiKey: "k",
      topN: 5,
    })
    const body = capturedBody as { documents: string[] } | null
    assert.ok(body, "body parsed")
    assert.equal(body!.documents.length, 5, "only topN documents sent to API")
  })
})

describe("buildRerankQuery", () => {
  it("composes role + skills + industries into short string", () => {
    const q = buildRerankQuery({
      recentRoleTitle: "Data Analyst",
      topSkills: ["Python", "SQL", "Tableau", "PowerBI", "A/B testing"],
      industryTags: ["tech_software", "ai_ml", "fintech_finance"],
    })
    assert.match(q, /Data Analyst/)
    assert.match(q, /Python/)
    assert.match(q, /tech_software/)
    assert.ok(q.length < 480, "query stays compact")
  })
  it("filters 'other' from industry tags + handles missing inputs", () => {
    const q = buildRerankQuery({
      recentRoleTitle: null,
      topSkills: null,
      industryTags: ["other", "tech_software"],
    })
    assert.match(q, /tech_software/)
    assert.doesNotMatch(q, /other/)
  })
  it("returns empty string when all inputs are missing", () => {
    assert.equal(buildRerankQuery({}), "")
  })
})

describe("buildJobCandidateText", () => {
  it("composes title + company + industry + skills", () => {
    const t = buildJobCandidateText({
      jobTitle: "Senior Data Scientist",
      companyName: "Stripe",
      industryKey: "fintech",
      requiredSkills: ["Python", "PyTorch", "SQL"],
    })
    assert.match(t, /Senior Data Scientist/)
    assert.match(t, /Stripe/)
    assert.match(t, /fintech/)
    assert.match(t, /skills: Python, PyTorch, SQL/)
  })
  it("handles missing fields gracefully", () => {
    const t = buildJobCandidateText({ jobTitle: "Engineer" })
    assert.match(t, /Engineer/)
  })
})
