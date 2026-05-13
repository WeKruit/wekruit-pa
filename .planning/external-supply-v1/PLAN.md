# External Supply V1 — Sprint Plan

> **For agentic workers:** This is the single-point-lead plan for the WeKruit External Candidate Supply Intake V1 initiative. Read `CONTEXT.md` first. Then read your assigned executor section in `EXECUTOR-PLANS.md`. Do not edit outside your assigned write scope.

**Status:** Lead-authored, 2026-05-13.
**Branch / worktree:** `codex/v2-external-supply-intake` / `.claude/worktrees/v2-external-supply-intake`.
**Initiative spec:** `.planning/INITIATIVE-external-candidate-supply-intake.md`.

---

## 1. Purpose / Big Picture

After this sprint, WeKruit recruiting ops can sit at `wekruit-pa.web.app/admin/external-supply` and run, in one place:

1. Drop a Juicebox / Lessie / Coresignal CSV / XLSX / JSON export.
2. Watch normalized rows resolve identity against `pa-users` (LinkedIn-first, email-secondary).
3. Approve `pa-users` profile creation / merge for the new LinkedIn-anchored candidates and route email-only or fuzzy-match rows to a review queue.
4. Pick a company + job, kick off an evaluation run, see Tier 1 / 2 / 3 / retain-only / blocked output for each candidate with hard-gate, soft-score, missing-info, and risk evidence.
5. Generate a ChatGPT Agent Mode research prompt for rows needing extra context, paste back structured findings, re-tier.
6. Approve email outreach, sync to Instantly (dry-run or live), and assign a manual LinkedIn outreach task with a personalized message.
7. See Instantly reply / bounce / unsubscribe events stream back, with each event landing as a PA `pa-outreach-events` doc so the candidate stays first-class in the global pool.

The sprint is a vertical marketplace capability: backend primitives + UI + eval + HITL + flywheel. It runs as an adjacent initiative to v2.0 S3+ and shares the same `pa-users` / handle / tag / matching / outreach contracts.

## 2. Observable Outcome

The sprint is complete when an operator can:

- Import a fixture batch of 100+ mixed external candidates and see deterministic per-row status.
- Open a candidate that auto-merged into an existing `pa-users` and confirm the LinkedIn handle is now indexed.
- Open a needs-review candidate and decide create / merge / reject.
- Run one company/job evaluation and see Tier 1/2/3/retain-only/blocked output.
- Trigger Instantly dry-run, see the would-be payload, then trigger live-sync (gated) and see lead-id assigned.
- Land an Instantly reply event in `pa-outreach-events` and see the candidate enter Claire's first-interview flow via the existing v1.9 pipeline.

## 3. Current Repo Orientation

See `CONTEXT.md` for the full reuse map. One-line summary: identity / handle / lifecycle / tags / evidence / conflict / event primitives shipped in S1 + S2 are extended, not duplicated. New collections are added strictly for batch / record / source-link / evaluation / research / outreach plan / Instantly sync / outreach event / source quality metric.

## 4. Locked Invariants And Non-Goals

### Invariants (cannot be violated by any executor)

1. Candidate is the durable global asset — `pa-users` is single source of truth.
2. External candidates share `pa-users`. No parallel candidate db.
3. LinkedIn URL is the primary external source identity handle. Email is secondary.
4. Email-only rows do not auto-create profiles in V1 — they route to needs-review.
5. Raw LinkedIn URL / email / phone never used as Firestore doc id.
6. LinkedIn sending is manual in V1 — generate copy/tasks only.
7. Tags written through `mergeUserTags`; never overwrite stronger existing facts.
8. Opt-out / bounce / cooldown / duplicate suppression gate every Instantly sync.
9. Match score never blocks first interview — Claire interviews regardless of tier.
10. Dashboard is internal-only on `wekruit-pa.web.app/admin/**` — no candidate-domain routes.
11. Every tag/fact written to `pa-users` carries source / confidence / evidence / version.
12. State transitions go through deterministic reducers; LLM may extract / judge / compose only.
13. v1.9 candidate journey must remain green after this sprint lands.

### Non-Goals (intentionally out of scope)

- LinkedIn send automation.
- Employer-visible external supply pages.
- Scheduled / automatic recurring imports.
- Refactoring `generateJobRecs` or v1.6 match cascade.
- Live outbound to non-test recipients without operator approval and explicit env flag.
- Cross-repo (`wekruit-scraping`) Python port of new vocab — deferred to a later milestone.
- Replacing or modifying any v1.9 / S0–S2 already-shipped behavior.

## 5. Data Model And Ownership

This section is **contract-binding**. Executor A finalizes Zod schemas. All others consume them as types via `@pa/core-types` re-exports. Schema files live in `packages/core-types/src/external-supply.ts` (new) and extend `packages/core-types/src/marketplace.ts` only where the spec requires (evidence-source enum, identity-conflict-kind enum, identity-event-type enum, handle-source enum).

### 5.1 Status enums (new)

```ts
// packages/core-types/src/external-supply.ts
export const ExternalSourceSchema = z.enum([
  "juicebox",
  "lessie",
  "coresignal",
  "manual_csv",
])

export const ExternalBatchStatusSchema = z.enum([
  "uploading",
  "normalizing",
  "normalized",
  "resolving_identity",
  "ready_for_review",
  "ready_to_evaluate",
  "completed",
  "failed",
])

export const IdentityResolutionStatusSchema = z.enum([
  "pending",
  "create_new",
  "merge_existing",
  "needs_review",
  "blocked",
])

export const EvaluationTierSchema = z.enum([
  "tier_1_personal_linkedin_and_email",
  "tier_2_personal_email",
  "tier_3_general_email",
  "retain_only",
  "blocked",
])

export const OutreachChannelSchema = z.enum([
  "personal_linkedin",
  "personal_email",
  "general_email",
  "no_outreach",
])

export const OutreachApprovalStatusSchema = z.enum([
  "draft",
  "awaiting_approval",
  "approved",
  "rejected",
  "sent",
  "failed",
])

export const InstantlySyncStatusSchema = z.enum([
  "not_synced",
  "dry_run_planned",
  "queued",
  "synced",
  "sync_failed",
  "suppressed",
])

export const OutreachEventKindSchema = z.enum([
  "email_sent",
  "email_opened",
  "email_clicked",
  "email_replied",
  "email_bounced",
  "email_unsubscribed",
  "email_marked_spam",
  "manual_linkedin_sent",
  "manual_linkedin_replied",
  "candidate_interested",
  "candidate_declined",
])

export const AgentResearchReviewStatusSchema = z.enum([
  "draft_prompt",
  "prompt_copied",
  "result_imported",
  "approved",
  "rejected",
])

export const SuppressionBlockReasonSchema = z.enum([
  "opted_out",
  "previously_bounced",
  "invalid_email",
  "cooldown",
  "duplicate_company_role_recent",
  "low_confidence_personalization",
])
```

