# Live Smoke Receipt — 2026-05-28 (feeds the agentic-rebuild /goal)

Real iMessage smoke run by Adam from +1 (424) 320-1960 against the deployed Claire
(post PR #245). This is a **live production receipt** — the agentic-rebuild goal
(V3-AGENTIC-GOAL-PROMPT.md) MUST treat the two failure gaps below as concrete,
must-fix requirements in P0 (eval fidelity) and P5 (reducer semantics). Do not
let P0's harness false-green these again.

## User / source of truth

- Candidate phone: +1 (424) 320-1960
- Resolved canonical user: `pa-users/LF8blURXyFBaeF7bhupu` (onboardingState: complete)
- After the smoke, observed state:
  - `tags.targetRoleFunction = ["product_management","software_engineering"]`  ← SWE NOT removed
  - `tags.targetJobType = undefined`                                            ← "full-time only" never written
  - `tags.targetLocations = ["san_francisco_bay_area","remote_united_states"]`  ← captured correctly
  - `tags.updatedAt = 2026-05-28T04:16:11Z`

## What PR #245 got RIGHT in production (do not regress these)

From `pa-turn-traces` + `pa-tool-calls` for the run (04:13–04:21):
- Traces now reach `status=completed` (6 of 7 turns), not stuck at `owner_arbitrated`.
- `pa-tool-calls` rows are created for find-match, each with `input.userTagsSnapshot`.
- The durable_preference_update turn fired and mutated the snapshot:
  find-match @04:15 snapshot `["software_engineering"]` → find-match @04:17 snapshot
  `["product_management","software_engineering"]` (extractor ran, ADDED product_management).
- No-match narration is grounded: outbound "I can't run a clean match yet because I
  don't have your work-authorization status on file" + trace
  `noMatchReason=missing_axis:visaStatus` (not the old generic apology).
- `targetLocations` extracted correctly (prompt field-name fix landed).
- A `tapback_only` delivery fired on a low-information turn (04:19).

## The CORE-TEST FAILURE — two gaps, both OUT of #245 scope

### Gap A — add-not-replace / missing negative + "only" semantics  (→ P5, lock #5)
"actually done with pure SWE, only want product strategy / PM, full-time" produced:
- `targetRoleFunction = ["product_management","software_engineering"]` — product was
  ADDED but software_engineering was NOT removed. Claire's own ack leaked it:
  "I'll keep matches focused on product management/software engineering roles".
- `targetJobType` stayed `undefined` — "full-time only" never wrote the constraint.

Root cause: preference updates are treated as ADDITIVE. There is no replace/remove
and no negative axis. `applyPartialUserTags` merge is shallow-replace per key
(`{...existing, ...cleaned}`), so the real defect is upstream: the extractor emitted
a patch that KEPT software_engineering (and omitted full-time) rather than expressing
"remove software_engineering" / "replace role set" / "set jobType=full_time".

Required fix (P5 connector reducer hardening + lock #5):
- Support add / update / delete / **avoid** semantics.
- "only X" → REPLACE the role set (or remove the others). "avoid Y" → write a negative
  axis (e.g. `negativeRoleFunction`/`negativeIndustrySector`) that the matcher SUBTRACTS.
- Capture single hard constraints like "full-time only" → `targetJobType=["full_time"]`.
- Every such change is narrated to the user truthfully ("switched you to product, dropped SWE").

### Gap B — matcher blocked on missing visaStatus  (separate, not a role-tag bug)
Both find-match calls returned `recCount=0, missing_axis:visaStatus`. The user never
provided work authorization, so the hard-filter cascade could not run regardless of
role tags. This is correct behavior (V16 needs visa), but it means the smoke could
not have surfaced roles even if role tags were perfect. The agent should proactively
collect the missing axis (the needsOnboarding directive already exists) before/while
attempting the match, and the no-match copy already names it — good, but the
collection loop should close it.

## My own eval had a FIDELITY BUG (P0 must fix)

The real-LLM harness (`apps/eval/conversation-experience/llm-runner.mjs`) FALSE-GREENED
gap A because:
1. It used a hand-rolled `mergePatch` with SET/replace semantics, not the production
   `applyPartialUserTags` path.
2. It exercised the extractor in ISOLATION on a single turn, so the model dropped
   software_engineering cleanly — production, with an existing `[software_engineering]`
   tag and the real write path, kept it.

P0 required fixes (eval fidelity — do this BEFORE trusting any later phase's green):
- The conversation-quality harness MUST drive the REAL production write path
  (`applyPartialUserTags` / `mergeUserTags`), not a stand-in merge.
- Add a fixture: initial `tags.targetRoleFunction=["software_engineering"]`,
  `targetJobType=["internship"]`; user says "done with pure SWE, only product, full-time";
  ASSERT final `targetRoleFunction` does NOT contain `software_engineering` and
  `targetJobType` contains `full_time`. This fixture WILL be RED against current code —
  that is the correct failing baseline; P5 turns it green.
- Add a fixture asserting the matcher's missing-axis collection loop closes (gap B).

## Reproduce the evidence

```
cd /tmp/wk-deploy-245/apps/functions   # or any checkout's apps/functions with deps built
export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp)
grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" <repo>/.env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
node verify-smoke.mjs LF8blURXyFBaeF7bhupu "2026-05-28T03:00:00Z"
```
(`verify-smoke.mjs` pairs pa-turn-traces / pa-tool-calls / pa-users.tags / pa-outbound.)

## Bottom line for the goal

- #245's mechanical + parse fixes WORK in production. Keep them.
- The user-facing "switch to product-only" failure is **lock #5 (add/update/delete/avoid
  semantics + negative axis)** — squarely the goal's P5 + the extractor rework.
- P0's harness MUST use the real write path so it cannot false-green this again.
- These two are non-negotiable acceptance items for the rebuild.
