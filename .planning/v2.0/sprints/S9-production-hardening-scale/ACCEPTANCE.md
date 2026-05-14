# S9 Acceptance - Production Hardening + Scale

S9 is complete only when launch readiness is visible, privacy and stop controls
are auditable, and live smoke/load checks prove no accidental outbound or
destructive privacy action.

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S9-production-hardening-scale` | `codex/v2-S9-production-hardening-scale` | PASS |
| Base | `git log --oneline -1` | includes S8 merge `90aaf29` | `90aaf29 feat(v2): add S8 flywheel HITL eval (#33)` | PASS |
| Executor plans | collect and integrate AGENT_PLAN outputs | no product code before plans | pending | PENDING |
| Contracts | core-types/persistence tests | privacy/readiness/stop schemas and writers pass | pending | PENDING |
| Functions | focused S9 function tests | privacy request, readiness snapshot, stop gates pass | pending | PENDING |
| Admin UI | focused dashboard tests | `/admin/launch-readiness` renders actionable redacted state | pending | PENDING |
| Candidate UI | focused landing tests | candidate privacy/export/delete/stop request path writes request only | pending | PENDING |
| S9 eval/static harness | `pnpm --dir tests/eval/s9-production-hardening-scale test` | dry-run launch harness, no outbound, no destructive delete, no PII artifacts | pending | PENDING |
| Regression subset | S5/S6/S7/S8 eval subset | previous marketplace locks preserved | pending | PENDING |
| Build/typecheck | touched packages | functions/dashboard/landing compile | pending | PENDING |
| Deploy | Firebase deploy if changed | deploy complete | pending | PENDING |
| Live no-contact smoke | route/auth/count checks | no outbound writes, no destructive privacy action | pending | PENDING |

## Hard Fail Conditions

- Any test or smoke sends live outreach without explicit approval.
- Any delete/export path destructively mutates production data without explicit
  approval.
- Any readiness artifact includes raw email, phone, LinkedIn URL, resume storage
  URI, or raw transcript text.
- Any admin/employer link opens non-passed candidate browsing.
- Candidate routes move to admin hosting.
- Stop-control state is not checked before outbound enqueue/send.