### 5.2 Core Records (new)

The fields below are minimum-viable — executor A may add `updatedAt`, `meta`, or audit fields, but must not remove any. All IDs are `crypto.randomUUID()` unless noted. Doc ids never contain raw PII.

```ts
ExternalSourcingBatch = {
  batchId: string                          // doc id
  source: ExternalSource
  companyId?: string                       // target company context, optional
  jobId?: string                           // target job context, optional
  status: ExternalBatchStatus
  rowCount: number
  validLinkedInCount: number
  validEmailCount: number
  duplicateCount: number
  needsReviewCount: number
  readyToProfileCount: number
  rawFileRef: { storageUri: string; mime: string; sha256: string; sizeBytes: number }
  normalizerVersion: string                // e.g. "ext-norm-2026-05"
  importedBy: string                       // operator uid
  meta?: Record<string, unknown>           // adapterVersion, columnMapping, rawHeaderSample — set by B
  createdAt: string
  updatedAt?: string
  completedAt?: string
  notes?: string
}

ExternalCandidateRecord = {
  recordId: string                         // doc id (uuid; NOT linkedin/email/phone)
  batchId: string
  source: ExternalSource
  rawPayload: Record<string, unknown>      // redacted before render
  canonicalLinkedInUrl?: string
  linkedinProfileHash?: string             // sha256(handleHashMaterial("linkedin", normalizedUrl))
  emails: { value: string; hash: string }[] // normalized + hashed
  phoneHash?: string
  name?: string
  currentTitle?: string
  currentCompany?: string
  experience: Array<{ company: string; title: string; startDate?: string; endDate?: string; durationMonths?: number }>
  education: Array<{ school: string; degree?: string; field?: string; endYear?: number }>
  location?: string                        // raw string, canonicalised lazily
  sourceTags: string[]                     // raw tag strings from source
  enrichment?: Record<string, unknown>     // raw enrichment block
  normalizationStatus: "ok" | "partial" | "failed"
  normalizationErrors?: string[]
  identityResolutionStatus: IdentityResolutionStatus
  resolvedUserId?: string                  // pa-users uid after resolution
  resolutionConflictId?: string            // pa-candidate-identity-conflicts ref if needs_review
  reviewReasons?: string[]
  evidence: MarketplaceEvidence[]
  createdAt: string
  updatedAt?: string
}

CandidateSourceLink = {
  sourceLinkId: string                     // doc id (uuid)
  candidateId?: string                     // pa-users uid; absent for pending_review/blocked
  status: "linked" | "pending_review" | "blocked"
  pendingRecordId?: string                 // ExternalCandidateRecord ref when candidateId absent
  source: ExternalSource
  batchId: string
  recordId: string                         // ExternalCandidateRecord ref
  canonicalLinkedInUrl?: string
  linkedinProfileHash?: string
  emailHashes: string[]
  confidence: number                       // 0..1; default 0.4 for external_sourcing
  evidence: MarketplaceEvidence[]
  createdAt: string
  createdBy: string                        // operator uid or "system"
}

CandidateEvaluationRun = {
  runId: string
  companyId: string
  jobId: string
  rubricVersion: string                    // e.g. "rubric-2026-05"
  triggeredBy: string
  scopeRecordIds?: string[]                // explicit subset; if absent, run over batch.recordIds
  scopeBatchId?: string
  candidateCount: number
  completedCount: number
  status: "queued" | "running" | "completed" | "failed"
  startedAt?: string
  completedAt?: string
  createdAt: string
  updatedAt?: string
}

CandidateCompanyJobEvaluation = {
  evaluationId: string                     // doc id; deterministic = `${candidateId}__${jobId}__${runId}`
  candidateId: string
  companyId: string
  jobId: string
  evaluationRunId: string
  rubricVersion: string
  generalRubricScore: number               // 0..1
  companyRubricScore: number               // 0..1
  jobRubricScore: number                   // 0..1
  hardGateResult: "pass" | "soft_block" | "hard_block"
  hardGateReasons: string[]
  softScore: number                        // weighted composite 0..1
  competitorAdjacency?: { matched: boolean; confidence: number; evidence?: string }
  industryAdjacency?: { sector: string; confidence: number }
  missingInfo: string[]
  risks: string[]
  evidence: MarketplaceEvidence[]
  explanation: string                      // 1-3 sentence operator-readable
  proposedTier: EvaluationTier
  reviewerDecision?: { finalTier: EvaluationTier; reviewer: string; reviewedAt: string; note?: string }
  createdAt: string
  updatedAt?: string
}

AgentResearchTask = {
  taskId: string                           // doc id
  evaluationRunId: string
  candidateIds: string[]
  promptVersion: string                    // e.g. "agent-prompt-2026-05-A"
  prompt: string                           // generated copy-paste-ready prompt
  expectedJsonSchemaVersion: string        // schema version the agent should produce
  reviewStatus: AgentResearchReviewStatus
  rawResult?: string                       // pasted-back raw text
  parsedFindings?: AgentResearchFinding[]
  parseErrors?: string[]
  reviewedBy?: string
  reviewedAt?: string
  createdAt: string
  updatedAt?: string
}

AgentResearchFinding = {
  findingId: string                        // uuid
  candidateId: string                      // pa-users uid (resolved or pending)
  recordId?: string                        // ExternalCandidateRecord ref if pre-resolution
  field: string                            // e.g. "currentCompany", "yearsExperience"
  value: unknown
  confidence: number                       // 0..1
  uncertainty?: string                     // freeform
  evidenceUrls: string[]
  approved: boolean
  approvedBy?: string
  approvedAt?: string
}

OutreachPlan = {
  planId: string                           // doc id (uuid)
  candidateId: string
  companyId: string
  jobId: string
  evaluationId: string                     // CandidateCompanyJobEvaluation ref
  tier: EvaluationTier
  channelDecision: OutreachChannel
  personalizedHook?: string
  whyThisRole?: string
  whyCompany?: string
  candidateSpecificSignal?: string
  emailSubject?: string
  emailBody?: string
  linkedinMessage?: string
  manualLinkedInTaskStatus?: "todo" | "sent" | "replied" | "skipped"
  manualLinkedInTaskAssignee?: string
  approvalStatus: OutreachApprovalStatus
  approvedBy?: string
  approvedAt?: string
  rejectionReason?: string
  suppressionGateResult: SuppressionGateResult
  evidence: MarketplaceEvidence[]
  createdAt: string
  updatedAt?: string
}

SuppressionGateResult = {
  allow: boolean
  blockedReasons: Array<
    | "opted_out"
    | "previously_bounced"
    | "invalid_email"
    | "cooldown"
    | "duplicate_company_role_recent"
    | "low_confidence_personalization"
  >
  cooldownUntil?: string
}

InstantlySyncRecord = {
  syncId: string                           // doc id (uuid)
  planId: string                           // OutreachPlan ref
  candidateId: string
  jobId: string
  companyId: string
  campaignId?: string                      // Instantly campaign
  listId?: string                          // Instantly list
  instantlyLeadId?: string
  syncStatus: InstantlySyncStatus
  mode: "dry_run" | "live"
  dryRunPayload?: Record<string, unknown>  // exact payload that would be sent
  liveSyncedAt?: string
  lastEventAt?: string
  error?: string
  createdAt: string
  updatedAt?: string
}

OutreachEvent = {
  eventId: string                          // doc id; deterministic from (provider, providerEventId)
  provider: "instantly" | "manual_linkedin" | "system"
  providerEventId?: string                 // for idempotency
  candidateId: string
  planId: string                           // OutreachPlan ref
  jobId: string
  companyId: string
  kind: OutreachEventKind
  payloadRedacted: Record<string, unknown>
  occurredAt: string
  recordedAt: string
}

SourceQualityMetric = {                    // optional / nice-to-have for V1
  metricId: string                         // doc id; deterministic `${source}__${yyyyMm}`
  source: ExternalSource
  windowStart: string
  windowEnd: string
  rowsIngested: number
  validRate: number
  duplicateRate: number
  identityConflictRate: number
  replyRate: number
  bounceRate: number
  conversionToFirstInterview: number
  createdAt: string
  updatedAt?: string
}
```

