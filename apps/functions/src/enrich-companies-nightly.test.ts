/**
 * Phase A5 — paEnrichCompaniesNightly / paEnrichCompaniesAdHoc unit tests.
 *
 * Covers:
 *  - YC cache hit → writes correct stage + tags + source="yc"
 *  - YC miss, Wikidata hit → source="wikidata"
 *  - All free tiers fail, LLM disabled → unknown stage/tags + enrichedAt stamp
 *  - lastReviewedBy != null doc → skipped (no write)
 *  - explicit names path → only those processed
 *  - "all_stale" path → uses staleness query
 *  - Clearbit quota at cap → tier skipped (probeClearbit returns null)
 *  - ycBatchYear / deriveYcStage / deriveYcTags edge cases
 *  - parseWikidataResponse / parseClearbitResponse / parseLlmReply parsing
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  buildCompanyDoc,
  buildWikidataQuery,
  deriveYcStage,
  deriveYcTags,
  emptyCounters,
  enrichOneCompany,
  lookupYc,
  parseClearbitResponse,
  parseLlmReply,
  parseWikidataResponse,
  runEnrichmentBatch,
  ycBatchYear,
  ycResultFor,
  type EnrichDeps,
  type EnrichmentResult,
  type YcCache,
} from "./enrich-companies-nightly.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-05-15T00:00:00Z").getTime()

type WriteCapture = { id: string; data: Record<string, unknown> }

function makeDeps(overrides: Partial<EnrichDeps> = {}): {
  deps: EnrichDeps
  writes: WriteCapture[]
} {
  const writes: WriteCapture[] = []
  const deps: EnrichDeps = {
    now: () => FIXED_NOW,
    log: () => {},
    errorLog: () => {},
    loadYcCache: async () => null,
    probeWikidata: async () => null,
    probeClearbit: async () => null,
    probeLlm: async () => null,
    readExisting: async () => null,
    writeCompany: async (id, data) => {
      writes.push({ id, data: data as Record<string, unknown> })
    },
    bumpClearbitQuota: async () => 1,
    readClearbitQuota: async () => null,
    resolveCandidateNames: async (_mode, explicit, limit) => explicit.slice(0, limit),
    ...overrides,
  }
  return { deps, writes }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("ycBatchYear", () => {
  it("extracts year from W/S batch codes", () => {
    assert.equal(ycBatchYear("W21"), 2021)
    assert.equal(ycBatchYear("S15"), 2015)
    assert.equal(ycBatchYear("w08"), 2008)
  })
  it("returns null for bad input", () => {
    assert.equal(ycBatchYear(null), null)
    assert.equal(ycBatchYear(""), null)
    assert.equal(ycBatchYear("Winter21"), null)
    assert.equal(ycBatchYear("X25"), null)
  })
})

describe("deriveYcStage", () => {
  const now = new Date("2026-05-15T00:00:00Z")
  it("active + new batch → seed", () => {
    assert.equal(deriveYcStage({ name: "X", batch: "W25", status: "active" }, now), "seed")
  })
  it("active + mid-age → series_a/b", () => {
    assert.equal(deriveYcStage({ name: "X", batch: "W22", status: "active" }, now), "series_a")
    assert.equal(deriveYcStage({ name: "X", batch: "W20", status: "active" }, now), "series_b")
  })
  it("acquired pre-W18 → private_mature", () => {
    assert.equal(
      deriveYcStage({ name: "X", batch: "W15", status: "acquired" }, now),
      "private_mature"
    )
  })
  it("dead → unknown", () => {
    assert.equal(deriveYcStage({ name: "X", batch: "W22", status: "dead" }, now), "unknown")
  })
})

describe("deriveYcTags", () => {
  const now = new Date("2026-05-15T00:00:00Z")
  it("active → yc_active", () => {
    const tags = deriveYcTags({ name: "X", batch: "W25", status: "active" }, now)
    assert.ok(tags.includes("yc_active"))
  })
  it("old active → yc_active + yc_alumni", () => {
    const tags = deriveYcTags({ name: "X", batch: "W15", status: "active" }, now)
    assert.ok(tags.includes("yc_active"))
    assert.ok(tags.includes("yc_alumni"))
  })
  it("AI industry → ai_native", () => {
    const tags = deriveYcTags(
      { name: "X", batch: "W22", status: "active", industry: "Artificial Intelligence" },
      now
    )
    assert.ok(tags.includes("ai_native"))
  })
})

describe("lookupYc", () => {
  it("matches by normalized name", () => {
    const cache: YcCache = {
      companies: [
        { name: "Anthropic", batch: "W22", status: "active" },
        { name: "OpenAI", batch: "W16", status: "active" },
      ],
    }
    const co = lookupYc(cache, "anthropic")
    assert.ok(co)
    assert.equal(co?.name, "Anthropic")
  })
  it("returns null on miss", () => {
    const cache: YcCache = { companies: [{ name: "Anthropic" }] }
    assert.equal(lookupYc(cache, "deepmind"), null)
  })
  it("handles null cache", () => {
    assert.equal(lookupYc(null, "x"), null)
  })
})

describe("ycResultFor", () => {
  it("extracts domain + logo from website", () => {
    const r = ycResultFor(
      { name: "Anthropic", batch: "W22", status: "active", website: "https://www.anthropic.com/" },
      new Date(FIXED_NOW)
    )
    assert.equal(r.source, "yc")
    assert.equal(r.patch?.domain, "anthropic.com")
    assert.equal(r.patch?.logoUrl, "https://logo.clearbit.com/anthropic.com")
  })
  it("includes yc_active tag for active batch", () => {
    const r = ycResultFor({ name: "X", batch: "W25", status: "active" }, new Date(FIXED_NOW))
    assert.ok(r.tags.includes("yc_active"))
  })
})

// ---------------------------------------------------------------------------
// Wikidata / Clearbit / LLM parsers
// ---------------------------------------------------------------------------

describe("buildWikidataQuery", () => {
  it("includes the company name verbatim and is SPARQL-shaped", () => {
    const q = buildWikidataQuery("Anthropic")
    assert.ok(q.includes('"Anthropic"@en'))
    assert.ok(q.includes("SELECT"))
    assert.ok(q.includes("wdt:P1128"))
  })
  it("escapes embedded quotes", () => {
    const q = buildWikidataQuery('Foo "Bar"')
    assert.ok(q.includes('"Foo \\"Bar\\""@en'))
  })
})

describe("parseWikidataResponse", () => {
  const now = new Date("2026-05-15T00:00:00Z")
  it("returns ipo_public when listed exchange present", () => {
    const r = parseWikidataResponse(
      {
        results: {
          bindings: [
            {
              employees: { value: "2000" },
              listed: { value: "http://wikidata.org/entity/Q123" },
            },
          ],
        },
      },
      now
    )
    assert.equal(r?.stage, "ipo_public")
    assert.equal(r?.source, "wikidata")
  })
  it("buckets by employee count", () => {
    const r = parseWikidataResponse(
      { results: { bindings: [{ employees: { value: "30" } }] } },
      now
    )
    assert.equal(r?.stage, "series_a")
    assert.equal(r?.patch?.employeeRange, "11-50")
  })
  it("returns null on empty bindings", () => {
    assert.equal(parseWikidataResponse({ results: { bindings: [] } }, now), null)
    assert.equal(parseWikidataResponse(null, now), null)
  })
})

describe("parseClearbitResponse", () => {
  it("derives stage from employee count + sets domain", () => {
    const r = parseClearbitResponse({
      name: "Anthropic",
      domain: "anthropic.com",
      metrics: { employees: 400, estimatedAnnualRevenue: 100_000_000 },
      tags: ["Artificial Intelligence", "B2B"],
    })
    assert.equal(r?.source, "clearbit")
    assert.equal(r?.stage, "series_c")
    assert.ok(r?.tags.includes("ai_native"))
    assert.equal(r?.patch?.domain, "anthropic.com")
  })
  it("returns null for completely empty payload", () => {
    assert.equal(parseClearbitResponse({}), null)
  })
})

describe("parseLlmReply", () => {
  it("parses content[0].text JSON", () => {
    const r = parseLlmReply(
      {
        content: [
          { type: "text", text: '{"stage":"series_b","tags":["ai_native","yc_active"]}' },
        ],
      },
      "Anthropic"
    )
    assert.equal(r?.source, "llm")
    assert.equal(r?.stage, "series_b")
    assert.deepEqual(r?.tags, ["ai_native", "yc_active"])
  })
  it("coerces invalid stage to 'unknown'", () => {
    const r = parseLlmReply(
      { content: [{ type: "text", text: '{"stage":"giga_unicorn","tags":[]}' }] },
      "X"
    )
    assert.equal(r?.stage, "unknown")
  })
  it("drops malformed tags", () => {
    const r = parseLlmReply(
      {
        content: [
          { type: "text", text: '{"stage":"seed","tags":["Big Tech","ai_native","123bad"]}' },
        ],
      },
      "X"
    )
    assert.deepEqual(r?.tags, ["ai_native"])
  })
  it("returns null on non-JSON reply", () => {
    assert.equal(parseLlmReply({ content: [{ type: "text", text: "no json here" }] }, "X"), null)
  })
})

// ---------------------------------------------------------------------------
// buildCompanyDoc
// ---------------------------------------------------------------------------

describe("buildCompanyDoc", () => {
  it("stamps createdAt on first write", () => {
    const r: EnrichmentResult = { stage: "seed", tags: ["yc_active"], source: "yc" }
    const doc = buildCompanyDoc("Anthropic", r, null, "2026-05-15T00:00:00Z")
    assert.equal(doc.createdAt, "2026-05-15T00:00:00Z")
    assert.equal(doc.updatedAt, "2026-05-15T00:00:00Z")
    assert.equal(doc.companyStage, "seed")
    assert.equal(doc.enrichmentSource, "yc")
    assert.equal(doc.id, "anthropic")
    assert.equal(doc.normalizedName, "anthropic")
    assert.equal(doc.lastReviewedBy, null)
  })
  it("does not stamp createdAt when doc existed", () => {
    const r: EnrichmentResult = { stage: "seed", tags: [], source: "wikidata" }
    const doc = buildCompanyDoc("X", r, { createdAt: "2026-01-01T00:00:00Z" }, "2026-05-15T00:00:00Z")
    assert.equal(doc.createdAt, undefined)
  })
  it("preserves prior enrichmentSource when result is unknown", () => {
    const r: EnrichmentResult = { stage: "unknown", tags: [], source: "unknown" }
    const doc = buildCompanyDoc("X", r, { enrichmentSource: "wikidata" }, "2026-05-15T00:00:00Z")
    assert.equal(doc.enrichmentSource, "wikidata")
  })
})

// ---------------------------------------------------------------------------
// enrichOneCompany — cascade tier ordering
// ---------------------------------------------------------------------------

describe("enrichOneCompany cascade", () => {
  it("YC cache hit short-circuits before Wikidata/Clearbit/LLM", async () => {
    const cache: YcCache = {
      companies: [{ name: "Anthropic", batch: "W22", status: "active" }],
    }
    let wikidataCalled = false
    let clearbitCalled = false
    let llmCalled = false
    const { deps } = makeDeps({
      probeWikidata: async () => {
        wikidataCalled = true
        return null
      },
      probeClearbit: async () => {
        clearbitCalled = true
        return null
      },
      probeLlm: async () => {
        llmCalled = true
        return null
      },
    })
    const counters = emptyCounters()
    const result = await enrichOneCompany("Anthropic", deps, counters, cache)
    assert.equal(result.source, "yc")
    assert.equal(wikidataCalled, false)
    assert.equal(clearbitCalled, false)
    assert.equal(llmCalled, false)
    assert.equal(counters.yc_hits, 1)
  })

  it("YC miss → Wikidata hit → returns wikidata", async () => {
    let wikidataCalled = false
    let clearbitCalled = false
    const { deps } = makeDeps({
      probeWikidata: async () => {
        wikidataCalled = true
        return { stage: "series_b", tags: [], source: "wikidata" }
      },
      probeClearbit: async () => {
        clearbitCalled = true
        return null
      },
    })
    const counters = emptyCounters()
    const result = await enrichOneCompany("Stripe", deps, counters, null)
    assert.equal(wikidataCalled, true)
    assert.equal(clearbitCalled, false)
    assert.equal(result.source, "wikidata")
    assert.equal(result.stage, "series_b")
    assert.equal(counters.wikidata_hits, 1)
  })

  it("all free tiers + LLM disabled → unknown source/stage/tags", async () => {
    const { deps } = makeDeps({
      probeWikidata: async () => null,
      probeClearbit: async () => null,
      probeLlm: async () => null,
    })
    const counters = emptyCounters()
    const result = await enrichOneCompany("ObscureCo", deps, counters, null)
    assert.equal(result.source, "unknown")
    assert.equal(result.stage, "unknown")
    assert.deepEqual(result.tags, [])
    assert.equal(counters.unknown, 1)
  })

  it("Clearbit quota at cap (probeClearbit returns null) → falls through to LLM", async () => {
    let llmCalled = false
    const { deps } = makeDeps({
      probeWikidata: async () => null,
      probeClearbit: async () => null,
      probeLlm: async () => {
        llmCalled = true
        return { stage: "seed", tags: ["ai_native"], source: "llm" }
      },
    })
    const counters = emptyCounters()
    const result = await enrichOneCompany("LlmOnly", deps, counters, null)
    assert.equal(llmCalled, true)
    assert.equal(result.source, "llm")
    assert.equal(counters.llm_hits, 1)
  })
})

// ---------------------------------------------------------------------------
// runEnrichmentBatch — end-to-end with in-memory store
// ---------------------------------------------------------------------------

describe("runEnrichmentBatch", () => {
  it("skips docs with lastReviewedBy set (no write)", async () => {
    const { deps, writes } = makeDeps({
      readExisting: async () => ({ lastReviewedBy: "admin1@wekruit.com" }),
      probeWikidata: async () => {
        throw new Error("should not be called")
      },
    })
    const counters = await runEnrichmentBatch("explicit", ["Anthropic"], 10, deps)
    assert.equal(counters.skipped_reviewed, 1)
    assert.equal(counters.processed, 0)
    assert.equal(writes.length, 0)
  })

  it("explicit names path → only those processed (resolveCandidateNames echoes input)", async () => {
    const cache: YcCache = {
      companies: [
        { name: "Anthropic", batch: "W22", status: "active" },
        { name: "Stripe", batch: "S10", status: "active" },
      ],
    }
    const { deps, writes } = makeDeps({
      loadYcCache: async () => cache,
    })
    const counters = await runEnrichmentBatch("explicit", ["Anthropic"], 10, deps)
    assert.equal(counters.candidates, 1)
    assert.equal(counters.processed, 1)
    assert.equal(counters.yc_hits, 1)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].id, "anthropic")
    assert.equal((writes[0].data as Record<string, unknown>).enrichmentSource, "yc")
    const tags = (writes[0].data as Record<string, unknown>).companyTags as string[]
    assert.ok(Array.isArray(tags) && tags.includes("yc_active"))
  })

  it("all_stale path → uses staleness resolver", async () => {
    let modeSeen: string | null = null
    const { deps, writes } = makeDeps({
      resolveCandidateNames: async (mode, _explicit, limit) => {
        modeSeen = mode
        return ["StaleCo"].slice(0, limit)
      },
      probeWikidata: async () => ({ stage: "series_a", tags: [], source: "wikidata" }),
    })
    const counters = await runEnrichmentBatch("all_stale", [], 50, deps)
    assert.equal(modeSeen, "all_stale")
    assert.equal(counters.candidates, 1)
    assert.equal(counters.processed, 1)
    assert.equal(writes.length, 1)
    assert.equal((writes[0].data as Record<string, unknown>).enrichmentSource, "wikidata")
  })

  it("writes 'unknown' stage with prior source preserved when all tiers miss", async () => {
    const { deps, writes } = makeDeps({
      readExisting: async () => ({
        enrichmentSource: "manual",
        createdAt: "2026-01-01T00:00:00Z",
        lastReviewedBy: null,
      }),
    })
    const counters = await runEnrichmentBatch("explicit", ["GhostCo"], 10, deps)
    assert.equal(counters.unknown, 1)
    assert.equal(writes.length, 1)
    const data = writes[0].data as Record<string, unknown>
    assert.equal(data.companyStage, "unknown")
    assert.deepEqual(data.companyTags, [])
    assert.equal(data.enrichmentSource, "manual")
    assert.equal(typeof data.enrichedAt, "string")
  })

  it("respects limit", async () => {
    const { deps, writes } = makeDeps({
      probeWikidata: async () => ({ stage: "seed", tags: [], source: "wikidata" }),
    })
    const counters = await runEnrichmentBatch(
      "explicit",
      ["A", "B", "C", "D", "E"],
      2,
      deps
    )
    assert.equal(counters.candidates, 2)
    assert.equal(writes.length, 2)
  })
})
