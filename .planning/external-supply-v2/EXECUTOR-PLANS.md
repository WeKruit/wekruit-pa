# External Candidate Supply V2 — Executor AGENT_PLAN ledger

All 7 AGENT_PLAN responses are summarized below with **Lead resolutions** that override the brief / PLAN.md when an ambiguity surfaced. Code waves consume these resolutions verbatim.

The full agent transcripts live in the spawning agent IDs (see git history for the dispatch commit `68f372b` reasoning chain). Authoritative deltas relative to PLAN.md are captured per-executor.

---

## A. Data Model + Contracts — INTEGRATED

### Scope (confirmed)
- Additive only on `packages/core-types/src/external-supply.ts`, `marketplace.ts`, `collections.ts`.
- New schemas: `AgentRankingActionSchema`, `AgentRankingEnsembleVoteSchema`, `AgentRankingResultSchema` + helper `createAgentRankingResultId(input: { evaluationRunId, candidateRecordId })`.
- Extend `CorrectionEventSchema.targetType` enum with `"agent_ranking_result"` (single new value).
- Add `agentRankingResults: "pa-agent-ranking-results"` to `PA_COLLECTIONS` AND export a bare `PA_AGENT_RANKING_RESULTS` const (both surfaces — V1 callables use the map, V2 helpers expect the bare const).
- Firestore-rules note doc `apps/functions/src/external-supply/firestore-rules.note.md`. The actual `firestore.rules` line is appended by the first executor that needs the collection (likely D when agent-rank writer lands).
- `external-supply.test.ts` 5 new cases (round-trip, override row, ensembleSize bounds, vote schema required fields, helper determinism). `marketplace.test.ts` 1 new parse case for `agent_ranking_result`.

### Schema literal (final — copy verbatim)

```ts
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
  candidateRecordId: IdSchema,
  candidateUserId: IdSchema.optional(),
  companyId: IdSchema,
  jobId: IdSchema,
  deterministicTier: EvaluationTierSchema,
  proposedAgentTier: EvaluationTierSchema,
  agentRationale: z.string().min(1).max(4_000),
  agentRisks: z.array(z.string().min(1)).default([]),
  agentRecommendedAction: AgentRankingActionSchema,
  ensembleVotes: z.array(AgentRankingEnsembleVoteSchema).default([]),
  modelUsed: z.string().min(1),
  ensembleSize: z.number().int().min(1).max(5).default(1),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  dryRun: z.boolean().default(false),
  promptVersion: z.string().min(1),
  status: z.enum(["proposed", "approved", "overridden", "ignored"]).default("proposed"),
  approvedTier: EvaluationTierSchema.optional(),
  approvedBy: IdSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  correctionEventId: IdSchema.optional(),
  createdAt: TimestampSchema,
})
export type AgentRankingResult = z.infer<typeof AgentRankingResultSchema>

export function createAgentRankingResultId(input: {
  evaluationRunId: string
  candidateRecordId: string
}): string {
  if (!input.evaluationRunId || !input.candidateRecordId) {
    throw new Error("createAgentRankingResultId: evaluationRunId and candidateRecordId required")
  }
  const material = `agent-rank:${input.evaluationRunId}:${input.candidateRecordId}`
  return `agent-rank__${createHash("sha256").update(material).digest("hex")}`
}
```

### Lead resolutions

- **L-A1** Use BOTH a `PA_COLLECTIONS.agentRankingResults` map entry AND a top-level `export const PA_AGENT_RANKING_RESULTS = "pa-agent-ranking-results"`. V1 readers can adopt either.
- **L-A2** Schema is additive-only; ensembleSize max 5 (V2 code caps at 3 via callable validation per L3 in PLAN §12, but schema stays liberal so V2.1 can lift the runtime cap without a schema rewrite).
- **L-A3** Firestore-rules note doc is sufficient for A's commit; the actual `firestore.rules` block is appended by D when the writer lands (avoids deploying a rule for an unused collection).
- **L-A4 (additive coordination with F)** F asks for `agentTierAcceptanceRate` + sibling counters on `SourceQualityMetricSchema`. **A also lands those additive optional fields** in the same commit so F doesn't fork core-types:
  ```ts
  // SourceQualityMetricSchema — append, all optional
  agentTierAcceptanceRate: ConfidenceSchema.optional(),
  agentOperatorOverrideRate: ConfidenceSchema.optional(),
  agentRankedTotal: z.number().int().nonnegative().optional(),
  agentApprovedUnchangedTotal: z.number().int().nonnegative().optional(),
  agentOverriddenTotal: z.number().int().nonnegative().optional(),
  costTableVersion: z.string().min(1).optional(),    // mirror D's per-ledger stamp on rollup rows
  ```
