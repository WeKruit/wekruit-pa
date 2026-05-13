# S1 Summary

**Status:** Landed and deployed.
**Date:** 2026-05-13.

## Outcome

S1 creates the marketplace data foundation for the v2.0 candidate-retention
marketplace:

- typed global candidate marketplace fields on the existing `pa-users/{userId}`
  anchor;
- typed per-job candidate opportunity state, match evidence, outbound invite,
  resume artifact, linked handle, employer-visible snapshot, feedback, and
  correction primitives;
- deterministic reducers proving LLM output is evidence, not direct lifecycle
  mutation;
- Firestore persistence helpers for state transitions and append-only flywheel
  events;
- an admin-only marketplace inspector in `UserDetail` plus a deep link at
  `/admin/candidates/:candidateId/profile`;
- Firestore rules/indexes for operator visibility and server-owned state writes.

## Verification Status

Passed:

- `pnpm --filter @pa/core-types test` — 6 passed.
- `pnpm --filter @pa/core-types typecheck`.
- `pnpm --filter @pa/pa-persistence test` — 97 passed.
- `pnpm --filter @pa/pa-persistence typecheck`.
- `pnpm --filter @pa/dashboard-web test` — 26 passed.
- PR CI dependency repair: dashboard tests now declare and build
  `@pa/job-rec`; rerun `pnpm --filter @pa/dashboard-web test` — 26 passed.
- `NODE_ENV=test PA_DASHBOARD_ENV=test pnpm -r test` — passed locally after
  the dashboard dependency repair.
- `npm run build --workspace=@pa/dashboard-web` — passed; Vite chunk-size warning only.
- `pnpm -r typecheck` — passed across 19 workspace projects.
- `pnpm --filter pa-orchestrator test` — 1479 passed.
- `cd apps/functions && pnpm test` — 1168 passed.
- Firestore indexes JSON parse check.
- Live curl checks for `candidate.wekruit.com`, public job URL, admin job-route
  redirect, and invalid public CV ingest request.
- Local Browser smoke for `/admin/candidates/test-candidate/profile`; reached
  the existing operator sign-in gate at the admin URL.
- PR #24 CI: CodeQL, analysis, v1.5 QA, and `typecheck + unit tests` passed.
- Deploy: `hosting:pa-dashboard,firestore:rules,firestore:indexes` deployed to
  `wekruit-5f89b` with repo-pinned Firebase CLI 15.3.1.
- Post-deploy smoke: admin `/admin` 200, admin `/j/*` 301 to candidate domain,
  candidate job route 200, CV ingest validation 400 with expected body,
  unauthenticated `pa-candidate-handles` read denied with 403.

## Files Changed

- `packages/core-types/src/marketplace.ts`
- `packages/core-types/src/marketplace.test.ts`
- `packages/core-types/src/collections.ts`
- `packages/core-types/src/index.ts`
- `packages/core-types/package.json`
- `packages/pa-persistence/src/marketplace.ts`
- `packages/pa-persistence/src/marketplace.test.ts`
- `packages/pa-persistence/src/index.ts`
- `packages/pa-persistence/package.json`
- `apps/dashboard-web/src/pages/CandidateProfile.tsx`
- `apps/dashboard-web/src/pages/CandidateMarketplace.tsx`
- `apps/dashboard-web/src/pages/CandidateMarketplace.helpers.ts`
- `apps/dashboard-web/src/pages/__tests__/CandidateMarketplace.test.ts`
- `apps/dashboard-web/src/App.tsx`
- `apps/dashboard-web/src/pages/UserDetail.tsx`
- `apps/dashboard-web/package.json`
- `config/firebase/firestore.rules`
- `config/firebase/firestore.indexes.json`
- `pnpm-lock.yaml`
- `.planning/v2.0/sprints/S1-marketplace-data-foundation/*`

## Product Decisions

- S1 keeps `pa-users/{userId}` as the global candidate profile anchor.
- S1 creates explicit per-job opportunity primitives instead of storing job outcomes on the global profile.
- S1 creates append-only feedback/correction primitives for later HITL and eval flywheel work.

## Known Gaps

- Browser smoke was unauthenticated and verified the protected route/auth wall.
  The inspector's data rendering is covered by TypeScript, build, and pure
  dashboard tests, not by a signed-in visual smoke with live Firestore data.

## Next Sprint Trigger

S2 can begin from updated `main` after merge commit `c153c9a`.
