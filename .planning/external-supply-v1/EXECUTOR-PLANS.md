# External Supply V1 — Executor Plans (Integrated)

> Lead-integrated AGENT_PLAN bundle. Implementation may begin only after the lead Integration Note (`PLAN.md` §9.1) is filled and committed. Lead resolutions to executor questions are inline below each plan.

## Template Reference

Per `.planning/AUTONOMOUS-SPRINT-HARNESS.md` §3 Phase 2 — every executor returns:

```text
AGENT_PLAN
Executor:
Objective:
Files to read:
Exclusive write scope:
Shared files needed:
Dependencies on other executors:
Proposed steps:
Tests/evals to add or run:
Safety/privacy checks:
Stop conditions:
Expected artifacts:
Questions for lead:
```

---

## A. Data Model + Contracts

### A's AGENT_PLAN

**Executor:** A — Data Model + Contracts
**Objective:** Lock Zod schema / status enum / type contract / collection-constant surface for External Supply V1 so executors B–H can implement against a stable `@pa/core-types` re-export. Pure additive: extend marketplace evidence/handle-source/identity-conflict/identity-event enums (PLAN §5.3); add 10 collection constants (§5.4); introduce `external-supply.ts` with every schema in §5.1–§5.2 plus deterministic doc-id helpers (§5.5); re-export from `index.ts`; ship round-trip + failure-case tests.

**Files to read:** CONTEXT, PLAN §5/§8/§11A, INITIATIVE §3/§4/§7, AUTONOMOUS-SPRINT-HARNESS §3, `packages/core-types/src/{marketplace.ts, marketplace.test.ts, collections.ts, index.ts, matching-jobs.ts}`, `packages/shared-tags/src/index.ts`, `pnpm-workspace.yaml`, `packages/core-types/package.json`, `tsconfig.base.json`.

**Exclusive write scope:** `packages/core-types/src/external-supply.ts` (new); `packages/core-types/src/external-supply.test.ts` (new); additive enum extensions in `marketplace.ts`; 10 new keys in `collections.ts`; additive re-exports in `index.ts`.

**Shared files needed:** `pnpm-workspace.yaml` — current `packages/*` glob already auto-discovers; no edit needed.

**Dependencies on other executors:** None upstream. Downstream: every other executor.

**Proposed steps:**
1. Write `external-supply.ts`: status enums (ExternalSource, ExternalBatchStatus, IdentityResolutionStatus, EvaluationTier, OutreachChannel, OutreachApprovalStatus, InstantlySyncStatus, OutreachEventKind, AgentResearchReviewStatus, **SuppressionBlockReason**); record schemas (every record from PLAN §5.2); deterministic id helpers (`createExternalEvaluationId`, `createOutreachEventId`, `createSourceQualityMetricId`).
2. Append enum extensions in `marketplace.ts`.
3. Add 10 keys to `PA_COLLECTIONS`.
4. Re-export new schemas + types from `index.ts`.
5. Author `external-supply.test.ts` (round-trip + failure matrix).
6. `pnpm --filter @pa/core-types test` + `pnpm --filter @pa/core-types build` green.
7. Commit `feat(external-supply): lock core-types contracts`.

**Tests/evals to add or run:** `external-supply.test.ts` with ≥1 round-trip + ≥1 failure case per record type; existing `marketplace.test.ts` and `scheduled-jobs.test.ts` must stay green; `tsc --noEmit` via build.

**Safety/privacy checks:** No raw email/LinkedIn/phone in fixtures; all doc-id rules enforced.

**Stop conditions:** Any required field cannot be modeled additively; existing test regresses; doc-id rule conflict.

**Expected artifacts:** Files listed above + commit + green test output.

**Questions for lead — RESOLVED:**

1. _pnpm-workspace.yaml — explicit `packages/external-supply/*` line or leave glob?_ → **Leave the glob.** No edit. (Removed from §11 Wave A.)
2. _AgentResearchFinding: `evidenceUrls: string[]` only or also `MarketplaceEvidence[]`?_ → **Keep `evidenceUrls: string[]` only.** Per-task `evidence: MarketplaceEvidence[]` lives on `AgentResearchTaskSchema` (parent), not per-finding.
3. _OutreachEvent id helper branches internally?_ → **Yes.** Helper accepts optional `providerEventId`; falls back to `crypto.randomUUID()` internally.
4. _Export `SuppressionBlockReasonSchema` as a named schema?_ → **Yes.** Export it so F can switch on it without re-declaring. Add to enum list in step 1.
5. _Optional `fuzzyMatchScore` on `CandidateIdentityConflictSchema`?_ → **No.** Park in `payloadRedacted: { fuzzyMatchScore }`. Keep marketplace.ts churn minimal.

