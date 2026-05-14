# S8 Plan - Flywheel + HITL + Eval

## 1. Purpose / Big Picture

Turn existing v2 marketplace events into an explicit improvement system:
corrections and outcomes become auditable flywheel data, selected corrections
generate regression/eval artifacts, and operators can inspect current eval
health without terminal logs.

## 2. Observable User Outcome

- Candidate self-correction of profile facts/preferences writes the same
  correction-event stream as operator edits.
- Operator HITL edits in job enrichment, matching/outreach, prescreen ambiguity,
  and employer-visible profile review are visible in one flywheel/eval surface.
- At least one human correction creates an eval artifact.
- A dry-run marketplace simulation shows the full v2 path ending in a passed
  profile plus flywheel event.

## 3. Current Repo Orientation

- Core event contracts exist in `packages/core-types/src/marketplace.ts`.
- Append-only writers exist in `packages/pa-persistence/src/marketplace.ts`.
- S7 added first-interview outcome integration and passed-only employer surface.
- Existing dashboard surfaces:
  - `/admin/marketplace` raw marketplace collections;
  - `/admin/qa-evaluator` v1.6 QA runs;
  - `/admin/job-enrichment-review`, `/admin/outreach-ops`,
    `/admin/passed-candidates`, `/admin/external-supply/**`.
- Existing eval suites live under `tests/eval/s5-*`, `tests/eval/s6-*`, and
  `tests/eval/s7-*`.

## 4. Locked Invariants And Non-Goals

- No broad employer candidate browsing.
- No scheduling, notes, or message-on-behalf-of employer workflow.
- No live Sendblue or Instantly send.
- No new tag taxonomy and no v1.6 matching re-litigation.
- No LLM-owned state transitions; reducers/services own transitions.
- No raw PII, resume storage locator, or raw transcript in eval artifacts.

## 5. Data Model And Ownership

Existing `FeedbackEvent` and `CorrectionEvent` remain the source of truth.
S8 may extend them only when a roadmap requirement cannot be represented
without semantic loss.

Add an eval artifact contract if needed, owned by the flywheel/eval layer:

- artifact id, artifact kind, source correction/feedback event ids;
- candidate/job references when safe;
- redacted fixture payload;
- status and latest run result;
- createdAt and actor.

## 6. UI Surface Map

Admin:

- Add `/admin/flywheel-eval` or extend `/admin/qa-evaluator` only if it remains
  operator-clear and not a raw JSON dump.
- Show correction-event counts, feedback-event counts, generated artifacts,
  scenario/eval status, and failure links.
- Keep links to source surfaces instead of duplicating large workflows.

Candidate:

- If scoped into S8 implementation, add a small `/me/profile` correction action
  that writes a redacted correction event and updates profile tags through the
  existing profile/tag pipeline.

## 7. Backend/API/Service Map

Likely backend additions:

- correction-to-eval artifact writer;
- marketplace simulation runner for S8 dry-run;
- admin callable/snapshot for flywheel/eval dashboard;
- feedback emission from S7 prescreen outcomes if not already covered.

## 8. Executor Topology And Disjoint Write Scopes

Executor A - Event Contracts + Persistence

- Owns `packages/core-types`, `packages/pa-persistence`, contract tests.

Executor B - Event Producers + Simulation

- Owns `apps/functions/src/**` flywheel services and dry-run marketplace sim.

Executor C - Admin Flywheel/Eval UI

- Owns `apps/dashboard-web/src/pages/*Flywheel*`, route/nav wiring, dashboard
  tests.

Executor D - Candidate Self-Correction

- Owns `apps/pa-landing/src/**` candidate correction UI/API hooks if included.

Executor E - Eval/Safety Harness

- Owns `tests/eval/s8-flywheel-hitl-eval/**`,
  `tests/scenarios/s8-flywheel-hitl-eval/**`, static guards, artifacts.

Shared files are sequenced behind one owner:

- `apps/functions/src/index.ts`: B owns exports.
- `apps/dashboard-web/src/App.tsx`: C owns route/nav.
- `packages/core-types/src/index.ts`: A owns exports.

## 9. Agent Plan Handshake

Executor plans are collected in `EXECUTOR-PLANS.md`.

## 9.1 Integration Note

1. File write scopes are disjoint.
   - A owns `packages/core-types/src/**` and `packages/pa-persistence/src/**`.
   - B owns `apps/functions/src/*flywheel*.ts`, `apps/functions/src/*eval*.ts`,
     focused tests, and function exports.
   - C owns `apps/dashboard-web/src/pages/FlywheelEval*`, its tests, and
     minimal `App.tsx` route/nav wiring.
   - D owns landing `/me/profile` UI/client wrapper only.
   - E owns S8 eval/scenario/static-guard files and S8 artifacts.
2. Shared files are sequenced.
   - A lands contracts first.
   - B consumes A contracts and owns backend callable/export shape.
   - C consumes B's redacted snapshot contract.
   - D consumes B's candidate correction callable.
   - E consumes A/B contracts and scans C/D touched files.
3. Data contracts are consistent.
   - S8 adds top-level `PA_COLLECTIONS.evalArtifacts =
     "pa-eval-artifacts"` and a first-class `EvalArtifact` schema.
   - `FeedbackEvent` and `CorrectionEvent` remain the flywheel spine.
   - `CorrectionEvent.actor` expands only to `candidate`, not the full
     marketplace actor enum.
   - Candidate-authored corrections use `targetType="user_tags"` or
     `targetType="candidate_profile"` with redacted before/after payloads.
