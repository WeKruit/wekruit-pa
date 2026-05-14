# `/goal` prompt — External Candidate Supply V2 (Agent-Ranked Multi-Source Pipeline)

> Copy-paste this entire block into a fresh `/goal` session (or a /loop
> dynamic-mode session) to hand the next milestone to a single-point
> lead agent. Self-contained. Loads its own sources of truth.

---

You are the single-point lead agent for **WeKruit External Candidate Supply V2: Agent-Ranked Multi-Source Pipeline**.

## North-star vision (long-term)

WeKruit is a multi-company candidate activation network. The durable asset is the candidate; jobs are demand events. External-candidate intake must keep delivering global supply growth at a 10× scale beyond V1:

1. Recruiting ops drags a CSV / XLSX / JSON onto the admin dashboard. The adapter is auto-detected (Juicebox / Lessie / Coresignal / a new source).
2. A preview pane shows: row count, identity-resolution forecast (LinkedIn-only / merge / review / blocked), tag-enrichment forecast, and an estimated tier breakdown — BEFORE the operator commits.
3. On commit, the pipeline runs: normalize → identity-resolve → `pa-users` upsert → tag enrichment (via `mergeUserTags` legacy surface + `globalTags` v2 surface) → company/job rubric evaluation → per-candidate "agent ranking pack" assembly.
4. The ranking pack — unified candidate profile + canonical tags + rubric output + missing-info hints + competitor / industry signal — is fed to an LLM agent (or multiple agents in ensemble) for natural-language ranking. The agent returns a tier proposal + rationale + risks + recommended next action per candidate. The operator approves or overrides; HITL writes correction events into the flywheel.
5. Approved candidates flow into outreach (Mailgun + manual LinkedIn task per V1.1) and reply / bounce / opt-out outcomes feed back into the candidate's global profile so the NEXT job for the same candidate uses better priors.

This is one continuous flywheel: every batch teaches the rubric weights, the agent prompt, and the source-quality metrics; every reply / bounce / interview outcome teaches matching for future jobs.

## Already shipped (do NOT re-litigate)