**Additional lead adjustments (downstream questions):**

- **B's Q2** asks to persist `columnMapping` per batch — **add** `meta: z.record(z.unknown()).optional()` field to `ExternalSourcingBatchSchema` (records adapter version, columnMapping, raw header sample). Already covered by the existing PLAN §5.2 narrative.
- **C's Q4** asks to relax source-link `candidateId` for pending-review rows — **change** `CandidateSourceLinkSchema`:
  - `candidateId: IdSchema.optional()`
  - Add field `pendingRecordId: IdSchema.optional()` (mirror of recordId for pending lookups)
  - Add field `status: z.enum(["linked","pending_review","blocked"]).default("linked")`
- **E's Q4** confirms `expectedJsonSchemaVersion` stays as a const in `agent-parse.ts`. A still exports `AgentResearchTaskSchema.expectedJsonSchemaVersion: z.string().min(1)`.

---

## B. Import + Normalization

### B's AGENT_PLAN

**Executor:** B — Import + Normalization
**Objective:** Own raw row ingestion from Juicebox / Lessie / Coresignal / manual-CSV exports through canonical normalization, in-batch dedup, batch-stat computation, and the admin `createBatch` Cloud Function callable that lands `ExternalSourcingBatch` + `ExternalCandidateRecord[]` in Firestore. Stand up `packages/external-supply/` workspace package with normalize lib + tests so Wave C executors can import from `@pa/external-supply`.

**Files to read:** CONTEXT §2.1/2.4/2.5, PLAN §5/§7/§11B, A's `external-supply.ts` (post-A), `packages/shared-tags/src/sha256.ts`, `packages/core-types/src/marketplace.ts`, `apps/functions/src/cv-ingest/cv-ingest.ts` (callable style).

**Exclusive write scope:** `packages/external-supply/{package.json, tsconfig.json, src/index.ts}`; `packages/external-supply/src/normalize.ts` + test; `apps/functions/src/external-supply/import.ts` + test; 4 adapters in `apps/functions/src/external-supply/adapters/*`; 3 fixture files in `tests/fixtures/external-supply/`.

**Shared files needed:** `apps/functions/src/index.ts` — F integrates final export list.

**Dependencies on other executors:** Blocked by A. Downstream: C, D, H consume B's output.

**Proposed steps:**
1. Scaffold `packages/external-supply` (private, ESM, deps `@pa/core-types`, `@wekruit/shared-tags`, `zod`).
2. `normalize.ts`: `canonicalizeLinkedInUrl`, `linkedinHash`, `normalizeEmail`, `emailHash`, `normalizePhoneE164`, `dedupeWithinBatch`.
3. Four source adapters returning `Array<NormalizedRecordDraft>`.
4. `import.ts` callable `paExternalSupplyCreateBatch`: admin-auth, persists raw file ref to Storage, runs adapter, normalizes, dedups, writes batch + records, computes stats, sets `status: "normalized"`. Idempotent by `sha256(rawFile)`.
5. Build minimal fixture files for happy + edge cases.

**Tests/evals to add or run:** normalize edge cases, per-adapter parser tests, in-memory Firestore E2E for `createBatch`. `pnpm --filter @pa/external-supply test` and `pnpm --filter functions test --testPathPattern external-supply` green.

**Safety/privacy checks:** No raw PII in doc ids. Phone/email hashed via existing helpers. File size cap (reuse `cv-size-cap.ts`). Admin auth gate.

**Stop conditions:** A's contracts not landed; canonical LinkedIn URL ambiguous; manual-csv columnMapping missing.

**Expected artifacts:** Package + lib + tests + adapters + import callable + 3 fixtures + commit `feat(external-supply): batch import + normalize`.

**Questions for lead — RESOLVED:**

