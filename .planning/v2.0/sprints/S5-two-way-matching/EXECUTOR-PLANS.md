# S5 Executor Plans

Status: AGENT_PLAN handshakes integrated from five parallel planners.
Implementation may begin with the write scopes below. Executors are not alone in
the codebase; do not revert or rewrite files outside the assigned scope.

## Lead Decisions From Discovery

- Candidate -> jobs remains `queryMatchingJobsV16`; S5 must not create a second
  recommender for that direction.
- Job -> candidates needs a new side-effect-free preview path. Existing
  `paReverseMatch` is useful prior art, but it sits beside `notify` /
  `bulkNotify` actions that write `pa-outbound`; S5 must not build on those
  sender actions.
- Match evidence should use the existing `CandidateJobMatch` collection instead
  of inventing a new edge store.
- Candidate `/me/matches` should use an authenticated callable projection that
  joins candidate-owned matches with public-safe job fields. Do not loosen raw
  Firestore reads for `pa-candidate-job-matches`.
- Admin job -> candidates debug belongs in `/admin/match-debug` as a second
  mode/tab. Keep the old `/match/candidates` notify surface as legacy only; do
  not expand it for S5.
- S5 storage is "latest materialized edge plus audit event" at
  `pa-candidate-job-matches/{candidateId}__{jobId}`. Full match history is not
  part of S5 unless the lead changes the data model.

## Executor A - Contracts And Persistence

AGENT_PLAN:

Objective: make marketplace match evidence versioned, explainable, and
materializable without triggering outbound.

Write scope:

- `packages/core-types/src/marketplace.ts`
- `packages/core-types/src/marketplace.test.ts`
- `packages/core-types/src/collections.ts` only if a new collection constant is
  strictly necessary
- `packages/pa-persistence/src/marketplace.ts`
- `packages/pa-persistence/src/marketplace.test.ts`
- `packages/pa-persistence/src/index.ts`

Required behavior:

- Extend `CandidateJobMatch` with explicit S5 metadata:
  `direction`, `matchVersion`, `jobEnrichmentVersion`, `computedAt`,
  `scoreBreakdown`, `matchedSignals`, `blockedSignals`,
  `candidateLifecycleStateAtMatch`, `candidateTagsUpdatedAt`, optional
  `staleAt`.
- `hardFilterResult` is explicit, and `scoreBreakdown` must be non-empty with
  components shaped as `{ score: 0..1, weight?: 0..1, summary?: string }`.
- Preserve existing candidate-job reducer behavior: match score cannot block
  `prescreen_started`.
- Add `writeCandidateJobMatch(db, match)` that validates the deterministic
  `createCandidateJobMatchId(candidateId, jobId)`, writes
  `pa-candidate-job-matches/{matchId}`, applies/merges candidate-job state with
  `latestMatchId`, and writes an audit event.
- Same payload is idempotent. Older `computedAt` than the stored match rejects
  as stale. Newer `computedAt` replaces the latest materialized match doc.
- Existing candidate-job states are not regressed; only `latestMatchId` changes
  for started/passed/not-passed/employer-visible/archived states.
- Keep `pa-outbound`, `pa-outbound-invites`, and `pa-users` untouched.

Tests:

- `pnpm --filter @pa/core-types test`
- `pnpm --filter @pa/pa-persistence test`
- Focused tests must cover match versioning, score breakdown validation,
  `latestMatchId` state update, idempotent same-match write, conflicting
  duplicate rejection, newer/stale match handling, no outbound/invite writes,
  and no score gate before first interview.

Stop conditions:

- Stop if implementation requires direct client writes to marketplace match
  collections.
- Stop if a write path creates `pa-outbound` rows.

## Executor B - Matching Service

AGENT_PLAN:

Objective: add pure two-way matching logic that keeps V16 as candidate -> jobs
and adds canonical-tag job -> candidates preview with reasons, risks, missing
info, and recommended action.

Write scope:

- `apps/job-rec/src/two-way-match.ts` or a similarly named new pure module
- `apps/job-rec/src/index.ts`
- `apps/job-rec/src/__tests__/two-way-match.test.ts`
- Existing `apps/job-rec/src/tools/query-matching-jobs-v16.ts` only for shared
  export/import cleanup, not behavioral rewrites

Required behavior:

- Add pure `rankCandidatesForJob` / `scoreCandidateForJob` style functions that
  accept an enriched matching job row plus retained candidate tag/profile rows.
- Add a pure mapper from V16 candidate -> jobs output into S5 evidence shape;
  do not build a second forward recommender.
- Use V16 axes symmetrically:
  role, visa, location, career stage, job type, freshness, ATS URL, and liveness
  as hard filters;
  skills, relevantTags, industrySector, salary, and optional embedding/LLM
  placeholders as score components.
- Recommended action is pure output only:
  `auto_outbound`, `hitl_review`, `do_not_contact`.
- `sponsorship=null` never becomes false. Sponsorship silence should create
  missing-info/risk when relevant, not a hard block.
- Output should be convertible to `CandidateJobMatch`.
- The module must stay pure: no Firestore dependency, no Cloud Functions
  dependency, no `send-imessage`, no `paReverseMatch`, no
  `enqueueReverseMatchNotify`, and no `PA_COLLECTIONS.outbound`.

Tests:

- Focused `node --import tsx --test apps/job-rec/src/__tests__/two-way-match.test.ts`.
- Cases: strong job -> candidate, role mismatch suppressed, sponsor-needed
  against `sponsorship=false` suppressed, `sponsorship=null` routes to review,
  promising missing-info routes to `hitl_review`, candidate -> jobs V16 fixture
  remains untouched.

Stop conditions:

- Stop if implementation would import or call `paReverseMatch` notify paths,
  `sendImessage`, daily batch delivery, or any `pa-outbound` writer.

## Executor C - Admin Debug API And UI

AGENT_PLAN:

Objective: expose both matching directions in the existing admin Match Debug
surface without outbound side effects.

Write scope:

- `apps/functions/src/admin-match-debug.ts`
- `apps/functions/src/index.ts`
- `apps/functions/src/__tests__/admin-match-debug.test.ts`
- `apps/dashboard-web/src/pages/MatchDebug.tsx`
- `apps/dashboard-web/src/pages/MatchDebug.helpers.ts` if helper extraction is
  needed
- `apps/dashboard-web/src/pages/__tests__/MatchDebug.test.ts`

Required behavior:

- Add admin callable `paAdminJobMatchDebug` that accepts `jobId`, optional
  limit, loads `matching-jobs/{jobId}`, loads retained/profile-ready candidates
  from `pa-users`, runs the pure S5 job -> candidates scorer, and returns a
  debug projection.
- The callable must be admin-gated using the existing admin callable pattern.
- It must not import or call `paReverseMatch` notify/bulkNotify, and must not
  write `pa-outbound`.
- Extend `/admin/match-debug` with a clear direction mode:
  candidate -> jobs keeps `paAdminMatchDebug`; job -> candidates calls
  `paAdminJobMatchDebug`.
- Keep `/match/candidates` unchanged unless a compile issue forces a small
  compatibility edit.

Tests:

- Focused admin callable tests for auth, validation, missing job, strong
  candidate result, and no-outbound dependency.
- Dashboard helper/render tests for direction state and candidate row
  formatting.
- Add an import/source guard that `admin-match-debug.ts` does not import
  `paReverseMatch`, `sendImessage`, notify helpers, or reference `pa-outbound`.

Stop conditions:

- Stop if the UI path requires PA_ADMIN_TOKEN prompts for the new debug mode;
  use Firebase callable auth instead.

## Executor D - Candidate Matches API And Route

AGENT_PLAN:

Objective: add candidate-facing `/me/matches` backed by a candidate-safe
callable projection, without opening raw marketplace collection reads.

Write scope:

- `apps/functions/src/identity/candidate-matches-api.ts`
- `apps/functions/src/identity/candidate-matches-api.test.ts`
- `apps/functions/src/index.ts`
- `apps/pa-landing/src/main.tsx`
- `apps/pa-landing/src/pages/CandidateMatches.tsx`
- `apps/pa-landing/src/pages/CandidatePortal.tsx`
- landing tests only if existing test harness supports them

Required behavior:

- Add callable `paCandidateListMatches({ limit?: number })` requiring Firebase
  Auth.
- Resolve `request.auth.uid` through existing `pa-candidate-auth/{uid}` mapping.
- Query `pa-candidate-job-matches` for that `candidateId`, join safe display
  fields from `pa-jobs/{jobId}`, and return redacted match cards.
- Include recommended and invited jobs when present. If no invite exists, show
  recommendation state only.
- Suppressed rows (`recommendedAction=do_not_contact` or hard-blocked) are not
  candidate-visible.
- Hidden or non-public jobs are not shown; returned job cards include only
  title, company, location, salary range, and `/j/{jobId}` link.
- Do not return raw `evidence`, `scoreBreakdown`, `blockedSignals`, internal
  `risks`, lifecycle snapshots, or `recommendedAction`.
- Candidate page `/me/matches` lives in `apps/pa-landing`, not dashboard.
- Preserve direct job entry: match score is explanatory, not a block.

Tests:

- Candidate callable tests for unauthenticated, unmapped auth, candidate-only
  filtering, hidden-job suppression, public-safe job projection, invite/state
  mapping, no writes, and redaction of internal evidence.
- `pnpm --filter @pa/landing build` after UI changes.

Stop conditions:

- Stop if implementation requires candidate direct read access to
  `pa-candidate-job-matches` or `pa-candidate-job-states`.

## Executor E - Acceptance, Rules, Deploy

AGENT_PLAN:

Objective: keep S5 measurable, safe, deployed, and restartable.

Write scope:

- `config/firebase/firestore.rules`
- `config/firebase/firestore.indexes.json`
- `tests/eval/s5-two-way-matching/**`
- `.planning/v2.0/sprints/S5-two-way-matching/*`

Required behavior:

- Keep raw marketplace match/invite collections server/operator-owned. Candidate
  reads must flow through callable projection unless explicitly justified.
- Add only indexes required by implemented S5 queries.
- Add deterministic ranking eval fixtures for candidate -> jobs, job ->
  candidates, and a HITL correction regression case.
- Acceptance ledger must include exact commands, deploy outputs, route/domain
  smokes, and a no-outbound count check.
- After code changes, deploy affected Firebase Functions/Hosting directly and
  verify live behavior.

Tests/smokes:

- Rules/index dry-run if rules or indexes change.
- Static no-outbound grep over S5 preview/list/match paths.
- Candidate route remains on `candidate.wekruit.com`; stale admin `/j/*`
  remains 301.
- Count `pa-outbound` before/after S5 live smokes.

Stop conditions:

- Stop on any candidate-domain/admin-domain drift or any live outbound write.
