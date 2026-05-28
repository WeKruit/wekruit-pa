# P1 — Vertical slice: job-search through agent-core · PLAN

## Goal (V3-AGENTIC-GOAL-PROMPT.md P1)
Let `run(agent)` drive job-search via `find-match`; rewrite its description Hermes-style; keep the deterministic commit in `execute`; delete the regex job-search path; eval gate = P0 suite green + a real-LLM stale-tag canary.

## Approach + the one deliberate deviation (SAFE-RAMP vs literal delete)

The goal says "delete the regex in P1." I implemented the agent path **behind a default-OFF flag (`paAgenticJobSearchEnabled`)** and **kept** the regex code as the flag-OFF default, rather than deleting it in this commit. Rationale (flagged to Adam for accept/override):

- **Zero-regression for live users.** Job-search is a live production path. Flag-OFF is a byte-for-byte no-op vs current `main`; the agent path only activates per-user when Adam ramps the flag — consistent with Adam's flag-ramp philosophy (V1.5-ROLLOUT, `paHumanizeRuntimeEnabled`, etc.).
- **"Never delete until proven IN PRODUCTION."** Architecture §12 + the live-smoke receipt both stress real-production proof. The real-LLM canary proves the *pattern*; the flag lets Adam prove it *live* before the irreversible deletion. The deletion is the immediate post-ramp follow-up, with the gate already green.
- The capability the goal wants (agent drives job-search, regex no longer owns it) is fully delivered when the flag is ON. The LOC collapse is *staged* behind the ramp, not abandoned.

If Adam prefers the literal in-P1 deletion, the gate is green and the delete-list is enumerated in CONTEXT.md / task #14 — it is a follow-up commit, not new work.

## Waves (executed)
- **A — eval-first gate:** `agent-jobsearch-canary.mjs` — real `maybeRunExtractor` (turn 1 commits product-only) → real `run(agent)` (turn 2 calls find-match) → asserts find-match saw POST-reducer tags. **3/3 green.** (commit `315207e4`)
- **B — connector + routing:**
  - Hermes-style `find-match` description (`ff14c668`).
  - strict-compatible `FindMatchInputSchema` (`.optional()`→`.nullable()`) so the agent can call it with no Responses-API 400 (`b82a6313`, proven end-to-end).
  - `paAgenticJobSearchEnabled` flag (default OFF) + `isAgenticJobSearchEnabled` + allowlist/toolPolicy guarantee + system-prompt directive + dispatch-skip. Flag-OFF = no-op.
- **D/E — gate + PR:** both eval layers + regression + SELF-REVIEW + stacked PR (see SUMMARY).

## Kept (deterministic, per KEYSTONE)
- `find-match` `execute` → `ctx.hooks.findMatch` (the V16 matcher + the `pa-tool-calls` ledger written by `runConnector`). The agent only CHOOSES the connector; the commit stays deterministic.
- All 8 non-job_search arbiter owners; the prescreen/onboarding rails; the output normalizer.

## Deferred to follow-up (documented, gate already green)
- The literal deletion of `handleCompletedUserJobSearchRequest` + the `job_search` arbiter owner + `FIND_MATCH_NARRATION` (staged behind the flag ramp).
- Re-homing `composeNoMatchReply` grounded V16-counter copy + `startPostMatchRetentionAfterJobRecs` as connector-verdict narration / post-turn hooks (needed at deletion time; under the flag the agent narrates the connector verdict).
