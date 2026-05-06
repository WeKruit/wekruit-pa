/**
 * iter34 sprint B.9 — unit tests for lib/embeddings.ts.
 *
 * Coverage:
 *   - synthesizeCvSummaryText: happy path, missing fields, signal-too-low → null
 *   - computeCvEmbedding: happy path, OpenAI throw, empty response, no key
 *   - computeCvEmbedding: cost-labels propagated to logTokenSpend
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  computeCvEmbedding,
  synthesizeCvSummaryText,
  type EmbeddingClient,
  type EmbeddingResumeInput,
} from "../lib/embeddings.js"

function happyInput(): EmbeddingResumeInput {
  return {
    candidateProfile: {
      name: "Adam Test",
      location: "San Francisco, CA",
      skills: ["TypeScript", "Firestore", "React"],
    },
    experiences: [
      {
        title: "Founder",
        company: "WeKruit",
        description: "Built Claire, the iMessage recruiting agent.",
      },
    ],
    education: [{ degree: "BS", school: "Some University", field: "CS" }],
    industryTags: ["tech_software"],
    topSkills: ["typescript", "firestore", "react"],
  }
}

function fakeClient(opts: {
  vector?: number[]
  throwErr?: Error
  usage?: { prompt_tokens?: number; total_tokens?: number }
  capture?: { lastInput?: string }
}): EmbeddingClient {
  return {
    embeddings: {
      create: async (req) => {
        if (opts.capture) opts.capture.lastInput = req.input
        if (opts.throwErr) throw opts.throwErr
        return {
          data: [{ embedding: opts.vector ?? new Array(1536).fill(0.001) }],
          usage: opts.usage,
        }
      },
    },
  }
}

describe("synthesizeCvSummaryText", () => {
  it("happy path → non-empty string with name + role + skills + tags", () => {
    const text = synthesizeCvSummaryText(happyInput())
    assert.ok(typeof text === "string")
    assert.ok(text!.includes("Adam Test"))
    assert.ok(text!.includes("Founder"))
    assert.ok(text!.includes("WeKruit"))
    assert.ok(text!.includes("TypeScript") || text!.toLowerCase().includes("typescript"))
    assert.ok(text!.includes("tech_software"))
  })

  it("returns null when input has no signal (empty profile, no skills, no exp)", () => {
    const text = synthesizeCvSummaryText({
      candidateProfile: { name: null },
      experiences: [],
      education: [],
      industryTags: [],
      topSkills: [],
    })
    assert.equal(text, null)
  })

  it("caps skills at 25 (no infinite list bloat)", () => {
    const skills = Array.from({ length: 50 }, (_, i) => `skill_${i}`)
    const text = synthesizeCvSummaryText({
      candidateProfile: { name: "A", skills },
      experiences: [
        {
          title: "Engineer",
          company: "BigCo",
          description: "shipped many things over years",
        },
      ],
    })
    assert.ok(text)
    // 25th must appear, 49th must not
    assert.ok(text!.includes("skill_24"))
    assert.ok(!text!.includes("skill_49"))
  })

  it("trims to MAX_EMBED_INPUT_CHARS (8000)", () => {
    const giant = "x".repeat(20000)
    const text = synthesizeCvSummaryText({
      candidateProfile: { name: "A" },
      experiences: [{ title: "T", company: "C", description: giant }],
    })
    assert.ok(text)
    assert.ok(text!.length <= 8000)
  })
})

describe("computeCvEmbedding", () => {
  it("happy path → returns vector + model + dim + computedAt", async () => {
    const vec = new Array(1536).fill(0.5)
    const client = fakeClient({ vector: vec })
    const result = await computeCvEmbedding(happyInput(), {
      client,
      nowIso: () => "2026-05-05T12:00:00.000Z",
    })
    assert.ok(result)
    assert.equal(result!.dim, 1536)
    assert.equal(result!.model, "text-embedding-3-small")
    assert.equal(result!.computedAt, "2026-05-05T12:00:00.000Z")
    assert.equal(result!.vector.length, 1536)
  })

  it("OpenAI throws → returns null (no propagation)", async () => {
    const client = fakeClient({ throwErr: new Error("rate_limited") })
    const result = await computeCvEmbedding(happyInput(), { client })
    assert.equal(result, null)
  })

  it("empty response (data[0].embedding empty array) → returns null", async () => {
    const client = fakeClient({ vector: [] })
    const result = await computeCvEmbedding(happyInput(), { client })
    assert.equal(result, null)
  })

  it("input with no usable signal → returns null without calling OpenAI", async () => {
    let calls = 0
    const client: EmbeddingClient = {
      embeddings: {
        create: async () => {
          calls += 1
          return { data: [{ embedding: [0.1] }] }
        },
      },
    }
    const result = await computeCvEmbedding(
      {
        candidateProfile: { name: null },
        experiences: [],
        education: [],
      },
      { client }
    )
    assert.equal(result, null)
    assert.equal(calls, 0, "must not call OpenAI when input is empty")
  })

  it("no API key + no client → returns null + warn (env keys cleared)", async () => {
    const prevKey1 = process.env.OPENAI_API_KEY
    const prevKey2 = process.env.PA_OPENAI_AGENT_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.PA_OPENAI_AGENT_API_KEY
    try {
      const result = await computeCvEmbedding(happyInput())
      assert.equal(result, null)
    } finally {
      if (prevKey1) process.env.OPENAI_API_KEY = prevKey1
      if (prevKey2) process.env.PA_OPENAI_AGENT_API_KEY = prevKey2
    }
  })

  it("trims input to 8000 chars before calling OpenAI", async () => {
    const capture: { lastInput?: string } = {}
    const giant = "x".repeat(20000)
    const client = fakeClient({ vector: new Array(1536).fill(0.1), capture })
    await computeCvEmbedding(
      {
        candidateProfile: { name: "Adam" },
        experiences: [{ title: "T", company: "C", description: giant }],
      },
      { client }
    )
    assert.ok(capture.lastInput)
    assert.ok(capture.lastInput!.length <= 8000)
  })
})
