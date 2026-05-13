# S1 Plan

## Purpose

Create the marketplace data foundation that all later v2.0 sprints depend on. S1 must make the global candidate profile and per-job opportunity state explicit, typed, reducer-owned, and visible to operators.

## Observable Outcome

An operator can inspect a candidate and see:

- global candidate lifecycle/profile fields;
- linked handles and resume artifacts;
- job-specific states, matches, and outbound invite records;
- feedback and correction events.

Developers can import shared schemas and reducers that prove LLM outputs do not directly mutate lifecycle state.

## Locked Invariants

- Candidate profile is the durable asset; job is a demand event.
- `pa-users/{userId}` remains the global candidate anchor for S1.
- Job-specific match/outbound/prescreen/pass state does not overwrite global profile state.
- Match score never blocks first interview.
- `NOT_PASS` retains the candidate in the global marketplace pool.
- Employer-visible profile snapshots are created only from passed candidate-job state.
- Feedback and corrections are append-only flywheel data.
- Candidate C-end routes stay on `candidate.wekruit.com` / `pa.wekruit.com`.

## Data Model

Canonical id:

- `candidateId` equals the existing `pa-users/{userId}` id.

Collections:

- `pa-users/{candidateId}`: existing global row, extended by typed marketplace profile fields.
- `pa-candidate-handles/{handleId}`: hashed/non-raw linked handles for email, phone, browser uid, ATS, Sendblue, future LinkedIn.
- `pa-resume-artifacts/{resumeId}`: canonical resume artifact pointer and parse status, optionally linking existing `parsedCandidateResumes`.
- `pa-candidate-job-states/{candidateId}__{jobId}`: per-opportunity state machine row.
- `pa-candidate-job-matches/{candidateId}__{jobId}`: latest candidate/job match evidence and action recommendation.
- `pa-outbound-invites/{inviteId}`: marketplace invite policy state linked to `pa-outbound` when sent.
- `pa-employer-visible-profiles/{jobId}__{candidateId}`: passed-only employer snapshot.
- `pa-feedback-events/{eventId}`: append-only outcome and user/employer signal.
- `pa-correction-events/{eventId}`: append-only HITL correction.

Reducer inputs are typed events. LLM output is accepted only as evidence on events; reducers decide state transitions.

## UI Surface Map

S1 adds an admin-only candidate profile inspector. The shortest path is to extend `UserDetail` with a `Marketplace` tab because it already owns candidate-scoped operator debugging.

The tab must separate:

- global candidate profile/lifecycle;
- handles/resumes;
- job-specific states/matches/invites/employer-visible snapshots;
- feedback/correction events.

No broad employer candidate browsing is introduced.

## Backend / Service Map

Shared schemas and pure reducers belong in `packages/core-types` so all later packages consume one contract.

Firestore write helpers belong in `packages/pa-persistence` so transition writes can:

- parse inputs through core schemas;
- update the state doc;
- write append-only audit/event rows;
- preserve idempotency for repeated events.

S1 does not wire these helpers into live prescreen/outbound paths unless needed by tests; later sprints own integration.

## Executor Topology

Executor A - Core Contracts:

- Write scope: `packages/core-types/src/marketplace.ts`, `packages/core-types/src/index.ts`, `packages/core-types/src/collections.ts`, core-types package metadata/tests.
- Owns schemas, ids, lifecycle reducer, candidate-job reducer.

Executor B - Persistence:

- Write scope: `packages/pa-persistence/src/marketplace.ts`, `packages/pa-persistence/src/index.ts`, `packages/pa-persistence/package.json`, persistence tests.
- Owns Firestore transition helpers and append-only event writes.
- Depends on Executor A contracts.

Executor C - Admin Inspector:

- Write scope: `apps/dashboard-web/src/pages/CandidateMarketplace.*`, `apps/dashboard-web/src/pages/UserDetail.tsx`, `apps/dashboard-web/src/pages/__tests__/CandidateMarketplace.test.ts`.
- Owns operator visibility and pure helper tests.
- Depends on collection constants/contracts from Executor A.

Executor D - Firebase / Acceptance:

- Write scope: `config/firebase/firestore.rules`, `config/firebase/firestore.indexes.json`, S1 acceptance docs/artifacts.
- Owns rules/indexes and acceptance harness commands.
- Depends on final collection names from Executor A.

If a shared file needs one owner, the owner is listed above. Other executors consume the owner’s interface.

## Agent Plan Handshake

Before implementation, each executor must return `AGENT_PLAN` only. The lead integrates the plans into `EXECUTOR-PLANS.md` and records the integration note below.

## Integrated Execution Note

Executor plans are integrated.

