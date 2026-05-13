# S0 Baseline Integration Context

**Sprint:** S0 - Baseline Integration.
**Date:** 2026-05-13.
**Harness:** `.planning/AUTONOMOUS-SPRINT-HARNESS.md`.
**Roadmap:** `.planning/MILESTONE-v2.0-candidate-retention-marketplace.md`.

## Purpose

S0 makes the v1.9 baseline safe for autonomous v2.0 execution. A future
`/goal` lead should be able to start S1 by reading repo files, without relying
on hidden thread context.

## Current Worktree

Active worktree:

```text
/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/frosty-wozniak-84b965
```

Current branch:

```text
claude/frosty-wozniak-84b965
```

Recent commits:

```text
f356e69 docs(v2.0): Adam-authored Candidate Retention Marketplace product lock + README blueprint
fce46ae v1.9 hotfix - PrescreenTrigger pending-invite binding (Q1 reply drop-to-Claire fix)
24bf963 docs - full product handoff brief for incoming lead agent (HANDOFF-TO-LEAD-2026-05-13.md)
a95ecc8 docs - domain split lock + canonical URLs across CLAUDE.md / AGENTS.md / V19 test guides
8ad0375 v1.9 hotfix - candidate flow LIVES on pa-landing (Adam: "c端都在这个上面")
```

Current dirty files are planning/docs only for this sprint setup:

```text
M  .planning/MILESTONE-v2.0-candidate-retention-marketplace.md
M  AGENTS.md
M  CLAUDE.md
M  README.md
?? .planning/AUTONOMOUS-SPRINT-HARNESS.md
?? .planning/v2.0/sprints/S0-baseline-integration/
```

If future `git status` shows runtime files, the S0 lead must classify them as:

- in-scope for S0
- user/other-agent changes to preserve
- unrelated dirty state to ignore

Never revert unrelated changes.

## Last Known Green Baseline

From `.planning/HANDOFF-TO-LEAD-2026-05-13.md` and current lead sanity pass:

- `pnpm --filter pa-orchestrator test` passed in v1.9 worktree: 1479/1479.
- `cd apps/functions && pnpm test` passed in v1.9 worktree: 1143/1143.
- `https://candidate.wekruit.com/` returned 200.
- `https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` returned 200.
- `https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer` redirected to candidate domain.
- `paPublicCvIngest` empty JSON returned `{"ok":false,"reason":"missing_userId_or_tempUserId"}`.

S0 must re-run and record these checks before S1 implementation starts.

## Locked Product Invariants

1. Candidate is the durable asset. Job is a demand event.
2. Global candidate profile owns mem0, tags, PII, Level 1 info, YoE, industry,
   salary range, location preference, visa, company size, resume, LinkedIn, and
   conversation-derived preferences.
3. Job-specific state owns match score, outbound invite, prescreen, outcome,
   employer-visible snapshot, and next-stage state.
4. Match score never blocks the first interview.
5. NOT_PASS keeps the candidate in the global marketplace.
6. Employer dashboard shows passed candidate profiles only.
7. Candidate flow stays on `candidate.wekruit.com` / `pa.wekruit.com`, not admin.
8. User tags and job tags share canonical vocab.
9. HITL corrections become eval/regression/flywheel data.
10. Sendblue outreach must be capacity-aware, cooldown-aware, opt-out-aware, and
    sticky by candidate/account.

## Relevant Files

Must read:

- `README.md`
- `CLAUDE.md`
- `AGENTS.md`
- `.planning/HANDOFF-TO-LEAD-2026-05-13.md`
- `.planning/MILESTONE-v2.0-candidate-retention-marketplace.md`
- `.planning/AUTONOMOUS-SPRINT-HARNESS.md`
- `.planning/V19-FULL-FLOW-TEST.md`
- `firebase.json`
- `apps/functions/package.json`
- `packages/pa-orchestrator/package.json`

Likely read-only orientation files:

- `apps/functions/src/public-cv-ingest.ts`
- `apps/functions/src/sendblue/webhook.ts`
- `packages/pa-orchestrator/src/prescreen`
- `packages/pa-orchestrator/src/pii`
- `apps/pa-landing`
- `apps/dashboard-web`
- `packages/shared-tags`

## S0 Non-Goals

- Do not implement S1 data models yet.
- Do not change candidate flow.
- Do not change Sendblue routing.
- Do not change match scoring.
- Do not change employer dashboard scope.
- Do not deploy unless a S0 verification discovers a doc/config drift requiring
  a minimal fix and Adam approves that action.

## S0 Completion Bar

S0 is complete when:

1. `CONTEXT.md`, `PLAN.md`, `EXECUTOR-PLANS.md`, `ACCEPTANCE.md`, and
   `SUMMARY.md` exist.
2. The six v1.9 sanity checks are re-run and recorded.
3. Dirty state is classified.
4. The v2.0 roadmap and autonomous harness references are consistent.
5. S1 entry criteria are explicit.
6. A future `/goal` agent can continue from S1 without asking what the baseline is.

