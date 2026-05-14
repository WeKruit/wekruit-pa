/**
 * Wave C (Executor D) — `agent-rank-prompt.ts` pure-module tests.
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  AGENT_RANK_EXPECTED_SCHEMA_VERSION,
  AGENT_RANK_PROMPT_VERSION,
  COST_TABLE_VERSION,
  MODEL_PRICING_USD_PER_1K,
  OUTPUT_TOKEN_BUDGET,
  buildAgentRankingPrompt,
  computeActualVoteCostUsd,
  estimateAgentRankingTokens,
  parseAgentRankingResponse,
  pickEnsembleMajority,
  projectAgentRankingCost,
  type AgentRankingPromptInput,
} from "./agent-rank-prompt.js"
import type { AgentRankingEnsembleVote } from "@pa/core-types"

function baseInput(): AgentRankingPromptInput {
  return {
    candidate: {
      recordId: "rec-001",
      candidateId: "cand-aaa",
      name: "Alice Johnson",
      canonicalLinkedInUrl: "https://linkedin.com/in/alice",
      currentTitle: "Senior Software Engineer",
      currentCompany: "Stripe",
      experience: [
        { company: "Stripe", title: "Senior Software Engineer", startDate: "2022-01" },
        { company: "Plaid", title: "Software Engineer", startDate: "2020-01", endDate: "2021-12" },
      ],
      skills: ["typescript", "react", "node", "postgres"],
    },
    company: {
      companyId: "co-1",
      companyName: "Acme",
      industrySector: ["financial_technology"],
      competitorCompanies: ["Stripe", "Adyen"],
      size: "scale_up",
    },
    job: {
      jobId: "job-1",
      jobTitle: "Senior Backend Engineer",
      roleFunction: ["software_engineering"],
      seniorityLevel: "senior",
      requiredSkills: ["typescript", "postgres"],
      locationBuckets: ["san_francisco_bay_area"],
      industrySector: ["financial_technology"],
    },
    approvedResearchFindings: [],
    deterministicRubric: {
      proposedTier: "tier_2_personal_email",
      generalRubricScore: 0.78,
      companyRubricScore: 0.71,
      jobRubricScore: 0.65,
      softScore: 0.7,
      hardGateResult: "pass",
      hardGateReasons: [],
      missingInfo: [],
      risks: [],
      explanation: "Skill overlap is solid; competitor match boosts company fit.",
    },
  }
}

test("buildAgentRankingPrompt — deterministic byte-for-byte on a golden fixture", () => {
  const a = buildAgentRankingPrompt(baseInput())
  const b = buildAgentRankingPrompt(baseInput())
  assert.equal(a.prompt, b.prompt)
  assert.equal(a.promptVersion, AGENT_RANK_PROMPT_VERSION)
  assert.equal(a.expectedSchemaVersion, AGENT_RANK_EXPECTED_SCHEMA_VERSION)
  assert.ok(a.prompt.includes("Job + Company:"))
  assert.ok(a.prompt.includes("Candidate:"))
  assert.ok(a.prompt.includes("Approved agent-research findings:"))
  assert.ok(a.prompt.includes("Deterministic rubric output:"))
  assert.ok(a.prompt.includes("Ranking ask:"))
  assert.ok(a.prompt.includes("Output JSON contract:"))
})

test("buildAgentRankingPrompt — PII scrub on candidate name + email-shaped fields", () => {
  const input = baseInput()
  input.candidate.name = "John Doe"
  input.candidate.currentTitle = "SWE at john.doe@example.com"
  input.candidate.currentCompany = "Acme +1 (415) 555-1234"
  const out = buildAgentRankingPrompt(input)
  assert.ok(!out.prompt.includes("john.doe@example.com"))
  assert.ok(!out.prompt.includes("(415) 555-1234"))
  // Last-name reduced to initial.
  assert.ok(out.prompt.includes("John D."))
  assert.ok(!out.prompt.includes("John Doe"))
})

test("buildAgentRankingPrompt — approved-only filter (the caller decides; builder renders what it gets)", () => {
  const input = baseInput()
  // Simulate caller already filtered to approved only.
  input.approvedResearchFindings = [
    {
      field: "yearsExperience",
      value: 6,
      confidence: 0.9,
      evidenceUrls: ["https://example.com/linkedin/alice"],
    },
  ]
  const a = buildAgentRankingPrompt(input)
  assert.ok(a.prompt.includes("yearsExperience: 6"))
  // Now ensure that if caller passes empty (rejected ones filtered), no findings appear.
  input.approvedResearchFindings = []
  const b = buildAgentRankingPrompt(input)
  assert.ok(b.prompt.includes("(none)"))
  assert.ok(!b.prompt.includes("yearsExperience:"))
})

test("buildAgentRankingPrompt — experience truncation note", () => {
  const input = baseInput()
  input.candidate.experience = []
  for (let i = 0; i < 15; i += 1) {
    input.candidate.experience.push({
      company: `Co${i}`,
      title: `Title${i}`,
      startDate: `20${10 + i}-01`,
    })
  }
  input.candidate.skills = Array.from({ length: 50 }, (_, i) => `skill-${i}`)
  const out = buildAgentRankingPrompt(input)
  assert.ok(out.prompt.includes("showing 10 of 15"))
  assert.ok(out.prompt.includes("showing 30 of 50"))
  // Earliest experience dropped (we keep most recent 10).
  assert.ok(!out.prompt.includes("Co0 "))
  assert.ok(out.prompt.includes("Co14"))
})

test("parseAgentRankingResponse — clean JSON round-trip", () => {
  const raw = JSON.stringify({
    schemaVersion: AGENT_RANK_EXPECTED_SCHEMA_VERSION,
    proposedAgentTier: "tier_2_personal_email",
    agentRationale: "Strong fit, competitor match.",
    agentRisks: ["unverified_yoe"],
    agentRecommendedAction: "outreach_now",
  })
  const r = parseAgentRankingResponse(raw)
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.vote.proposedAgentTier, "tier_2_personal_email")
  assert.equal(r.vote.agentRecommendedAction, "outreach_now")
  assert.deepEqual(r.vote.agentRisks, ["unverified_yoe"])
  assert.equal(r.schemaVersionMismatch, false)
})

test("parseAgentRankingResponse — tolerates fenced ```json blocks + prose", () => {
  const raw = `Sure! Here is the result:

\`\`\`json
{
  "schemaVersion": "${AGENT_RANK_EXPECTED_SCHEMA_VERSION}",
  "proposedAgentTier": "tier_1_personal_linkedin_and_email",
  "agentRationale": "Top-1.",
  "agentRisks": [],
  "agentRecommendedAction": "outreach_now"
}
\`\`\`

Hope that helps!`
  const r = parseAgentRankingResponse(raw)
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.vote.proposedAgentTier, "tier_1_personal_linkedin_and_email")
})

test("parseAgentRankingResponse — schema version mismatch surfaced, parse still succeeds", () => {
  const raw = JSON.stringify({
    schemaVersion: "agent-rank-result-DRIFT",
    proposedAgentTier: "retain_only",
    agentRationale: "Borderline.",
    agentRisks: [],
    agentRecommendedAction: "retain_warm",
  })
  const r = parseAgentRankingResponse(raw)
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.schemaVersionMismatch, true)
  assert.equal(r.vote.proposedAgentTier, "retain_only")
})

test("parseAgentRankingResponse — surfaces parseErrors without throwing on invalid envelope", () => {
  const r = parseAgentRankingResponse("{ this is not valid json")
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.ok(r.parseErrors.length > 0)
})

test("pickEnsembleMajority — 3-of-3 same tier wins", () => {
  const v = (tier: AgentRankingEnsembleVote["proposedAgentTier"]): AgentRankingEnsembleVote => ({
    modelUsed: "gpt-5.4-nano",
    proposedAgentTier: tier,
    agentRationale: `rationale-${tier}`,
    agentRisks: [],
    agentRecommendedAction: "outreach_now",
    inputTokens: 10,
    outputTokens: 10,
    costUsd: 0,
  })
  const r = pickEnsembleMajority(
    [v("tier_1_personal_linkedin_and_email"), v("tier_1_personal_linkedin_and_email"), v("tier_1_personal_linkedin_and_email")],
    "tier_2_personal_email",
  )
  assert.equal(r.proposedAgentTier, "tier_1_personal_linkedin_and_email")
  assert.equal(r.tieFellBackToDeterministic, false)
  assert.equal(r.agentRecommendedAction, "outreach_now")
})

test("pickEnsembleMajority — 2-of-3 majority wins; risks concatenated with model prefix", () => {
  const votes: AgentRankingEnsembleVote[] = [
    {
      modelUsed: "gpt-5.4-nano",
      proposedAgentTier: "tier_2_personal_email",
      agentRationale: "fit",
      agentRisks: ["maybe_old_data"],
      agentRecommendedAction: "outreach_now",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    },
    {
      modelUsed: "gpt-5.4-nano",
      proposedAgentTier: "tier_2_personal_email",
      agentRationale: "fit2",
      agentRisks: [],
      agentRecommendedAction: "outreach_after_research",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    },
    {
      modelUsed: "gpt-5.4-nano",
      proposedAgentTier: "retain_only",
      agentRationale: "weak",
      agentRisks: ["no_recent_signal"],
      agentRecommendedAction: "retain_warm",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    },
  ]
  const r = pickEnsembleMajority(votes, "tier_3_general_email")
  assert.equal(r.proposedAgentTier, "tier_2_personal_email")
  assert.equal(r.tieFellBackToDeterministic, false)
  assert.deepEqual(r.agentRisks, ["[gpt-5.4-nano] maybe_old_data", "[gpt-5.4-nano] no_recent_signal"])
})

test("pickEnsembleMajority — 3-way tie falls back to deterministic + outreach_after_research", () => {
  const votes: AgentRankingEnsembleVote[] = [
    {
      modelUsed: "m1",
      proposedAgentTier: "tier_1_personal_linkedin_and_email",
      agentRationale: "r1",
      agentRisks: [],
      agentRecommendedAction: "outreach_now",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    },
    {
      modelUsed: "m2",
      proposedAgentTier: "tier_2_personal_email",
      agentRationale: "r2",
      agentRisks: [],
      agentRecommendedAction: "outreach_now",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    },
    {
      modelUsed: "m3",
      proposedAgentTier: "tier_3_general_email",
      agentRationale: "r3",
      agentRisks: [],
      agentRecommendedAction: "retain_warm",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    },
  ]
  const r = pickEnsembleMajority(votes, "retain_only")
  assert.equal(r.proposedAgentTier, "retain_only")
  assert.equal(r.tieFellBackToDeterministic, true)
  assert.equal(r.agentRecommendedAction, "outreach_after_research")
})

test("estimateAgentRankingTokens — positive integers, deterministic", () => {
  const a = estimateAgentRankingTokens("hello world")
  const b = estimateAgentRankingTokens("hello world")
  assert.equal(a, b)
  assert.ok(a > 0)
  assert.ok(Number.isInteger(a))
  assert.equal(estimateAgentRankingTokens(""), 0)
  // Approximates char/4 rounded up.
  assert.equal(estimateAgentRankingTokens("aaaa"), 1)
  assert.equal(estimateAgentRankingTokens("aaaaa"), 2)
})

test("projectAgentRankingCost — math sanity for known pricing row", () => {
  const longPrompt = "x".repeat(4_000) // ≈1000 tokens
  const proj = projectAgentRankingCost({
    prompts: [longPrompt, longPrompt],
    model: "gpt-5.4-nano",
    ensembleSize: 3,
  })
  const pricing = MODEL_PRICING_USD_PER_1K["gpt-5.4-nano"]
  // estimateTokens(4000 chars) = 1000 -> ceil(1000/1000) = 1
  // 2 prompts * 3 ensembleSize = 6 calls of 1 input thousand-block each
  const expectedIn = 6 * pricing.in
  const expectedOut = 6 * (OUTPUT_TOKEN_BUDGET / 1000) * pricing.out
  const expected = expectedIn + expectedOut
  assert.ok(Math.abs(proj.totalProjectedCostUsd - expected) < 1e-9)
  assert.ok(proj.perCandidateCostUsd > 0)
  assert.equal(COST_TABLE_VERSION, "pricing-2026-05-A")
})

test("computeActualVoteCostUsd — applies pricing per model", () => {
  const usd = computeActualVoteCostUsd({
    model: "gpt-5.4-nano",
    inputTokens: 1000,
    outputTokens: 400,
  })
  const pricing = MODEL_PRICING_USD_PER_1K["gpt-5.4-nano"]
  const expected = (1000 / 1000) * pricing.in + (400 / 1000) * pricing.out
  assert.ok(Math.abs(usd - expected) < 1e-9)
})