- **L-A5** Greenlit to start: **YES, immediately.** Wave A is single-executor; B-G gate on A's merge.

---

## B. Adapter Registry + Detection — INTEGRATED

### Scope (confirmed)
- New `packages/external-supply/src/adapter-detect.ts` + `.test.ts` (pure heuristic).
- New `apps/functions/src/external-supply/adapters/registry.ts` + `.test.ts` exporting `AdapterDescriptor` + `ADAPTER_REGISTRY` + `getAdapter()` + `getRegistrySignatures()`.
- Each adapter file appends `const X_SIGNATURE: AdapterSignature` — purely additive.
- `import.ts` `dispatchAdapter` body swap to registry lookup. V1 import-test parity preserved (same error string for `manual_csv` missing mapping; same `rawHeaderSample` computation for CSV-shape adapters).
- Detection heuristic = required-key match + bonus-key boost + shape penalty + extension hint, clamp 0..1.

### Per-adapter signature literals (final)

```ts
JUICEBOX_SIGNATURE: { source: "juicebox", requiredKeys: ["linkedin_url","email_primary","full_name"], bonusKeys: ["current_position","current_company_name","location_string","experience_array","education_array","skills","enrichment"], acceptedShapes: ["json"], adapterVersion: JUICEBOX_ADAPTER_VERSION }
LESSIE_SIGNATURE:    { source: "lessie", requiredKeys: ["linkedin url","email","name"], bonusKeys: ["title","company","location","phone","skills"], acceptedShapes: ["csv","tsv"], adapterVersion: LESSIE_ADAPTER_VERSION }
CORESIGNAL_SIGNATURE:{ source: "coresignal", requiredKeys: ["profile.url","contact.primary_email","profile.full_name"], bonusKeys: ["profile.headline","profile.location.name","contact.phone","experience","education","skills"], acceptedShapes: ["json"], adapterVersion: CORESIGNAL_ADAPTER_VERSION }
MANUAL_CSV_SIGNATURE:{ source: "manual_csv", requiredKeys: [], bonusKeys: [], acceptedShapes: ["csv","tsv"], adapterVersion: MANUAL_CSV_ADAPTER_VERSION }
```

### Lead resolutions

- **L-B1** xlsx detection is **descoped in V2**. Detection returns `shapeHint: "xlsx"` → forced fallback to `manual_csv` + warning `"xlsx_not_yet_supported"`. C (preview) and E (dashboard) respect this fallback. V3 candidate.
- **L-B2** Coresignal token extraction = one-level dotted paths only (top-level keys + object-valued first-level child keys). Sufficient to discriminate Coresignal from Juicebox. Widen to deeper only if real-world Coresignal exports break detection.
- **L-B3** JSONL = out of scope. If an exporter switches to JSONL, an adapter follow-up adds JSONL parsing.
- **L-B4** Confidence thresholds (PLAN L2 confirmed): ≥0.9 lock, 0.6–0.9 suggest, <0.6 → `manual_csv` fallback + require operator column mapping.
- **L-B5** `rawHeaderSample` continues to be computed by `dispatchAdapter` (in `import.ts`) AROUND the registry call, gated on `descriptor.signature.acceptedShapes.includes("csv")`. `AdapterResult` shape unchanged.
- **L-B6** Greenlit to start: **YES after A's commit lands.** B can build adapter-detect/registry against the existing adapter exports without depending on A's new schemas.

---

## C. Dashboard Preview Server — INTEGRATED

