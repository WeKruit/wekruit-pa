# `/goal` prompt — CoreSignal Intake → Match → Outbound (Dashboard E2E)

> Copy-paste this entire block into a fresh `/goal` session (or `/loop` dynamic)
> to hand the next milestone to a single-point lead agent. Self-contained.

---

You are the single-point lead agent for **WeKruit CoreSignal Intake + Outbound Pipeline**.

## North-star vision

Operator pastes a CoreSignal candidate ID list (from CoreSignal Playground filter or saved search) into the WeKruit admin dashboard. System fetches CoreSignal `employee_multi_source/collect/{id}` JSON, normalizes through the same `pa-resume-parser` + `mergeUserTags` pipeline used for resumes, resolves identity by canonical LinkedIn URL hash, creates or merges a `pa-users` global profile. Operator picks a job → batch-matches every candidate through existing `queryMatchingJobs` V16. Operator clicks "Generate Pitch" per match → LLM produces evidence-only personalized email → operator approves → Instantly sends with full suppression + cooldown gates. When candidate later magic-link signs in at `candidate.wekruit.com`, email match claims the pre-created profile.

Everything lives in `/admin/external-supply/**` routes already shipped by V1+V2. Zero CLI, zero CSV plumbing for operator.

## Already shipped (DO NOT re-litigate)

