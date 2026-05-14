# External Candidate Supply V2 — CONTEXT

Date: 2026-05-14
Branch: `codex/v2-external-supply-v2`
Worktree: `.claude/worktrees/v2-external-supply-v2`
Base: `origin/main` (5638b93 = PR #34 V1 audit fixes) + cherry-picked Mailgun swap (ae93e8c) + V2 prompt doc (5d011bb).

## Why V2

V1 (PR #29 / #31 / #34 / #35) shipped a runnable internal pipeline (15 callables, 1 webhook, 10 admin routes, 10 collections, Mailgun delivery) but the operator UX is a file-picker form with no preview, the adapter dispatch is a hard-coded switch, and tier proposal is purely deterministic. V2 adds three step-changes:

1. **Drag-drop + preview** — operator drags CSV/XLSX/JSON onto a single page, the system auto-detects the adapter, runs a server-side dry-run, and shows row counters + identity-resolution forecast + tag-enrichment forecast + estimated tier breakdown **before** anything writes.
2. **Adapter registry** — `juicebox / lessie / coresignal / manual_csv` become entries in a registry; new sources land by adding a file + a registry row. Detection scores each adapter and offers an override.
3. **Agent ranking layer** — after the deterministic D-rubric runs, an LLM agent receives a per-candidate ranking pack (unified profile + canonical tags + rubric output + approved agent-research findings) and returns natural-language tier proposal + rationale + risks + recommended next action. Operator approves or overrides; overrides write correction events that feed the flywheel.

V2 is additive on top of V1 primitives — no V1 callable changes signature, no V1 collection rename, no V1 contract break. The deterministic rubric continues to produce a `proposedTier`; the agent-ranking row sits **alongside** it on the same evaluation row.

## V1 primitives V2 reuses (DO NOT rebuild)

| V1 surface | V2 use |
|---|---|
| `packages/core-types/src/external-supply.ts` schemas (`ExternalSourcingBatch`, `ExternalCandidateRecord`, `CandidateSourceLink`, `CandidateIdentityResolution`, `CandidateEvaluationRun`, `CandidateCompanyJobEvaluation`, `AgentResearchTask`, `OutreachPlan`, `MailgunSyncRecord`, `OutreachEvent`, `SourceQualityMetric`) | Read-only references. V2 adds **one** new schema (`AgentRankingResultSchema`) + **one** collection const + **one** additive `CorrectionEventSchema.targetType` enum value. |
| `packages/external-supply/src/normalize.ts` (`canonicalizeLinkedInUrl`, `emailHash`, `linkedinHash`, `phoneHash`, dedupe) | Unchanged. Detection + preview reuse these. |
| `apps/functions/src/external-supply/adapters/{juicebox,lessie,coresignal,manual-csv}.ts` (each exports `parseX` + `X_ADAPTER_VERSION`) | Wrapped by the new registry. Detection scoring reads each adapter's column-header signature. |
| `apps/functions/src/external-supply/import.ts` `paExternalSupplyCreateBatchUploadUrl` + `paExternalSupplyCreateBatch` | Unchanged signature. The preview callable is a **separate** read-only callable that reuses the same adapter dispatch. |
| `apps/functions/src/external-supply/resolve-identity.ts` `runResolveBatchIdentity` | Dry-run mode (new): same logic but writes to an in-memory accumulator instead of Firestore. Preview reuses this. |
| `apps/functions/src/external-supply/legacy-user-tags-bridge.ts` (`mergeUserTags` wrapper) + `mergeWeakGlobalTags` | Preview tag-enrichment forecast computes what these would write, doesn't write. |
| `apps/functions/src/external-supply/evaluate.ts` (`runEvaluation` + D-rubric `evaluateGeneral/Company/Job`) | Unchanged. Agent ranking reads its `CandidateCompanyJobEvaluation` rows. |
| `packages/external-supply/src/agent-prompt.ts` + `agent-parse.ts` (ChatGPT Agent Mode prompts) | Template + parser patterns reused for the agent-ranking prompt. |
| `packages/agent-runtime` `runWithOpenAI` | Agent ranking calls the model through this surface. |
| `apps/functions/src/external-supply/mailgun-sync.ts` + `mailgun-webhook.ts` | Unchanged. V2 does not touch outreach delivery. |
| `packages/core-types/src/marketplace.ts` `CorrectionEventSchema` | Additive enum extension `agent_ranking_result`. |
| `apps/dashboard-web/src/pages/external-supply/{Landing,BatchNew,BatchDetail,Review,Evaluations,EvaluationDetail,Research,Outreach,Sync,Audit}.tsx` | BatchNew is **rewritten** for drag-drop + preview. EvaluationDetail gets a new sibling `EvaluationAgentRanking.tsx`. Audit is **extended** to render the agent-ranking step. Other pages unchanged. |
| `pa-orchestrator/qa-evaluator-weekly` | Extended with an agent-tier-acceptance-rate sample. |

## V1 invariants V2 inherits unchanged

1. Candidate = global durable asset; external candidates share `pa-users`.
2. LinkedIn URL is the primary external identity handle. Email is secondary. Email-only rows route to review.
3. Raw LinkedIn / email / phone never become Firestore doc ids; everything goes through `createCandidateHandleId` / `createOutreachEventId` sha256.
4. `mergeUserTags` writes `pa-users.tags` (v1.6 matching surface); `mergeWeakGlobalTags` writes `pa-users.globalTags` (v2.0 marketplace surface). Weak-merge only.
5. Suppression gates (opt-out / bounce / cooldown / duplicate) run before every Mailgun sync.
6. Match score / tier never blocks the first interview.
7. Dashboard internal-only at `wekruit-pa.web.app/admin/**`. No candidate-domain surface added.
8. LinkedIn outreach manual; agent-ranking does NOT change this.
9. Every tag/fact written to `pa-users` carries source / confidence / evidence / version.
10. State transitions deterministic; LLM may extract / judge / compose only. Agent-ranking returns **proposals**; the operator approves/overrides; reducers persist.
11. `pa-tool-calls` cost ledger remains the authoritative LLM-cost record. Agent-ranking writes per-call entries with `{ kind: "external_supply_agent_rank", evaluationRunId, candidateId, modelUsed, inputTokens, outputTokens, costUsd }`.

## Risks & open questions

| # | Risk | Mitigation |
|---|---|---|
| R1 | XLSX parse needs a new dependency (V1 only handles CSV/JSON). | Use `xlsx` (already used elsewhere? grep first). If new, scoped to the preview server only; adapters keep CSV/JSON in-tree. |
| R2 | Auto-detect on a fresh-source CSV could pick the wrong adapter. | Heuristic returns a confidence per adapter; operator override is one click; if top score <0.6, default to `manual_csv` and prompt operator to map columns. |
| R3 | Agent-ranking cost runaway on a 500-row batch with ensemble. | Hard per-batch budget cap (`EXTERNAL_SUPPLY_AGENT_RANKING_BUDGET_USD_PER_BATCH=10`). The callable aborts the run when projected cost > cap. Dry-run returns prompt + token estimates only. |
| R4 | Preview must NOT pollute prod data (Adam will dry-run against live Firestore). | All preview paths are read-only — they read `pa-candidate-handles` + `pa-users` + `pa-companies` + `pa-jobs` and accumulate in-memory. Single integration test asserts zero write-side effects against the in-memory fake. |
| R5 | Agent override correction-event volume might explode `pa-correction-events`. | Schema unchanged; same write pattern as V1's tier-override correction. Weekly QA evaluator aggregates by source-month, not per-event. |
| R6 | Mailgun swap (ae93e8c) is on this branch but not on main. V2 ships against this state and assumes the swap merges (or this branch absorbs it). | V2 depends on `MailgunSyncRecord` only via the dashboard audit page (one trace cell). No tighter coupling. |

## What V2 does NOT do

- LinkedIn automation. **Locked manual.**
- Employer-visible external-supply pages.
- Scheduled / cron batch imports.
- Mailgun inbound parsing for reply detection (V3).
- Cross-repo Python adapter port.
- Embedding-based candidate similarity rerank inside agent-ranking (the agent reads the unified candidate + canonical tags; embedding similarity is the v1.6/v1.7 matching path and stays orthogonal).

## Reference list

- `.planning/external-supply-v1/PLAN.md` (V1 contract baseline)
- `.planning/external-supply-v1/SUMMARY.md` (V1 ship state, including Mailgun V1.1 follow-up)
- `.planning/external-supply-v1/DASHBOARD-CLICK-THROUGH-PROMPT.md` (V1 dashboard verification spec — V2 extends)
- `.planning/V2-EXTERNAL-SUPPLY-V2-GOAL-PROMPT.md` (this milestone's brief)
- `.planning/AUTONOMOUS-SPRINT-HARNESS.md` (lead-process contract)
- `CLAUDE.md` (deploy authority, v1.6 + v2.0 locks)
- `README.md` (Candidate Retention Marketplace blueprint)