1. _`csv-parse` runtime dep OK?_ → **Yes.** Use `csv-parse` (already widely used) or `papaparse`. Add to `packages/external-supply/package.json`. Tree-shake-friendly version preferred.
2. _Persist `columnMapping` on batch doc?_ → **Yes.** A adds `meta: z.record(z.unknown()).optional()` on `ExternalSourcingBatchSchema`. Stash `{ adapterVersion, columnMapping, rawHeaderSample }` there.
3. _Phone normalization with US default?_ → **No.** Always require E.164. Non-E.164 → `normalizationErrors.push("phone_not_e164")`. Phone is optional anyway; don't break record.
4. _Firebase Storage write of `rawFileRef` in B's scope?_ → **Yes.** Add helper `uploadBatchRawFile(buffer, sha256)` that returns `{ storageUri, mime, sha256, sizeBytes }`. H's E2E test mocks Storage by passing a pre-constructed `rawFileRef` directly to a lower-level helper.

---

## C. Identity + pa-users Upsert

### C's AGENT_PLAN

**Executor:** C — Identity + pa-users Upsert
**Objective:** LinkedIn-first identity resolution + pa-users upsert path for external sourcing rows. Wrap (do not modify) `resolveCandidateIdentity` to handle: (1) LinkedIn-hash canonical lookup auto-merge, (2) email-only -> `needs_review`, (3) LinkedIn-vs-email mismatch -> `linkedin_email_candidate_mismatch` conflict, (4) fuzzy name+company hit -> `external_fuzzy_match` conflict, (5) `blocked` terminal for unresolvable rows. Write `pa-candidate-source-links`, link LinkedIn handle, merge tags via `mergeUserTags` weak-only, emit `external_candidate_imported` / `external_source_linked` audit events. Admin callable to iterate a batch.

**Files to read:** CONTEXT §2.1/§3/§6, PLAN §5/§7/§8/§11B-C-block/§15, `packages/core-types/src/marketplace.ts`, `packages/pa-persistence/src/identity.ts`, `packages/pa-persistence/src/identity.test.ts`, `packages/shared-tags/src/index.ts`.

**Exclusive write scope:** `packages/pa-persistence/src/external-supply-identity.ts` + test; `packages/pa-persistence/src/external-supply-upsert.ts` + test; `apps/functions/src/external-supply/resolve-identity.ts` + test.

**Shared files needed:** read-only A contracts, `identity.ts`, `mergeUserTags`. F appends export to `apps/functions/src/index.ts`.

**Dependencies on other executors:** Blocked by A. Soft on B (canonical LinkedIn URL helper). Used by G, F, H downstream.

**Proposed steps:**
1. After A merges, pull schemas + consts.
2. `external-supply-identity.ts` exports `resolveExternalSupplyIdentity(db, record, opts)` returning `{ status, candidateId?, conflictId?, reviewReasons[] }`.
3. `external-supply-upsert.ts` `upsertCandidateFromExternalRecord({db, record, resolution, operatorUid})` branches per status. `mergeUserTags` weak-only. Identity events emitted.
4. Callable `resolveBatchIdentity({batchId})` paginates records, updates statuses, decrements/increments batch counters. Idempotent.
5. Admin-auth gate via `admin-bootstrap`.

**Tests/evals to add or run:** LinkedIn-only hit auto-merge; LinkedIn-only miss create; email-only → review; LinkedIn+email mismatch → conflict; fuzzy → conflict; blocked terminal; upsert idempotency; weak-only tag merge (no stronger-fact overwrite); audit event emission; callable end-to-end against in-memory Firestore. `pnpm --filter @pa/pa-persistence test` + `pnpm --filter functions test --testPathPattern external-supply`.

**Safety/privacy checks:** No raw PII in doc ids. Raw payload never propagated to `payloadRedacted`. Never overwrite linkedinUrl if already different — route to review. `mergeUserTags` always sole writer.

**Stop conditions:** A's schemas not published; LinkedIn-only auto-create semantics ambiguous.

**Expected artifacts:** 3 source files + 3 tests + green `pa-persistence` + `functions/external-supply` suites + commit `feat(external-supply): identity resolution + pa-users upsert`.

**Questions for lead — RESOLVED:**

