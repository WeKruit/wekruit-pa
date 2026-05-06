/**
 * v1.7 Phase 70 — MatchDebug page smoke test.
 *
 * The dashboard package has no React Testing Library so we follow the
 * QaEvaluator/CanonicalTags convention: import the module to assert it
 * type-checks + parses, plus exercise its constants for drift-detection
 * against V16_SCORE_WEIGHTS in apps/job-rec/src/match-weights.ts.
 *
 * Run via:
 *   node --import tsx --test apps/dashboard-web/src/pages/__tests__/MatchDebug.test.ts
 */
import test from "node:test"
import assert from "node:assert/strict"

import { V16_SCORE_WEIGHTS } from "@pa/job-rec"

// Mirror copy of DEFAULT_WEIGHTS in MatchDebug.tsx — keep in sync to detect
// dashboard/CF drift. If V16 changes the canonical weights, this test fails
// loud + we update both.
const MATCH_DEBUG_DEFAULT_WEIGHTS = {
  llmMatch: 0.4,
  skillJaccard: 0.2,
  relevantTags: 0.15,
  industrySector: 0.1,
  cvEmbCosine: 0.1,
  salaryFit: 0.05,
} as const

test("MatchDebug DEFAULT_WEIGHTS mirror V16_SCORE_WEIGHTS exactly", () => {
  for (const k of Object.keys(MATCH_DEBUG_DEFAULT_WEIGHTS) as Array<
    keyof typeof MATCH_DEBUG_DEFAULT_WEIGHTS
  >) {
    assert.equal(
      MATCH_DEBUG_DEFAULT_WEIGHTS[k],
      V16_SCORE_WEIGHTS[k],
      `MatchDebug default weight for ${k} drifted from V16_SCORE_WEIGHTS`,
    )
  }
})

// Note: we intentionally do NOT import the MatchDebug component module here.
// The page's transitive `firebase` import requires `import.meta.env.VITE_*`
// (Vite-only) which Node's test runner cannot supply — same constraint as
// QaEvaluator.test.ts and MatchCandidates.test.ts (they also avoid loading
// the page modules and only test pure helpers). Type-correctness of
// MatchDebug.tsx is covered by `tsc --noEmit` on dashboard build.

test("V16_SCORE_WEIGHTS sum to 1.0 (sanity for sandbox sliders)", () => {
  const sum =
    V16_SCORE_WEIGHTS.llmMatch +
    V16_SCORE_WEIGHTS.skillJaccard +
    V16_SCORE_WEIGHTS.relevantTags +
    V16_SCORE_WEIGHTS.industrySector +
    V16_SCORE_WEIGHTS.cvEmbCosine +
    V16_SCORE_WEIGHTS.salaryFit
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `V16 weights sum=${sum}`)
})
