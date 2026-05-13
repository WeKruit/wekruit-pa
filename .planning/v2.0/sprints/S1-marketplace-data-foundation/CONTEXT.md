# S1 Context

**Sprint:** S1 - Marketplace Data Foundation
**Branch:** `codex/v2-S1-marketplace-data-foundation`
**Worktree:** `.claude/worktrees/v2-S1-marketplace-data-foundation`
**Base:** `main` at `5decc7ff614ec1a781315e126c5efe60e032a6dd`
**Date:** 2026-05-13

## Starting State

S0 landed on `main` through PR #23 as `5decc7f chore(v2): close S0 baseline integration`.

S0 verification on the landed branch:

- GitHub `typecheck + unit tests`: pass.
- GitHub `v1.5 QA team`: pass.
- GitHub CodeQL analyses: pass.
- Local S0 recursive rerun: `NODE_ENV=test PA_DASHBOARD_ENV=test pnpm -r test` passed on the final S0 branch head before landing.

Root checkout note: `/Users/adam/Desktop/WeKruit/wekruit-pa` still has unrelated local `package.json` and `package-lock.json` edits. They are outside this S1 worktree and are not part of this sprint.

## Product Invariant Advanced

S1 creates explicit source-of-truth primitives that separate:

- global candidate profile and lifecycle state, anchored to `pa-users/{userId}`;
- per-job candidate opportunity state, keyed by `{candidateId, jobId}`;
- append-only feedback and correction flywheel events;
- employer-visible passed profile snapshots.

This sprint must not turn WeKruit back into a job page, pre-screen bot, or employer ATS. It only creates the foundation that later identity, intake, matching, outreach, interview, and HITL sprints consume.

## Source Of Truth Decision

The global candidate profile anchor remains `pa-users/{userId}`.

Reasoning:

- Current v1.9 code already treats `pa-users` as the global profile row for phone, tags, onboarding, PII-adjacent state, runtime mode, and memory partition metadata.
- README/CLAUDE state that `profile_created` means a `pa-users` global profile exists.
- Creating a second `pa-candidates` identity root in S1 would split ownership before S2 identity merge exists.

S1 therefore adds typed marketplace fields and related collections around the existing `pa-users` candidate id, instead of creating a parallel candidate identity system.

## Relevant Existing Files

Core shared contracts:

- `packages/core-types/src/index.ts`
- `packages/core-types/src/collections.ts`
- `packages/core-types/src/broker.ts`
- `packages/core-types/package.json`

Persistence / Firestore helpers:

- `packages/pa-persistence/src/index.ts`
- `packages/pa-persistence/package.json`

Dashboard operator surfaces:

- `apps/dashboard-web/src/App.tsx`
- `apps/dashboard-web/src/pages/UserDetail.tsx`
- `apps/dashboard-web/src/pages/Users.tsx`
- `apps/dashboard-web/src/pages/MatchCandidates.tsx`
- `apps/dashboard-web/src/pages/__tests__/MatchCandidates.test.ts`

Firebase config:

- `config/firebase/firestore.rules`
- `config/firebase/firestore.indexes.json`

Regression anchors:

- `packages/pa-orchestrator`
- `apps/functions`
- `candidate.wekruit.com`
- `wekruit-pa.web.app` admin-to-candidate redirect behavior
- `paPublicCvIngest` validation shape

## Required S1 Primitives

Schemas/types:

- `CandidateProfile`
- `CandidateHandle`
- `ResumeArtifact`
- `CandidateLifecycleState`
- `CandidateJobState`
- `CandidateJobMatch`
- `OutboundInvite`
- `EmployerVisibleProfile`
- `FeedbackEvent`
- `CorrectionEvent`

Reducers:

- global candidate lifecycle reducer;
- candidate-job opportunity reducer.

Firestore:

- collection constants for new marketplace docs;
- operator-only rules for sensitive marketplace collections;
- indexes for candidate and job inspector queries.

Admin/debug visibility:

- candidate profile inspector that clearly shows global fields separately from job-specific states.

## Non-Goals

- No live outbound.
- No production data migration.
- No destructive collection rewrite.
- No employer-wide candidate browsing beyond operator/admin inspection.
- No candidate-facing `/me` build unless it is trivial after backend/admin acceptance is complete.
- No new identity merge behavior; S2 owns claim and handle merge.
- No change to first-interview routing.
- No match-score gate before interview.
