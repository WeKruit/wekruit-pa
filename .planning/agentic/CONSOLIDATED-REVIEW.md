# Agentic rebuild — consolidated self-review (pre-Adam)

Method: **Round 1** = 9 parallel code-reviewer subagents, one per PR, each checking
the diff against the architecture locks. **Round 2** = direct code verification of
the two concrete defects + cross-PR conflict mapping. Done before handing to Adam.

## Headline
- **Every flag-ON agentic path is DEFAULT-OFF → zero production regression today.**
  Landing the stack with flags off is low *runtime* risk (it's an 8-way merge, see runbook).
- **No flag-ON agentic path is RAMP-READY yet** — each is functionally incomplete
  and/or under-tested on the ON side.
- **2 confirmed code defects**, both in flag-OFF / not-live-wired paths → must-fix
  **before ramp/live-wire**, NOT production-breaking now.

## Per-PR verdicts
| PR | Phase | Verdict | Default-OFF no-op? |
|----|-------|---------|--------------------|
| #251 | P0 eval foundation | **SHIP-READY** | n/a (eval infra; real seam verified genuine). CI UNSTABLE = a *queued* check, not a fail |
| #253 | P1 jobsearch slice | NEEDS-CHANGES | yes (verified) — flag-ON drops post-match retention + profile-update persist |
| #254 | P2 interaction layer | NEEDS-CHANGES | yes — reflex quick-ack typing-pulse half-wired; PR body claims a test that doesn't exist |
| #255 | P3 prescreen | **NEEDS-CHANGES (keystone)** | yes — see Defect 1 |
| #256 | P4 onboarding | NEEDS-CHANGES | yes — tangent answer never surfaced; real export untested (canary reimplements inline) |
| #257 | P5 connector hardening | SHIP-READY | yes (verified) — but role-avoidance not structurally guaranteed (see Themes) |
| #259 | P6 voice collapse | SHIP-READY | n/a — deletion verified a true no-op; lock #2 honored (ab-framework kept for guardrail dep) |
| #258 | P7 scaling proof | NEEDS-CHANGES | n/a — see Defect 2 |
| #260 | P8 safety guardrails | SHIP-READY | yes (verified) — dead until wired live; track the PII gap |

## Confirmed defects (verified by reading the code, Round 2)
1. **P3 keystone — multi-record question-skip/fabrication** (`apps/functions/src/prescreen-agentic-turn.ts:155`, `toolChoice:"auto"` at :193). `record_prescreen_answer.execute` calls the real `PreScreenPipeline.runTurn` (scores + advances qOrder) on **every** invocation, keeping only the last result. Under `toolChoice:auto` the model can call it ≥2× per turn → the FSM advances through multiple questions, scoring later ones against text the candidate never sent. The agent still can't self-assign PASS/FAIL or write the terminal (those stay deterministic), so it's a *partial* keystone breach — but it skips/fabricates answers. **Fix:** record at most once per turn (`if (box.recorded) return cached`) + a canary assert of exactly one record call. Flag-OFF/not-live → not production-active.
2. **P7 idempotency — non-atomic dedup race** (`packages/pa-connectors/src/schedule-connector.ts:59-72`). Dedup is read-then-write (`await ref.get()`; if `!exists` then `await ref.set()`) — two concurrent same-user×job turns both read `!exists` → double-book. The repo pattern is `runTransaction`; simplest fix is `ref.create()` (atomic, throws if exists). Undermines the very "dedup/idempotency" property this phase exists to prove. Test covers sequential replay only. Not live-wired (eval allowlist only).

## Cross-cutting themes
- **flag-ON incompleteness** is the dominant pattern: P1 (retention/profile-persist dropped), P2 (typing-pulse asymmetry), P3 (multi-record), P4 (tangent reply never surfaced). All correctly default-OFF, so safe to merge but not to ramp.
- **eval-fidelity gaps:** P3/P4 canaries don't assert exact-once / P4's canary reimplements the agent inline instead of importing the real `runAgenticOnboardingTurn` — the gate can pass while the shipped code diverges. P3/P4 handler branches aren't in the deterministic process-intact gate.
- **P5 role-avoidance not structural:** the actual live-smoke root cause ("avoid SWE" kept SWE) is mitigated only by the LLM re-emitting a positive list without swe (field-level replace, not value-removal); `full_time`-when-implied is model-dependent. The industry negative axis is clean, but there's no `roleFunctionNegativeList`. Consider a structured role-negative axis as the durable fix.
- **PR-body inaccuracies to correct:** P1 + P2 claim a test that isn't present; P6 says the eval "blocked 3 unsafe deletions" (it blocked 2, cleared 1 — the commit is correct).

## My-own-work check
P6 (#259) and P8 (#260), authored this session, were reviewed skeptically by an
independent agent and verified sound (true no-op deletion + lock #2 honored; SDK
`runInParallel:false` halts before the model; empty-guardrails = real no-op).

## Recommendation
- **Merge (flags OFF):** acceptable runtime risk once P0 CI is green + the 8-way
  conflicts are resolved per `MERGE-RUNBOOK.md`. This banks the foundation without
  changing Claire's behavior. (Still your call — the stack is on hold-for-review.)
- **Do NOT ramp any agentic flag** until: P3 multi-record guard + test; P7 atomic
  dedup; P1 retention/profile re-home; P2/P4 completeness + real-export canaries.
- **P8 PII gap:** wiring the SDK guardrails live + retiring legacy `checkInboundSafety`
  is the only path that closes the never-enforced SSN/CC gate — track it.