4. Backend primitives have UI/operator state.
   - `paAdminFlywheelEvalSnapshot` exposes redacted summary, coverage,
     artifact, simulation, correction, and feedback rows to
     `/admin/flywheel-eval`.
5. LLM behavior has eval/trace coverage.
   - S8 does not require a live LLM call. Candidate correction projection uses
     existing deterministic tag/profile pipelines in this cut; any future LLM
     parser must be covered by S8 eval fixtures before activation.
6. HITL edits produce flywheel events.
   - Correction-event onCreate automatically materializes eval artifacts.
   - Candidate self-corrections always create a redacted correction event, even
     when no structured mutation is safe; the generated artifact can be
     `needs_review`.
7. Product invariants are preserved.
   - No broad employer candidate browsing, no live outbound, no admin-domain
     candidate route, no raw PII artifacts, no new tag taxonomy.
8. Execution wave order.
   - Wave A: A contracts/persistence.
   - Wave B: B services/callables/triggers/simulation.
   - Wave C: C admin UI and D candidate UI.
   - Wave D: E eval/scenario/static guards and regression subset.
   - Wave E: docs, acceptance, deploy, live non-sending smoke, PR.

## 9.2 Integration Status

- Wave A implemented shared contracts and append-only persistence.
- Wave B implemented flywheel services, callables, trigger, and dry-run
  simulation.
- Wave C implemented `/admin/flywheel-eval`.
- Wave D implemented the `/me/profile` open-ended candidate correction panel.
- Wave E implemented S8 eval/scenario/static guards.
- Integration tightened privacy by redacting unsafe correction text before it
  can enter correction reasons or eval artifacts.
- Local verification has passed through focused tests, regression eval subset,
  typecheck/build, and full functions tests.
- Firebase deploy passed for functions, dashboard hosting, and landing hosting.
- Live non-sending smoke passed with candidate/admin route split intact,
  unauth callables gated, and `pa-outbound` unchanged.
- Commit, PR, checks, merge, and next sprint advance remain the active gate.

## 10. Milestones

1. Write S8 docs and collect executor plans.
2. Integrate write scopes and choose the minimal vertical S8 cut.
3. Wave A: contracts, fixture shapes, failing tests.
4. Wave B: event/artifact writers and simulation/API service.
5. Wave C: admin/candidate surfaces.
6. Wave D: evals, simulation, safety guards, no-contact checks.
7. Wave E: docs, acceptance, deploy, live non-sending smoke, PR.

## 11. Concrete Steps

1. Implement `EvalArtifact` contracts and persistence writers.
2. Implement flywheel event builders, correction-artifact materializer,
   correction onCreate artifact trigger, candidate-job-state feedback trigger,
   dry-run simulation, admin snapshot callable, and candidate correction
   callable.
3. Implement `/admin/flywheel-eval`.
4. Implement `/me/profile` open-ended correction panel.
5. Implement S8 eval/scenario/static-guard harness.
6. Run focused package tests, then broader regressions and deploy/live smoke.

## 12. Verification Harness

Minimum:

- `pnpm --filter @pa/core-types test`
- `pnpm --filter @pa/core-types typecheck`
- `pnpm --filter @pa/pa-persistence test`
- `pnpm --filter @pa/pa-persistence typecheck`
- focused functions/dashboard/landing tests for S8
- `node --import tsx --test tests/eval/s8-flywheel-hitl-eval/*.test.ts`
- S8 static guard for PII, broad employer browsing, candidate-domain split, and
  no live outbound
- S5/S6/S7 eval regression subset
- functions/dashboard/landing typecheck/build as touched
- Firebase deploy if functions/hosting/rules change
- live non-sending route/auth/count smoke only

## 13. HITL And Flywheel Events

Every manual correction path included in S8 must write `CorrectionEvent`.
Every outcome path included in S8 must write `FeedbackEvent` or document why an
existing event already covers it. At least one correction must generate an eval
artifact.

## 14. Safety And Privacy Checks

- Redacted artifacts only.
- No raw email/phone/LinkedIn/resume storage URI in employer/eval surfaces.
- No automatic LinkedIn send.
- No Sendblue/Instantly live send.
- Candidate-domain and admin-domain split stays intact.

## 15. Idempotence And Recovery

Append-only event/artifact writers must be deterministic or conflict-detecting.
Repeated simulation runs should reuse run ids or create clearly separate run
records without mutating production state.

## 16. Progress

- [x] S8 selected from updated `main`.
- [x] S8 worktree created from `2c48792`.
- [x] Source docs and prior sprint summary read.
- [x] Executor plans collected.
- [x] Integrated plan written.
- [x] Wave A contracts/persistence implemented and verified.
- [ ] Wave B/C/D/E implementation integrated.

## 17. Decision Log

- Use existing `FeedbackEvent` / `CorrectionEvent` as the flywheel spine.
- S8 dashboard should connect artifacts/status to events, not duplicate every
  existing admin queue.
- Add top-level `pa-eval-artifacts`; it is cross-flywheel, while existing job
  enrichment eval fixtures remain job-intake-specific.
- Use automatic correction-event artifact generation, not a manual admin button.
- Use a candidate-job-state trigger for prescreen outcome feedback to avoid
  patching the S7 terminal action path.
- Include candidate self-correction in S8, but keep it open-ended and inside
  `/me/profile`.

## 18. Surprises And Discoveries

- External Supply V1 already writes correction and feedback events on several
  paths, so S8 should consolidate and expose rather than rebuild.
- S8 worktree needed local workspace links before persistence tests could
  import branch-local `@pa/core-types`; otherwise Node walked up to the parent
  repo's stale `node_modules`.

## 19. Outcomes And Retrospective

Pending.