### 5.3 Extensions to existing schemas in `marketplace.ts`

| Schema | Extension |
|---|---|
| `MarketplaceEvidenceSchema.source` | Add `"external_sourcing"`, `"agent_research"`, `"instantly_delivery"`. |
| `CandidateHandleSourceSchema` | Add `"external_sourcing"`. |
| `IdentityConflictKindSchema` | Add `"linkedin_email_candidate_mismatch"`, `"external_fuzzy_match"`. |
| `IdentityEventTypeSchema` | Add `"external_source_linked"`, `"external_candidate_imported"`. |

Executor A owns these edits. They are additive only — no value removed.

### 5.4 Collection Constants

Executor A adds these to `PA_COLLECTIONS` in `packages/core-types/src/collections.ts`:

```ts
externalSourcingBatches: "pa-external-sourcing-batches",
externalCandidateRecords: "pa-external-candidate-records",
candidateSourceLinks: "pa-candidate-source-links",
candidateEvaluationRuns: "pa-candidate-evaluation-runs",
candidateCompanyJobEvaluations: "pa-candidate-company-job-evaluations",
agentResearchTasks: "pa-agent-research-tasks",
outreachPlans: "pa-outreach-plans",
instantlySyncRecords: "pa-instantly-sync-records",
outreachEvents: "pa-outreach-events",
sourceQualityMetrics: "pa-source-quality-metrics",
```

### 5.5 Doc Id Rules

| Collection | Doc id |
|---|---|
| `pa-external-sourcing-batches` | `crypto.randomUUID()` |
| `pa-external-candidate-records` | `crypto.randomUUID()` |
| `pa-candidate-source-links` | `crypto.randomUUID()` |
| `pa-candidate-evaluation-runs` | `crypto.randomUUID()` |
| `pa-candidate-company-job-evaluations` | `${candidateId}__${jobId}__${evaluationRunId}` (deterministic for idempotent re-write) |
| `pa-agent-research-tasks` | `crypto.randomUUID()` |
| `pa-outreach-plans` | `crypto.randomUUID()` |
| `pa-instantly-sync-records` | `crypto.randomUUID()` |
| `pa-outreach-events` | `${provider}__${providerEventId}` if provider event id is present; otherwise `crypto.randomUUID()`. |
| `pa-source-quality-metrics` | `${source}__${yyyyMm}` |
| `pa-candidate-handles` (LinkedIn) | unchanged: `linkedin__<sha256_hash>` |

## 6. UI Surface Map (Internal Admin Only)

Routes live on `wekruit-pa.web.app/admin/external-supply/...`. Reuse existing dashboard layout / nav / auth gate. No candidate-domain pages.

| Route | Purpose | Source of truth |
|---|---|---|
| `/admin/external-supply` | Landing — latest batches, summary metrics, quick-jump to active run | `pa-external-sourcing-batches` + `pa-source-quality-metrics` |
| `/admin/external-supply/batches/new` | Upload Juicebox / Lessie / Coresignal file, pick source adapter, optional companyId / jobId | callable: `paExternalSupplyCreateBatch` |
| `/admin/external-supply/batches/:batchId` | Batch detail — stats, per-row table, identity-resolution status, action menu (re-resolve, approve, reject, push to evaluation) | `pa-external-sourcing-batches/{batchId}` + child query `pa-external-candidate-records?batchId=:batchId` |
| `/admin/external-supply/review` | Needs-review queue (LinkedIn-vs-email conflicts, fuzzy matches, email-only, low-confidence) | query `identityResolutionStatus == needs_review` |
| `/admin/external-supply/evaluations` | Evaluation runs list + per-run detail | `pa-candidate-evaluation-runs` |
| `/admin/external-supply/evaluations/:runId` | Per-candidate Tier 1/2/3/retain-only/blocked table with hard-gate / risks / explanation; bulk re-tier; per-row edit | `pa-candidate-company-job-evaluations?evaluationRunId=:runId` |
| `/admin/external-supply/research` | Agent research workbench — generate prompt, copy, paste back result, parse, approve findings | `pa-agent-research-tasks` |
| `/admin/external-supply/outreach` | Outreach queue — per-plan view, suppression gates, edit copy, approve, send to Instantly, manual LinkedIn task assignment | `pa-outreach-plans` + `pa-instantly-sync-records` |
| `/admin/external-supply/sync` | Instantly sync status — per-record state, last event, error | `pa-instantly-sync-records` + `pa-outreach-events` |
| `/admin/external-supply/audit` | Source quality / audit / why-this-tier traceback | `pa-source-quality-metrics` + cross-collection joins |

States covered on every page: loading / empty / error / success / partial (e.g. parse error rows). Tables follow existing dashboard table component pattern (`apps/dashboard-web/src/components`).

## 7. Backend / API / Service Map

