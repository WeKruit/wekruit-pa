# P0 — Two-layer eval foundation · SUMMARY (baseline receipt = the contract)

**Branch:** `claude/agentic-P0-eval-foundation` off `origin/main` `883d7d45`. **Node 24.3.0.**
P0 adds eval scaffolding only — **zero** `packages/**` / `apps/functions/**` source modified, **nothing deleted**. The deletions begin in P1 and are gated by the baseline frozen here.

## What shipped

```
apps/eval/conversation-experience/
  harness-lib.mjs                 # shared: dotenv, fixture load, placeholders, dist import
  process-intact-runner.mjs       # LAYER 1 — deterministic HARD gate (exit code)
  process-fixtures/*.json         # 5 fixtures (prescreen ×2, onboarding, trigger, idempotency)
  bfcl-runner.mjs                 # LAYER 2 — real @openai/agents tool-choice/abstention/delivery (advisory)
  bfcl-fixtures/*.json            # 7 fixtures
  runner.mjs, llm-runner.mjs      # (seed) arbiter canary + real extraction — kept
  README.md                       # two-layer eval section
firebase.json                     # process-intact + arbiter canary added to functions predeploy (blocking)
```

## Baseline receipt — run against CURRENT code (`883d7d45`). This is the contract every later phase must not regress.

### Layer 1 — process-intact (DETERMINISTIC GATE) — `exit 0`
```
PASS  01-prescreen-full-question-set.json  [prescreen_fsm]      — all Qs asked, no-skip, PASS once
PASS  02-prescreen-hardstop-no-skip.json   [prescreen_fsm]      — HARD_STOP, later Q not reached, terminal once
PASS  03-onboarding-slot-order.json        [onboarding_slots]   — 5 slots canonical order, no skip, durable projection
PASS  04-trigger-prescreen-routing.json    [trigger]            — production PRESCREEN_RE parse + routing
PASS  05-candidate-job-idempotency.json    [candidate_job_idempotency] — terminal commit-once + dedup
process-intact: 5/5 fixtures green
```
Arbiter-decision canary (`runner.mjs`): `PASS avoid-swe-after-onboarding.json (2 turns)` — `exit 0`.

