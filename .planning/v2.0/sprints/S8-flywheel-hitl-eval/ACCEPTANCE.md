# S8 Acceptance - Flywheel + HITL + Eval

S8 is complete only when a correction/outcome flywheel is visible, tested, and
verified without live outbound side effects.

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S8-flywheel-hitl-eval` | `codex/v2-S8-flywheel-hitl-eval` | PASS |
| Base | `git log --oneline -1 main` | includes S7 merge `2c48792` | `2c48792 feat(v2): add S7 first-interview passed surface (#32)` | PASS |
| Executor plans | collect and integrate AGENT_PLAN outputs | no code before plans | A-E plans recorded in `EXECUTOR-PLANS.md`; integration note added to `PLAN.md` before product code edits | PASS |
| Core contracts | `pnpm --filter @pa/core-types test`; `pnpm --filter @pa/core-types typecheck` | event/artifact schemas pass | test: 76 pass / 0 fail; typecheck passed | PASS |
| Persistence | `pnpm --filter @pa/pa-persistence test`; `pnpm --filter @pa/pa-persistence typecheck` | append-only event/artifact writers pass | test: 146 pass / 0 fail; typecheck passed | PASS |
| Functions focused | `node --import tsx --test apps/functions/src/__tests__/flywheel-eval.test.ts apps/functions/src/__tests__/flywheel-candidate-correction.test.ts` | correction -> artifact, feedback emission, simulation pass | 6 pass / 0 fail | PASS |
| Dashboard focused | `pnpm --filter @pa/dashboard-web test -- FlywheelEval` | flywheel/eval surface renders read-only status and links | 63 pass / 0 fail | PASS |
| Candidate focused | `apps/functions/node_modules/.bin/tsx --test apps/pa-landing/src/lib/candidate-profile-correction.test.ts` | correction path calls redacted candidate correction callable | 2 pass / 0 fail; rerun escalated after sandbox pipe EPERM | PASS |
| S8 eval harness | `pnpm --dir tests/eval/s8-flywheel-hitl-eval test` | full marketplace sim + safety eval pass | 10 pass / 0 fail / 0 skip | PASS |
| Static/safety guards | S8 static guard inside `pnpm --dir tests/eval/s8-flywheel-hitl-eval test` | no raw PII artifacts, no broad employer browsing, no live outbound | `S8 static guard passed (18 files scanned).` | PASS |
| Regression subset | `node --import tsx --test tests/eval/s5-two-way-matching/*.test.ts`; `node --import tsx --test tests/eval/s6-outreach-platform/*.test.ts`; `node --import tsx --test tests/eval/s7-first-interview-passed-surface/*.test.ts` | previous marketplace locks preserved | S5: 3 pass / 0 fail; S6: 23 pass / 0 fail; S7: 6 pass / 0 fail | PASS |
| Build/typecheck | functions/dashboard/landing touched packages | functions/dashboard/landing compile | functions typecheck/build/test passed; dashboard typecheck/build passed; landing build passed | PASS |
| Diff whitespace | `git diff --check` | no whitespace errors | passed before deploy/doc closeout | PASS |
| Deploy | `env PA_DASHBOARD_VITE_ENV_FILE=apps/dashboard-web/.env.pa-firebase-generated VITE_CV_INGEST_URL=https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest FIREBASE_CLI_SKIP_UPDATE_CHECK=1 ./node_modules/.bin/firebase deploy --only functions,hosting:pa-dashboard,hosting:pa-landing --project wekruit-5f89b --non-interactive` | deploy complete | PASS. First combined attempt stopped before upload on missing dashboard Vite env; generated gitignored Firebase web config and final deploy completed. Created `paAdminFlywheelEvalSnapshot`, `paCandidateProfileCorrection`, `paFlywheelCorrectionEvalArtifact`; released `https://wekruit-pa.web.app` and `https://wekruit-pa-landing.web.app`. | PASS |
| Live non-sending smoke | route/auth/count checks | no live outbound writes | PASS. `candidate.wekruit.com/j/5063962007` 200; `candidate.wekruit.com/me/profile` 200; `wekruit-pa.web.app/admin/flywheel-eval` 200; admin `/j/5063962007` 301 -> candidate domain; unauth `paAdminFlywheelEvalSnapshot` 403; unauth `paCandidateProfileCorrection` 401; Firestore counts stayed `pa-outbound 190 -> 190`, `pa-outbound-invites 0 -> 0`, `pa-eval-artifacts 0 -> 0`, `pa-correction-events 0 -> 0`, `pa-feedback-events 0 -> 0`. | PASS |

## Hard Fail Conditions

- Any employer/admin surface can query or browse non-passed candidates.
- Any eval artifact stores raw email, phone, LinkedIn URL, resume storage URI,
  or raw transcript text.
- Any S8 harness sends live Sendblue/Instantly/LinkedIn outreach.
- Candidate routes move to admin hosting.
- A correction mutates state without writing an auditable correction event.