- **V1** (PR #29 + #31, merged 2026-05-13): `pa-external-sourcing-batches` + `pa-external-candidate-records` + `pa-candidate-source-links` + `pa-candidate-evaluation-runs` + `pa-candidate-company-job-evaluations` + `pa-agent-research-tasks` + `pa-outreach-plans` + `pa-instantly-sync-records` + `pa-outreach-events` + `pa-source-quality-metrics` collections. 15 admin callables + 1 Instantly webhook deployed. 10 admin routes under `wekruit-pa.web.app/admin/external-supply/**`. Adapters for Juicebox / Lessie / Coresignal / manual-CSV. Identity resolution LinkedIn-first against `pa-candidate-handles`. Deterministic D-rubric (general / company / job) with tier proposal (`tier_1` / `tier_2` / `tier_3` / `retain_only` / `blocked`).
- **V1 audit fixes** (PR #34, merged 2026-05-13): E2E runner works from repo root, `createOutreachEventId` hashes `providerEventId`, `mergeUserTags` bridge wired so `pa-users.tags` is populated (v1.6 matching pipeline can see external prospects), live prod smoke evidence captured.
- **V1.1 Mailgun swap** (PR #35): Mailgun is the active email-delivery channel via existing `sendMailgun` transport. Instantly path preserved for emergency switch. `paExternalSupplyGetConfig` returns `{ defaultEmailProvider: "mailgun", mailgunConfigured, instantlyConfigured, liveOutreachEnabled }`.
- **Competitor flow locked**: `company.competitorCompanies[]` is surfaced per-evaluation by Executor E's ChatGPT Agent Mode flow, NOT a maintained `pa-companies` field.

Read the actual source-of-truth files for full detail before deciding scope:
- `README.md` (Product Blueprint: Candidate Retention Marketplace)
- `CLAUDE.md` (deploy authority + v1.6 design lock + v2.0 product lock)
- `AGENTS.md`
- `.planning/MILESTONE-v2.0-candidate-retention-marketplace.md`
- `.planning/AUTONOMOUS-SPRINT-HARNESS.md` (lead-process contract)
- `.planning/INITIATIVE-external-candidate-supply-intake.md` (V1 spec — read for invariants)
- `.planning/external-supply-v1/PLAN.md` (V1 contract definitions you extend)
- `.planning/external-supply-v1/SUMMARY.md` (V1 ship state)
- `.planning/external-supply-v1/DASHBOARD-CLICK-THROUGH-PROMPT.md` (V1 dashboard verification)

## Non-negotiable rules (inherited from V1 — apply to V2)

1. Candidate is the durable global asset. Company/job is demand context.
2. External candidates share the SAME `pa-users` collection. No parallel candidate DB.
3. LinkedIn URL is the primary external source identity handle. Email is secondary.
4. Email-only rows MUST NOT auto-create profiles. They route to review.
5. Raw LinkedIn URL / email / phone NEVER used as Firestore doc id (use `createCandidateHandleId` / `createOutreachEventId` sha256 helpers).
6. LinkedIn sending is manual in V1+V2 — generate copy/tasks only, never automate.
7. Tags written through `mergeUserTags` for `pa-users.tags` (legacy v1.6 matching surface) AND `mergeWeakGlobalTags` for `pa-users.globalTags` (v2.0 marketplace surface). Weak-merge only — never overwrite stronger existing facts.
8. Opt-out / bounce / cooldown / duplicate suppression gates run before every Mailgun sync.
9. Match score / tier never blocks first interview — Claire interviews regardless once a candidate enters a job flow.
10. Dashboard is internal-only at `wekruit-pa.web.app/admin/**`. Never on `candidate.wekruit.com` / `pa.wekruit.com`.
11. Every tag/fact written to `pa-users` carries source / confidence / evidence / version.
12. State transitions go through deterministic reducers. LLM may extract / judge / compose only.
13. v1.9 candidate journey + V1 external-supply pipeline must remain green after V2 lands.

## V2 scope (what THIS milestone adds)

### A. Dashboard CSV/XLSX upload UX

- Drag-drop file onto `/admin/external-supply/batches/new` instead of file-picker chrome.
- Auto-detect adapter (juicebox / lessie / coresignal / manual_csv) from column headers + first-row sniff. Operator can override the auto-detect in a single click.
- Inline preview pane (BEFORE commit):
  - Row count + per-source-shape sniffed confidence.
  - Per-row identity-resolution forecast (run `resolveExternalSupplyIdentity` in dry-mode against pa-candidate-handles index, do NOT write).
  - Tag-enrichment forecast: which fields `mergeUserTags` would fill on each candidate (skills / industryEnum / recentRoleTitle / etc.) and which existing strong-evidence fields would be preserved.
  - Estimated tier distribution if the operator immediately ran evaluation against a chosen company/job.
- Commit button triggers the existing `paExternalSupplyCreateBatchUploadUrl` → `paExternalSupplyCreateBatch` callable chain. Preview must not pollute prod data — it's a server-side dry-run that reads `pa-candidate-handles` + `pa-users` but never writes.

### B. Multi-source extensibility

- Promote source adapters to a registry: `apps/functions/src/external-supply/adapters/registry.ts` exports `{ [sourceKey]: AdapterDescriptor }`. New sources land by adding an adapter file + a registry entry; no callable changes needed.
- Adapter detection heuristic: scan first 50 rows + column-header normalization → confidence score per adapter → top scorer wins (operator can override). Heuristic config lives in `packages/external-supply/src/adapter-detect.ts`.
- New `ExternalSourceSchema` enum values are ADDITIVE (locked under the v1.6 "no abbreviations" rule — full snake_case tokens).

### C. Agent ranking layer

- New `apps/functions/src/external-supply/agent-rank.ts` callable `paExternalSupplyRunAgentRanking({ evaluationRunId, model?, ensembleSize? })`. Reads:
  - `pa-candidate-company-job-evaluations` rows for the run.
  - The unified candidate (`pa-users/{id}` + `pa-candidate-handles` + `pa-resume-artifacts` if present).
  - Approved `pa-agent-research-tasks` findings.
  - The deterministic D-rubric output already on the evaluation row.
- Composes a per-candidate "ranking pack" prompt (similar shape to E's research prompt but ASK is: rank + justify + flag risks). Sends to LLM via existing `packages/agent-runtime` provider chain. Default model = `gpt-5.4-nano` (cheap pass) with optional `claude-sonnet-4-6` ensemble (per CLAUDE.md LLM chain D7 / D9).
- Stores ranking output in a new `pa-agent-ranking-results` collection alongside the evaluation row:
  - `proposedAgentTier`, `agentRationale` (operator-readable), `agentRisks[]`, `agentRecommendedAction` (`outreach_now` / `outreach_after_research` / `retain_warm` / `do_not_contact`), `modelUsed`, `tokensUsed`, `createdAt`.
- Operator may approve / override the agent tier in the dashboard. Override writes a `pa-correction-events` row with `targetType: "agent_ranking_result"` (extend `CorrectionEventSchema.targetType` enum additively).
- Cost cap: per-batch budget cap env var `EXTERNAL_SUPPLY_AGENT_RANKING_BUDGET_USD_PER_BATCH=10`. Tracked via `pa-tool-calls` cost ledger (existing v1.6 infra).
- Dry-run mode: returns the prompts + token estimates without calling LLM. Operator picks dry-run / live in the dashboard.

### D. Dashboard surfaces

- New page `/admin/external-supply/batches/new` — drag-drop + preview + commit (replaces existing simple form).
- New section `/admin/external-supply/evaluations/:runId/agent-ranking` — per-candidate agent-ranking table with `proposedAgentTier` + `agentRationale` + ensemble columns when ensemble enabled + operator approve/override controls.
- Extend `/admin/external-supply/audit` "Why this tier?" trace to include the agent-ranking step in the chain.
- Bulk-select + bulk-approve agent-tier overrides on the evaluation detail page so an operator can fast-path a 100-row batch.

### E. Flywheel & eval

- Every operator override writes correction event (existing pattern) that becomes a regression case for the agent-ranking prompt.
- Weekly QA evaluator (`pa-orchestrator paQaEvaluatorWeekly`) extended to sample 50 agent-ranked candidates and score the operator-override rate — if >15% rate, gate prompt promotion to the next milestone.
- `pa-source-quality-metrics` extended with `agentTierAcceptanceRate` per source per month.

## Out-of-scope for V2 (Adam expansion required)

- Live LinkedIn automation.
- Employer-visible external-supply pages.
- Scheduled / automatic batch imports (still operator-triggered).
- Mailgun inbound routing for reply detection (separate Mailgun feature; ship in V3 if Adam approves).
- Cross-repo Python adapter ports.

## Lead process (per AUTONOMOUS-SPRINT-HARNESS.md)

1. Read all sources of truth listed above.
2. Branch from updated `main`:
   ```bash
   git fetch origin
   git worktree add .claude/worktrees/v2-external-supply-v2 -b codex/v2-external-supply-v2 origin/main
   cd .claude/worktrees/v2-external-supply-v2
   ```
3. Create `.planning/external-supply-v2/` with:
   - `CONTEXT.md` (current state + reuse map vs V1 primitives)
   - `PLAN.md` (full sprint plan, wave breakdown, executor topology)
   - `EXECUTOR-PLANS.md` (AGENT_PLAN per executor)
   - `ACCEPTANCE.md` (pass/fail ledger)
   - `SUMMARY.md` (final report skeleton)
4. Dispatch executors for `AGENT_PLAN` only — no code until lead integration note lands.
5. Lock Data Model + Contracts first (Executor A). Other executors run in parallel against locked contracts.
6. Wave order:
   - **Wave A**: schema + adapter registry contract + `AgentRankingResult` Zod schema + collection consts
   - **Wave B**: adapter registry + adapter-detect + dashboard CSV preview server (parallel: registry / detect / preview-callable)
   - **Wave C**: agent-rank lib + agent-rank callable + cost-cap integration + tests
   - **Wave D**: dashboard pages (drag-drop, preview, agent-ranking review)
   - **Wave E**: eval / acceptance fixture / Cowork dashboard click-through prompt for V2 / SUMMARY

## Required executor topology

| Executor | Write scope |
|---|---|
| A. Data Model + Contracts | `packages/core-types/` additive — adapter descriptor type, `AgentRankingResult` schema, new collection const, new correction-event target-type enum value |
| B. Adapter Registry + Detection | `packages/external-supply/src/adapter-detect.ts`, `apps/functions/src/external-supply/adapters/registry.ts`, adapter file scaffolding for future sources |
| C. Dashboard Preview Server | `apps/functions/src/external-supply/preview-batch.ts` (server-side dry-run forecast callable), tests |
| D. Agent Ranking | `packages/external-supply/src/agent-rank-prompt.ts`, `apps/functions/src/external-supply/agent-rank.ts`, cost-cap integration via existing `pa-tool-calls`, tests |
| E. Dashboard UX | `apps/dashboard-web/src/pages/external-supply/BatchNew.tsx` (rewrite), new `EvaluationAgentRanking.tsx` page, drag-drop component, preview pane, ranking table |
| F. Flywheel Integration | Extend `pa-orchestrator/qa-evaluator-weekly` + `pa-source-quality-metrics` rollups for agent-tier-acceptance-rate; correction-event handling for agent-tier overrides |
| G. Verification | `tests/external-supply-v2/end-to-end.test.ts` end-to-end harness, Cowork click-through prompt, ACCEPTANCE ledger |

## Acceptance

- A 100+ row fixture batch can be drag-dropped, auto-adapter-detected with ≥0.9 confidence on the right adapter, previewed (forecast counters match post-commit reality within ±5%), committed.
- Identity resolution + tag enrichment counts match the preview forecast.
- Agent ranking runs against the evaluation set, writes per-candidate `pa-agent-ranking-results` rows, respects the budget cap (no overshoot), produces operator-readable rationale.
- Operator override writes a `pa-correction-events` row with `targetType: "agent_ranking_result"`.
- Dashboard end-to-end click-through (drag-drop → preview → commit → resolve → evaluate → agent-rank → approve → outreach draft → Mailgun dry-run sync → reply event back) works without terminal steps.
- Live prod e2e via Admin-SDK script (modeled on V1's `apps/functions/scripts/external-supply-prod-smoke.ts`): captures `agent-rank.json` evidence with per-candidate prompt + response + tier.
- Final SUMMARY.md report lists: commands run, fixtures used, pass/fail per check, remaining risks, any live credentials/config still required.

## Ask Adam ONLY for

- Unsettled product behavior not answered by this prompt, the V1 spec, or the milestone roadmap.
- Destructive migration or data deletion.
- Live outreach to non-test recipients (Mailgun env flag flip).
- Paid API budget for agent-ranking ensemble beyond the default `EXTERNAL_SUPPLY_AGENT_RANKING_BUDGET_USD_PER_BATCH=10`.
- Adding a NEW source whose canonical column shape is undocumented (need a sample export).
- Any change that would make external candidates separate from `pa-users`.

## Do NOT ask Adam for

- Whether to use LinkedIn URL as the external source identity. **Locked.**
- Whether to keep LinkedIn sending manual. **Locked for V1 + V2.**
- Whether to run required acceptance checks. **Yes, always.**
- Whether to use Mailgun or Instantly. **Mailgun is the default channel. Instantly stays as switch-back.**
- How to derive competitor companies. **Agent research finding, not a maintained field.**
- Implementation details that follow existing repo patterns from V1.

## Start

Begin by creating `.planning/external-supply-v2/CONTEXT.md` and `PLAN.md` (read V1's PLAN.md first as the contract baseline you build on top of). Then ask executors A-G for `AGENT_PLAN` outputs.

`git fetch origin && git worktree add .claude/worktrees/v2-external-supply-v2 -b codex/v2-external-supply-v2 origin/main && cd .claude/worktrees/v2-external-supply-v2`