### Scope (confirmed)
- New callable `paExternalSupplyPreviewBatch` in `apps/functions/src/external-supply/preview-batch.ts`.
- Extract `forecastTagWrites(existing, draft)` from `legacy-user-tags-bridge.ts` (additive export); refactor existing `dualWriteLegacyUserTagsFromExternal` to call it internally (net behavior unchanged).
- Extract `dispatchAdapter` from `import.ts` into a small exported pure helper so preview reuses without re-implementing.
- Reuse `resolveExternalSupplyIdentity` from `@pa/pa-persistence` (read-only inner resolver) row-by-row in preview — do NOT reuse `runResolveBatchIdentity` (which writes).
- Tier forecast path requires additive exports of `loadJobContext`, `loadCompanyContext`, `coerceCandidateProfile` (or equivalent) from `apps/functions/src/external-supply/evaluate.ts`. Pure functions; no behavior change.

### Dry-mode contract (final)
- Code path is read-only **by construction** (no helper called by preview performs a Firestore write).
- Test guarantees it by wrapping the Firestore fake in a `recordingDb` proxy that throws on any `.set/.update/.add/.delete/.create/.commit-with-pending-writes/batch().*`. Assertion: zero writes against the 105-row fixture.
- `dryRun` flag NOT added to `mergeUserTags` / `dualWriteLegacyUserTagsFromExternal`. Preview just doesn't call them.

### Lead resolutions

- **L-C1** Adopt option (b) BUT realized via call-site avoidance, not a flag plumbed through writers. Document this in the code header.
- **L-C2** Cap `tagEnrichmentForecast.perCandidatePreview[]` at **25 rows** (UI scroll-friendly, payload-bounded). Hashed candidateKey only — no PII.
- **L-C3** Cap raw file size at **5 MB pre-base64** (Zod: `base64Bytes.length <= 7_000_000`). Warn at 3 MB.
- **L-C4** xlsx files → `warnings: ["xlsx_not_yet_supported"]` + `chosenSource: "manual_csv"` fallback. No `xlsx` lib added in V2.
- **L-C5** Tier forecast keys MUST match the canonical `EvaluationTierSchema` values verbatim (`tier_1_personal_linkedin_and_email` / `tier_2_personal_email` / `tier_3_general_email` / `retain_only` / `blocked`). The `tier_3_general_email_or_retain_only` label in PLAN §3.5 was a forecast-display name, not an enum value — preview emits enum-keyed counts and dashboard maps to display labels.
- **L-C6** Auth gate = `requireExternalSupplyAdmin(req.auth)`, reuse V1 helper.
- **L-C7** `apps/functions/src/external-supply/index.ts` is created in this wave (D also touches it; merge order = B/C first, then D appends; lead handles small conflict if any).
- **L-C8** Greenlit to start: **after A merges** so any new types are typed properly. May start scaffold against existing V1 surfaces immediately.

---

## D. Agent Ranking — INTEGRATED

### Scope (confirmed)
- New `packages/external-supply/src/agent-rank-prompt.ts` + `.test.ts` — prompt builder + JSON parser + ensemble majority + token estimator + helpers. Pure.
- New `apps/functions/src/external-supply/agent-rank.ts` + `.test.ts` — three callables (`paExternalSupplyRunAgentRanking`, `paExternalSupplyApproveAgentTier`, `paExternalSupplyOverrideAgentTier`) + cost projector + ledger writer.
- Edit `apps/functions/src/index.ts` (top-level — NOT a sub-index file) to re-export the new callables. (Brief mention of `apps/functions/src/external-supply/index.ts` is interpreted as "wire into the function entry-point" — V1 pattern uses top-level `apps/functions/src/index.ts`.)
- Edit `apps/functions/src/external-supply/firestore.rules` block (or `firestore.rules` root) to grant operator-only read on `pa-agent-ranking-results` + `pa-correction-events` (V1 already grants read on correction events; verify).