- **External-supply V1 + V2** (PRs #29/31/34/35): full `pa-external-sourcing-batches`, `pa-external-candidate-records`, `pa-candidate-source-links`, `pa-candidate-evaluation-runs`, `pa-candidate-company-job-evaluations`, `pa-outreach-plans`, `pa-outreach-events`, `pa-instantly-sync-records`, `pa-suppression-list` collections. 15+ admin callables. 10 dashboard routes under `wekruit-pa.web.app/admin/external-supply/**`. Adapters for Juicebox / Lessie / `coresignal-2026-05-A` (OLD nested-shape coresignal export). Identity resolution via `pa-candidate-handles`. Tier rubric + agent ranking. Mailgun default outbound. Instantly path preserved.
- **CoreSignal secrets infra**: `CORESIGNAL_API_KEY` Firebase secret + `paAdminCoresignalAgenticSearch` CF using `cdapi/v2/agentic_search/reasoning` endpoint. Auth pattern established.
- **Mature scripts prototype**: `scripts/coresignal-fetch.mjs` + `scripts/coresignal-fetch-employees.mjs` proven against live `cdapi/v2/employee_multi_source/collect/{id}` + `cdapi/v2/company_multi_source/collect/{id}` — 1000 employees + 343 companies fetched. Reference for v2 collect endpoint shape.

## What THIS milestone adds (V2.1)

### P1 — CoreSignal v2 collect adapter + batch fetch CF (2 days)

1. **`packages/external-supply/src/coresignal-collect-client.ts`** (NEW): typed thin client for `employee_multi_source/collect/{id}` + `company_multi_source/collect/{id}`. 3 retries on 429/5xx, zod-validated response.
2. **`apps/functions/src/external-supply/adapters/coresignal-collect-v2.ts`** (NEW): adapter version `coresignal-collect-2026-05-A`. Normalizes new flat shape into `NormalizedRecordDraft`. Register in adapter registry under new `coresignal_collect_v2` enum.
3. **`apps/functions/src/external-supply/coresignal-batch-fetch.ts`** (NEW): `paCoresignalFetchBatch({ candidateIds, companyId?, jobId? })` admin callable. Fans out via async queue (4 concurrent), writes `pa-external-candidate-records`, triggers existing identity-resolve worker.
4. **Dashboard: `/admin/external-supply/batch/new`** (extend): textarea tab for ID list paste, calls `paCoresignalFetchBatch`.

### P2 — LinkedIn experience → resume-parser tagging path (1 day)

5. **`packages/pa-resume-parser/src/coresignal-input-adapter.ts`** (NEW): converts structured `experience[] + education[] + inferred_skills` into parser input. Output tags carry `source: 'coresignal_linkedin'`.
6. **Wire into identity-resolve worker**: when `pa-external-candidate-records.source = "coresignal_collect_v2"` → run tagging → mergeUserTags → mergeWeakGlobalTags.

### P3 — Pitch email gen CF + prompt + evals (2 days)

7. **`apps/functions/src/external-supply/generate-pitch-email.ts`** (NEW): `paGeneratePitchEmail({candidateId, jobId, matchId})`. Evidence-only prompt (see PRD §7). LLM chain gpt-5.4-nano → Sonnet-4-6 → gpt-4.1-mini. Writes `pa-outreach-plans/{planId}` status=draft. Insufficient evidence → status=review_required.
8. **Evals** in `tests/qa/coresignal-pitch/`: hallucination check, sensitive-attribute injection, empty-evidence handling.

### P4 — Approve-and-send CF + suppression gates + outreach detail page (1.5 days)

9. **`apps/functions/src/external-supply/approve-and-send.ts`** (NEW): `paApproveAndSendOutreach({planId})`. 6 preflight gates (see PRD §8). On pass call `instantlySync()`, write `pa-instantly-sync-records`, update plan status `sent`. On fail status=`blocked` with reason, no API call.
10. **Dashboard: `/admin/external-supply/outreach/:planId`** (NEW page): subject/body editor, evidence list, suppression banner, Approve & Send button, event timeline.

### P5 — E2E scenario test + ship gate (1 day)

11. **`tests/scenarios/coresignal-e2e.yaml`** (NEW): 5 real CoreSignal IDs → ingest → tag → match → pitch → approve → simulate webhook → assert event rows.
12. **Ship gate**: orchestrator tests + external-supply tests + functions tests + scenario green → deploy functions + hosting → prod verify.

## Non-negotiable rules (inherited)

All 13 V1/V2 rules apply: LinkedIn URL = primary external identity handle; raw PII never Firestore doc id; tag writes via `mergeUserTags` + `mergeWeakGlobalTags`; opt-out/bounce/cooldown gates before every send; match score never blocks first interview; dashboard internal-only at `wekruit-pa.web.app/admin/**`; source/confidence/evidence/version on every tag; LinkedIn DM = manual only (pitch EMAIL via Instantly OK); deterministic reducers for state, LLM extracts/judges/composes only.

## Deliverables checklist

- [ ] P1.1 `coresignal-collect-client.ts` + tests
- [ ] P1.2 `coresignal-collect-v2.ts` adapter + registry entry + tests
- [ ] P1.3 `paCoresignalFetchBatch` CF + tests
- [ ] P1.4 Dashboard `BatchNew` tab + textarea
- [ ] P2.1 `coresignal-input-adapter.ts` in pa-resume-parser + tests
- [ ] P2.2 Identity-resolve worker switch case
- [ ] P3.1 `generate-pitch-email.ts` CF + prompt + tests
- [ ] P3.2 3 pitch evals
- [ ] P4.1 `approve-and-send.ts` CF + 6 preflight gates + tests
- [ ] P4.2 Dashboard `OutreachDetail` page
- [ ] P5.1 `coresignal-e2e.yaml` scenario
- [ ] P5.2 Full test suite green + deploy + prod verify

## Definition of done

E2E live: paste 1 real CoreSignal ID at `https://wekruit-pa.web.app/admin/external-supply/batch/new` → within 30s see `pa-users` profile created/merged with `coresignal_linkedin` source tags → click "Run match" against a real `matching-jobs/{id}` → see score + evidence → click "Generate pitch" → see draft email referencing real candidate experience + job requirement (no hallucination) → click "Approve & Send" → Instantly lead created → simulated webhook bumps status to `opened` → operator sees event timeline.

## Reference

- PRD: `.planning/PRD-CORESIGNAL-INTAKE-OUTBOUND.md`
- V1 initiative: `.planning/INITIATIVE-external-candidate-supply-intake.md`
- V2 goal (Juicebox/Lessie): `.planning/V2-EXTERNAL-SUPPLY-V2-GOAL-PROMPT.md`
- Existing CoreSignal old adapter: `apps/functions/src/external-supply/adapters/coresignal.ts`
- Working API client prototype: `scripts/coresignal-fetch-employees.mjs`
- Auth pattern: `apps/functions/src/admin-coresignal-agentic-search.ts`
