# Phase 59: Dashboards - Context

**Gathered:** 2026-05-06
**Status:** Ready for planning
**Mode:** Decisions D2, D11, D16 locked

<domain>
## Phase Boundary

Three admin dashboard pages:
1. `/admin/canonical-tags` — view all 9 axes vocab + Firestore overlay; promote sandbox industry tokens to canonical
2. `/admin/qa-evaluator` — display weekly QA evaluator runs (Phase 61 produces; Phase 59 displays)
3. `/admin/onboarding-questions` extension — add link from each user → pa-users.tags view

**REQ-IDs:** DASH-01, DASH-02, DASH-03, DASH-04 (4)

**In scope:**
- New page `apps/dashboard-web/src/pages/CanonicalTags.tsx` — vocab browser + promote-button
- New CF `paPromoteSandboxTag` (admin-only callable, writes to `pa-canonical-tags/industry-sector/tokens/{token}` with `status: 'promoted'`)
- New page `apps/dashboard-web/src/pages/QaEvaluator.tsx` — list `pa-qa-evaluator-runs` with summary + drill-down
- Extend `apps/dashboard-web/src/pages/OnboardingQuestions.tsx` — per-user "View Tags" button → modal showing `pa-users.tags`
- Tests for new pages + CF
- Hosting deploy

**Out of scope:**
- QA evaluator weekly run (Phase 61 — produces the data this phase displays)
- Match-debug page (deferred to v1.7)

</domain>

<decisions>
## Implementation Decisions

### CanonicalTags page (DASH-01, DASH-02)
- 9-axis tab nav: roleFunction / industrySector / major / visa / jobType / careerStage / location / relevantTags / skills
- Each tab shows: enum values list + count of usage in pa-users.tags + count in matching-jobs (live aggregation, cached 5min)
- IndustrySector tab adds:
  - "Sandbox" subsection: tokens with `status: 'sandbox'` in `pa-canonical-tags/industry-sector/tokens/`
  - Per-token: rawText evidence list + count + "Promote" button + "Reject" button
  - "Promote" calls `paPromoteSandboxTag` CF → updates Firestore overlay → refreshes UI
- Audit log of promotions visible (limit 50, sorted by promotedAt desc)
- Vocab is loaded by importing from `@wekruit/shared-tags` Phase 52

### paPromoteSandboxTag CF (DASH-02)
- onCall, admin-only (auth.token.admin === true)
- Input: `{ vocab: 'industry-sector', token: string, action: 'promote' | 'reject' }`
- Writes to `pa-canonical-tags/industry-sector/tokens/{token}` updating `status` + `promotedAt` + `promotedBy`
- Validates token via `validateCanonicalToken` (Phase 52) — rejects abbreviations
- Returns `{ ok: true, token, status }` or `{ ok: false, reason }`

### QaEvaluator page (DASH-03)
- Lists `pa-qa-evaluator-runs` ordered by runAt desc (latest first)
- Per run shows: runId, runAt, sampleSize, hardFilterPassRate %, top3AcceptableRate %, alertSent boolean
- Click → drill into per-pair scores (sample of 100)
- Per pair: userId, jobId, scores breakdown, judge reasoning
- Only visible if user is admin

### OnboardingQuestions extension (DASH-04)
- Existing page lists onboarding question answers
- Add per-user "View Tags" button → modal showing pa-users.tags JSON pretty-formatted
- Modal also shows: "Last CV update" timestamp + "Last chat update" timestamp + sources

### Tests
- React component tests for CanonicalTags + QaEvaluator (vitest + @testing-library/react)
- CF unit tests for paPromoteSandboxTag (admin auth check, schema validation, Firestore write)
- Smoke test: load page in test renderer, verify renders without errors

</decisions>

<code_context>
## Existing Code Insights

### Existing dashboard pages to mirror pattern
- `apps/dashboard-web/src/pages/MatchWeights.tsx` — admin-only weighted dashboard (good pattern)
- `apps/dashboard-web/src/pages/Flags.tsx` — Firestore-backed CRUD UI
- `apps/dashboard-web/src/pages/OnboardingQuestions.tsx` — extend per-user details
- `apps/dashboard-web/src/lib/firebase.ts` — Firebase client init

### Reusable Phase 52 helpers
- `import { ROLE_FUNCTION_VOCAB, INDUSTRY_SECTOR_VOCAB, ... } from '@wekruit/shared-tags'`
- `import { validateCanonicalToken } from '@wekruit/shared-tags'`

### Existing CF patterns to mirror
- `apps/functions/src/admin-bootstrap.ts` — admin-only callable pattern
- `apps/functions/src/index.ts` — register pattern

### Firestore collections involved
- `pa-canonical-tags/industry-sector/tokens/{token}` — overlay (Phase 52 sandbox)
- `pa-canonical-tags-audit/{eventId}` — promote/reject audit log
- `pa-users` — count by tags axes
- `matching-jobs` — count by axes
- `pa-qa-evaluator-runs` — Phase 61 data

</code_context>

<specifics>
## Specific Ideas

- Use Tailwind for styling (existing pattern in dashboard-web)
- Hosting deploy: `pnpm run deploy:hosting`
- React Router add: `/admin/canonical-tags`, `/admin/qa-evaluator`
- Sidebar nav: add new entries
- Cache vocab counts in localStorage 5min to avoid spamming Firestore aggregations

</specifics>

<deferred>
## Deferred Ideas

- Match-debug live tester (v1.7)
- Per-job rerank cache viewer (v1.7)
- Skill bucketing inspector (v1.7)

</deferred>