### Layer 2 — conversation-quality (REAL `gpt-5.4-nano`, ADVISORY) — non-blocking
BFCL (`bfcl-runner.mjs`):
```
MISS 01-toolchoice-find-match-en.json   [tool_choice]  — model ABSTAINED on explicit EN "find me SWE jobs"
ok   02-toolchoice-find-match-zh.json   [tool_choice]  — called find-match ✓
ok   03-toolchoice-set-preference.json  [tool_choice]  — called set-matching-preferences ✓
ok   04-abstention-chitchat.json        [abstention]   — abstained ✓
ok   05-abstention-onboarding-prescreen-tangent.json [abstention] — abstained ✓ (context-bridge tangent)
ok   06-delivery-low-info-ack.json      [delivery]     — tapback ✓
ok   07-delivery-substantive.json       [delivery]     — text ✓

  tool-choice accuracy : 2/3 (67%)
  abstention accuracy  : 2/2 (100%)
  delivery accuracy    : 2/2 (100%)
```
Extraction / answer-capture (`llm-runner.mjs`): **3/3 deterministic gate PASS** (`avoid-swe`, `multi-value-visa`, `negative-preference`). Advisory grader flagged **1**: on `avoid-swe`, `careerStage:"intern"` is carried over unsupported (the candidate didn't restate intern status).

> Layer-2 numbers are non-deterministic even at temp 0 (advisory). They flag follow-ups; they do not block CI.

### Regression — `exit 0`
- `pnpm --filter pa-orchestrator test` → **tests 1803 · pass 1803 · fail 0**
- `pnpm --filter @pa/functions test`  → **tests 2028 · pass 2028 · fail 0**

### LOC collapse baseline (the ~9,586 → ~500-1000 tracker)
`packages/pa-orchestrator/src/voice/` source-only = **9,586 LOC** (matches the architecture doc exactly). Delete-targets also include `conversation-turn-arbiter.ts` (565), `conversation-action-arbiter.ts` (478), `no-match-narration.ts` (267), `run-connector-with-narration.ts` (159), `match-connectors.ts` narration (~25 of 381), plus the in-`index.ts` regex dispatch block (L4329–4646 ~320) + `handleCompletedUserJobSearchRequest` (L3486–3672, 187). KEEP: `output-normalizer.ts` (420). **P0 removed 0 LOC** (foundation only).

## SELF-REVIEW (answered with evidence)

- [x] **KEYSTONE held?** P0 added no conversation logic and no process logic — only eval. The eval itself is split exactly on the seam: Layer 1 grades process state (deterministic), Layer 2 measures model HOW (LLM, advisory). ✔
- [x] **Deleted any load-bearing deterministic logic?** No. `git diff --stat` touches only `apps/eval/**`, `firebase.json` (+2 predeploy lines), `.planning/agentic/P0-**`. Zero product source changed. ✔
- [x] **Process-intact eval — deterministic assertions + pass counts:** 5/5 fixtures, drivers exercise REAL `PreScreenPipeline.runTurn`, `applyCandidateJobEvent`, `SHARED_ONBOARDING_QUESTIONS`/`resolveNext`, and the production `PRESCREEN_RE`. Asserted: all-questions-asked, no-skip (qOrder adjacency), terminal value, terminal-once + post-terminal idempotency, candidate×job commit-once + dedup. ✔
- [x] **Conversation-quality eval — real-LLM scores incl. irrelevance/abstention vs baseline:** tool-choice 2/3, **abstention 2/2**, delivery 2/2, extraction 3/3 (1 advisory flag). This IS the P0 baseline; nothing to regress against yet. ✔
- [x] **Added behavior as a connector vs new regex branch?** N/A — P0 adds no behavior. ✔
- [x] **Every connector.execute returns a verdict and LLM narrates it?** N/A in P0 (no connectors changed). ✔
- [x] **Terminal idempotency keyed to fire exactly once?** Proven by `05-candidate-job-idempotency`: replaying the same `eventId` → `idempotent:true changed:false`, state doc unchanged; illegal restart after terminal → rejected, state unchanged. ✔
- [x] **Kept the output normalizer; only deleted eval-proven-redundant voice?** Nothing deleted in P0. `output-normalizer.ts` confirmed KEEP. ✔
- [x] **Regression green?** pa-orchestrator 1803/1803, functions 2028/2028. ✔
- [x] **Receipts present:** real-LLM output (BFCL + llm-runner above), eval output (process-intact above), regression counts above. No deploy in P0 (no production-Claire change). ✔
- [x] **LOC delta:** P0 = **+0 removed** (foundation). Baseline frozen for the tracker. ✔

### Honest gaps (next eval/prompt-tuning targets)
1. **Tool-choice under-calls explicit EN job-search** with the neutral triage prompt (1/3 miss). This is exactly what P1's Hermes-style `find-match` description rewrite (verbatim trigger phrases incl. EN) must fix — the baseline will show the lift.
2. **Agents-SDK strict-schema debt:** production `buildSdkTools` passes raw Zod connector schemas with optional fields → the live agent path would 400 under Responses strict function-calling. `bfcl-runner.mjs` works around it (non-strict JSON schema) to measure routing; **P1 must fix for real** (strict-compatible schemas or `strict:false` in the adapter).
3. **No negative-preference axis** in the extractor — "avoid adtech/crypto" lands in `relevantTags` as `avoid_*` rather than a typed negative axis. Documented by `negative-preference` fixture.
4. **`careerStage` carry-over** flagged by the grader on `avoid-swe` — unsupported `intern` survives.
5. **No-match narration** not yet exercised end-to-end (needs a tool-result→narration path); tracked for a later conversation-quality fixture.

## Definition of done
A1–A7 in ACCEPTANCE.md all ✅. Baseline frozen above. PR opened against `main` with these receipts in the body.