1. _LinkedIn-only row — auto-create or hold for review?_ → **Auto-create.** Per PLAN §11 C1 and INITIATIVE §3. LinkedIn is sufficient signal for a `prospect` profile.
2. _`external_sourcing` default evidence confidence = 0.4 (weak)?_ → **Yes, 0.4.** `mergeUserTags` weak-only ensures no stronger existing fact gets overwritten.
3. _Fuzzy match algorithm — exact normalized name + currentCompany in V1?_ → **Yes, exact V1.** Normalize via `name.toLowerCase().replace(/[^a-z ]/g,"").trim()` and case-insensitive `currentCompany` exact match. Token-set / Jaro-Winkler deferred to V2.
4. _Source-link `candidateId` for needs_review / blocked rows — null or optional?_ → **Optional.** A relaxes `CandidateSourceLinkSchema.candidateId` to `IdSchema.optional()` and adds `status: "linked"|"pending_review"|"blocked"` + `pendingRecordId?: IdSchema`. C writes pending source-link with `candidateId` absent and `status: "pending_review"`.

---

## D. Evaluation + Rubric Engine

### D's AGENT_PLAN

**Executor:** D — Evaluation + Rubric Engine
**Objective:** Pure rubric engine (general / company / job sub-scores, hard gates per JOB-DATA-CONTRACT §6.3, tier proposal). `runEvaluation` admin callable writes idempotent `pa-candidate-company-job-evaluations` docs under `pa-candidate-evaluation-runs/{runId}`. No global `pa-users` mutation.

**Files to read:** CONTEXT, PLAN §5/§11 Wave C-D, INITIATIVE §4/§5 Step 5, `marketplace.ts`, A's `external-supply.ts`, `collections.ts`, shared-tags canonical vocab, `apps/job-rec/src/match-weights.ts` + `tools/query-matching-jobs-v16.ts` (read-only).

**Exclusive write scope:** `packages/external-supply/src/rubric.ts` + test; `apps/functions/src/external-supply/evaluate.ts` + test.

**Shared files needed:** none.

**Dependencies on other executors:** A (blocking). B/C input data shape (soft).

**Proposed steps:** rubric helpers (general/company/job) + `proposeTier` mapping + `composeEvaluation` aggregator + `runEvaluation` callable (deterministic doc id idempotent).

**Tests/evals to add or run:** Hard-gate matrix; soft-score bounds; tier-mapping table; idempotency; missing-info detection; deterministic composite doc id. `pnpm --filter @pa/external-supply test` + `pnpm --filter functions test --testPathPattern evaluate`.

**Safety/privacy checks:** No raw email/phone/LinkedIn in evidence/explanation. No `pa-users` writes. Pure functions in rubric.ts. Admin-auth callable. Tier never blocks first interview (Invariant 9).

**Stop conditions:** A's schemas drift; JOB-DATA-CONTRACT semantics unreproducible purely.

**Expected artifacts:** rubric lib (~400 LOC) + tests + callable + commit `feat(external-supply): rubric engine + evaluation runs`.

**Questions for lead — RESOLVED:**

1. _`rubricVersion` constant or caller override?_ → **Default constant `"rubric-2026-05-v1"`, allow override** for future A/B.
2. _Competitor-adjacency: read `pa-companies` or treat as missingInfo?_ → **Treat as missingInfo in V1.** Optional enrichment via E's agent research findings. No `pa-companies` read in V1.
3. _`retain_only` as catch-all?_ → **Yes.** "Neither blocked nor outreach-worthy now" maps to `retain_only`.
4. _Tier weights as file-level constants?_ → **Yes for V1.** Make them named exports so eval / regression can pin them.

---

## E. Agent Research + Prompt Contract

### E's AGENT_PLAN

**Executor:** E — Agent Research + Prompt Contract
**Objective:** Deterministic ChatGPT Agent Mode prompt generator (`buildAgentResearchPrompt`), defensive JSON parser (`parseAgentResearchResult`), three admin callables (`generateAgentResearchPrompt`, `importAgentResearchResult`, `approveAgentResearchFinding`). V1 is copy-paste flow — no auto-fetch. Findings require human approval before influencing tier.

**Files to read:** A's `external-supply.ts` + `collections.ts` + `marketplace.ts`, `admin-bootstrap.ts`.

**Exclusive write scope:** `packages/external-supply/src/agent-prompt.ts` + test (+ golden fixture); `packages/external-supply/src/agent-parse.ts` + test; `apps/functions/src/external-supply/agent-task.ts` + test.

