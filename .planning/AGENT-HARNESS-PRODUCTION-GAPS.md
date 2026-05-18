# Agent Harness Production Gaps

This is the current gap list before broad, non-allowlisted production use.

## Business Testing Decision

Business/internal testing can start now if it is framed as controlled beta testing:

- Use allowlisted testers only.
- Use a small number of known test phone numbers.
- Tell testers this is a live beta and ask them to report confusing replies, missing links, unsafe behavior, duplicate messages, and stuck states.
- Do not open this to public user acquisition traffic until the hardening gates below pass.

## Source Of Truth / Branch Hygiene

- `main` has the latest Claire iMessage fixes for job recommendations, URLs, requirements, prescreen session handling, and live evidence docs.
- Current voice/runtime branches must merge or rebase `main` before any deploy.
- Do not deploy from stale branches that do not include the shared job recommendation formatter/session fixes.

## Missing Production Proof

1. Staging concurrency stress proof is not current.
   - Run `apps/stress` Artillery scenarios against staging.
   - Required scenarios: inbound burst, upstream webhook flood, downstream fire.
   - Record p50/p95/p99, 2xx/429/5xx split, Firestore transaction errors, duplicate sends, and queue lag.

2. Prescreen Firestore stress proof needs a fresh run.
   - Run `apps/functions/scripts/prescreen-stress-firestore.ts` with Node 24.
   - Required scenarios: strong PASS, adjacent recovery PASS, fragmented multi-message PASS, weak HARD_STOP, user-exit PAUSE.
   - Verify session terminal, workSession boundary, memory event, candidate-job state, and employer-visible snapshot.

3. Safety/guardian flag state needs current proof.
   - Verify which flags are ON/OFF for prompt injection, illegal content, rate abuse, privacy, stop controls, allowlist, quota, and outbound suppression.
   - Confirm blocked/suppressed cases do not create tapbacks or extra outbound messages.

4. Live iMessage business-test matrix needs a fresh clean run for a non-Adam tester.
   - Normal onboarding.
   - Layoff onboarding.
   - Job prescreen PASS.
   - Job prescreen adjacent/probing.
   - Job prescreen HARD_STOP after repeated probing.
   - Pause/stop/start.
   - Job recommendation request with URLs and requirements.
   - Privacy/export/delete-memory question.
   - Random off-topic question during onboarding/prescreen.

5. Observability is not yet operator-grade.
   - Firestore/log proof exists, but business users need an admin view that shows: current session owner, current question/state, last user messages, last Claire messages, terminal state, safety blocks, memory writes, job-rec sends, and outbound delivery status.
   - Missing or confusing dashboard visibility should be treated as a production blocker for operators, even if backend state is correct.

6. Voice runtime must prove parity before being mixed into production.
   - Voice branch must include latest `main`.
   - Voice must use the same session/state/contracts as SMS.
   - Voice must not create a separate memory/session path that can conflict with iMessage.
   - Required proof: same prescreen scenarios over voice produce equivalent state transitions and safe terminal behavior.

7. Rollout/runbook is incomplete for public traffic.
   - Need one page with: enable flags, rollback flags, emergency stop, quota checks, Sendblue health checks, Firestore checks, and exact commands to inspect failed sessions.
   - Need daily monitoring checklist for first week of beta.

8. Security/dependency backlog exists.
   - GitHub reported dependency vulnerabilities on default branch during push.
   - This is not blocking controlled testing, but it is a blocker for broad production confidence.

## Minimum Gate For Broad Production

Do not call the harness production-ready for public users until all are true:

- `main` is merged into active deploy branches.
- Node 24 tests pass for functions, orchestrator, agent runtime, and safety.
- Staging Artillery stress run passes thresholds with no unexpected 5xx.
- Prescreen Firestore stress run passes all five scenarios.
- Fresh live iMessage matrix passes with one non-Adam business tester.
- Dashboard/operator observability shows enough state to debug without direct Firestore.
- Safety flags and suppression behavior are verified live.
- Rollback and emergency stop runbook exists.
