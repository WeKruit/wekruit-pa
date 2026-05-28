# Agentic rebuild — merge runbook (P0→P8)

Status: all 9 PRs built, tested, SELF-REVIEWed, `MERGEABLE/CLEAN` vs their base.
**Adam chose "hold for review" (2026-05-28)** — nothing is merged. This is the
landing plan for a human/reviewer (or a future approved session).

## Stack topology

```
main
 └─ P0 #251  claude/agentic-P0-eval-foundation   (base = main, CI: UNSTABLE)
     ├─ P1 #253  jobsearch-slice
     ├─ P2 #254  interaction-layer
     ├─ P3 #255  prescreen
     ├─ P4 #256  onboarding
     ├─ P5 #257  connector-hardening
     ├─ P6 #259  voice-collapse
     ├─ P7 #258  scaling-proof
     └─ P8 #260  safety-guardrails
```

P1–P8 are **siblings off the same P0 tip**, NOT a chain. Each is clean vs P0, but
they are NOT clean vs each other — sequential landing will conflict (below).

## Pre-flight
1. **P0 CI is `UNSTABLE`** — investigate/clear the failing-or-pending check on
   #251 before it lands first. (It's eval-harness infra; likely a non-required
   check, but confirm.)
2. Node 24 for every gate: `source ~/.zshrc && nvm use 24`.
3. This is a **production-Claire** change (conversation/prescreen/voice/safety
   runtime). Per CLAUDE.md, deploy AFTER merge, minimum scope, then live-smoke.

## Merge order + method
Land P0 to `main` first, then retarget each sibling to `main` and merge in phase
order (P1→P2→P3→P4→P5→P6→P7→P8). After each retarget, re-run gates and resolve
conflicts before merging the next.

```
# 0. P0 → main (once CI green)
gh pr merge 251 --merge        # or squash per repo norm

# 1..8. for each sibling, in order:
gh pr edit <N> --base main     # retarget off the now-merged P0
#   resolve conflicts (see below), push, re-run gates, then:
gh pr merge <N> --merge
```

## Expected conflicts (the ONLY cross-sibling ones)
- **`packages/pa-orchestrator/src/index.ts`** — touched by **P1, P4, P6**.
  - P1/P4 inject (different) flag-gated blocks; P6 *deletes* the mixed-register
    block + an import + 2 comments. Resolve by keeping all three edits (the P6
    deletion does not overlap P1/P4 insertions — they're different regions, but
    git will flag adjacent-hunk conflicts). Verify the import list + the post-gen
    cascade region after merge.
- **`packages/pa-orchestrator/package.json`** (the explicit `test` file list) —
  touched by **P6, P8**.
  - P6 *removes* `src/voice/mixed-register-mirror.test.ts`; P8 *adds*
    `src/guardrails/__tests__/sdk-input-guardrails.test.ts`. Union both edits on
    the one-line list (remove the P6 entry, keep the P8 entry).

Everything else (eval runners, pa-connectors, prescreen/onboarding agentic-turn
modules, fixtures) is touched by ≤1 sibling → no cross-sibling conflict.

## Per-step gate (run after each merge/conflict-resolution, before the next)
```
source ~/.zshrc && nvm use 24
pnpm --filter @pa/agent-runtime test          # expect 62/62
pnpm --filter pa-orchestrator build           # tsc clean (also rebuilds dist for the evals)
pnpm --filter pa-orchestrator test            # expect 0 fail (count grows as phases stack)
pnpm --filter @pa/functions test              # expect 0 fail
node apps/eval/conversation-experience/process-intact-runner.mjs   # 5/5 (6/6 once P3 is in)
# advisory (real key + Firebase in .env; costs cents):
node apps/eval/conversation-experience/bfcl-runner.mjs
node apps/eval/conversation-experience/voice-collapse-runner.mjs
```

## Deferred Adam-gated decisions to make DURING/AFTER landing
These were intentionally NOT done in-PR (locks + safety). Decide per phase:
- **P1–P5 staged deletions** — ramp-then-delete vs delete-now for the
  flag-gated-OFF legacy paths replaced by connectors/agentic turns.
- **P6 ab-framework** — eval cleared it (0/12), but `stripABFramework` is reused
  by the agentic `guardrails/output/ab-strip.ts`. Removal = drop only the *legacy*
  index.ts post-gen invocation once that agentic guardrail is confirmed live.
  (ab-probe / phrase-repeat / am-i-ai stay — eval proved load-bearing / oracle gap.)
- **P8 legacy `checkInboundSafety` retirement** — the production-safety cutover.
  Wire `buildSafetyInputGuardrails` onto the agentic turn context (one-line,
  flag-gated), confirm the agentic path is live + parity (incl. closing the PII
  gap), THEN retire the legacy pre-filter. Do not delete authoritative safety first.

## Deploy (after merge, per CLAUDE.md — separate approval)
```
cd apps/functions && pnpm run deploy      # predeploy gate must pass
# then live-smoke +1 (717) 491-9939 and paste Firestore + transcript proof
```