**Shared files needed:** `packages/external-supply/src/index.ts` barrel — B owns scaffold; E appends barrel exports.

**Dependencies on other executors:** Blocked by A. Soft on D's `CandidateCompanyJobEvaluation.missingInfo[]` shape (types only).

**Proposed steps:** prompt builder template + Zod-mirrored output contract + parser with safe JSON extract + three callables; per-finding approval that stores audit evidence.

**Tests/evals to add or run:** Round-trip golden (prompt → fake compliant JSON → parse); malformed-JSON rejection; multi-candidate aggregation; per-finding approve flow.

**Safety/privacy checks:** Prompt never includes raw email/phone — masked. Prompt instructs agent to refuse PII scraping. Findings start `approved=false`. No auto-merge to `pa-users`. Admin auth gate. Audit via `pa-tool-calls`.

**Stop conditions:** A's schemas not exported; D's `approvedFindings` consumption requires E to write into evaluation docs (cross-scope).

**Expected artifacts:** 3 source files + 3 tests + golden fixture + commit `feat(external-supply): agent research prompt + import flow`.

**Questions for lead — RESOLVED:**

1. _Approval semantics — auto-rerun or operator-triggered?_ → **Operator-triggered.** No auto-rerun on approval. Approved findings are stored on `AgentResearchTask.parsedFindings[].approved=true`; D's `runEvaluation` reads them on next manual run. E does NOT emit `pa-correction-events` for finding approval — only an operator tier override does that (G writes correction events through D's callable).
2. _Partial-success on `parsedFindings`?_ → **Yes.** Valid findings stored; per-finding errors accumulate on `parseErrors[]`. Operator can hand-edit and re-import.
3. _`promptVersion` cadence?_ → **`"agent-prompt-2026-05-A"` as initial constant.** Bump on any structural prompt change. Golden fixture commit-required.
4. _`expectedJsonSchemaVersion` lives in agent-parse.ts?_ → **Yes.** Single constant `AGENT_RESULT_SCHEMA_VERSION = "agent-result-2026-05-A"`. Referenced as string in the task doc.

---

## F. Outreach + Instantly

### F's AGENT_PLAN

**Executor:** F — Outreach + Instantly
**Objective:** Outreach decisioning (tier → channel + personalization), suppression-gate evaluator, Instantly client (dry-run + live), sync callable, webhook receiver that writes `pa-outreach-events` and `pa-feedback-events`. Manual LinkedIn = task records only — no automation. Live mode requires env flag + secret.

**Files to read:** CONTEXT, PLAN §5/§7/§11/§14, INITIATIVE §4/§7, `marketplace.ts`, A's `external-supply.ts`, `apps/functions/src/sendblue/` (read-only style), `packages/agent-runtime/src/`, `admin-bootstrap.ts`.

**Exclusive write scope:** `packages/external-supply/src/outreach.ts` + test; `packages/external-supply/src/instantly-client.ts` + test; `apps/functions/src/external-supply/outreach.ts` + test; `apps/functions/src/external-supply/instantly-sync.ts` + test; `apps/functions/src/external-supply/instantly-webhook.ts` + test.

**Shared files needed:** `apps/functions/src/index.ts` — F owns final webhook+callable export append.

**Dependencies on other executors:** A blocking; C/D/B for data shapes.

**Proposed steps:**
1. `decideOutreach`, `evaluateSuppression`, copy generator with LLM fallback.
2. `instantly-client.ts` thin fetch client (dry-run echoes payload).
3. Callables `draftOutreachPlan` / `approveOutreachPlan` / `rejectOutreachPlan` / `assignManualLinkedInTask` / `markManualLinkedInTaskStatus`.
4. `syncPlanToInstantly(planId, { mode })` re-runs suppression at callable entry, hard-gates live mode, writes sync record.
5. Webhook HTTP function with HMAC verify, idempotent event write, also writes `pa-feedback-events`.
6. Append exports to `apps/functions/src/index.ts`.

**Tests/evals to add or run:** Tier→channel matrix; suppression gate matrix; Instantly dry-run golden; live-mode gate behavior; webhook idempotency; HMAC reject; LLM fallback.

**Safety/privacy checks:** Live sync requires `EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED=true` AND `INSTANTLY_API_KEY`. Suppression re-evaluated at callable entry. Webhook HMAC. No raw PII in doc ids. Redacted payloads. Admin auth gate. LinkedIn manual only.

