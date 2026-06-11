/**
 * employer-signals.test.ts — derived employer-history quality signals (Adam 2026-06-10).
 *
 * Covers: the growth-tier pure function, the pa-companies join (recency pick, normalizer reuse,
 * fail-open), the ownership/prestige extraction (STRICT schema shape, validation caps, injectable
 * client, fail-open), and the combined derivation.
 *
 *   node --import tsx --test apps/functions/src/external-supply/employer-signals.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildOwnershipInput,
  deriveEmployerCompanySignals,
  deriveEmployerGrowthTier,
  deriveEmployerHistorySignals,
  extractOwnershipSignals,
  loadEmployerCompanySignals,
  topCompanyIdsByRecency,
  OWNERSHIP_JSON_SCHEMA,
  type EmployerHistoryRow,
} from "./employer-signals.js"

// ─── deriveEmployerGrowthTier — documented pure rules ────────────────────

describe("deriveEmployerGrowthTier", () => {
  it("any series_a..c employer → growth", () => {
    assert.equal(deriveEmployerGrowthTier(["series_b"]), "growth")
    assert.equal(deriveEmployerGrowthTier(["ipo_public", "series_a"]), "growth")
    assert.equal(deriveEmployerGrowthTier(["seed", "series_c", "private_mature"]), "growth")
  })
  it("only early employers (pre_seed/seed) → early_stage", () => {
    assert.equal(deriveEmployerGrowthTier(["pre_seed"]), "early_stage")
    assert.equal(deriveEmployerGrowthTier(["seed", "pre_seed"]), "early_stage")
  })
  it("only mature employers → mature", () => {
    assert.equal(deriveEmployerGrowthTier(["ipo_public"]), "mature")
    assert.equal(deriveEmployerGrowthTier(["series_d_plus", "private_mature"]), "mature")
  })
  it("early AND mature mix (no series_a..c) → growth (spans both ends)", () => {
    assert.equal(deriveEmployerGrowthTier(["seed", "ipo_public"]), "growth")
  })
  it("no recognized stage signal → unknown (incl. unknown/bootstrapped/non_profit/junk)", () => {
    assert.equal(deriveEmployerGrowthTier([]), "unknown")
    assert.equal(deriveEmployerGrowthTier(["unknown"]), "unknown")
    assert.equal(deriveEmployerGrowthTier(["bootstrapped", "non_profit"]), "unknown")
    assert.equal(deriveEmployerGrowthTier(["not_a_stage"]), "unknown")
  })
})

// ─── topCompanyIdsByRecency — normalizer reuse + recency pick ────────────

describe("topCompanyIdsByRecency", () => {
  it("uses the pa-companies doc-id normalizer (normalizeCompanyName)", () => {
    const ids = topCompanyIdsByRecency([{ company: "Stripe, Inc." }, { company: "Y Combinator" }])
    assert.deepEqual(ids, ["stripe-inc", "y-combinator"])
  })
  it("dedupes the same company across rows and caps at 5 by recency (current first)", () => {
    const rows: EmployerHistoryRow[] = [
      { company: "Old Co", startDate: "2015-01-01" },
      { company: "Older Co", startDate: "2013-01-01" },
      { company: "Mid Co", startDate: "2018-01-01" },
      { company: "Recent Co", startDate: "2022-01-01" },
      { company: "Current Co", startDate: "2024-01-01", isCurrent: true },
      { company: "current co" }, // dup under normalization
      { company: "Sixth Co", startDate: "2020-01-01" },
    ]
    const ids = topCompanyIdsByRecency(rows)
    assert.equal(ids.length, 5)
    assert.equal(ids[0], "current-co", "current role leads")
    assert.deepEqual(ids, ["current-co", "recent-co", "sixth-co", "mid-co", "old-co"])
    assert.ok(!ids.includes("older-co"), "6th-oldest company dropped by the top-5 cap")
  })
  it("rows without a company are skipped; empty input → []", () => {
    assert.deepEqual(topCompanyIdsByRecency([{ title: "Engineer" }, {}]), [])
    assert.deepEqual(topCompanyIdsByRecency([]), [])
  })
})

// ─── deriveEmployerCompanySignals — pure derivation ──────────────────────

describe("deriveEmployerCompanySignals", () => {
  it("derives stages/tags/big-tech/growth-tier from loaded docs; missing docs skipped", () => {
    const out = deriveEmployerCompanySignals([
      { companyStage: "ipo_public", companyTags: ["big_tech", "mag_7"] },
      null, // company not enriched yet — fine
      { companyStage: "series_b", companyTags: ["yc_alumni", "unicorn"] },
    ])
    assert.deepEqual(out.employerStages, ["ipo_public", "series_b"])
    assert.deepEqual(out.employerTags, ["big_tech", "mag_7", "yc_alumni", "unicorn"])
    assert.equal(out.hasBigTechBackground, true)
    assert.equal(out.employerGrowthTier, "growth")
  })
  it("mag_7 alone also sets hasBigTechBackground", () => {
    const out = deriveEmployerCompanySignals([{ companyStage: "ipo_public", companyTags: ["mag_7"] }])
    assert.equal(out.hasBigTechBackground, true)
  })
  it("no big-tech tag → hasBigTechBackground key ABSENT (never false)", () => {
    const out = deriveEmployerCompanySignals([{ companyStage: "seed", companyTags: ["yc_active"] }])
    assert.ok(!("hasBigTechBackground" in out))
    assert.equal(out.employerGrowthTier, "early_stage")
  })
  it("`unknown` stage carries no signal — not recorded, no growth tier emitted from it", () => {
    const out = deriveEmployerCompanySignals([{ companyStage: "unknown", companyTags: [] }])
    assert.ok(!("employerStages" in out))
    assert.ok(!("employerGrowthTier" in out), "tier only emitted when a stage informed it")
  })
  it("all docs missing → {} (the seam then writes NOTHING)", () => {
    assert.deepEqual(deriveEmployerCompanySignals([null, undefined, null]), {})
  })
  it("employerTags capped at 30 + deduped/normalized", () => {
    const tags = Array.from({ length: 40 }, (_, i) => `tag_${i}`)
    const out = deriveEmployerCompanySignals([
      { companyStage: "seed", companyTags: [...tags, "TAG_0", " tag_1 "] },
    ])
    assert.equal(out.employerTags!.length, 30)
    assert.equal(new Set(out.employerTags).size, 30)
  })
})

// ─── loadEmployerCompanySignals — join fail-open ─────────────────────────

describe("loadEmployerCompanySignals — fail-open", () => {
  const rows: EmployerHistoryRow[] = [{ company: "Stripe", title: "SWE" }]
  it("a throwing loader logs + returns {} (merge result unaffected)", async () => {
    const events: string[] = []
    const out = await loadEmployerCompanySignals(rows, {
      getCompanyDocs: async () => {
        throw new Error("firestore down")
      },
      log: (e) => events.push(e),
    })
    assert.deepEqual(out, {})
    assert.ok(events.includes("pa.employer_signals.company_join_error"))
  })
  it("no company rows → {} without calling the loader", async () => {
    let called = false
    const out = await loadEmployerCompanySignals([{ title: "Engineer" }], {
      getCompanyDocs: async () => {
        called = true
        return []
      },
    })
    assert.deepEqual(out, {})
    assert.equal(called, false)
  })
  it("loader receives the normalized doc ids", async () => {
    let received: string[] = []
    await loadEmployerCompanySignals(rows, {
      getCompanyDocs: async (ids) => {
        received = ids
        return [null]
      },
    })
    assert.deepEqual(received, ["stripe"])
  })
})

// ─── extractOwnershipSignals — STRICT schema + validation + injectable ───

describe("OWNERSHIP_JSON_SCHEMA", () => {
  it("is STRICT with additionalProperties:false and all fields required (json_schema strict contract)", () => {
    assert.equal(OWNERSHIP_JSON_SCHEMA.strict, true)
    assert.equal(OWNERSHIP_JSON_SCHEMA.schema.additionalProperties, false)
    assert.deepEqual(
      [...OWNERSHIP_JSON_SCHEMA.schema.required].sort(),
      ["founderRole", "scopeOfOwnership", "selectivitySignals"],
    )
    assert.equal(OWNERSHIP_JSON_SCHEMA.schema.properties.scopeOfOwnership.additionalProperties, false)
  })
})

describe("extractOwnershipSignals", () => {
  const rows: EmployerHistoryRow[] = [
    { title: "Co-Founder", company: "Acme", description: "Led a team of 5 • $2M ARR • Top 0.1% of 390K honoree" },
  ]
  it("valid LLM JSON → validated signals (injectable client, no network)", async () => {
    let sawText = ""
    const out = await extractOwnershipSignals(rows, {
      llmCall: async ({ text }) => {
        sawText = text
        return JSON.stringify({
          founderRole: true,
          scopeOfOwnership: { teamSize: 5, revenue: "$2M ARR", users: null },
          selectivitySignals: ["Top 0.1% of 390K"],
        })
      },
    })
    assert.ok(sawText.includes("Co-Founder @ Acme"), "input carries title@company + description")
    assert.deepEqual(out, {
      founderRole: true,
      scopeOfOwnership: { teamSize: 5, revenue: "$2M ARR" },
      selectivitySignals: ["Top 0.1% of 390K"],
    })
  })
  it("founderRole=false is OMITTED (never write a negative claim from a 3k window)", async () => {
    const out = await extractOwnershipSignals(rows, {
      llmCall: async () =>
        JSON.stringify({
          founderRole: false,
          scopeOfOwnership: { teamSize: null, revenue: null, users: 5000 },
          selectivitySignals: [],
        }),
    })
    assert.deepEqual(out, { scopeOfOwnership: { users: 5000 } })
    assert.ok(!("founderRole" in (out ?? {})))
  })
  it("caps enforced: ≤10 selectivity signals, each ≤60 chars; junk scope values dropped", async () => {
    const out = await extractOwnershipSignals(rows, {
      llmCall: async () =>
        JSON.stringify({
          founderRole: true,
          scopeOfOwnership: { teamSize: 2.7, revenue: "  ", users: -3 },
          selectivitySignals: [
            ...Array.from({ length: 12 }, (_, i) => `honor ${i} ${"x".repeat(80)}`),
          ],
        }),
    })
    assert.equal(out!.selectivitySignals!.length, 10)
    assert.ok(out!.selectivitySignals!.every((s) => s.length <= 60))
    assert.ok(!("scopeOfOwnership" in out!), "non-integer teamSize / blank revenue / negative users all dropped")
  })
  it("fail-open: unparseable / empty / throwing client → null", async () => {
    assert.equal(await extractOwnershipSignals(rows, { llmCall: async () => "not json" }), null)
    assert.equal(await extractOwnershipSignals(rows, { llmCall: async () => "" }), null)
    assert.equal(
      await extractOwnershipSignals(rows, {
        llmCall: async () => {
          throw new Error("rate limited")
        },
      }),
      null,
    )
  })
  it("no usable input rows → null without calling the client", async () => {
    let called = false
    const out = await extractOwnershipSignals([{}, { description: "" }], {
      llmCall: async () => {
        called = true
        return "{}"
      },
    })
    assert.equal(out, null)
    assert.equal(called, false)
  })
  it("buildOwnershipInput caps at ~3k chars", () => {
    const long: EmployerHistoryRow[] = Array.from({ length: 10 }, (_, i) => ({
      title: `Role ${i}`,
      company: `Co ${i}`,
      description: "y".repeat(1_000),
    }))
    assert.ok(buildOwnershipInput(long).length <= 3_000)
  })
})

// ─── deriveEmployerHistorySignals — combined orchestration ───────────────

describe("deriveEmployerHistorySignals", () => {
  const rows: EmployerHistoryRow[] = [
    { title: "Founder", company: "Acme", isCurrent: true, description: "built it 0→1" },
  ]
  it("merges company-join + ownership halves", async () => {
    const out = await deriveEmployerHistorySignals(rows, {
      getCompanyDocs: async () => [{ companyStage: "seed", companyTags: ["yc_alumni"] }],
      llmCall: async () =>
        JSON.stringify({
          founderRole: true,
          scopeOfOwnership: { teamSize: null, revenue: null, users: null },
          selectivitySignals: [],
        }),
    })
    assert.deepEqual(out, {
      employerStages: ["seed"],
      employerTags: ["yc_alumni"],
      employerGrowthTier: "early_stage",
      founderRole: true,
    })
  })
  it("each half is independently fail-open: both failing → {} (write nothing)", async () => {
    const out = await deriveEmployerHistorySignals(rows, {
      getCompanyDocs: async () => {
        throw new Error("join down")
      },
      llmCall: async () => {
        throw new Error("llm down")
      },
    })
    assert.deepEqual(out, {})
  })
  it("no getCompanyDocs dep → ownership half still runs", async () => {
    const out = await deriveEmployerHistorySignals(rows, {
      llmCall: async () =>
        JSON.stringify({
          founderRole: true,
          scopeOfOwnership: { teamSize: null, revenue: null, users: null },
          selectivitySignals: [],
        }),
    })
    assert.deepEqual(out, { founderRole: true })
  })
  it("empty rows → {}", async () => {
    assert.deepEqual(await deriveEmployerHistorySignals([], {}), {})
  })
})