### Prompt + parser (final)
- `AGENT_RANK_PROMPT_VERSION = "agent-rank-2026-05-A"` baked into every prompt + persisted on every result row.
- `expectedJsonSchemaVersion = "agent-rank-result-2026-05-A"`.
- Output JSON envelope per the AGENT_PLAN. `parseAgentRankingResponse` defensive: fenced-code strip + brace-substring fallback + Zod validation + surfaces `schemaVersionMismatch` + `parseErrors[]` without throwing.
- Truncate experience to last 10 entries + skills to top 30 in the prompt (note that in the prompt body so the agent knows it's truncated input). PII scrub on candidate name + email-shaped strings.

### Cost cap algorithm (final)
- Pricing table HARD-CODED in `agent-rank.ts` (NOT env-driven) with `COST_TABLE_VERSION = "pricing-2026-05-A"` stamped on every ledger + ranking row.
- Token estimator: duplicate the 30-line helper locally in `agent-rank-prompt.ts` (rejected: re-exporting from `pa-orchestrator/src/voice/context-window.ts` — adds dep weight).
- Output token budget = `OUTPUT_TOKEN_BUDGET = 400`. `max_tokens = 500` passed to provider to bound actual spend.
- Budget resolution: payload `budgetUsd` → env `EXTERNAL_SUPPLY_AGENT_RANKING_BUDGET_USD_PER_BATCH` → default `10.00`.
- Projection: `perCandidate = ceil(estimateTokens(prompt) / 1000) * pricing.in + (OUTPUT_TOKEN_BUDGET / 1000) * pricing.out`. `total = perCandidate * candidates.length * ensembleSize`.
- Abort path: projected > budget → 0 writes, 0 LLM calls, return `{ abortedReason: "budget_exceeded", costUsd: 0, projectedCostUsd, ... }`.

### Ensemble strategy (final)
- `ensembleSize` valid 1..3 in V2 (Zod). Schema allows up to 5 for V2.1.
- `ensembleSize=1` → single vote = result.
- `ensembleSize>1` → same model called N times. Future: `model?: string[]` deferred.
- `pickEnsembleMajority(votes)`:
  - Strict majority `> N/2` on `proposedAgentTier` → that tier wins; that vote's rationale = `agentRationale`.
  - Tie → fall back to `deterministicTier` + force `agentRecommendedAction = "outreach_after_research"` + rationale "Ensemble tie — deferring to deterministic tier and routing to follow-up research."
  - `agentRisks` = concat across votes with `[modelUsed]` prefix.
- Hard-gate clamp: if `deterministicTier === "blocked"`, force `proposedAgentTier = "blocked"` + append `agentRisks: ["hard_gate_blocked"]`.

### Cost ledger integration (final)
- V1 writer found at `apps/functions/src/external-supply/outreach.ts:741` — `writeToolCallAudit` → `PA_COLLECTIONS.toolCalls` (`"pa-tool-calls"`).
- D writes one ledger row per LLM call (ensembleSize=3 × 50 candidates = 150 rows).
- Row shape: provider, callable, candidateId, evaluationId, resultId, modelUsed, promptRedacted (charCount + estimatedInputTokens + promptVersion), responseRedacted (schemaVersionOk + proposedAgentTier + outputTokens + parseErrors.length), costUsd, costTableVersion, createdAt.
- Failures/parse errors write a ledger row with `responseRedacted.error: "<short>"`.

### Override / approve flow (final — mirrors A's schema)
- `runOverrideAgentTier(resultId, newTier, reason)` — admin auth; assert `status === "proposed"`; batch-write `pa-agent-ranking-results/{resultId}` status update + `pa-correction-events/{uuid}` with `targetType: "agent_ranking_result"`, `targetId: resultId`, before/after, reason. Idempotent on already-overridden (re-reads existing correctionEventId).
- `runApproveAgentTier(resultId, reason?)` — admin auth; update only; no correction event.
- Re-run agent-ranking on a terminal row (approved/overridden) is a SKIP, not an overwrite. Test asserts.

### Lead resolutions

- **L-D1** Pricing table hard-coded with `COST_TABLE_VERSION` stamp. Confirmed. Future runtime overlay deferred.
- **L-D2** Token estimator duplicated locally — keep `packages/external-supply` free of orchestrator dep.
- **L-D3** "Sub-index file" interpretation = wire into top-level `apps/functions/src/index.ts` (V1 pattern). C / D / F coordinate on this single file; lead arbitrates if conflicts arise.
- **L-D4 (HARD REQUIREMENT)** `runWithOpenAI` and `firestore` MUST be deps-injectable on the `run*` handlers (e.g., `runAgentRanking(input, { db, runWithOpenAI, now, ... })`). G's e2e harness depends on this. Hard imports = G blocked. Surface this to D before code lands.
- **L-D5** `max_tokens=500` per LLM call to bound spend even if estimator under-projects.
- **L-D6** Truncate experience to last 10 entries + skills to top 30 in prompt; document in code header.
- **L-D7** Approve = no correction event. Override = correction event with `targetType: "agent_ranking_result"`. Re-run on terminal row = skip.
- **L-D8** Greenlit to start: **after A merges.** Independent of B/C.

---

## E. Dashboard UX — INTEGRATED

### Scope (confirmed)
- Rewrite `BatchNew.tsx` into a 3-step wizard (Drop → Preview → Commit) using new `Dropzone` + `PreviewPane` components.
- New `EvaluationAgentRanking.tsx` page at `/admin/external-supply/evaluations/:runId/agent-ranking` with `RankingTable` + `RankingApprovalRow` + bulk approve + override modal.
- Extend `Audit.tsx` "Why this tier?" trace with agent-ranking sub-panel.
- Add `runAgentRanking` button + dry-run toggle + budget input on `EvaluationDetail.tsx` (small edit).
- Extend `external-supply-client.ts` with `previewBatch`, `runAgentRanking`, `approveAgentTier`, `overrideAgentTier`, `listAgentRankingResults`, `getAgentRankingResult`.

### UI library reality (final)
- **No Tailwind / Radix / MUI in `apps/dashboard-web`.** Repo pattern is plain React + inline `React.CSSProperties` + `ui.tsx` primitives (`PageHeader`, `Panel`, `EmptyState`, `LoadingState`, `ErrorState`, `Badge`, `DataTable`). Override modal = focus-trapped custom div with `role="dialog"` + `aria-modal="true"` and a backdrop.
- **Tests use `node --test` + `react-dom/server.renderToStaticMarkup`** (matches existing dashboard test pattern). NOT vitest. Static-markup assertions only.

### Bulk approve concurrency
- Cap concurrency at **5** via a tiny `pLimit`-style shim (or sequential `for...of` if <10 rows).

### Lead resolutions

- **L-E1** Reject vitest; mirror existing `node --test` + `renderToStaticMarkup` pattern. Mock client helpers via local module shim (not portable mock libs).
- **L-E2** No optimistic updates — straight refetch after mutation. Match V1 `overrideTier` flow.
- **L-E3** Drag-drop file-size cap = 5 MB raw (matches preview callable Zod). Chunked `btoa` over `Uint8Array` for base64 to avoid stack overflow.
- **L-E4** `EvaluationTierBadge` already accepts `EvaluationTierSchema` values. Confirm at integration.
- **L-E5** Correction-event display: render the `correctionEventId` short hash as monospace text (no detail page exists yet — out of V2 scope). Tooltip "no UI page yet — query `pa-correction-events/{id}` directly".
- **L-E6** Greenlit to start: **after A merges** (types). UI scaffold may start against stub fixtures earlier; final commit waits.

---

## F. Flywheel Integration — INTEGRATED

### Scope (confirmed)
- Edit `apps/functions/src/qa-evaluator-weekly.ts` (NOT `packages/pa-orchestrator/src/` — PLAN §2 path was wrong; corrected below).
- Add `sampleAgentRankingRows`, `computeAgentOverrideMetrics`, `makeSeededRng` helpers; thread per-domain RNG so existing sampler determinism stays intact.
- Persist `agentRanking: { sampled, approvals, overrides, operatorOverrideRate, flag, weekKey }` on the run doc (`pa-qa-evaluator-runs/{runId}`).
- New `apps/functions/src/external-supply/source-quality.ts` + `.test.ts` — monthly per-source rollup CF `paExternalSupplyRollupSourceQualityMonthly` (cron `0 8 1 * *`). Writes per-source `agentTierAcceptanceRate` rollups via `createSourceQualityMetricId(source, yyyyMm)`.

### Lead resolutions

- **L-F1 (path correction)** PLAN §2 incorrectly listed `packages/pa-orchestrator/src/qa-evaluator-weekly.ts`. Real file is `apps/functions/src/qa-evaluator-weekly.ts`. PLAN.md footnote will record this; F edits in place.
- **L-F2** F does NOT extend `SourceQualityMetricSchema` itself — **A lands the additive Zod fields in the same commit as the V2 contracts** (see L-A4). F only writes to those fields.
- **L-F3** >15% override flag stored on the **run doc** (`pa-qa-evaluator-runs/{runId}.agentRanking.flag`) — NOT a synthetic `pa-source-quality-metrics` row keyed by week. Slack/Mailgun alert reuses existing alert plumbing. Dashboard surface = out of F's scope (E may add the alert badge later; not in V2 scope).
- **L-F4** Sampler pool cap = 200; sample size = 50. Status filter: only `"approved" | "overridden"` rows count toward denominator; `"proposed"` and `"ignored"` excluded.
- **L-F5** Threshold = `> 0.15` strict (rounds 0.15 → `false`, 0.151 → `true`).
- **L-F6** Cross-collection join (ranking → record → batch → source) batches `batchId` lookups via `in`-query per 10 ids.
- **L-F7** Greenlit to start: **after A merges (for the new optional Zod fields) AND after D's schema is consumed live**. F can scaffold tests against fixture data immediately.

---

## G. Verification — INTEGRATED

### Scope (confirmed)
- Build `tests/external-supply-v2/end-to-end.test.ts` mirroring V1 structure (`node --test` driver + per-row blocks).
- Helpers: `agent-rank-llm-stub.ts` (deterministic in-memory LLM stub), `preview-driver.ts` (recording-proxy Firestore for write assertion). Reuse V1 `firestore-fake.ts` + `seed.ts` unchanged via relative-path import.
- Fixtures: `big-batch-v2.json` (105 rows mixed-source) + `seed-pa-users.json` (extended V1 seeds) + `unknown-shape.csv` (negative fixture).
- `apps/functions/scripts/external-supply-v2-prod-smoke.ts` — mirrors V1 prod-smoke + 4 new steps (preview, agent-rank dry-run, agent-rank live, override).
- `.planning/external-supply-v2/DASHBOARD-CLICK-THROUGH-PROMPT.md` operator runbook.
- Fill `ACCEPTANCE.md` rows + `SUMMARY.md` narrative.

### Fixture distribution (final)
- 35 juicebox + 35 lessie + 35 coresignal.
- Identity: 50 create_new + 20 merge_existing + 21 review (10 email-only + 11 mismatch) + 10 blocked + 3 within-batch dup + 1 spare = 105.
- Tier-eligibility after evaluation: tier_1 ~12, tier_2 ~25, tier_3 ~18, retain_only ~10, blocked ~5.

### Live prod-smoke defaults (final)
- ensembleSize = **1** in prod-smoke (Adam can rerun with --ensemble=3).
- budgetUsd = **$2** default cap on prod-smoke (well below $10 production budget).
- OPENAI_API_KEY required for step 5; if missing, step skipped with `skippedReason: "openai_key_missing"`.
- Mailgun dry-run only — no live email.

### Lead resolutions

- **L-G1 (HARD REQUIREMENT propagation to D)** D's `run*` handlers MUST accept `{ db, runWithOpenAI, now, ... }` deps. Already captured as L-D4. G's harness fails-fast at integration if not.
- **L-G2** Live prod-smoke ensembleSize=1, budget=$2. Production callable default stays $10 / size 1 per PLAN.
- **L-G3** Synthetic prod-smoke ids carry prefix `prod-smoke-v2-<iso>` for manual cleanup; no auto-delete (matches V1 pattern).
- **L-G4** Correction-event doc id: `randomUUID()` (V1 pattern). Harness doc-id audit accepts uuid OR sha256-prefix shape.
- **L-G5** Network calls in tests blocked via `globalThis.fetch = () => { throw new Error("network not allowed") }` at top of e2e file. LLM stub fully replaces `runWithOpenAI`.
- **L-G6** Tier-forecast guard: `if (forecast.tierForecast)` defensive check (C only emits when `forecastEvaluationFor` supplied).
- **L-G7** Greenlit to start: **immediately** for fixture composition + click-through prompt + prod-smoke skeleton (parallel to A). e2e rows 8-12 gate on D's deps-injectable callable shape.

---

## Wave readiness summary

| Wave | Executors | Gate | Status |
|---|---|---|---|
| A | A | none | **start now** |
| B | B, C | A merged | armed |
| C | D | A merged | armed |
| D | E | A + B + C + D contracts published | scaffolded against types after A |
| E | F, G | E shipped (F+G land after dashboard) | G may start fixtures + click-through immediately |

Lead will not block A on PR review since it's a single-executor wave; A commits, lead spot-checks, B-G proceed.