| Surface | New module | Purpose |
|---|---|---|
| Import | `apps/functions/src/external-supply/import.ts` + `apps/functions/src/external-supply/adapters/{juicebox,lessie,coresignal,manual-csv}.ts` | Parse upload, normalize, batch stats, write batch + record rows. |
| Normalize lib | `packages/external-supply/src/normalize.ts` | Pure functions: LinkedIn URL canonicalize (extends `normalizeCandidateHandleValue("linkedin",...)`), email normalize, phone normalize, dedup-within-batch. |
| Identity | `apps/functions/src/external-supply/resolve-identity.ts` + `packages/pa-persistence/src/external-supply-identity.ts` | Wraps `resolveCandidateIdentity` from existing identity layer; adds LinkedIn-first preference, fuzzy-match-to-conflict logic, source-link writer. |
| Profile upsert | `packages/pa-persistence/src/external-supply-upsert.ts` | Calls `mergeUserTags`; ensures stable-fact rules; writes audit `external_candidate_imported` event. |
| Evaluation | `packages/external-supply/src/rubric.ts` + `apps/functions/src/external-supply/evaluate.ts` | General + company + job rubric scoring; hard-gate / soft-score / tier proposal. |
| Agent research | `packages/external-supply/src/agent-prompt.ts` + `packages/external-supply/src/agent-parse.ts` + `apps/functions/src/external-supply/agent-task.ts` | Build prompt; parse pasted JSON; validate against schema; attach findings to evaluation. |
| Outreach decision | `packages/external-supply/src/outreach.ts` + `apps/functions/src/external-supply/outreach.ts` | Tier-to-channel mapping, suppression gates, copy generator (uses existing LLM provider). |
| Instantly client | `packages/external-supply/src/instantly-client.ts` + `apps/functions/src/external-supply/instantly-sync.ts` | API client (live + dry-run); webhook receiver. |
| Webhook | `apps/functions/src/external-supply/instantly-webhook.ts` | Receives Instantly events, writes `pa-outreach-events`, updates plan + sync record. |
| Callables | `apps/functions/src/external-supply/callables.ts` | Admin-only callables: createBatch, resolveBatch, approveProfile, runEvaluation, generateAgentPrompt, importAgentResult, approveOutreach, dryRunSync, liveSync. |
| Source quality | `apps/functions/src/external-supply/source-quality.ts` | Periodic / on-demand rollup of metrics. |

Auth: every callable requires `@wekruit.com` Google auth (reuse existing admin gate from `apps/functions/src/admin-bootstrap.ts`).

## 8. Executor Topology

Eight executors, disjoint write scopes.

| Executor | Write scope (exclusive) | Read-only |
|---|---|---|
| **A. Data Model + Contracts** | `packages/core-types/src/external-supply.ts` (new); additive edits to `packages/core-types/src/marketplace.ts` (only the 4 enum extensions in §5.3); additive edits to `packages/core-types/src/collections.ts`; new `packages/core-types/src/external-supply.test.ts`. **No UI, no business logic.** | `marketplace.ts`, `collections.ts`, `INITIATIVE`, `PLAN`. |
| **B. Import + Normalization** | `apps/functions/src/external-supply/import.ts`, `apps/functions/src/external-supply/adapters/*`, `packages/external-supply/src/normalize.ts`, `packages/external-supply/src/normalize.test.ts`. New package `packages/external-supply/` scaffold (`package.json`, `tsconfig.json`, `src/index.ts`). | A's contracts; existing `shared-tags/sha256` and `normalizeCandidateHandleValue`. |
| **C. Identity + pa-users Upsert** | `apps/functions/src/external-supply/resolve-identity.ts`, `packages/pa-persistence/src/external-supply-identity.ts`, `packages/pa-persistence/src/external-supply-upsert.ts`, tests for both. | A's contracts, `pa-persistence/src/identity.ts`, `core-types/marketplace.ts`. **Must not modify** `identity.ts` or `claim-api.ts`. |
| **D. Evaluation + Rubric Engine** | `packages/external-supply/src/rubric.ts`, `packages/external-supply/src/rubric.test.ts`, `apps/functions/src/external-supply/evaluate.ts`. | A's contracts, `shared-tags`, `pa-jobs` schema for company / job context. |
| **E. Agent Research + Prompt Contract** | `packages/external-supply/src/agent-prompt.ts`, `packages/external-supply/src/agent-parse.ts`, tests, `apps/functions/src/external-supply/agent-task.ts`. | A's contracts. |
| **F. Outreach + Instantly** | `packages/external-supply/src/outreach.ts`, `packages/external-supply/src/instantly-client.ts`, `apps/functions/src/external-supply/outreach.ts`, `apps/functions/src/external-supply/instantly-sync.ts`, `apps/functions/src/external-supply/instantly-webhook.ts`, tests. | A's contracts, `pa-jobs` for job context. Suppression gate reads `pa-users.outreach` and `pa-outreach-events`. |
| **G. Dashboard** | `apps/dashboard-web/src/pages/external-supply/*`, `apps/dashboard-web/src/lib/external-supply-client.ts`, `apps/dashboard-web/src/components/external-supply/*` (new). Additive nav link in `apps/dashboard-web/src/App.tsx`. | A's contracts, callable signatures. **Must use existing layout / theme / table components.** |
| **H. Verification / Eval** | `.planning/external-supply-v1/ACCEPTANCE.md`, `.planning/external-supply-v1/SUMMARY.md`, `tests/external-supply/*` (new), `tests/fixtures/external-supply/*` (new). Writes acceptance evidence into `.planning/external-supply-v1/artifacts/`. | Everything. |

**Shared file ownership rules**:
- `apps/functions/src/index.ts` is shared. Owner: F (registers Instantly webhook last). B and C and D and E add their callables in their own files; F appends the export list. To avoid merge conflicts, lead applies the final export list during integration.
- `apps/dashboard-web/src/App.tsx` shared. Owner: G (adds the single nav link + route block). All other executors do not touch.
- `pnpm-workspace.yaml` shared. Owner: A (adds `packages/external-supply` workspace entry during Wave A).

## 9. Agent Plan Handshake

Before code lands, every executor returns an `AGENT_PLAN` (no code) using the exact template in `.planning/AUTONOMOUS-SPRINT-HARNESS.md` §3 Phase 2. Plans are appended to `EXECUTOR-PLANS.md`. Lead writes an integration note here (§9.1) confirming scopes are disjoint before any executor implements.

### 9.1 Integration Note (filled 2026-05-13)

All 8 AGENT_PLANs collected in `EXECUTOR-PLANS.md`. Lead review:

1. **Write scopes disjoint?** Yes. Verified each executor edits only paths listed in PLAN §8. Cross-checks:
   - A owns `packages/core-types/src/external-supply.ts` + additive marketplace/collections edits.
   - B owns `packages/external-supply/` scaffold + `apps/functions/src/external-supply/import.ts` + adapters/.
   - C owns `packages/pa-persistence/src/external-supply-*.ts` + `apps/functions/src/external-supply/resolve-identity.ts`.
   - D owns `packages/external-supply/src/rubric.ts` + `apps/functions/src/external-supply/evaluate.ts`.
   - E owns `packages/external-supply/src/agent-{prompt,parse}.ts` + `apps/functions/src/external-supply/agent-task.ts`.
   - F owns `packages/external-supply/src/{outreach,instantly-client}.ts` + `apps/functions/src/external-supply/{outreach,instantly-sync,instantly-webhook,config}.ts`.
   - G owns `apps/dashboard-web/src/pages/external-supply/*` + `apps/dashboard-web/src/components/external-supply/*` + `apps/dashboard-web/src/lib/external-supply-client.ts`.
   - H owns `tests/external-supply/*` + `tests/fixtures/external-supply/*` + the planning artifact docs.

2. **Shared files sequenced behind one owner?** Yes.
   - `apps/functions/src/index.ts` → **F is final owner**. B, C, D, E, F each declare exported callable symbols in their own files. F appends the full export list during integration. The lead applies any remaining merge fix-up.
   - `apps/dashboard-web/src/App.tsx` → **G is sole owner** (additive nav + route block).
   - `packages/external-supply/src/index.ts` (barrel) → **B is owner** (scaffold). E + D + F add their exports through their own files; B's barrel re-exports the package's public API.
   - `pnpm-workspace.yaml` → no edit (existing `packages/*` glob).

3. **Data contracts consistent?** Yes, after the following inline tweaks to PLAN §5 (already applied):
   - Added `SuppressionBlockReasonSchema` to §5.1.
   - Added `meta?: Record<string, unknown>` to `ExternalSourcingBatch` in §5.2.
   - Relaxed `CandidateSourceLink.candidateId` to optional and added `status` + `pendingRecordId` in §5.2.
   - Added Wave B step for `paExternalSupplyCreateBatchUploadUrl` + `paExternalSupplyCreateBatch` callable (§11 Wave B B5).
   - Added F's `paExternalSupplyGetConfig` callable (§11 Wave C F3.5).

4. **Every backend primitive has UI visibility or operator debug state?** Yes. Mapping (collection → page):
   - `pa-external-sourcing-batches` → `/admin/external-supply` + `/admin/external-supply/batches/:batchId`
   - `pa-external-candidate-records` → batch-detail row table + `/admin/external-supply/review`
   - `pa-candidate-source-links` → batch-detail row drawer (audit tab)
   - `pa-candidate-evaluation-runs` → `/admin/external-supply/evaluations`
   - `pa-candidate-company-job-evaluations` → `/admin/external-supply/evaluations/:runId`
   - `pa-agent-research-tasks` → `/admin/external-supply/research`
   - `pa-outreach-plans` → `/admin/external-supply/outreach`
   - `pa-instantly-sync-records` → `/admin/external-supply/sync`
   - `pa-outreach-events` → sync detail row + audit page
   - `pa-source-quality-metrics` → landing page summary cards + `/admin/external-supply/audit`

5. **Every LLM behavior has eval or trace coverage?** Yes.
   - F's copy generator logs prompt + response (redacted) to `pa-tool-calls` (existing trace channel).
   - E's agent prompt has a golden fixture; parser tests include malformed-JSON rejection.
   - F's LLM fallback to deterministic template tested explicitly.
   - D's rubric is pure / deterministic — no LLM in V1.
   - H's E2E uses mocked LLM that asserts shape only.

6. **Every HITL edit produces a correction/flywheel event?** Yes.
   - Operator tier override in `/admin/external-supply/evaluations/:runId` → `pa-correction-events` with `targetType="candidate_company_job_evaluation"`.
   - Outreach copy edit + reject + tier-override in `/admin/external-supply/outreach` → `pa-correction-events` with `targetType="outreach_plan"` (new target type — A extends `CorrectionEventSchema.targetType` enum **only if** needed; otherwise piggy-back on `feedback_event`). **Resolution:** keep existing `targetType` set; correction events for outreach plans use `targetType="feedback_event"` with `payloadRedacted.planId`. No A change.
   - Identity-conflict resolution in `/admin/external-supply/review` → existing `merge_decision_recorded` event in `pa-candidate-identity-events` (no new schema).
   - Reply / bounce / unsubscribe webhook → `pa-feedback-events` (existing flywheel).
   - Agent finding approval → not a correction event itself; only operator tier override after approval is one.

7. **Any executor plan violates product invariants?** No. Verified each plan against PLAN §4:
   - LinkedIn auto-send: F explicitly disabled, manual tasks only. ✓
   - Candidate-domain bleed: G explicit zero `apps/pa-landing` imports; verified. ✓
   - Raw PII as doc id: A's doc-id rules + B's normalize + C's source-link all uuid/hash. ✓
   - Match score blocks first interview: D's `proposeTier` never emits "do not interview"; `retain_only`/`blocked` only suppress outreach intensity. ✓
   - `pa-users` weaker-fact overwrite: C uses `mergeUserTags` weak-only with default confidence 0.4. ✓
   - Live Instantly without flag: F hard-gates with env + secret. ✓
   - Two LinkedIn canonicalizers: B is the only TS canonicalizer; Python port deferred. ✓

8. **Wave order:** `A → (B || C) → (D || E || F) → G → H`. Implementation may begin at Wave A. H may begin fixture authoring immediately after A's commit (read-only on schemas).

**Approved. Implementation begins.**

## 10. Milestones

Each milestone is an independently verifiable slice:

1. **M1 — Contracts locked**: `packages/core-types/src/external-supply.ts` lands with passing Zod parse tests for every record type + collection constants + 4 marketplace enum extensions. (Wave A end.)
2. **M2 — Batch + normalize**: Operator can upload a fixture file via callable; batch row + N records appear with normalized LinkedIn / email / phone hashes. (Wave B end.)
3. **M3 — Identity resolution**: Each record gets a deterministic `identityResolutionStatus`. New `pa-candidate-handles` (linkedin) + `pa-candidate-source-links` written. Conflicts land in `pa-candidate-identity-conflicts` with `linkedin_email_candidate_mismatch` or `external_fuzzy_match`. (Wave B end.)
4. **M4 — Profile upsert**: `pa-users` profiles get LinkedIn URL onto the profile + source link + tags via `mergeUserTags` with stable-fact protection. Audit `external_candidate_imported` event lands. (Wave B end.)
5. **M5 — Evaluation runs**: Operator picks company + job, runs evaluation, gets per-candidate Tier 1/2/3/retain-only/blocked with hard-gate / risks / explanation. (Wave C end.)
6. **M6 — Agent research**: Operator can generate copy-paste prompt, paste back result, parse + attach to evaluation. (Wave C end.)
7. **M7 — Outreach decisioning**: Plans appear with personalized copy + suppression gate verdict. (Wave C end.)
8. **M8 — Instantly dry-run + live**: Approved plan syncs dry-run payload first, then live mode behind config flag, lands `instantlyLeadId`. (Wave C end.)
9. **M9 — Webhook + events**: Instantly events post back to `pa-outreach-events`, plans and sync records update accordingly. (Wave C end.)
10. **M10 — Dashboard end-to-end**: All routes wired to real callables. Operator can walk import → resolve → evaluate → research → outreach → sync → outcome without terminal-only steps. (Wave D end.)
11. **M11 — Acceptance harness**: 100+ candidate fixture passes acceptance ledger; SUMMARY.md filled. (Wave E end.)

## 11. Concrete Steps Per Wave

### Wave A — Contracts (Executor A)

