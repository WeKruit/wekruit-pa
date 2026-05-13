# S5 Acceptance

This ledger starts pending and must be filled with exact commands/results before
S5 is called complete.

## Required Checks

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S5-two-way-matching` | `codex/v2-S5-two-way-matching` | PASS |
| Base | `git log --oneline -1` | starts from merged S4 commit `e27edf6` | `e27edf6 feat(v2): add job enrichment review pipeline` | PASS |
| Core contracts tests | `pnpm --filter @pa/core-types test` | two-way match contracts pass | 15 pass, 0 fail | PASS |
| Core typecheck | `pnpm --filter @pa/core-types typecheck` | shared contracts compile | exit 0 | PASS |
| Persistence tests | `pnpm --filter @pa/pa-persistence test` | match persistence and reducers pass | 115 pass, 0 fail | PASS |
| Persistence typecheck | `pnpm --filter @pa/pa-persistence typecheck` | persistence compiles | exit 0 | PASS |
| Job-rec tests | `node --import tsx --test apps/job-rec/src/__tests__/two-way-match.test.ts tests/eval/s5-two-way-matching/s5-ranking-eval.test.ts`; `pnpm --filter @pa/job-rec test` | candidate -> jobs and job -> candidates ranking pass | S5 focused 10 pass; full package 435 pass | PASS |
| Job-rec typecheck/build | `pnpm --filter @pa/job-rec typecheck`; `pnpm --filter @pa/job-rec build` | scorer compiles and package exports are deployable | both exit 0 | PASS |
| Functions tests | `node --import tsx --test apps/functions/src/__tests__/admin-match-debug.test.ts apps/functions/src/identity/candidate-matches-api.test.ts`; `pnpm --filter @pa/functions test` | admin/candidate matching APIs pass | focused 19 pass; full package 1199 pass | PASS |
| Functions typecheck/build | `pnpm --filter @pa/functions typecheck`; `pnpm --filter @pa/functions build` | functions compile and production bundle builds | both exit 0; bundle emitted `apps/functions/lib/index.js` | PASS |
| Dashboard tests | `node --import tsx --test apps/dashboard-web/src/pages/__tests__/MatchDebug.test.ts`; `pnpm --filter @pa/dashboard-web test` | Match Debug behavior passes | focused 4 pass; full package 37 pass | PASS |
| Dashboard build | `pnpm --filter @pa/dashboard-web build` if admin UI touched | admin bundle builds | Vite build exit 0 | PASS |
| Landing tests/build | `pnpm --filter @pa/landing typecheck`; `pnpm --filter @pa/landing build` | candidate matches route builds | both exit 0 | PASS |
| S5 no-outbound static guard | `rg -n "pa-outbound\|PA_COLLECTIONS\\.outbound\|sendImessage\|enqueueReverseMatchNotify\|paReverseMatch\|bulkNotify\|action:\\s*[\"']notify" apps/job-rec/src/two-way-match.ts apps/functions/src/admin-match-debug.ts apps/functions/src/identity/candidate-matches-api.ts tests/eval/s5-two-way-matching \|\| true` | no sender/outbound references in new S5 paths | no matches | PASS |
| Rules/index dry-run | Firebase dry-run if rules/indexes touched | rules/indexes validate | not run; S5 did not touch rules/indexes | N/A |
| Deploy | `PA_DASHBOARD_VITE_ENV_FILE=/Users/adam/Desktop/WeKruit/wekruit-pa/apps/dashboard-web/.env.production.local npx firebase-tools deploy --only functions,hosting:pa-dashboard,hosting:pa-landing --project wekruit-5f89b --non-interactive`; then `PA_LANDING_VITE_ENV_FILE=/Users/adam/Desktop/WeKruit/wekruit-pa/apps/pa-landing/.env.production.local npx firebase-tools deploy --only hosting:pa-landing --project wekruit-5f89b --non-interactive` | functions/hosting deploy and candidate env keeps CV ingest URL | second deploy completed; first dashboard+landing deploy completed but lacked landing `VITE_CV_INGEST_URL`, fixed by targeted pa-landing redeploy with `VITE_CV_INGEST_URL` present | PASS |
| Candidate route regression | `curl -sS -L -o /dev/null -w "%{http_code} %{url_effective}\n" https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` | HTTP 200 | `200 https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` | PASS |
| Candidate CV route regression | `curl -sS -L https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer/cv`; deployed JS grep for `paPublicCvIngest` | HTTP 200 and deployed bundle includes CV ingest URL | `200`; bundle contains `https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest` | PASS |
| Admin redirect regression | `curl -sS -D - -o /dev/null https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer` | HTTP 301 to candidate domain | `HTTP/2 301`; `location: https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` | PASS |
| Admin Match Debug live smoke | `curl -sS -L -o /dev/null -w "%{http_code} %{url_effective}\n" https://wekruit-pa.web.app/admin/match-debug`; unauth callable probe | HTTP 200 and API exists behind auth | route `200`; `paAdminJobMatchDebug` unauth POST returned `403 PERMISSION_DENIED admin only` | PASS |
| Candidate matches live smoke | `curl -sS -L -o /dev/null -w "%{http_code} %{url_effective}\n" https://candidate.wekruit.com/me/matches`; unauth callable probe | HTTP 200 on candidate domain and callable auth gate holds | route `200`; `paCandidateListMatches` unauth POST returned `401 UNAUTHENTICATED` | PASS |
| No-outbound smoke | count `pa-outbound` before/after S5 smokes | no `pa-outbound` count change | `pa-outbound-count=190` before; `190` after route/callable smokes and final landing redeploy | PASS |

## Hard Fail Conditions

- S5 sends live outbound or writes `pa-outbound`.
- Candidate route moves to the admin domain.
- Employer can browse non-passed candidates.
- Match score blocks first interview entry once the candidate is in a job flow.
- `sponsorship=false` is inferred from silence.
- `roleFunction` and `industrySector` are collapsed into one axis.
- Recommended action creates side effects instead of remaining a pure S5 output.
