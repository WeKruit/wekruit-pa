/**
 * v2.0 External Supply V2 — Wave D dashboard UX — EvaluationAgentRanking
 * page tests.
 *
 * The page transitively imports `lib/firebase.ts` (Vite-only DSL) so we
 * cannot import the page module directly under Node's `--test` loader.
 * Instead we exercise the `RankingTable` subcomponent (which is the page's
 * primary user-visible surface) in both empty and populated states.
 *
 * Run via:
 *   node --import tsx --test apps/dashboard-web/src/pages/external-supply/__tests__/EvaluationAgentRanking.test.tsx
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { RankingTable } from "../../../components/external-supply/RankingTable.js"
import type { AgentRankingResult } from "../../../lib/external-supply-client.js"

function row(overrides: Partial<AgentRankingResult> = {}): AgentRankingResult {
  return {
    resultId: "agent-rank__1111",
    evaluationRunId: "run-abc",
    candidateRecordId: "record-12345678",
    candidateUserId: undefined,
    companyId: "company-1",
    jobId: "job-1",
    deterministicTier: "tier_3_general_email",
    proposedAgentTier: "tier_1_personal_linkedin_and_email",
    agentRationale: "Strong fit on infra-platform skills.",
    agentRisks: [],
    agentRecommendedAction: "outreach_now",
    ensembleVotes: [],
    modelUsed: "gpt-5.4-nano",
    ensembleSize: 1,
    totalInputTokens: 1200,
    totalOutputTokens: 80,
    totalCostUsd: 0.004,
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

const noopProps = {
  selected: new Set<string>(),
  onToggleSelect: () => {},
  onToggleSelectAll: () => {},
  onApprove: () => {},
  onOverride: () => {},
}

test("EvaluationAgentRanking (table): empty state renders Run agent ranking hint", () => {
  const html = renderToStaticMarkup(
    createElement(RankingTable, { results: [], ...noopProps }),
  )
  assert.match(html, /No agent ranking yet/)
  assert.match(html, /Run agent ranking from the actions above/)
})

test("EvaluationAgentRanking (table): loading state renders LoadingState label", () => {
  const html = renderToStaticMarkup(
    createElement(RankingTable, { results: [], loading: true, ...noopProps }),
  )
  assert.match(html, /Loading agent ranking/)
})

test("EvaluationAgentRanking (table): populated state shows column headers + one row per result", () => {
  const results = [
    row(),
    row({ resultId: "agent-rank__2222", candidateRecordId: "record-22220000", status: "approved", approvedTier: "tier_2_personal_email" }),
  ]
  const html = renderToStaticMarkup(
    createElement(RankingTable, { results, ...noopProps }),
  )
  assert.match(html, /Candidate/)
  assert.match(html, /Deterministic tier/)
  assert.match(html, /Proposed agent tier/)
  assert.match(html, /Rationale/)
  assert.match(html, /Risks/)
  assert.match(html, /Action/)
  assert.match(html, /Ensemble/)
  assert.match(html, /Approve/)
  assert.match(html, /Override/)
  // Both record ids appear (truncated)
  assert.match(html, /record-1/)
  assert.match(html, /record-2/)
  // Status pills for proposed + approved both rendered
  assert.match(html, /proposed/)
  assert.match(html, /approved/)
})

test("EvaluationAgentRanking (table): selected rows mark the row checkbox", () => {
  const r = row()
  const html = renderToStaticMarkup(
    createElement(RankingTable, {
      results: [r],
      ...noopProps,
      selected: new Set([r.resultId]),
    }),
  )
  assert.match(html, /checked/)
})
