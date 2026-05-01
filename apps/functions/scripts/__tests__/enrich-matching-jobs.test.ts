import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  parseArgs,
  decideEnrichment,
  summarizeDecision,
  makeEmptySummary,
  formatSummary,
} from "../enrich-matching-jobs.js"
import { mapToCanonicalIndustry } from "../../src/cv-ingest/industry-tags.js"

describe("enrich-matching-jobs CLI parser", () => {
  it("defaults to dry-run when neither --dry-run nor --live passed", () => {
    const a = parseArgs([])
    assert.equal(a.dryRun, true)
    assert.equal(a.live, false)
    assert.equal(a.maxJobs, null)
  })

  it("--live --max-jobs=200 --batch=100 parses cleanly", () => {
    const a = parseArgs(["--live", "--max-jobs=200", "--batch=100"])
    assert.equal(a.live, true)
    assert.equal(a.dryRun, false)
    assert.equal(a.maxJobs, 200)
    assert.equal(a.batch, 100)
  })
})

describe("decideEnrichment (pure)", () => {
  it("doc already has industryEnum → action=skip reason=already_enriched", () => {
    const d = decideEnrichment(
      { industryKey: "fintech", industryEnum: "fintech_finance" },
      mapToCanonicalIndustry
    )
    assert.equal(d.action, "skip")
    if (d.action === "skip") assert.equal(d.reason, "already_enriched")
  })

  it("doc with no industry/industryKey → action=skip reason=no_industry", () => {
    const d = decideEnrichment({}, mapToCanonicalIndustry)
    assert.equal(d.action, "skip")
    if (d.action === "skip") assert.equal(d.reason, "no_industry")
  })

  it("doc with industryKey='fintech' → action=update industryEnum=fintech_finance", () => {
    const d = decideEnrichment({ industryKey: "fintech" }, mapToCanonicalIndustry)
    assert.equal(d.action, "update")
    if (d.action === "update") {
      assert.equal(d.industryEnum, "fintech_finance")
      assert.equal(d.sourceKey, "fintech")
    }
  })

  it("doc with unknown industryKey='space_exploration' → action=update industryEnum=other", () => {
    const d = decideEnrichment({ industryKey: "space_exploration" }, mapToCanonicalIndustry)
    assert.equal(d.action, "update")
    if (d.action === "update") {
      assert.equal(d.industryEnum, "other")
    }
  })

  it("idempotent: re-decision after a previous run leaves doc untouched (already_enriched)", () => {
    const data = { industryKey: "fintech" }
    const first = decideEnrichment(data, mapToCanonicalIndustry)
    assert.equal(first.action, "update")
    // Simulate the live mode applying the write — the next decide call sees it.
    const data2 = { ...data, industryEnum: "fintech_finance" }
    const second = decideEnrichment(data2, mapToCanonicalIndustry)
    assert.equal(second.action, "skip")
    if (second.action === "skip") assert.equal(second.reason, "already_enriched")
  })
})

describe("summarizeDecision + formatSummary", () => {
  it("counts by tag and surfaces 'other' samples", () => {
    const summary = makeEmptySummary()
    summary.scanned = 4

    summarizeDecision(
      decideEnrichment({ industryKey: "fintech" }, mapToCanonicalIndustry),
      "doc_a",
      summary
    )
    summarizeDecision(
      decideEnrichment({ industryKey: "ai_ml" }, mapToCanonicalIndustry),
      "doc_b",
      summary
    )
    summarizeDecision(
      decideEnrichment({ industryKey: "made_up" }, mapToCanonicalIndustry),
      "doc_c",
      summary
    )
    summarizeDecision(
      decideEnrichment({ industryKey: "fintech", industryEnum: "fintech_finance" }, mapToCanonicalIndustry),
      "doc_d",
      summary
    )

    assert.equal(summary.updated, 3)
    assert.equal(summary.alreadyEnriched, 1)
    assert.equal(summary.byTag.get("fintech_finance"), 1)
    assert.equal(summary.byTag.get("ai_ml"), 1)
    assert.equal(summary.byTag.get("other"), 1)
    assert.equal(summary.unmappedSamples.length, 1)
    assert.equal(summary.unmappedSamples[0]!.id, "doc_c")
    assert.equal(summary.unmappedSamples[0]!.industryKey, "made_up")

    const out = formatSummary(summary, { dryRun: true, live: false, maxJobs: null, batch: 500 })
    assert.match(out, /scanned:\s+4/)
    assert.match(out, /updated:\s+3/)
    assert.match(out, /alreadyEnriched:\s+1/)
    assert.match(out, /Unmapped samples/)
  })
})
