# External Candidate Supply V2 — Sprint Summary

> Wave E close-out. ACCEPTANCE.md is the live evidence ledger; this file is the narrative.

## Status

**Code-complete on `codex/v2-external-supply-v2` (HEAD includes Wave G commit).** All 7 executor AGENT_PLANs integrated by the lead (commit `0e73a0c`); Waves A→G shipped. 24-row ACCEPTANCE ledger: **20 `pass` + 4 `known_gap`** (manual dashboard click-through rows 13 / 14 / 18, plus live prod e2e row 19 marked `known_gap` until first prod deploy lands). 0 hard-fail conditions.

V2 ships the second-pass intelligence layer on top of V1's external-supply pipeline: auto-adapter detection (Juicebox / Lessie / Coresignal / manual_csv) with confidence-thresholded fallback, a fully read-only `paExternalSupplyPreviewBatch` callable that previews identity + tag + tier forecasts before any Firestore writes, a three-callable agent-ranking layer (`runAgentRanking` + `runApproveAgentTier` + `runOverrideAgentTier`) with deterministic cost projection + hard budget cap + ensemble majority + cost ledger + correction-event audit trail, and the dashboard surfaces (drag-drop + preview pane + ranking review) wired to it. Wave F threads the agent-ranking layer into the existing v1.6 QA evaluator weekly sampler + the monthly source-quality rollup so HITL overrides feed the flywheel automatically.

## Outcome

The candidate retention marketplace now ingests external candidate batches through a drag-drop UI with **forecast before commit** — the operator sees identity-merge outcomes, tag-enrichment outcomes, AND tier-distribution forecasts before any Firestore writes happen. After commit, the existing V1 evaluation rubric still produces the canonical `deterministicTier`; V2 then layers an agent-ranking pass on top (single model in V2.0, ensemble up to 3 votes available, budget-capped). Operators approve or override per-row; overrides are logged as `pa-correction-events` with the new `targetType: "agent_ranking_result"`, feeding the v1.6 QA evaluator weekly sampler and the per-source monthly acceptance rollup. The marketplace north-star — **candidate is the durable asset, job is the event** — is preserved: agent-ranking never overrides hard-gate blocks (clamp test enforced), and the override correction-event trail makes every HITL signal a flywheel artifact.

## Files Changed

Aggregate diff from `origin/main..HEAD` (after Wave G commit): **120 files changed, ~15,808 insertions, ~3,837 deletions**.

- New planning docs: `.planning/external-supply-v2/{CONTEXT,PLAN,EXECUTOR-PLANS,ACCEPTANCE,SUMMARY,DASHBOARD-CLICK-THROUGH-PROMPT}.md` + `artifacts/*`
- Wave A contracts: `packages/core-types/src/{external-supply,marketplace,collections,index}.ts` + new tests (AgentRankingResultSchema, ensemble vote schema, action enum, deterministic id helper, correction-event targetType extension, `PA_AGENT_RANKING_RESULTS` const)
- Wave B detection: `packages/external-supply/src/adapter-detect.{ts,test.ts}` + `apps/functions/src/external-supply/adapters/registry.{ts,test.ts}` + per-adapter `*_SIGNATURE` appends + `import.ts` registry dispatch swap
- Wave C preview: `apps/functions/src/external-supply/preview-batch.{ts,test.ts}` + `legacy-user-tags-bridge.ts` `forecastTagWrites` extract + `evaluate.ts` additive readers (`loadCompanyContext`, `loadJobContext`, `coerceCandidateProfile`)
- Wave D agent-ranking: `packages/external-supply/src/agent-rank-prompt.{ts,test.ts}` + `apps/functions/src/external-supply/agent-rank.{ts,test.ts}` (three deps-injectable runners + three CF wrappers); index entry wires
- Wave E dashboard: `apps/dashboard-web/src/pages/external-supply/{BatchNew,EvaluationAgentRanking,Audit,EvaluationDetail}.tsx` + new `Dropzone` / `PreviewPane` / `RankingTable` / `RankingApprovalRow` components + `external-supply-client.ts` extensions + `App.tsx` route
- Wave F flywheel: `apps/functions/src/qa-evaluator-weekly.ts` agent-tier sampler (`sampleAgentRankingRows`, `computeAgentOverrideMetrics`) + `apps/functions/src/external-supply/source-quality.ts` `agentTierAcceptanceRate` rollup + `paExternalSupplyRollupSourceQualityMonthly` cron
- Wave G verification: `tests/external-supply-v2/{end-to-end.test.ts,package.json}` (10 e2e rows) + filled `apps/functions/scripts/external-supply-v2-prod-smoke.ts` + fixtures `tests/fixtures/external-supply-v2/{big-batch-v2,seed-pa-users,company-job,unknown-shape}` + `.planning/external-supply-v2/artifacts/*` evidence