A1. **Skip** — `pnpm-workspace.yaml` already globs `packages/*`, no edit needed (confirmed by A's plan).
A2. Create `packages/core-types/src/external-supply.ts` exporting every Zod schema + type listed in §5, including `SuppressionBlockReasonSchema` (added per resolution).
A3. Extend the 4 marketplace enums (§5.3). Pure additive — append new values to the end.
A4. Update `packages/core-types/src/collections.ts` with §5.4 entries.
A5. Re-export new public types from `packages/core-types/src/index.ts`.
A6. Add `packages/core-types/src/external-supply.test.ts` — Zod `parse` round-trip for every schema + `safeParse` failure cases for required fields.
A7. Run `pnpm --filter @pa/core-types test`. Expect: all new tests green + existing `marketplace.test.ts` still green.
A8. Commit `feat(external-supply): lock core-types contracts`. Push the branch.

### Wave B — Import + Identity + Upsert (Executors B + C, parallel)

#### B (Import + Normalization)

B1. Scaffold `packages/external-supply/` (package.json, tsconfig.json extending repo base, src/index.ts barrel).
B2. Implement `packages/external-supply/src/normalize.ts`:
   - `canonicalizeLinkedInUrl(raw: string): string | null` — lowercases host, strips query string + trailing slash + locale prefix `/{cc}/in/...`, requires `linkedin.com/in/...` shape, returns null if invalid.
   - `linkedinHash(canonical: string): string` — `sha256(candidateHandleHashMaterial("linkedin", canonical))`.
   - `normalizeEmail(raw: string): string | null` — RFC-5322 light validation + lowercase.
   - `emailHash(normalized: string)`.
   - `normalizePhoneE164(raw: string)`.
   - `dedupeWithinBatch(records, by: 'linkedin' | 'email')`.
B3. Tests covering every helper with edge cases (uppercase, query strings, locale prefixes, trailing slashes, invalid shapes).
B4. Implement source adapters in `apps/functions/src/external-supply/adapters/*.ts`:
   - `juicebox.ts` — map Juicebox CSV/XLSX/JSON columns.
   - `lessie.ts` — Lessie equivalent.
   - `coresignal.ts` — Coresignal JSON shape.
   - `manual-csv.ts` — operator-defined column mapping.
   - Each adapter returns `Array<Omit<ExternalCandidateRecord, "recordId" | "batchId" | "createdAt">>`.
B5. Implement `apps/functions/src/external-supply/import.ts`:
   - `paExternalSupplyCreateBatchUploadUrl({ sha256, mime, sizeBytes, source })` callable → returns Firebase Storage signed PUT URL + intended `storageUri`. Idempotent on (sha256).
   - `paExternalSupplyCreateBatch({ source, storageUri, sha256, companyId?, jobId?, columnMapping? })` callable → fetches file from Storage, runs adapter, normalizes, dedups, writes batch + records, computes stats, sets `status: "normalized"`. Persists `{ adapterVersion, columnMapping, rawHeaderSample }` to `batch.meta`. Idempotent on `sha256`.
B6. Tests: parser tests per adapter using small fixture files; one end-to-end test that drives `createBatch` against in-memory Firestore.
B7. Run `pnpm --filter functions test --testPathPattern external-supply` green.
B8. Commit `feat(external-supply): batch import + normalize`.

#### C (Identity + Upsert)

C1. Implement `packages/pa-persistence/src/external-supply-identity.ts`:
   - `resolveExternalSupplyIdentity(db, record)` — given an `ExternalCandidateRecord`, attempt LinkedIn-hash lookup first, then email-hash lookup, then return `create_new` / `merge_existing` / `needs_review` / `blocked` with conflict id when applicable. Internally calls `resolveCandidateIdentity` but adds:
     - LinkedIn auto-merge path.
     - Email-only → always `needs_review` in V1.
     - LinkedIn-vs-email candidate mismatch → write `pa-candidate-identity-conflicts` doc with kind `linkedin_email_candidate_mismatch` and return `needs_review`.
     - Fuzzy name + company hit (when no canonical handles) → write conflict kind `external_fuzzy_match`, return `needs_review`.
C2. Implement `packages/pa-persistence/src/external-supply-upsert.ts`:
   - `upsertCandidateFromExternalRecord(db, { record, resolution, operatorUid })`:
     - If `create_new`: create `pa-users/{uid}` with prospect state via existing `resolveCandidateIdentity` pathway, then add LinkedIn handle, then write source-link, then `mergeUserTags` (no stronger-existing-fact override), then write identity event `external_candidate_imported`.
     - If `merge_existing`: skip create, just add LinkedIn handle if not already linked, write source-link, run `mergeUserTags` with weak-only semantics, write identity event `external_source_linked`.
     - If `needs_review` or `blocked`: write source-link in a "pending" state (no candidateId), no profile mutation.
   - Returns `CandidateProfileUpsertResult = { recordId; status: "created"|"merged"|"pending_review"|"blocked"; candidateId?; sourceLinkId; auditEventId? }`.
C3. Wrap C1+C2 in an Admin callable `apps/functions/src/external-supply/resolve-identity.ts → resolveBatchIdentity(batchId)` which iterates records, writes resolution status, decrements/increments batch stats.
C4. Tests: identity resolver unit tests (canonical LinkedIn hit, email-only -> review, LinkedIn-email mismatch, fuzzy-only, blocked), upsert tests verifying no-overwrite-stronger-fact and audit event.
C5. Run `pnpm --filter @pa/pa-persistence test` + `pnpm --filter functions test --testPathPattern external-supply` green.
C6. Commit `feat(external-supply): identity resolution + pa-users upsert`.

### Wave C — Evaluation + Agent Research + Outreach + Instantly (Executors D + E + F, parallel)

#### D (Evaluation)

D1. Implement `packages/external-supply/src/rubric.ts`:
   - `evaluateGeneralRubric(profile, record)` — global hireability / signal quality / data completeness 0..1.
   - `evaluateCompanyRubric(profile, record, company)` — adjacency to company industry / stage / past-employee competitor / school match.
   - `evaluateJobRubric(profile, record, job)` — role-function / skills / location / seniority / visa / salary fit, hard gates per JOB-DATA-CONTRACT.md.
   - `proposeTier(scores, gates)` — explicit mapping rules from score buckets to `EvaluationTier`.
D2. Implement `apps/functions/src/external-supply/evaluate.ts` callable: takes `{ runId | { batchId, companyId, jobId, rubricVersion } }`, iterates candidates, writes evaluation docs deterministically (idempotent by composite doc id).
D3. Tests covering each rubric helper + the tier-proposal mapping + idempotency of re-running an evaluation.
D4. Commit `feat(external-supply): rubric engine + evaluation runs`.

#### E (Agent Research)

E1. Implement `packages/external-supply/src/agent-prompt.ts`:
   - `buildAgentResearchPrompt(candidates, missingInfo, companyJobContext)` — produces a copy-pasteable ChatGPT Agent Mode prompt that demands JSON output matching `agentResearchResultSchemaVersion`. Must request evidence URLs + confidence + uncertainty per finding.
E2. Implement `packages/external-supply/src/agent-parse.ts`:
   - `parseAgentResearchResult(raw)` — defensive JSON extraction, runs Zod validation, returns `parsedFindings[]` or `parseErrors[]`.
E3. Implement `apps/functions/src/external-supply/agent-task.ts` callables: `generateAgentResearchPrompt(...)`, `importAgentResearchResult(...)`, `approveAgentResearchFinding(...)`.
E4. Tests: round-trip prompt → schema-conformant fake result → parse; multi-candidate aggregation; reject malformed JSON.
E5. Commit `feat(external-supply): agent research prompt + import flow`.

#### F (Outreach + Instantly)

F1. Implement `packages/external-supply/src/outreach.ts`:
   - `decideOutreach(profile, evaluation, suppressionContext)` → `OutreachPlan` draft. Maps tier → channel:
     - tier_1 → personal_linkedin + personal_email
     - tier_2 → personal_email
     - tier_3 → general_email
     - retain_only → no_outreach
     - blocked → no_outreach with `blockedReasons`
   - Suppression gates: opt-out, bounced before, invalid email, cooldown, duplicate company/role within cooldown.
   - Copy generator: invokes existing LLM provider in `packages/agent-runtime` for `personalizedHook` / `whyThisRole` / `whyCompany` / `emailSubject` / `emailBody` / `linkedinMessage`. Each call has a fallback deterministic template.
F2. Implement `packages/external-supply/src/instantly-client.ts`:
   - Thin HTTP client. Methods: `addLeadToList`, `listCampaigns`, `getLead`, `markUnsubscribed`. Auth: `INSTANTLY_API_KEY` env. Dry-run mode returns the would-be request body without calling network.
F3. Implement `apps/functions/src/external-supply/instantly-sync.ts` callable: takes `planId`, dry-run or live mode flag, writes `pa-instantly-sync-records`, calls client, updates plan approval status. Re-evaluate suppression at callable entry (defense in depth). Live mode requires `EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED=true` AND `INSTANTLY_API_KEY` set; otherwise force dry-run.

F3.5. Implement `apps/functions/src/external-supply/config.ts` callable `paExternalSupplyGetConfig` that returns `{ liveOutreachEnabled: boolean; instantlyConfigured: boolean }` for the dashboard live-sync gate.
F4. Implement `apps/functions/src/external-supply/instantly-webhook.ts` HTTP function: receives reply / bounce / unsubscribe / open / click events, idempotent write by `(provider, providerEventId)`, updates plan + sync record + emits `pa-feedback-events` so v1.9 candidate state can react.
F5. Tests: tier→channel mapping, suppression-gate decision matrix, Instantly dry-run payload golden test, webhook idempotency.
F6. Commit `feat(external-supply): outreach decisioning + instantly sync + webhook`.

### Wave D — Dashboard (Executor G)

G1. Add nav link + route block in `apps/dashboard-web/src/App.tsx` for `/admin/external-supply/*`.
G2. Implement `apps/dashboard-web/src/lib/external-supply-client.ts` — thin callable wrappers (typed against A's exports).
G3. Implement each page from §6 in `apps/dashboard-web/src/pages/external-supply/*` using existing dashboard component library + theme.
G4. Reusable components in `apps/dashboard-web/src/components/external-supply/`: BatchTable, RecordRow, IdentityStatusBadge, EvaluationTierBadge, OutreachCopyEditor, InstantlySyncStateChip.
G5. Loading / empty / error / partial states implemented per route.
G6. Add a basic vitest component test for the BatchTable + IdentityStatusBadge.
G7. Run dashboard locally (`pnpm --filter dashboard-web dev`) with seeded fixture data and screenshot key routes into `.planning/external-supply-v1/artifacts/`.
G8. Commit `feat(external-supply): admin dashboard surfaces`.

### Wave E — Acceptance (Executor H)

H1. Build a 100+ candidate fixture combining Juicebox / Lessie / Coresignal sample rows: ~50 LinkedIn-only, ~20 LinkedIn+email matching existing pa-users, ~10 email-only, ~10 LinkedIn+email mismatch (review), ~10 fuzzy-only (review).
H2. Add `tests/external-supply/end-to-end.test.ts` that runs the full pipeline against in-memory Firestore + mocked LLM / Instantly client and asserts:
   - row counts per identity status
   - profile create / merge counts
   - tier breakdown
   - dry-run Instantly payload shape
   - opt-out / bounce gate behavior
H3. Run `pnpm --filter pa-orchestrator test`, `pnpm --filter functions test`, `pnpm --filter @pa/core-types test`, `pnpm --filter @pa/pa-persistence test`, repo-wide `pnpm -r build`, and a focused dashboard vite build.
H4. Capture stdout/stderr into `.planning/external-supply-v1/artifacts/`.
H5. Fill `ACCEPTANCE.md` ledger with pass/fail per check.
H6. Fill `SUMMARY.md` with outcome, files changed, commands run, gaps, next-sprint trigger.
H7. Commit `docs(external-supply): acceptance evidence + summary`.

## 12. Verification Harness

Each Wave commits with green tests on its package(s). Final Wave E:

| Check | Command | Expected |
|---|---|---|
| core-types tests | `pnpm --filter @pa/core-types test` | all green incl. new external-supply.test.ts |
| pa-persistence tests | `pnpm --filter @pa/pa-persistence test` | all green incl. external-supply-identity + upsert |
| external-supply pkg tests | `pnpm --filter @pa/external-supply test` | all green |
| functions tests | `pnpm --filter functions test` | all green incl. external-supply/* |
| dashboard build | `pnpm --filter dashboard-web build` | success |
| repo build | `pnpm -r build` | success |
| v1.9 regression (lightweight) | `pnpm --filter pa-orchestrator test` | all green |
| Fixture E2E | `pnpm --filter functions test -- end-to-end` | 100 candidates: deterministic per-row status; dry-run payload golden; webhook idempotent |
| Dashboard manual | Visit each route in `apps/dashboard-web` dev server | All routes render; no terminal-only step |

Hard fails (cause sprint to halt and flag Adam):

- Candidate route reaches candidate domain.
- LinkedIn auto-sending implemented.
- Live Instantly sync sent without explicit env flag.
- Raw PII used as Firestore doc id.
- `pa-users` overwritten with weaker external fact.

## 13. HITL And Flywheel

- Every identity conflict creates a `pa-candidate-identity-conflicts` row that the dashboard surfaces in `/admin/external-supply/review`. Operator decisions write an `IdentityEvent` `merge_decision_recorded` (existing).
- Every operator tier override writes `pa-correction-events` with `targetType: "candidate_company_job_evaluation"` and before/after redacted snapshots — re-using existing schema.
- Agent research approvals write evidence onto evaluation records and create `pa-correction-events` if findings change tier.
- Outreach copy edits + tier overrides + reject decisions write `pa-correction-events`.
- Reply / bounce / unsubscribe events write `pa-outreach-events` AND `pa-feedback-events` so the existing flywheel + future scoring calibration picks them up.

## 14. Safety And Privacy

- Raw LinkedIn URL / email / phone never used as Firestore doc id. Hash-derived ids only.
- Raw payload preserved on `pa-external-candidate-records.rawPayload` but redacted in dashboard renders (mask emails + phones).
- All admin callables require `@wekruit.com` auth via existing `admin-bootstrap`.
- Live Instantly sync requires `INSTANTLY_API_KEY` Firebase secret + `EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED=true` env to be active. Default config = dry-run only.
- Cooldown / opt-out / bounce gates run before every live sync request — checked at callable entry, not just at copy generation.
- LLM copy generation logs prompt + response (redacted) to existing `pa-tool-calls` for audit.
- Webhook signature verification (Instantly HMAC if available) before writing events.

## 15. Idempotence And Recovery

- `pa-candidate-company-job-evaluations` doc id is composite (`candidateId__jobId__runId`) — re-running an evaluation overwrites cleanly.
- `pa-outreach-events` doc id is composite (`provider__providerEventId`) — webhook redelivery is idempotent.
- `pa-instantly-sync-records` track `syncStatus`; retry creates a new record but plan only references latest.
- Failed batch import leaves batch in `failed` state; operator can re-upload (new `batchId`).
- Profile upsert is safe to retry: LinkedIn handle write is upsert-by-doc-id, source-link insert checks for existing `(recordId, candidateId)` and de-dupes.
- Lifecycle / candidate state transitions go through existing reducers; no direct field writes.

## 16. Progress

- [x] 2026-05-13 — Worktree + branch created from `origin/main`.
- [x] 2026-05-13 — Initiative + goal docs copied into worktree.
- [x] 2026-05-13 — CONTEXT.md written.
- [x] 2026-05-13 — PLAN.md written.
- [x] 2026-05-13 — EXECUTOR-PLANS.md skeleton in place.
- [x] 2026-05-13 — AGENT_PLANs collected from all 8 executors.
- [x] 2026-05-13 — Integration note filled in §9.1; lead resolutions captured in EXECUTOR-PLANS.md.
- [x] 2026-05-13 — Wave A green (commits `7302587`, `8816ecc`, `ad75bcc`).
- [x] 2026-05-13 — Waves B + C green (`9dc30b7`, `5627019`, `b07b10a`, `02c158b`, `a74a5f1`).
- [x] 2026-05-13 — Wave D green (`feb3d94`).
- [x] 2026-05-13 — Wave E green; acceptance ledger filled (`8866501`); 23 pass / 1 known-gap (manual dashboard click-through deferred to post-deploy smoke).
- [x] 2026-05-13 — Lead final integration: `apps/functions/src/index.ts` re-exports all 15 external-supply callables + Instantly webhook.

## 17. Decision Log

- **2026-05-13 — Reuse `pa-candidate-handles` for LinkedIn hash index.** Rationale: S2 shipped that collection with `linkedin` kind. Building a parallel `pa-candidate-identity-index` would duplicate the resolver and risk drift. Author: lead.
- **2026-05-13 — Email-only rows always `needs_review` in V1.** Rationale: initiative + Adam directive locked. Author: lead.
- **2026-05-13 — Keep Instantly outreach separate from `pa-outbound-invites`.** Rationale: invites flow is Sendblue/iMessage for retained candidates; Instantly is cold email for external-supply candidates. Separate collections keep mental model clean and avoid coupling. Author: lead.
- **2026-05-13 — Resume parsing deferred for V1.** Rationale: Juicebox / Lessie / Coresignal already ship structured fields; resume PDF parse pipeline is heavy. Defer to V2 if a source ever surfaces raw PDFs. Author: lead.
- **2026-05-13 — Build `packages/external-supply/` workspace package.** Rationale: rubric + outreach + Instantly + agent-prompt are pure-ish libs reused by callable + tests + future scripts. Author: lead.

## 18. Surprises And Discoveries

- _2026-05-13_: Discovered `pa-candidate-handles.kind = "linkedin"` already exists in the S2 schema. Originally the initiative spec mentioned a new `pa-candidate-identity-index` collection — we collapse it onto the existing handles collection. Evidence: `packages/core-types/src/marketplace.ts:74-83`.

## 19. Outcomes And Retrospective

To be filled in `SUMMARY.md` at Wave E. Includes: final test counts, files changed, commits landed, remaining risks, next sprint trigger (likely: Instantly live credentials, source-quality dashboard graphs, agent research auto-fetch).

