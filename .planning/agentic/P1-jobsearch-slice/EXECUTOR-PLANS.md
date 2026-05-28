# P1 — EXECUTOR-PLANS

Lead orchestrated; disjoint scopes. Two read-only investigators + one bounded surgery executor + lead synthesis/verification.

## AGENT_PLAN — Executor R1 (routing-path research) · read-only · DONE
- Objective: end-to-end map of the current job-search routing (inbound dispatch, arbiter job_search owner, `handleCompletedUserJobSearchRequest`, `run(agent)` integration point, eval canary) + the delete/keep/risk list.
- Result: precise file:line map (dispatch L4593-4614; arbiter owner L289-299; handler L3486-3667; agent loop L5141; buildTurnTools L4068; find-match OFF because the seed/flags gate it). Surfaced the 3 risks (strict-schema 400, lost side-effects, multi-owner dispatch). Consumed by PLAN + the surgery.

## Lead (waves A + B-connector) · DONE
- Exclusive scope: `apps/eval/conversation-experience/agent-jobsearch-canary.mjs` (new), `packages/pa-connectors/src/match-connectors.ts` (Hermes description + strict-schema), `.planning/agentic/P1-*`.
- Built + proved the canary (3/3), the Hermes description, and the strict-schema unblock (verified via a real SDK find-match call — no 400).

## AGENT_PLAN — Executor S1 (flag-gated routing surgery) · bounded write · DONE
- Objective: wire the agent job-search path behind `paAgenticJobSearchEnabled` (default OFF); flag-OFF = byte-for-byte no-op.
- Exclusive write scope: `apps/functions/src/admin-bootstrap.ts` (flag seed), `packages/pa-orchestrator/src/shared-onboarding-outbound.ts` (`isAgenticJobSearchEnabled` + allowlist), `packages/pa-orchestrator/src/index.ts` (dispatch-skip + system-prompt directive + toolPolicy guarantee). Forbidden: eval files, prescreen/onboarding, unrelated owners, NO deletion.
- Result: 3 files, +65/-3. Flag-OFF no-op verified. Lead reviewed the full diff (correct) + independently re-ran all gates green.

## Lead verification (trust-but-verify)
- Reviewed `git diff` of all 3 surgery files line-by-line; confirmed every flag-ON branch short-circuits to current behavior when OFF.
- Independently re-ran: process-intact 5/5, arbiter canary PASS, agent-path canary GREEN, + full regression (SUMMARY).
