# S4 Acceptance

This ledger starts pending and must be filled with exact commands/results before
S4 is called complete.

## Required Checks

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S4-job-enrichment` | `codex/v2-S4-job-enrichment` | PASS |
| Base | `git merge-base HEAD origin/main && git log --oneline -1 $(git merge-base HEAD origin/main)` | starts from merged S3 commit `8484a36` | `8484a36 feat(v2): add bulk resume intake (#26)` | PASS |
| Core contracts tests | `pnpm --filter @pa/core-types test` | job enrichment schemas/reducers pass | 13 tests passed | PASS |
| Core typecheck | `pnpm --filter @pa/core-types typecheck` | shared contracts compile | passed | PASS |
| Core build/export | `pnpm --filter @pa/core-types build`; `pnpm --filter @pa/core-types exec node -e ...` | shared package builds and exports S4 contracts | build passed; `JobOpportunityPublicSchema`, `toPublicJobOpportunity`, and `JobEnrichmentDraftSchema` exported | PASS |
| Persistence tests | `pnpm --filter @pa/pa-persistence test` | enrichment persistence/corrections pass | 110 tests passed | PASS |
| Persistence typecheck | `pnpm --filter @pa/pa-persistence typecheck` | persistence compiles | passed | PASS |
| Job enricher tests | `pnpm --filter @pa/job-tag-enricher test` | tag extraction and guardrails pass | 30 tests passed | PASS |
| Job enricher typecheck/build | `pnpm --filter @pa/job-tag-enricher typecheck`; `pnpm --filter @pa/job-tag-enricher build` | package compiles and builds | both passed | PASS |
| Functions focused tests | `node --import tsx --test apps/functions/src/__tests__/job-enrichment.test.ts` | draft generation/approval/HITL paths pass | 5 tests passed | PASS |
| Functions full tests | `pnpm --filter @pa/functions test` | existing functions remain green | 1,189 tests passed, 0 failed | PASS |
| Functions typecheck | `pnpm --filter @pa/functions typecheck` | functions compile | passed | PASS |
| Dashboard focused tests | `node --import tsx --test apps/dashboard-web/src/pages/__tests__/JobEnrichmentReview.test.ts` | admin review helpers pass | 3 tests passed | PASS |
| Dashboard tests | `pnpm --filter @pa/dashboard-web test` | admin review UI behavior passes | 35 tests passed, 0 failed | PASS |
| Dashboard typecheck | `pnpm --filter @pa/dashboard-web typecheck` | dashboard compiles | passed | PASS |
| Dashboard build | `pnpm --filter @pa/dashboard-web build` | admin bundle builds | passed; existing Vite large-chunk warning only | PASS |
| Rules/index dry-run | `npx firebase-tools deploy --only firestore:rules,firestore:indexes --project wekruit-5f89b --non-interactive --dry-run` | rules/indexes validate | rules compiled successfully | PASS |
| Deploy functions/rules/indexes | `npx firebase-tools deploy --only functions,firestore:rules,firestore:indexes --project wekruit-5f89b --non-interactive` | S4 callables and rules deployed | deployed; `paJobEnrichmentGenerateDraft`, `RefreshDraft`, `ApproveDraft`, `RejectDraft`, `SaveCorrections` created; rules released | PASS |
| Deploy admin hosting | `PA_DASHBOARD_VITE_ENV_FILE=apps/pa-landing/.env.production.local npx firebase-tools deploy --only hosting:pa-dashboard --project wekruit-5f89b --non-interactive` | dashboard hosting deployed | deployed to `https://wekruit-pa.web.app`; env injection wrote required Vite keys | PASS |
| Public CV regression | `curl -X POST https://papubliccvingest-evm6xq7jyq-uc.a.run.app -H 'content-type: application/json' -d '{}'` | HTTP 400 `missing_userId_or_tempUserId` | HTTP 400, body `{"ok":false,"reason":"missing_userId_or_tempUserId"}` | PASS |
| Candidate route regression | `curl -L https://candidate.wekruit.com/j/s4-smoke` | HTTP 200 | HTTP 200, final URL `https://candidate.wekruit.com/j/s4-smoke` | PASS |
| Admin redirect regression | `curl -L -D ... https://wekruit-pa.web.app/j/s4-smoke` | HTTP 301 to candidate domain | first response HTTP 301 `location: https://candidate.wekruit.com/j/s4-smoke`, final HTTP 200 | PASS |
| Admin route live smoke | `curl -L https://wekruit-pa.web.app/admin/job-enrichment` | HTTP 200 after deploy | HTTP 200, final URL `https://wekruit-pa.web.app/admin/job-enrichment` | PASS |
| Deployed bundle smoke | fetch deployed admin JS bundle | dashboard contains S4 review page and callable names | deployed bundle contains `Job Enrichment Review`, `Reject draft`, and refresh/save/approve/reject callable names | PASS |
| No-outbound smoke | count `pa-outbound` before/after deployed route + CV smoke | no `pa-outbound` count change | before 190, after 190, delta 0 | PASS |
| Diff hygiene | `git diff --check` | no whitespace errors | passed | PASS |

## Hard Fail Conditions

- Candidate route moves to admin domain.
- Candidate can read admin-only enrichment review state.
- Employer can browse non-passed candidates.
- `sponsorship=false` is inferred from silence.
- `roleFunction` and `industrySector` are collapsed into one axis.
- Generated prescreen config is published as final without approval/confidence.
- S4 sends live outbound.
- Corrections are applied without append-only correction/flywheel evidence.