1. File write scopes are disjoint. Executor A owns core contracts, B owns persistence helpers, C owns dashboard inspector, and D owns Firebase rules/indexes plus acceptance docs.
2. Shared files are sequenced. Executor A's `PA_COLLECTIONS` and marketplace exports land first. Executor B/C/D consume those names. Lead owns `pnpm-lock.yaml` if core-types adds `tsx`.
3. Data contracts are consistent. `candidateId` is the existing `pa-users/{userId}` id. Job state, match, invite, feedback, correction, and employer-visible records are separate docs keyed by candidate/job/event ids.
4. Backend primitives have UI visibility. Executor C reads all S1 marketplace collections in a read-only `Marketplace` tab on `UserDetail`.
5. LLM behavior has reducer coverage. LLM-like intent can appear only as event evidence; lifecycle and candidate-job state change through deterministic reducers in core-types and persistence helpers.
6. HITL edits produce flywheel events. Corrections and feedback are append-only event docs, with client rules denying update/delete.
7. No executor plan violates product invariants. Employer-visible snapshots require passed candidate-job state. `not_passed` remains per-job and does not exit the global candidate pool.
8. Execution order: Wave A core contracts/tests -> Wave B persistence/tests -> Wave C admin inspector/tests -> Wave D rules/indexes/acceptance artifacts -> Wave E regressions and summary.

Lead decisions:

- Existing `pa-audit-events` is enough for transition audit in S1; no dedicated transition-event collection.
- Duplicate append-only feedback/correction ids return existing only for identical payloads; conflicting duplicate payloads throw.
- Employer-visible snapshot helper is in S1, guarded by passed state.
- S1 browser rules are read-only for state collections. `pa-feedback-events` and `pa-correction-events` allow operator create/read only and deny update/delete.
- Export both a full `CandidateProfileSchema` and an additive `CandidateProfileMarketplaceFieldsSchema`.

## Waves

Wave A - Schemas and reducer tests:

- Add marketplace schemas.
- Add deterministic lifecycle and candidate-job reducers.
- Add tests covering every README blueprint state.

Wave B - Persistence helpers:

- Add transition write helpers.
- Write state doc plus append-only audit/event rows.
- Add fake Firestore tests proving idempotent state updates and append-only feedback/correction.

Wave C - Admin inspector:

- Add marketplace tab on candidate detail.
- Fetch/read new collections by candidateId.
- Render global-vs-job-specific sections.

Wave D - Rules, indexes, and dry-run harness:

- Add operator-only Firestore rules.
- Add indexes needed by the inspector and future job activation queries.
- Add focused tests/evals for parser/reducer behavior.

Wave E - Regression and summary:

- Run targeted package tests.
- Run recursive build/typecheck/test as feasible.
- Run v1.9 route/curl regression checks if config/rules/build changes require it.
- Update `ACCEPTANCE.md` and `SUMMARY.md`.

## Verification Harness

Minimum targeted checks:

- `pnpm --filter @pa/core-types typecheck`
- `pnpm --filter @pa/core-types test`
- `pnpm --filter @pa/pa-persistence test`
- `npm run build --workspace=@pa/dashboard-web`
- Firestore rules/index JSON sanity check

Standing regression:

- `pnpm --filter pa-orchestrator test`
- `cd apps/functions && pnpm test`
- `curl -sS -i -I https://candidate.wekruit.com/`
- `curl -sS -i -I https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer`
- `curl -sS -i -I https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer`
- `curl -sS -i -X POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest -H 'content-type: application/json' -d '{}'`

No deploy is planned for S1 until code and rules are accepted. If Firestore rules/indexes change and the sprint lands, deploy directly per repo contract unless blocked by Adam or explicit safety issue.

## HITL / Flywheel

S1 defines correction and feedback event schemas but does not require a full HITL queue. The admin inspector must show those events so later HITL UI has a visible source of truth.

## Safety And Privacy

- No raw PII in public document ids.
- Candidate handles must include normalized value only when the field is allowed for operator-only storage; hashed id fields are used for lookup ids.
- Employer-visible snapshots must require passed state and candidate/job linkage.
- Candidate profile reads remain operator-only in dashboard rules for S1.
- Candidate C-end profile claim/read rules are deferred to S2.

## Progress

- [x] S0 landed on `main`.
- [x] S1 worktree created from updated `main`.
- [x] S1 context drafted.
- [x] S1 plan drafted.
- [x] Executor plans collected.
- [x] Integrated execution note written.
- [x] Wave A implemented.
- [x] Wave B implemented.
- [x] Wave C implemented.
- [x] Wave D implemented.
- [x] Acceptance complete.

## Decision Log

- `pa-users/{userId}` remains the global candidate anchor for S1.
- Candidate/job opportunity state gets separate collection rows keyed by candidate and job to prevent job outcomes from mutating global state.
- Admin visibility starts inside `UserDetail` as a marketplace tab rather than a new employer browsing surface.

## Surprises

- Local dashboard browser smoke needed the existing untracked
  `apps/dashboard-web/.env.local` linked into the S1 worktree; without it the
  route reached the Vite app but stopped at the Firebase env guard.
- Review caught an employer-visible snapshot linkage gap before packaging:
  passed state is not enough; the referenced candidate-job state must also
  match the snapshot's `candidateId`, `jobId`, and state doc id.
- PR CI caught that dashboard tests imported `@pa/job-rec` through
  `MatchDebug.test.ts` without declaring it in `@pa/dashboard-web`; the package
  now declares the dev dependency and builds `@pa/job-rec` in `pretest`.

## Outcomes

S1 marketplace data foundation is implemented and locally accepted. It is ready
to package into a branch/PR; deploy is still pending landing because this sprint
changes dashboard code plus Firestore rules/indexes.
