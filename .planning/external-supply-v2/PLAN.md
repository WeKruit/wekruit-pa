# External Candidate Supply V2 — PLAN

Date: 2026-05-14
Lead: single-point agent on `codex/v2-external-supply-v2`

## 0. Definition of Done (acceptance excerpt)

A 100+ row mixed-source fixture batch can be drag-dropped onto `/admin/external-supply/batches/new`, auto-detected with ≥0.9 confidence, previewed (counters match post-commit ±5%), committed, identity-resolved, evaluated, agent-ranked under the budget cap, operator-approved (or overridden into a correction event), drafted into outreach, dry-run synced to Mailgun, and traced end-to-end on the audit page — without terminal-only steps. Live prod evidence captured in `agent-rank.json`. Final SUMMARY.md lists commands run + pass/fail.

## 1. Wave structure

| Wave | Theme | Gates | Parallelism |
|---|---|---|---|
| **A** | Contracts | Lead reviews + integrates AGENT_PLANs. A merges schema + collection const before B-G start code. | A solo |
| **B** | Registry + detection + preview | A's contracts on `main` of this branch. | B + C parallel (disjoint write scopes) |
| **C** | Agent-ranking lib + callable | A's `AgentRankingResultSchema` merged. May start after Wave A merges; runs in parallel with B's preview. | D solo (but parallel with B/C) |
| **D** | Dashboard rewrite | A's contracts; B's preview-callable contract; D's callable contract. Dashboard can start against mocked types and converge. | E solo (after B + C + D contracts published) |
| **E** | Flywheel + verification + SUMMARY | B/C/D/E shipped. | F + G parallel |

Note: executor letters in the brief ARE the wave-letter prefixes; the executor topology table below uses the same letters as the brief.

## 2. Executor topology

Mirror of brief §"Required executor topology" — disjoint write scopes:

| Executor | Wave | Write scope |
|---|---|---|
| **A. Data Model + Contracts** | A | `packages/core-types/src/external-supply.ts` (additive), `packages/core-types/src/marketplace.ts` (extend `CorrectionEventSchema.targetType` enum), `packages/core-types/src/collections.ts` (add `PA_AGENT_RANKING_RESULTS`), `packages/core-types/src/external-supply.test.ts` (cover new schema + helper) |
| **B. Adapter Registry + Detection** | B | `packages/external-supply/src/adapter-detect.ts` (new), `packages/external-supply/src/adapter-detect.test.ts` (new), `apps/functions/src/external-supply/adapters/registry.ts` (new), `apps/functions/src/external-supply/adapters/registry.test.ts` (new). Existing adapters export an additional `signature` const consumed by detection (additive — no signature break). |
| **C. Preview Server** | B | `apps/functions/src/external-supply/preview-batch.ts` (new — `paExternalSupplyPreviewBatch` callable), `apps/functions/src/external-supply/preview-batch.test.ts` (new), `apps/functions/src/external-supply/index.ts` (export new callable). |
| **D. Agent Ranking** | C | `packages/external-supply/src/agent-rank-prompt.ts` (new) + `.test.ts`, `apps/functions/src/external-supply/agent-rank.ts` (new — `paExternalSupplyRunAgentRanking` callable) + `.test.ts`, exports in `apps/functions/src/external-supply/index.ts`. |
| **E. Dashboard UX** | D | `apps/dashboard-web/src/pages/external-supply/BatchNew.tsx` (rewrite for drag-drop + preview), `apps/dashboard-web/src/pages/external-supply/EvaluationAgentRanking.tsx` (new), `apps/dashboard-web/src/pages/external-supply/Audit.tsx` (extend trace), `apps/dashboard-web/src/components/external-supply/{Dropzone,PreviewPane,RankingTable,RankingApprovalRow}.tsx` (new), `apps/dashboard-web/src/lib/external-supply-client.ts` (extend with `previewBatch`, `runAgentRanking`, `approveAgentTier`, `overrideAgentTier`), `apps/dashboard-web/src/App.tsx` (new route registration). Tests under `apps/dashboard-web/src/pages/external-supply/__tests__/`. |
| **F. Flywheel Integration** | E | `packages/pa-orchestrator/src/qa-evaluator-weekly.ts` (extend with agent-tier sampler), `packages/pa-orchestrator/src/qa-evaluator-weekly.test.ts`, `apps/functions/src/external-supply/source-quality.ts` (extend rollup with `agentTierAcceptanceRate`), correction-event handling for `agent_ranking_result` target type (lookup in `evaluate.ts` / dashboard mutation path — owner E for the dashboard write, owner F for the QA-sampler read). |
| **G. Verification** | E | `tests/external-supply-v2/end-to-end.test.ts` (new), `tests/fixtures/external-supply-v2/*` (new fixture batches), `apps/functions/scripts/external-supply-v2-prod-smoke.ts` (modeled on V1's prod-smoke), `.planning/external-supply-v2/DASHBOARD-CLICK-THROUGH-PROMPT.md` (new), `.planning/external-supply-v2/ACCEPTANCE.md` ledger, `.planning/external-supply-v2/SUMMARY.md` final report. |

Integration constraints reaffirmed from brief:
- A's contracts must merge first.
- B / C / D parallel after A.
- E can start mocked, must converge to real APIs from B / C / D before acceptance.
- F + G run after E lands.
- No candidate-domain surface. No employer-visible page. No LinkedIn automation.

## 3. Detailed contracts (Executor A authoritative; reproduced here for visibility)

### 3.1 `AgentRankingResultSchema`

```ts
// packages/core-types/src/external-supply.ts (additive)

export const AgentRankingActionSchema = z.enum([
  "outreach_now",
  "outreach_after_research",
  "retain_warm",
  "do_not_contact",
])
export type AgentRankingAction = z.infer<typeof AgentRankingActionSchema>

export const AgentRankingEnsembleVoteSchema = z.object({
  modelUsed: z.string().min(1),
  proposedAgentTier: EvaluationTierSchema,
  agentRationale: z.string().min(1).max(4_000),
  agentRisks: z.array(z.string().min(1)).default([]),
  agentRecommendedAction: AgentRankingActionSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
})
export type AgentRankingEnsembleVote = z.infer<typeof AgentRankingEnsembleVoteSchema>

export const AgentRankingResultSchema = z.object({
  resultId: IdSchema,
  evaluationRunId: IdSchema,
  candidateRecordId: IdSchema,                // pa-external-candidate-records doc id
  candidateUserId: IdSchema.optional(),       // pa-users uid if resolved
  companyId: IdSchema,
  jobId: IdSchema,
  deterministicTier: EvaluationTierSchema,    // copy of D-rubric proposedTier at ranking time
  proposedAgentTier: EvaluationTierSchema,    // ensemble majority if ensembleSize > 1
  agentRationale: z.string().min(1).max(4_000),
  agentRisks: z.array(z.string().min(1)).default([]),
  agentRecommendedAction: AgentRankingActionSchema,
  ensembleVotes: z.array(AgentRankingEnsembleVoteSchema).default([]),
  modelUsed: z.string().min(1),               // primary model
  ensembleSize: z.number().int().min(1).max(5).default(1),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  dryRun: z.boolean().default(false),
  promptVersion: z.string().min(1),           // bumped when prompt changes
  status: z.enum(["proposed", "approved", "overridden", "ignored"]).default("proposed"),
  approvedTier: EvaluationTierSchema.optional(),  // populated on approve/override
  approvedBy: IdSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  correctionEventId: IdSchema.optional(),     // set when override writes a CorrectionEvent
  createdAt: TimestampSchema,
})
export type AgentRankingResult = z.infer<typeof AgentRankingResultSchema>

export function createAgentRankingResultId(input: {
  evaluationRunId: string
  candidateRecordId: string
}): string {
  const material = `agent-rank:${input.evaluationRunId}:${input.candidateRecordId}`
  return `agent-rank__${createHash("sha256").update(material).digest("hex")}`
}
```

### 3.2 Collection const + Firestore rules

```ts
// packages/core-types/src/collections.ts
export const PA_AGENT_RANKING_RESULTS = "pa-agent-ranking-results" as const
```

Firestore rules (added in same block as other external-supply collections): operator-only read; mutations through callable / Admin SDK.

### 3.3 `CorrectionEventSchema.targetType` extension

```ts
// packages/core-types/src/marketplace.ts — additive enum value
targetType: z.enum([
  // ...existing values
  "agent_ranking_result",
]),
```

Update `marketplace.test.ts` accordingly (one new parse case).

### 3.4 Adapter descriptor + signature

```ts
// packages/external-supply/src/adapter-detect.ts (new)
export interface AdapterSignature {
  source: ExternalSource
  /** Lower-cased column-header tokens (CSV/XLSX) or top-level JSON keys we expect. */
  requiredKeys: string[]
  /** Header tokens / keys that, if present, raise confidence further. */
  bonusKeys: string[]
  /** File-type hints: 'csv' | 'xlsx' | 'json' | 'tsv'. */
  acceptedShapes: Array<"csv" | "xlsx" | "json" | "tsv">
  /** Adapter version used at detection time (audit trail). */
  adapterVersion: string
}

export interface AdapterDetection {
  source: ExternalSource
  confidence: number     // 0..1
  matchedKeys: string[]
  missingKeys: string[]
  shapeHint: "csv" | "xlsx" | "json" | "tsv"
  reason: string         // operator-readable
}

export function detectAdapter(input: {
  rawBytes: Buffer
  filename: string
  mime: string
  registry: AdapterSignature[]
}): AdapterDetection[]   // sorted by confidence desc
```

Adapter files (`adapters/juicebox.ts` etc.) export a new `const JUICEBOX_SIGNATURE: AdapterSignature = { ... }` alongside the existing `JUICEBOX_ADAPTER_VERSION`. No existing export changes.

### 3.5 Preview callable

```ts
// apps/functions/src/external-supply/preview-batch.ts (new)
export const paExternalSupplyPreviewBatch = onCall(...)

// Payload
{
  filename: string,
  mime: string,
  base64Bytes: string,          // up to ~5 MB pre-base64 (validate)
  overrideSource?: ExternalSource,
  forecastEvaluationFor?: {
    companyId: string,
    jobId: string,
  },
}

// Response
{
  detection: AdapterDetection[],
  chosenSource: ExternalSource,
  rowCount: number,
  validLinkedInCount: number,
  validEmailCount: number,
  withinBatchDuplicates: number,
  identityForecast: {
    createNew: number,
    mergeExisting: number,
    needsReview: number,
    blocked: number,
    perReviewReason: Record<string, number>,
  },
  tagEnrichmentForecast: {
    perFieldFillCount: Record<string, number>,    // e.g. industryEnum / recentRoleTitle / skills
    perFieldPreservedCount: Record<string, number>,
    perCandidatePreview: Array<{
      candidateKey: string,                       // hashed handle id
      willFill: string[],
      willPreserve: string[],
    }>,
  },
  tierForecast?: {
    tier_1_personal_linkedin_and_email: number,
    tier_2_personal_email: number,
    tier_3_general_email_or_retain_only: number,
    retain_only: number,
    blocked: number,
  },
  warnings: string[],
}
```

Implementation reuses `dispatchAdapter` from `import.ts` (extracted to a pure helper if not already), `resolveRecordIdentity` from `resolve-identity.ts` in **dry-mode** (no writes), `legacy-user-tags-bridge.ts` `forecastTagWrites` helper (new — pure function over an existing `pa-users` doc), and `runEvaluation` rubric helpers from `evaluate.ts` (the deterministic rubric path only — no agent-research).

Dry-mode contract: the preview callable MUST NOT write to any Firestore collection. Test asserts via a deps-injected `firestore` fake that records every `.set/.update/.add/.delete` call; expectation = 0 writes.

### 3.6 Agent-ranking callable

```ts
// apps/functions/src/external-supply/agent-rank.ts (new)
export const paExternalSupplyRunAgentRanking = onCall(...)

// Payload
{
  evaluationRunId: string,
  model?: string,                           // default: env EXTERNAL_SUPPLY_AGENT_RANKING_MODEL || "gpt-5.4-nano"
  ensembleSize?: number,                    // default 1; max 3 in V2
  dryRun?: boolean,                         // default false; true → returns prompts + token estimates, no LLM call
  candidateRecordIds?: string[],            // optional filter; default = whole run
  budgetUsd?: number,                       // overrides env EXTERNAL_SUPPLY_AGENT_RANKING_BUDGET_USD_PER_BATCH (default 10)
}

// Response
{
  evaluationRunId: string,
  rankedCount: number,
  skippedCount: number,
  abortedReason?: "budget_exceeded" | "dry_run",
  costUsd: number,
  budgetUsd: number,
  results: AgentRankingResult[],            // full rows (Firestore writes happen alongside)
}
```

Algorithm:
1. Load `pa-candidate-company-job-evaluations` rows for `evaluationRunId`.
2. For each candidate: gather unified profile (`pa-users` if resolved + `pa-candidate-handles` + `pa-resume-artifacts`), approved `AgentResearchFinding` entries, the deterministic D-rubric output (already on the evaluation row), and the canonical tag block.
3. Build a ranking prompt (template in `packages/external-supply/src/agent-rank-prompt.ts`) and assemble per-candidate inputs.
4. **Project cost** = sum of `estimateTokens(prompt) * priceIn + estimateTokens(jsonOut) * priceOut * ensembleSize`. If > budget → abort, write nothing, return `abortedReason: "budget_exceeded"`. Operator can raise `budgetUsd` in payload.
5. If `dryRun` → return the per-candidate prompts + estimated token counts; do not call the model; do not write any `AgentRankingResult` row.
6. Else call `runWithOpenAI` (or the active model provider in `packages/agent-runtime`) per candidate × ensemble. Parse JSON. Ensemble majority on tier; if no majority, fall back to deterministic tier and flag `agentRecommendedAction: "outreach_after_research"`.
7. Write one `pa-agent-ranking-results/{resultId}` per candidate. Write one `pa-tool-calls` ledger entry per LLM call.

Cost-cap test: a synthetic 200-row run with default budget aborts before LLM call.

### 3.7 Override + correction event

Dashboard override flow:
1. Operator clicks "Override → tier_2" on a ranking row.
2. Dashboard calls a new `paExternalSupplyOverrideAgentTier` callable in `agent-rank.ts`:
   - input: `resultId`, `newTier`, `reason`
   - writes `pa-agent-ranking-results/{resultId}.{ status: "overridden", approvedTier, approvedBy, approvedAt, correctionEventId }`
   - writes one `pa-correction-events/{eventId}` with `targetType: "agent_ranking_result"`, `targetId: resultId`, `before: { proposedAgentTier }`, `after: { approvedTier }`, `reason`
3. Approve (no change) flow writes only the `approved` status fields; no correction event.

## 4. Wave A — Lock contracts (Executor A)

Deliverables:
- `packages/core-types/src/external-supply.ts` — add `AgentRankingActionSchema`, `AgentRankingEnsembleVoteSchema`, `AgentRankingResultSchema`, `createAgentRankingResultId`. Re-export from `index.ts`.
- `packages/core-types/src/marketplace.ts` — extend `CorrectionEventSchema.targetType` enum with `"agent_ranking_result"`.
- `packages/core-types/src/collections.ts` — add `export const PA_AGENT_RANKING_RESULTS = "pa-agent-ranking-results" as const`.
- `packages/core-types/src/external-supply.test.ts` — assertion suite for the new schema + `createAgentRankingResultId` determinism.
- `packages/core-types/src/marketplace.test.ts` — one new parse case for the `agent_ranking_result` target.
- `apps/functions/src/external-supply/firestore-rules.note.md` (or inline in `firestore.rules`) — operator-only read for `pa-agent-ranking-results`.

Acceptance: `pnpm --filter @pa/core-types test` green; new schema passes; deterministic id helper round-trips; `tsc --build` from repo root succeeds.

## 5. Wave B — Registry + detection (Executor B)

Deliverables:
- `packages/external-supply/src/adapter-detect.ts` + `.test.ts` — `detectAdapter` heuristic.
- `apps/functions/src/external-supply/adapters/registry.ts` + `.test.ts` — registry export `{ juicebox, lessie, coresignal, manual_csv }` with `{ adapterVersion, signature, parse }` per row.
- Each existing adapter exports `const X_SIGNATURE: AdapterSignature`. No other change.
- `apps/functions/src/external-supply/import.ts` swap the `switch` for a registry lookup (single-line dispatch change). Existing tests must remain green.

Acceptance: detection fixture (each adapter's known-good first row + headers) yields top score on the right adapter with confidence ≥0.9; a manual-CSV-style unknown shape yields top score ≤0.6.

## 6. Wave B — Preview server (Executor C)

Deliverables:
- `apps/functions/src/external-supply/preview-batch.ts` + `.test.ts` — pure handler + onCall wrapper.
- `apps/functions/src/external-supply/legacy-user-tags-bridge.ts` — extract a pure `forecastTagWrites(existingUserDoc, draft)` helper used by the preview.
- `apps/functions/src/external-supply/index.ts` — re-export the new callable.

Test fixtures: reuse `tests/fixtures/external-supply/big-batch.json` (105 rows) — preview must yield identity-forecast counts within ±5% of the V1 e2e harness post-commit numbers.

Acceptance: in-memory Firestore fake records 0 writes; counters match e2e numbers; tier-forecast totals = rowCount; warnings surface for >1000-row uploads.

## 7. Wave C — Agent ranking (Executor D)

Deliverables:
- `packages/external-supply/src/agent-rank-prompt.ts` + `.test.ts` — prompt builder + JSON parser.
- `apps/functions/src/external-supply/agent-rank.ts` + `.test.ts` — `paExternalSupplyRunAgentRanking` callable + `paExternalSupplyOverrideAgentTier` callable.
- `apps/functions/src/external-supply/index.ts` — re-export the new callables.

Tests:
- dry-run returns prompts + estimates, writes 0 ranking rows + 0 tool-call rows;
- budget cap aborts before any LLM call when projected > budget;
- ensemble majority + tie-break + cost ledger writes;
- override writes correction event with `targetType: "agent_ranking_result"`.

Acceptance: live prod smoke (Admin SDK) against a real evaluation run yields ≥1 ranking row + ≥1 tool-call ledger row + per-candidate rationale strings.

## 8. Wave D — Dashboard (Executor E)

Deliverables:
- `apps/dashboard-web/src/pages/external-supply/BatchNew.tsx` rewritten with drag-drop, adapter override dropdown, preview pane, commit button.
- `apps/dashboard-web/src/pages/external-supply/EvaluationAgentRanking.tsx` — per-candidate table with `deterministicTier` / `proposedAgentTier` / `agentRationale` / `agentRisks` / `agentRecommendedAction` / approve / override.
- `apps/dashboard-web/src/components/external-supply/Dropzone.tsx`, `PreviewPane.tsx`, `RankingTable.tsx`, `RankingApprovalRow.tsx` — pure presentational.
- `apps/dashboard-web/src/lib/external-supply-client.ts` — `previewBatch`, `runAgentRanking`, `approveAgentTier`, `overrideAgentTier` helpers.
- `apps/dashboard-web/src/pages/external-supply/Audit.tsx` — extend the per-candidate trace to render the agent-ranking step (model used, tier, rationale, approval status, correction event id).
- `apps/dashboard-web/src/App.tsx` — register `/admin/external-supply/evaluations/:runId/agent-ranking`.
- Vitest specs under `__tests__/`.

Acceptance: vitest green; vite build green; manual click-through against the dev server (and live prod after F+G land) walks drag-drop → preview → commit → resolve → evaluate → agent-rank → approve → outreach draft without terminal steps.

## 9. Wave E — Flywheel + verification (Executors F + G)

F deliverables:
- `packages/pa-orchestrator/src/qa-evaluator-weekly.ts` — sample 50 ranking rows per week, compute `operatorOverrideRate`, flag when >15%.
- `apps/functions/src/external-supply/source-quality.ts` — extend monthly rollup with `agentTierAcceptanceRate` per source.
- Tests cover sampler determinism + rollup math.

G deliverables:
- `tests/external-supply-v2/end-to-end.test.ts` — e2e harness driving the new fixture batch through preview → commit → resolve → evaluate → agent-rank → approve → audit trace.
- `tests/fixtures/external-supply-v2/big-batch-v2.json` — 100+ rows with at least one mismatch case per adapter.
- `apps/functions/scripts/external-supply-v2-prod-smoke.ts` — modeled on V1's prod-smoke. Outputs `agent-rank.json` with per-candidate prompt + response + tier.
- `.planning/external-supply-v2/DASHBOARD-CLICK-THROUGH-PROMPT.md` — operator runbook for the V2 surfaces.
- `.planning/external-supply-v2/ACCEPTANCE.md` ledger filled with pass/fail rows.
- `.planning/external-supply-v2/SUMMARY.md` final report with commands run + remaining risks.

## 10. Deploy plan

Same as V1 (CLAUDE.md "Deploy commands"):
1. `cd apps/functions && pnpm run deploy` (predeploy gate runs build + typecheck + tests + smoke; aborts on failure)
2. `PA_DASHBOARD_VITE_ENV_FILE=apps/dashboard-web/.env.production.local pnpm run deploy:hosting`
3. `firebase deploy --only firestore:rules --project wekruit-5f89b --non-interactive` (only if `firestore.rules` changes for the new collection)

After deploy: lead runs `external-supply-v2-prod-smoke.ts` and saves the `agent-rank.json` artifact under `.planning/external-supply-v2/artifacts/`.

## 11. Open Adam-ask items (deferred until verification reveals them)

None proactively — every product question is locked by the brief + V1 spec. Lead surfaces only when a real ambiguity appears (e.g., the prod evaluation set has zero ranking-eligible rows). Per CLAUDE.md "no delegate back to Adam".

## 12. Decision log (running)

| # | Decision | Date | Owner |
|---|---|---|---|
| L1 | V2 branch is rebased on top of Mailgun swap (cherry-picked from `codex/v2-external-supply-mailgun-swap`) so V2's audit trace + `getConfig` integration sees Mailgun as default. | 2026-05-14 | Lead |
| L2 | Detection heuristic threshold = 0.6 (above → operator can commit; below → default to `manual_csv` and require column mapping). | 2026-05-14 | Lead |
| L3 | Ensemble cap = 3 in V2. Higher requires Adam budget approval. | 2026-05-14 | Lead |
| L4 | Override correction-event `targetType: "agent_ranking_result"` is the single additive enum value. No `agent_research_finding` or `agent_prompt_version` target types in V2 (deferred). | 2026-05-14 | Lead |
| L5 | Preview server is read-only; zero Firestore writes. Asserted by a dedicated test. | 2026-05-14 | Lead |
| L6 | Cost ledger writes through `pa-tool-calls` existing v1.6 infra; one row per LLM call, even on ensemble. | 2026-05-14 | Lead |
| L7 | Dry-run is the ONLY way an operator can preview cost before commit; budget cap is hard. | 2026-05-14 | Lead |
