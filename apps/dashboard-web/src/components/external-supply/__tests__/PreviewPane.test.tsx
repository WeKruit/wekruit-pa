/**
 * v2.0 External Supply V2 — Wave D dashboard UX — PreviewPane rendering tests.
 *
 * Asserts the 5 sections (Detection / Identity / Tag enrichment / Tier /
 * Warnings) all render structural markers. Renders to static markup —
 * no jsdom dependency.
 *
 * Run via:
 *   node --import tsx --test apps/dashboard-web/src/components/external-supply/__tests__/PreviewPane.test.tsx
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { PreviewPane } from "../PreviewPane.js"
import type { PreviewBatchResult } from "../../../lib/external-supply-client.js"

const FULL_PREVIEW: PreviewBatchResult = {
  ok: true,
  detection: {
    top: {
      source: "juicebox",
      confidence: 0.92,
      requiredMatched: 5,
      requiredCount: 6,
      bonusMatched: 3,
      reasons: ["matched profile.url", "matched contact.primary_email"],
    },
    candidates: [
      {
        source: "juicebox",
        confidence: 0.92,
        requiredMatched: 5,
        requiredCount: 6,
        bonusMatched: 3,
        reasons: ["matched profile.url"],
      },
      {
        source: "manual_csv",
        confidence: 0.15,
        requiredMatched: 0,
        requiredCount: 0,
        bonusMatched: 0,
        reasons: ["fallback"],
      },
    ],
    shapeHint: "json",
    warnings: [],
  },
  identityForecast: {
    expectedCreateNew: 42,
    expectedMergeExisting: 11,
    expectedNeedsReview: 3,
    expectedBlocked: 0,
  },
  tagEnrichmentForecast: {
    perAxisCoverage: {
      roleFunction: 56,
      industrySector: 50,
    },
    avgSkillsPerRow: 4.7,
    missingRoleFunctionRows: 2,
  },
  tierForecast: {
    tier_1_personal_linkedin_and_email: 12,
    tier_2_personal_email: 18,
    tier_3_general_email: 10,
    retain_only: 14,
    blocked: 2,
  },
  rowCountPreview: 56,
  warnings: ["xlsx_not_yet_supported"],
}

test("PreviewPane: renders all 5 section titles", () => {
  const html = renderToStaticMarkup(createElement(PreviewPane, { preview: FULL_PREVIEW }))
  assert.match(html, /Detection/)
  assert.match(html, /Identity forecast/)
  assert.match(html, /Tag-enrichment forecast/)
  assert.match(html, /Tier forecast/)
  assert.match(html, /Warnings/)
})

test("PreviewPane: detection table shows confidence percentage", () => {
  const html = renderToStaticMarkup(createElement(PreviewPane, { preview: FULL_PREVIEW }))
  assert.match(html, /92%/)
  assert.match(html, /juicebox/)
  assert.match(html, /manual_csv/)
})

test("PreviewPane: identity forecast shows all four buckets", () => {
  const html = renderToStaticMarkup(createElement(PreviewPane, { preview: FULL_PREVIEW }))
  assert.match(html, /Create new/)
  assert.match(html, /Merge existing/)
  assert.match(html, /Needs review/)
  assert.match(html, /Blocked/)
  // Numeric values appear
  assert.match(html, />42</)
  assert.match(html, />11</)
})

test("PreviewPane: tag-enrichment section shows axis coverage rows", () => {
  const html = renderToStaticMarkup(createElement(PreviewPane, { preview: FULL_PREVIEW }))
  assert.match(html, /roleFunction/)
  assert.match(html, /industrySector/)
  assert.match(html, /avgSkillsPerRow/)
})

test("PreviewPane: tier forecast renders per-tier counts when tierForecast supplied", () => {
  const html = renderToStaticMarkup(createElement(PreviewPane, { preview: FULL_PREVIEW }))
  assert.match(html, />12</)
  assert.match(html, />18</)
})

test("PreviewPane: tier forecast falls back to empty-state when tierForecast omitted", () => {
  const noTier: PreviewBatchResult = { ...FULL_PREVIEW, tierForecast: undefined }
  const html = renderToStaticMarkup(createElement(PreviewPane, { preview: noTier }))
  assert.match(html, /No tier forecast/)
  assert.match(html, /Pin a company \+ job/)
})

test("PreviewPane: warnings list shows each warning string", () => {
  const html = renderToStaticMarkup(createElement(PreviewPane, { preview: FULL_PREVIEW }))
  assert.match(html, /xlsx_not_yet_supported/)
})

test("PreviewPane: empty tag coverage renders empty-state", () => {
  const noTags: PreviewBatchResult = {
    ...FULL_PREVIEW,
    tagEnrichmentForecast: {
      perAxisCoverage: {},
      avgSkillsPerRow: 0,
      missingRoleFunctionRows: 0,
    },
  }
  const html = renderToStaticMarkup(createElement(PreviewPane, { preview: noTags }))
  assert.match(html, /No tag coverage/)
})