## Commands Run (with exact pass/fail)

| Command | Outcome |
|---|---|
| `pnpm --filter @pa/core-types test` | pass — 82/82 |
| `pnpm --filter @pa/external-supply test` | pass — 150/150 |
| `pnpm --filter functions test` | pass — 1417/1417 |
| `cd tests/external-supply && pnpm test` (V1 e2e) | pass — 13/13 |
| `cd tests/external-supply-v2 && pnpm test` (V2 e2e) | pass — 10/10 |
| `cd apps/functions && pnpm run typecheck` | pass |
| `cd apps/functions && pnpm run build` | pass (15.8 MB bundle) |
| `cd apps/functions && pnpm run deploy` | **predeploy gate pass / upload blocked** — build + typecheck + smoke + tests (1417/1417) all green; Firebase Functions CLI then rejected upload because `MAILGUN_WEBHOOK_SIGNING_KEY` Firebase Secret is unset in non-interactive mode. Adam-action: `firebase functions:secrets:set MAILGUN_WEBHOOK_SIGNING_KEY` (set to empty string is OK — webhook handler treats empty as "skip signature verify"). Full log: `artifacts/deploy-functions.log`. |
| `pnpm run deploy:hosting` | pending — dashboard build green via tests; hosting deploy follows the functions deploy after Adam unblocks the secret |
| `firebase deploy --only firestore:rules` | rules wired by Wave D commit; no additional Wave G changes |
| `node --import tsx apps/functions/scripts/external-supply-v2-prod-smoke.ts` | pending — script wired + typecheck-green; first live run writes `artifacts/live-prod-smoke.json` + `artifacts/agent-rank-dryrun.json` + `artifacts/agent-rank.json` after functions deploy lands |

## Eval / Harness Artifacts Created

Under `.planning/external-supply-v2/artifacts/` (Wave G):

- `wave-e-adapter-detection.json` — confidence ranking per adapter against V2 fixture (juicebox / lessie / coresignal all ≥0.9; unknown-shape.csv routes to manual_csv)
- `wave-e-preview-hygiene.json` — recording-proxy write log (empty) + preview response on the 35-row juicebox slice
- `wave-e-preview-forecast.json` — aggregate identity + tag forecast across all three adapter slices; rowCount=105
- `wave-e-agent-rank-dryrun.json` — dry-run output with prompts + estimates + 0 LLM calls + 0 writes
- `wave-e-agent-rank-live.json` — ensemble=3 live run (LLM stub): 3 ranking docs + 9 tool-call ledger rows
- `wave-e-agent-rank-budget-abort.json` — 200-synthetic-row run, `abortedReason: "budget_exceeded"`, 0 LLM calls
- `wave-e-agent-override.json` — override flips status to `overridden`, writes `pa-correction-events` row with `targetType: "agent_ranking_result"`
- `wave-e-doc-id-audit.log` — every `pa-agent-ranking-results` id matches `agent-rank__<sha256>` regex; zero raw PII
- `wave-e-candidate-domain-grep.log` — `apps/pa-landing/src/**` has 0 agent-ranking / external-supply hits
- `wave-e-linkedin-automation-grep.log` — V2 new code roots have 0 outbound `linkedin.com` HTTP automation

Pending (live-prod artifacts — first run after deploy):

- `live-prod-smoke.json`
- `agent-rank-dryrun.json` (prod)
- `agent-rank.json` (prod; gated on `OPENAI_API_KEY`)
- `deploy-functions.log`, `deploy-hosting.log`, `deploy-rules.log`

