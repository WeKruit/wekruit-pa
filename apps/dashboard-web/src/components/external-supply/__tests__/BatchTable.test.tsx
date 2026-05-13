/**
 * v2.0 External Supply V1 — Wave D — BatchTable rendering tests.
 *
 * Uses `react-dom/server.renderToStaticMarkup` to keep the dashboard
 * package's `node --test` runner happy — no jsdom needed. We assert the
 * HTML output contains the expected markers for each render state
 * (loading / empty / error / populated).
 *
 * Run via:
 *   node --import tsx --test apps/dashboard-web/src/components/external-supply/__tests__/BatchTable.test.tsx
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { ExternalCandidateRecord } from "@pa/core-types"
import { BatchTable } from "../BatchTable.js"

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
}

test("BatchTable: loading state renders the LoadingState label", () => {
  const html = render(createElement(BatchTable, { records: [], loading: true }))
  assert.match(html, /Loading records/)
})

test("BatchTable: error state renders the ErrorState message", () => {
  const html = render(
    createElement(BatchTable, { records: [], error: "boom: storage timeout" }),
  )
  assert.match(html, /boom: storage timeout/)
})

test("BatchTable: empty state renders the EmptyState body", () => {
  const html = render(createElement(BatchTable, { records: [] }))
  assert.match(html, /No records/)
  assert.match(html, /re-upload|Re-upload|re-upload/i)
})

test("BatchTable: populated state renders one tbody row per record + header", () => {
  const recs: ExternalCandidateRecord[] = [
    {
      recordId: "11111111-2222-3333-4444-555555555555",
      batchId: "batch-1",
      source: "juicebox",
      rawPayload: {},
      emails: [{ value: "alice@example.com", hash: "0123456789abcdef0123" }],
      experience: [],
      education: [],
      sourceTags: [],
      normalizationStatus: "ok",
      identityResolutionStatus: "create_new",
      evidence: [],
      name: "Alice Engineer",
      currentTitle: "Senior SWE",
      currentCompany: "Acme Corp",
      canonicalLinkedInUrl: "https://www.linkedin.com/in/alice-engineer",
      createdAt: "2026-05-13T00:00:00.000Z",
    },
    {
      recordId: "22222222-3333-4444-5555-666666666666",
      batchId: "batch-1",
      source: "juicebox",
      rawPayload: {},
      emails: [],
      experience: [],
      education: [],
      sourceTags: [],
      normalizationStatus: "ok",
      identityResolutionStatus: "needs_review",
      evidence: [],
      createdAt: "2026-05-13T00:01:00.000Z",
    },
  ]

  const html = render(createElement(BatchTable, { records: recs }))
  // Header columns appear
  assert.match(html, /Record/)
  assert.match(html, /Name/)
  assert.match(html, /Current/)
  assert.match(html, /Email/)
  assert.match(html, /LinkedIn/)
  assert.match(html, /Status/)
  // Identity-status badges are present (both rows)
  assert.match(html, /Create new/)
  assert.match(html, /Needs review/)
  // Email is masked, never the raw alice@
  assert.ok(!html.includes("alice@example.com"), "raw email must not appear in markup")
  assert.match(html, /a\*+@example\.com/)
  // LinkedIn link present
  assert.match(html, /linkedin\.com\/in\/alice-engineer/)
})
