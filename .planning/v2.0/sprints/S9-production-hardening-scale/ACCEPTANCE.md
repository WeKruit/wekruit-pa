# S9 Acceptance - Production Hardening + Scale

S9 is complete only when launch readiness is visible, privacy and stop controls
are auditable, and live smoke/load checks prove no accidental outbound or
destructive privacy action.

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S9-production-hardening-scale` | `codex/v2-S9-production-hardening-scale` | PASS |
| Base | `git log --oneline -1` | includes S8 merge `90aaf29` | `90aaf29 feat(v2): add S8 flywheel HITL eval (#33)` | PASS |
| Executor plans | collect and integrate AGENT_PLAN outputs | no product code before plans | A/B plans collected with subagents; C/D/E plans integrated locally; integration note added to `PLAN.md` before product code edits | PASS |
| Contracts | core-types/persistence tests | privacy/readiness/stop schemas and writers pass | `pnpm --filter @pa/core-types test` 79 pass; `pnpm --filter @pa/core-types typecheck` pass; `pnpm --filter @pa/pa-persistence test` 150 pass; `pnpm --filter @pa/pa-persistence typecheck` pass | PASS |
| Functions | function tests | privacy request, readiness snapshot, stop gates pass | `pnpm --filter @pa/functions test` 1346 pass; `pnpm --filter @pa/functions typecheck` pass | PASS |
| Admin UI | dashboard tests | `/admin/launch-readiness` renders actionable redacted state | `pnpm --filter @pa/dashboard-web test` 67 pass; route/nav guard confirms no `/j/:jobId` admin route | PASS |
| Candidate UI | landing tests | candidate privacy/export/delete/stop request path writes request only | `node --import tsx --test apps/pa-landing/src/lib/candidate-privacy-request.test.ts` 2 pass; `pnpm --filter @pa/landing typecheck` pass | PASS |
| S9 eval/static harness | `pnpm --dir tests/eval/s9-production-hardening-scale test` | dry-run launch harness, no outbound, no destructive delete, no PII artifacts | 5 pass; static guard scanned 20 files | PASS |
| Regression subset | S5/S6/S7/S8 eval subset | previous marketplace locks preserved | S5 3 pass; S6 23 pass; S7 6 pass; S8 10 pass + static guard | PASS |
| Build/typecheck | touched packages | functions/dashboard/landing compile | `pnpm --filter @pa/functions build` pass; `pnpm --filter @pa/dashboard-web build` pass with existing bundle-size warnings; `pnpm --filter @pa/landing build` pass with existing bundle-size warning; `git diff --check` pass | PASS |
| Deploy | Firebase deploy if changed | deploy complete | `firebase deploy --only functions,hosting:pa-dashboard,hosting:pa-landing --project wekruit-5f89b --non-interactive` completed. New S9 callables created; dashboard and landing hosting released. | PASS |
| Live no-contact smoke | route/auth/count checks | no outbound writes, no destructive privacy action | `live-no-contact-smoke-2026-05-14.json`: candidate `/`, candidate `/j/s9-smoke-route-only`, candidate `/me/profile`, and admin `/admin/launch-readiness` returned 200; unauth callables rejected 401/403; `pa-outbound` stayed `190 -> 190`; privacy/readiness/stop-control collections stayed `0 -> 0`. | PASS |

## Hard Fail Conditions

- Any test or smoke sends live outreach without explicit approval.
- Any delete/export path destructively mutates production data without explicit
  approval.
- Any readiness artifact includes raw email, phone, LinkedIn URL, resume storage
  URI, or raw transcript text.
- Any admin/employer link opens non-passed candidate browsing.
- Candidate routes move to admin hosting.
- Stop-control state is not checked before outbound enqueue/send.
