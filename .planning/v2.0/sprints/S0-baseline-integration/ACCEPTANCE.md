# S0 Acceptance

This file records S0 verification. Fill `Actual result` and `Status` when the
checks are run.

## Required Checks

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `claude/frosty-wozniak-84b965` | `claude/frosty-wozniak-84b965` | PASS |
| Dirty state | `git status --short` | S0 docs/planning files only | S0 docs/planning files only at plan creation | PASS |
| Orchestrator tests | `pnpm --filter pa-orchestrator test` | all pass, prior baseline 1479/1479 | pending rerun | PENDING |
| Functions tests | `cd apps/functions && pnpm test` | all pass, prior baseline 1143/1143 | pending rerun | PENDING |
| Candidate landing | `curl -sI https://candidate.wekruit.com/` | HTTP 200 | pending rerun | PENDING |
| Public job page | `curl -sI https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` | HTTP 200 | pending rerun | PENDING |
| Admin redirect | `curl -sI https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer` | HTTP 301 to candidate domain | pending rerun | PENDING |
| Public CV ingest validation | `curl -s -X POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest -H 'content-type: application/json' -d '{}'` | `{"ok":false,"reason":"missing_userId_or_tempUserId"}` | pending rerun | PENDING |
| Doc cross-reference | `rg -n "AUTONOMOUS-SPRINT-HARNESS|MILESTONE-v2.0|Product Blueprint" README.md CLAUDE.md AGENTS.md .planning/MILESTONE-v2.0-candidate-retention-marketplace.md .planning/AUTONOMOUS-SPRINT-HARNESS.md` | all canonical docs point to blueprint, roadmap, harness | pending final check | PENDING |

## Hard Fail Conditions

- Candidate route appears on admin domain as primary route.
- First interview is blocked by match score.
- Employer sees a not-passed candidate.
- Raw PII is used as public document id.
- Live outbound is sent during S0.
- Costed eval/live run starts during S0.
- Runtime code is edited without updating S0 plan.

## Evidence

Branch:

```text
claude/frosty-wozniak-84b965
```

Initial dirty state:

```text
M .planning/MILESTONE-v2.0-candidate-retention-marketplace.md
M AGENTS.md
M CLAUDE.md
M README.md
?? .planning/AUTONOMOUS-SPRINT-HARNESS.md
?? .planning/v2.0/sprints/S0-baseline-integration/
```

Remaining evidence pending rerun.