## Product Decisions Recorded

See `PLAN.md` §12 Decision log (L1..L7) and `EXECUTOR-PLANS.md` lead resolutions L-A1..L-G7.

Key locks:

- **L-D4 (HARD)**: `runAgentRanking` accepts `{ db, runWithOpenAI, now, newId }` deps — G's e2e harness depends on this; CF wrapper sources `runWithOpenAI` from `@pa/agent-runtime`.
- **L-A1**: Both `PA_COLLECTIONS.agentRankingResults` (map) AND top-level `PA_AGENT_RANKING_RESULTS` const exported — V1 / V2 readers can pick either.
- **L-B4**: Detection threshold 0.9 lock / 0.6 suggest / <0.6 → `manual_csv` fallback (operator must supply column mapping).
- **L-C1**: Preview is read-only by **call-site avoidance** (no `dryRun` flag plumbed through `mergeUserTags`). Recording-proxy test enforces.
- **L-D1**: Pricing table hard-coded with `COST_TABLE_VERSION = "pricing-2026-05-A"` stamped on every ledger + ranking row.
- **L-D5**: `max_tokens=500` on every LLM call to bound spend even if estimator under-projects.
- **L-D7**: Approve = no correction event. Override = correction event with `targetType: "agent_ranking_result"`. Re-run on terminal row = skip.
- **L-G5**: Network calls in tests blocked via top-of-file `globalThis.fetch = () => { throw new Error(...) }`.

## Unresolved Gaps

1. **Dashboard manual click-through (rows 13, 14, 18)** — automated tests cover the client API surface compile and the underlying callables (functions tests 1417/1417 pass); the human-eye click-through against the live dashboard remains an Adam-action per `.planning/external-supply-v2/DASHBOARD-CLICK-THROUGH-PROMPT.md`.
2. **Live prod e2e (row 19)** — `external-supply-v2-prod-smoke.ts` is wired and typechecks; first live run happens immediately after deploy and writes the prod artifacts. If `OPENAI_API_KEY` isn't set in the local env when the script runs, the live agent-ranking step is skipped with `skippedReason: "openai_key_missing"` and the dry-run still records projected cost + prompt artifacts.
3. **xlsx detection (L-B1)** — descoped in V2. `.xlsx` magic / mime detected and routed to `manual_csv` fallback with `xlsx_not_yet_supported` warning. V3 candidate.
4. **JSONL exporters (L-B3)** — out of V2 scope. If a future Coresignal export switches to JSONL we'll add a JSONL adapter follow-up.
5. **Ensemble model heterogeneity** — V2 ensembles call the same model N times. V2.1 may extend `model?: string[]` for multi-model ensembles; schema already permits ensembleSize up to 5.

## Next Sprint Trigger

V2.1 candidates (not in V2 scope, surface to Adam when relevant):

- xlsx parsing (V3-grade adapter library decision).
- Heterogeneous ensemble (`model?: string[]` runtime).
- Dashboard correction-event detail page (link from ranking row's override badge — currently renders monospace short hash with tooltip "no UI page yet").
- Source-quality dashboard surface (currently flag is on `pa-qa-evaluator-runs/{runId}.agentRanking.flag` only; visualization deferred).

Adam-action items (V2 launch unblocks):

1. **Set Firebase Secret `MAILGUN_WEBHOOK_SIGNING_KEY`** (carry-over from the V1 Mailgun swap commit `ae93e8c`, surfaced by V2's first deploy attempt). Run `firebase functions:secrets:set MAILGUN_WEBHOOK_SIGNING_KEY` — setting it to empty string is acceptable per the webhook handler's "empty = skip signature verify" branch. Without this the Cloud Functions deploy aborts in non-interactive mode. Once set, re-run `cd apps/functions && pnpm run deploy`.
2. Verify `OPENAI_API_KEY` is set (or accept agent-rank live step skipped) before running `external-supply-v2-prod-smoke.ts` against prod.
3. Walk through `.planning/external-supply-v2/DASHBOARD-CLICK-THROUGH-PROMPT.md` once to close acceptance rows 13 / 14 / 18.