**Stop conditions:** A's contracts not landed; Instantly HMAC scheme unclear (ship optional verification + document gap, no live mode until resolved).

**Expected artifacts:** 5 source files + 5 tests + final `index.ts` export append + commit `feat(external-supply): outreach decisioning + instantly sync + webhook`.

**Questions for lead — RESOLVED:**

1. _Write `pa-feedback-events` on Instantly reply in F's scope?_ → **Yes.** Per PLAN §13.
2. _Cooldown defaults — 14d duplicate, 30d post-bounce?_ → **Yes.** Lock as named constants in `outreach.ts`: `DUPLICATE_COMPANY_ROLE_COOLDOWN_DAYS = 14`, `POST_BOUNCE_COOLDOWN_DAYS = 30`, `POST_DECLINE_COOLDOWN_DAYS = 90`.
3. _Instantly campaign/list selection — operator-supplied or default-mapped?_ → **Operator-supplied per plan** via callable input. No company/tier default mapping in V1.
4. _Sync writes a v1.9-compatible `CandidateJobEvent` (`outbound_sent`) to advance reducer?_ → **No, decoupled in V1.** External-supply outreach is its own track. The reducer integration is a future sprint trigger.
5. _Live-sync env gate exposure — callable or public config doc?_ → **Callable.** F exports `getExternalSupplyConfig` callable that returns `{ liveOutreachEnabled: boolean, instantlyConfigured: boolean }`. G calls it to decide whether to render the live-sync button.

---

## G. Dashboard

### G's AGENT_PLAN

**Executor:** G — Dashboard
**Objective:** Internal admin UI under `/admin/external-supply/*` (10 routes incl. landing). Reuse existing dashboard layout / components / firebase callable client. All routes render loading/empty/error/partial/success states. No candidate-domain pages.

**Files to read:** existing dashboard pages for style mirror; `components/ui*`; `lib/firebase`; A's contracts; callable signatures from all backend executors.

**Exclusive write scope:** `apps/dashboard-web/src/pages/external-supply/*` (10 page files); `apps/dashboard-web/src/components/external-supply/*` (8 reusable comps); `apps/dashboard-web/src/lib/external-supply-client.ts`; additive nav link + route block in `apps/dashboard-web/src/App.tsx`; vitest specs.

**Shared files needed:** `App.tsx` — G is sole editor (additive only).

**Dependencies on other executors:** All backend executors' callable signatures; H seeds fixture data for dev preview.

**Proposed steps:** types client → shared components → 10 pages → vitest comp tests → manual screenshots into `artifacts/`.

**Tests/evals to add or run:** Vitest comp tests for `BatchTable` + `IdentityStatusBadge`; manual route walk; `pnpm --filter dashboard-web build` green.

**Safety/privacy checks:** Routes under admin-auth branch only. `RedactedField` masks emails/phones in raw payload renders. No raw PII in keys/URL params. Live-sync button gated via callable config check. Zero `apps/pa-landing` references.

**Stop conditions:** A's `external-supply.ts` not exported; callable signatures missing; H fixtures missing.

**Expected artifacts:** 10 pages + ~8 components + lib client + App.tsx patch + 2+ vitest specs + screenshots + commit `feat(external-supply): admin dashboard surfaces`.

**Questions for lead — RESOLVED:**

1. _File upload transport — signed URL or base64 payload?_ → **Signed URL.** B exports a `createBatchUploadUrl` callable that returns a Firebase Storage signed PUT URL. BatchNew uploads directly, then calls `createBatch` with the storageUri. This keeps the callable payload small. Update B's plan to add this helper.
2. _Audit page renders `pa-correction-events`?_ → **Yes.** Include a join with `pa-correction-events` filtered by `targetType` in `("candidate_company_job_evaluation","outreach_plan")`. Renders the HITL trail.
3. _Live-sync env gate — callable or public doc?_ → **Callable.** Use F's `getExternalSupplyConfig` (added per F's resolution #5).
4. _Operator-uid attribution — server-side or payload?_ → **Server-side.** All callables read `context.auth.uid` (and email). Dashboard never sends `operatorUid` in payload.

---

## H. Verification / Eval

### H's AGENT_PLAN

