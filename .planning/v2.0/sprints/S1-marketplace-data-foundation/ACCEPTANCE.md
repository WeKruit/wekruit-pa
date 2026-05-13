# S1 Acceptance

This file records S1 verification.

## Required Checks

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S1-marketplace-data-foundation` | `codex/v2-S1-marketplace-data-foundation` | PASS |
| Base | `git rev-parse main origin/main HEAD` | S1 branch starts from landed S0 main `5decc7f` | all three refs at `5decc7ff614ec1a781315e126c5efe60e032a6dd` | PASS |
| Core schemas | `pnpm --filter @pa/core-types test` | marketplace schemas and reducers cover README states | 6 tests passed, 0 failed | PASS |
| Core typecheck | `pnpm --filter @pa/core-types typecheck` | shared contracts compile | passed | PASS |
| Persistence tests | `pnpm --filter @pa/pa-persistence test` | transition helpers write state + append-only events | 97 tests passed, 0 failed | PASS |
| Dashboard tests | `pnpm --filter @pa/dashboard-web test` | marketplace summary helpers remain correct | 26 tests passed, 0 failed | PASS |
| Dashboard build | `npm run build --workspace=@pa/dashboard-web` | admin inspector compiles | build passed; Vite chunk-size warning only | PASS |
| Firestore rules/indexes | `node -e "JSON.parse(...firestore.indexes.json...)"` plus rule diff review | new sensitive marketplace collections are operator-only; indexes cover inspector queries | indexes JSON parsed; rules add operator read/server write only, feedback/correction create-only | PASS |
| Recursive typecheck | `pnpm -r typecheck` | workspace typechecks after generated/build dependencies exist | passed across 19 workspace projects | PASS |
| Orchestrator regression | `pnpm --filter pa-orchestrator test` | existing v1.9 candidate journey logic remains green | 1479 tests passed, 0 failed | PASS |
| Functions regression | `cd apps/functions && pnpm test` | existing functions remain green | 1168 tests passed, 0 failed | PASS |
| Candidate landing | `curl -sS -i -I https://candidate.wekruit.com/` | HTTP 200 | `HTTP/2 200` | PASS |
| Public job page | `curl -sS -i -I https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` | HTTP 200 | `HTTP/2 200` | PASS |
| Admin redirect | `curl -sS -i -I https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer` | HTTP 301 to candidate domain | `HTTP/2 301`, `location: https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` | PASS |
| Public CV ingest validation | `curl -sS -i -X POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest -H content-type:application/json -d {}` | `HTTP/2 400` and `{"ok":false,"reason":"missing_userId_or_tempUserId"}` | exact expected status/body | PASS |
| Local dashboard route smoke | Browser to `http://127.0.0.1:5175/admin/candidates/test-candidate/profile` | protected route starts without routing to candidate/public surface | reached `Operator sign-in` auth gate at same admin URL | PASS |

## Hard Fail Conditions

- Candidate lifecycle state can be directly set from an LLM output.
- Candidate-job `not_passed` mutates global candidate lifecycle to an exit state.
- Match score blocks first interview.
- Employer-visible snapshot can be created without passed candidate-job state.
- Raw PII is used as a public document id.
- Candidate routes move to the admin domain.
- A live outbound, production mutation, destructive migration, or paid eval is run without an explicit dry-run/approval path.

## Evidence

- Core reducers enforce deterministic lifecycle and candidate-job transitions:
  low-confidence LLM evidence does not mutate lifecycle, match score does not
  gate first interview, and `not_passed` remains job-specific.
- Persistence helpers write `pa-users` marketplace fields, write separate
  `pa-candidate-job-states`, append feedback/correction events idempotently,
  and reject conflicting duplicate event ids.
- Employer-visible snapshot writes now require passed state plus exact
  candidate/job/state-doc linkage.
- Admin inspector is reachable only behind the existing operator auth wall and
  is linked from `UserDetail`.
- Candidate/admin domain split remains intact in live curl checks.
- PR CI initially failed because dashboard tests imported `@pa/job-rec` without
  a dashboard package dependency; `@pa/dashboard-web` now declares the dev
  dependency and builds `@pa/job-rec` before tests. Targeted dashboard tests
  pass locally after that fix, and the CI-equivalent
  `NODE_ENV=test PA_DASHBOARD_ENV=test pnpm -r test` passes locally.
