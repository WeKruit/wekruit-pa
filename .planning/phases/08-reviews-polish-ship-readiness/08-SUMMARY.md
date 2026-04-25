# Phase 8 Summary: Reviews, polish, and ship readiness

## Verification Evidence

Passed:

```bash
npm test
npm run build
npm run typecheck
npm run build --workspace=@pa/dashboard-web
```

Current automated test baseline: 33 passing tests across worker, agent registry, memory, broker, orchestrator, and safety.

## Engineering Review

Findings resolved during this autonomous pass:
- Orchestrator was hard to test because OpenAI runtime calls were static imports. Fixed with a small deps seam.
- Outbound allowlist mismatch could leave jobs stuck in `sending`. Fixed by marking the job `failed`.
- Scheduled job/heartbeat runtime state did not exist. Added Firestore-backed primitives and tests.
- Agent default switching needed guardrails for known failed model probes. Added helper and tests.

## Design Review

Code-level design review findings resolved:
- Raw root route replaced by Overview.
- Side nav has active state and responsive behavior.
- Conversation list has search/filter/latest/error affordances.
- Reusable UI primitives now cover headers, panels, badges, empty/error/loading states, and tables.

Not run:
- Full `gstack-design-review` live screenshot/fix loop. Blocked by dirty working tree and no explicit commit permission.

## Remaining Non-Code Gaps

- Official target slug is `gpt-5.4-nano`; the earlier 404 was for the wrong `gpt5.4nano` string. Do not make it default until the official slug probe passes.
- ATM default profile still returns `Unsupported runtime profile "personal-assistant-default"`.
- Vite build warns main dashboard chunk is larger than 500 kB; functional but should be split before production hardening.
- Browser-authenticated visual QA screenshots still need a clean-tree review pass.
