# Phase 61: QA evaluator weekly (SHIP GATE) - Context

**Gathered:** 2026-05-06
**Status:** Shipped 2026-05-06 (`12a5934`). Verified: [.planning/v1.6-MILESTONE-AUDIT.md](../../v1.6-MILESTONE-AUDIT.md).
**Mode:** Decisions D13 locked. **THIS IS THE V1.6 FINAL SHIP GATE**.

<domain>
## Phase Boundary

Cloud Scheduler `paQaEvaluatorWeekly` runs Mon 09:00 UTC, samples 100 user×match pairs, computes hard-filter pass + top-3 acceptable rate via Qwen-7B (D13). Surfaced via `/admin/qa-evaluator` (Phase 59). Slack/email alert if pass <90%/70%. Failure-loop: failing pairs → priority queue, next-week run re-evaluates same users; until pass ≥90%/70%, milestone NOT shipped.

**REQ-IDs:** QA-01, QA-02, QA-03, QA-04, QA-05 (5)

**In scope:**
- New CF `paQaEvaluatorWeekly` Cloud Scheduler 09:00 UTC Mondays
- Sampling logic: 100 user×match pairs from active users with tags
- Per-pair Qwen-7B judge: hard-filter pass + top-3 acceptable
- Output `pa-qa-evaluator-runs/{runId}` with full sample + per-pair score + summary
- Alert via existing notification path (Slack webhook URL in env, email via Mailgun)
- Failure-loop: priority queue persists failing user×match pairs, next run re-evaluates

**Out of scope:**
- Documentation (Phase 62)
- Real-time match notifications (REQUIREMENTS line 120 — out of scope)

</domain>

<decisions>
## Implementation Decisions

### Schedule (QA-01)
- Cron: `0 9 * * 1` (Monday 09:00 UTC = Sunday 02:00 PT, before US workday)
- Timeout: 540s (9 min). 100 pairs × 3s/pair Qwen-7B = 300s comfortably
- Memory: 1GB
- Region: us-central1

### Sampling (QA-01)
- Read all `pa-users` with `tags.targetRoleFunction.length > 0`
- Random sample 100 user IDs (or all if fewer than 100)
- For each: query top-3 matches via queryMatchingJobsV16 (Phase 56)
- Write evaluation request: `{userId, jobId, userTags, jobSnapshot, expectedRoleFunction, expectedIndustrySector}`

### Judge prompt (QA-04)
- Qwen-7B JSON-mode (free, SiliconFlow)
- Grounded in candidate's `tags.targetRole` + `tags.relevantIndustry` + `tags.skills`
- Returns: `{ hardFilterPass: boolean, top3Acceptable: boolean, reasoning: string }`
- hardFilterPass: did the recommended job satisfy basic role/visa/location/freshness? (sanity check on Phase 56 hard filter)
- top3Acceptable: would a reasonable recruiter offer this job to this candidate? (semantic match check)

### Output (QA-02)
- Collection: `pa-qa-evaluator-runs/{runId}`
- Doc shape:
  ```ts
  {
    runId: string,
    runAt: string,  // ISO
    sampleSize: number,
    hardFilterPassRate: number,  // 0..1
    top3AcceptableRate: number,  // 0..1
    alertSent: boolean,
    pairs: [{
      userId: string,
      jobId: string,
      hardFilterPass: boolean,
      top3Acceptable: boolean,
      reasoning: string,
      evaluatedAt: string
    }],
    failingUserIds: string[],  // for next-week re-eval (QA-05)
  }
  ```

### Alert (QA-03)
- If hardFilterPassRate < 0.9 OR top3AcceptableRate < 0.7:
  - Slack post (webhook URL `PA_SLACK_ALERT_WEBHOOK` in env)
  - Email via Mailgun to `developers@wekruit.com`
  - Mark `alertSent: true` on run doc
- Alert message: `⚠ QA evaluator FAILED: hardFilter={pct}% (target ≥90%), top3Acceptable={pct}% (target ≥70%). Run: ...`

### Failure-loop (QA-05)
- Failing user×match pairs added to `pa-qa-priority-queue/{userId}` with TTL 8 days
- Next week's run starts by querying priority queue + adds 100 more samples (until queue clears)
- Until `hardFilterPassRate ≥ 0.9 AND top3AcceptableRate ≥ 0.7` for 2 consecutive runs, milestone marked `qa-failing`
- Audit: write `pa-milestones-state/{milestoneVersion}.qaShipGate` with `{ status: 'pass'|'fail', lastRunAt, lastRates }`

### Tests
- Unit tests for: sample selection, judge prompt schema, alert logic, failure-loop
- Integration test: mock Firestore + LLM, verify full run produces correct output shape
- Smoke test: run against tiny sample (5 users) in dev env

</decisions>

<code_context>
## Existing Code Insights

### Reusable
- `apps/functions/src/lib/llm-rerank.ts` — Qwen-7B JSON-mode wrapper (reuse pattern, NOT the rerank fn itself)
- `apps/functions/src/nightly-rerank.ts` — Phase 58 scheduled batch (mirror structure)
- `apps/functions/src/email/mailgun.ts` — existing email lib
- `apps/functions/src/lib/match-reason.ts` — existing match reasoning helper
- `apps/functions/src/liveness-sweep.ts` — Phase 57 scheduled batch with audit pattern

### Files to add
- `apps/functions/src/qa-evaluator-weekly.ts` — main CF
- `apps/functions/src/lib/qa-judge.ts` — Qwen-7B judge wrapper
- `apps/functions/src/__tests__/qa-evaluator-weekly.test.ts`
- `apps/functions/src/lib/__tests__/qa-judge.test.ts`

### Files to modify
- `apps/functions/src/index.ts` — register `paQaEvaluatorWeekly`
- Optionally `apps/dashboard-web/src/pages/QaEvaluator.tsx` — refine display per real run output (Phase 59 already has skeleton)

### Env / Secrets
- `SILICONFLOW_API_KEY` (Qwen-7B) — already provisioned (Phase 58)
- `PA_SLACK_ALERT_WEBHOOK` (optional, Slack alert) — provision if not present
- Mailgun env (existing)

</code_context>

<specifics>
## Specific Ideas

- Random sampling: Math.random pick 100 from active users (deterministic seed for testability)
- Judge: prompt template includes user.targetRoleFunction + user.skills + job.roleTitle + job.companyName + job.requiredSkills + job.industrySector
- Result aggregation: simple mean of {hardFilterPass: 0|1, top3Acceptable: 0|1}
- Alerting: only alert if previous run was alertSent: false (avoid spam)
- Priority queue clears when 2 consecutive runs pass thresholds

</specifics>

<deferred>
## Deferred Ideas

- Adversarial test suite (v1.7)
- Multi-judge ensemble (v1.7)
- Confidence intervals on rates (v1.7 — Wilson score)
- A/B testing harness for new prompt iterations (v1.7)

</deferred>