**Executor:** H — Verification / Eval
**Objective:** 100+ candidate mixed-mode acceptance fixture + single end-to-end test driving the full pipeline against in-memory Firestore + mocked LLM + mocked Instantly. Capture artifacts. Fill ACCEPTANCE.md + SUMMARY.md. Verify cross-cutting invariants.

**Files to read:** All planning docs + final EXECUTOR-PLANS.md + A's contracts + (cross-cuts everything read-only).

**Exclusive write scope:** `tests/external-supply/end-to-end.test.ts` (+ helpers); `tests/fixtures/external-supply/big-batch.json`; `tests/fixtures/external-supply/seed-pa-users.json`; `tests/fixtures/external-supply/company-job.json`; `.planning/external-supply-v1/ACCEPTANCE.md` (fill); `.planning/external-supply-v1/SUMMARY.md` (fill); `.planning/external-supply-v1/artifacts/*`.

**Shared files needed:** none written.

**Dependencies on other executors:** Blocked until Waves A + B + C land. May start fixture authoring once A's enums merge.

**Proposed steps:** Author fixtures → drive pipeline via public services → assert per-row identity + tier + payload + suppression + idempotency → grep for invariant violations → run repo-wide test+build suite → capture artifacts → fill ledger + summary.

**Tests/evals to add or run:** `tests/external-supply/end-to-end.test.ts` + every command in PLAN §12 table.

**Safety/privacy checks:** Doc-id audit; live-mode flag absence asserted; webhook idempotency; weaker-fact-overwrite asserted absent; grep apps/pa-landing returns zero; grep `linkedin.com` POST returns zero.

**Stop conditions:** Any hard-fail in PLAN §12.

**Expected artifacts:** Listed logs + JSON + filled ACCEPTANCE + filled SUMMARY.

**Questions for lead — RESOLVED:**

1. _Existing in-memory Firestore harness?_ → **Yes.** Reuse the same fake Firestore pattern used in `packages/pa-persistence/src/identity.test.ts` (it composes a minimal `Firestore`-shaped object in-test). If a richer harness is needed, lift the pattern into `tests/external-supply/helpers/firestore-fake.ts`. Do not add a new emulator dependency.
2. _Seed pa-users — full S2 or minimum?_ → **Minimum.** Just what `resolveCandidateIdentity` reads: `pa-users/{uid}` with `linkedinUrl`, lifecycle, `globalTags`, plus matching `pa-candidate-handles/{linkedin__hash}` docs. No `pa-candidate-auth` / `pa-candidate-self-profiles` required.
3. _Reply event → Claire first interview — stub reducer or invoke?_ → **Stub.** Assert that F's webhook wrote `pa-feedback-events` with the right kind and that the existing reducer would advance — but do not invoke `pa-orchestrator` here. Test scope contained.
4. _v1.9 regression baseline?_ → **Detect deltas.** Run `pnpm --filter pa-orchestrator test`; baseline = green on `origin/main`. Any new failure attributed to this sprint is a hard-fail.

---

## Lead Integration Note (Cross-cutting)

Filled in `PLAN.md` §9.1.

Cross-executor changes that fall out of resolutions:

- **B's plan** adds `createBatchUploadUrl` callable (per G's Q1 resolution).
- **A's plan** adds `meta?` to `ExternalSourcingBatchSchema` (per B's Q2).
- **A's plan** relaxes `CandidateSourceLinkSchema.candidateId` to optional + adds `status` + `pendingRecordId` (per C's Q4).
- **A's plan** exports `SuppressionBlockReasonSchema` as a named schema (per A's Q4).
- **F's plan** adds `getExternalSupplyConfig` callable (per F Q5 / G Q3).
- **Wave A** drops the `pnpm-workspace.yaml` edit step (per A's Q1).
- **C, D, E, F, G, H** all confirm they wait on A's commit before starting their write work; H may begin fixture authoring (read-only on schemas) immediately after A's commit.

Wave order final:

```
Wave A  (Executor A)                     — contracts lock
Wave B  (Executors B + C, parallel)      — import/normalize + identity/upsert
Wave C  (Executors D + E + F, parallel)  — rubric / agent research / outreach + instantly
Wave D  (Executor G)                     — dashboard
Wave E  (Executor H)                     — fixture + E2E + acceptance + summary
```
