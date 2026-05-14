/**
 * v2.0 External Supply V2 — Wave D dashboard UX — RankingApprovalRow tests.
 *
 * Static-markup tests for the per-row approve / override surface. The
 * override modal is hidden until clicked, so we assert: (a) approve +
 * override buttons render, (b) deterministic + proposed tier badges
 * render, (c) status pill text matches the input.
 *
 * Run via:
 *   node --import tsx --test apps/dashboard-web/src/components/external-supply/__tests__/RankingApprovalRow.test.tsx
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { RankingApprovalRow } from "../RankingApprovalRow.js"
import type { AgentRankingResult } from "../../../lib/external-supply-client.js"

function makeResult(overrides: Partial<AgentRankingResult> = {}): AgentRankingResult {
  return {
    resultId: "agent-rank__deadbeef",
    evaluationRunId: "run-abc",
    candidateRecordId: "record-12345678-aaaa-bbbb",
    candidateUserId: undefined,
    companyId: "company-1",
    jobId: "job-1",
    deterministicTier: "tier_3_general_email",
    proposedAgentTier: "tier_1_personal_linkedin_and_email",
    agentRationale:
      "Strong React/TypeScript signals from a top-tier startup; recent project matches the JD's infra-platform asks.",
    agentRisks: ["unverified_visa"],
    agentRecommendedAction: "outreach_now",
    ensembleVotes: [
      {
        modelUsed: "gpt-5.4-nano",
        proposedAgentTier: "tier_1_personal_linkedin_and_email",
        agentRationale: "Strong fit",
        agentRisks: [],
        agentRecommendedAction: "outreach_now",
        inputTokens: 1200,
        outputTokens: 80,
        costUsd: 0.0042,
      },
    ],
    modelUsed: "gpt-5.4-nano",
    ensembleSize: 1,
    totalInputTokens: 1200,
    totalOutputTokens: 80,
    totalCostUsd: 0.0042,
    dryRun: false,
    promptVersion: "agent-rank/v1",
    status: "proposed",
    approvedTier: undefined,
    approvedBy: undefined,
    approvedAt: undefined,
    correctionEventId: undefined,
    createdAt: "2026-05-13T20:00:00.000Z",
    ...overrides,
  }
}

function renderRow(result: AgentRankingResult, extra: Partial<React.ComponentProps<typeof RankingApprovalRow>> = {}): string {
  // Wrap in <table><tbody> so the row's <tr> is valid HTML
  return renderToStaticMarkup(
    createElement(
      "table",
      null,
      createElement(
        "tbody",
        null,
        createElement(RankingApprovalRow, {
          result,
          onApprove: () => {},
          onOverride: () => {},
          ...extra,
        }),
      ),
    ),
  )
}

test("RankingApprovalRow: renders approve and override buttons", () => {
  const html = renderRow(makeResult())
  assert.match(html, /Approve/)
  assert.match(html, /Override/)
})

test("RankingApprovalRow: renders deterministic + proposed tier badges", () => {
  const html = renderRow(makeResult())
  // Badges render their tier-label mapped output; we just need the
  // status-badge container plus the tier string.
  assert.match(html, /status-badge/)
  // Two badge instances (deterministic + proposed)
  const matches = html.match(/status-badge/g) ?? []
  assert.ok(matches.length >= 2, "expected at least 2 tier badges")
})

test("RankingApprovalRow: status pill mirrors the result.status", () => {
  const html = renderRow(makeResult({ status: "approved", approvedTier: "tier_1_personal_linkedin_and_email" }))
  assert.match(html, /approved/)
})

test("RankingApprovalRow: rationale truncates visible text to 200 chars + ellipsis", () => {
  const long = "a".repeat(250)
  const html = renderRow(makeResult({ agentRationale: long }))
  // Visible truncated content: 199 a's + ellipsis (also encoded as HTML
  // entity in attribute / text node)
  assert.match(html, /a{199}/)
  // Ellipsis character — visible truncation marker
  assert.ok(html.includes("…") || html.includes("&hellip;"))
})

test("RankingApprovalRow: action label mapped from agentRecommendedAction", () => {
  const html = renderRow(makeResult({ agentRecommendedAction: "outreach_after_research" }))
  assert.match(html, /After research/)
})

test("RankingApprovalRow: approve button disabled when status=approved", () => {
  const html = renderRow(
    makeResult({ status: "approved", approvedTier: "tier_2_personal_email" }),
  )
  // Approve appears with disabled attribute
  assert.match(html, /disabled[^>]*>Approve|Approve[^<]*<.*disabled/)
})

test("RankingApprovalRow: select checkbox renders when onToggleSelect provided", () => {
  const html = renderRow(makeResult(), { onToggleSelect: () => {}, selected: true })
  assert.match(html, /type="checkbox"/)
  assert.match(html, /checked/)
})

test("RankingApprovalRow: select checkbox absent without onToggleSelect", () => {
  const html = renderRow(makeResult())
  // First column should be empty (no checkbox in this row); but other
  // checkboxes in the modal also absent (modal hidden) — assert no
  // input[type=checkbox] in the rendered row.
  assert.ok(!html.includes('type="checkbox"'))
})
