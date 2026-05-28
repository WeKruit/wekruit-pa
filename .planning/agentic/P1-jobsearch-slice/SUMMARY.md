# P1 — Vertical slice: job-search through agent-core · SUMMARY

**Branch:** `claude/agentic-P1-jobsearch-slice`, stacked on the corrected P0 tip (`02c3e826`).
**Outcome:** the agent core can drive a job-search turn (via `find-match`), proven by a real-LLM canary, shipped **behind `paAgenticJobSearchEnabled` (default OFF)** so it is rampable with zero regression. The literal regex deletion is staged behind that ramp (deviation from "delete in P1" — see PLAN; flagged for Adam).

## Commits
- `ff14c668` — Hermes-style `find-match` description (verbatim EN+ZH triggers + "Do NOT call when…").
- `b82a6313` — strict-compatible `FindMatchInputSchema` (`.optional()`→`.nullable()`); agent can call find-match with no Responses-API 400.
- `315207e4` — `agent-jobsearch-canary.mjs` (the real-LLM deletion gate).
- (pending commit) — `paAgenticJobSearchEnabled` flag + `isAgenticJobSearchEnabled` + allowlist/toolPolicy guarantee + system-prompt directive + dispatch-skip (3 files, +65/-3, flag-OFF no-op).

## Receipts
- **agent-path canary (real `gpt-5.4-nano`): 3/3 GREEN** — turn 1 (real `maybeRunExtractor`) commits product-only tags; turn 2 (real `run(agent)`) the model CALLS `find-match` and the connector saw the POST-reducer tags `["product_management"]` (no stale `software_engineering`). The Adam-bug invariant holds in the agent path.
- **strict-schema proof:** the agent (real SDK, production `buildSdkTools` path, strict Zod) called find-match on "find me some software engineering jobs" — the exact EN turn that ABSTAINED at the P0 baseline — with no 400.
- **process-intact: 5/5, exit 0** (no regression vs P0 baseline). **arbiter canary `runner.mjs`: PASS** (flag-OFF → `job_search` owner unchanged).
- **Regression:** pa-orchestrator **1803/1803**; pa-connectors **29/29**; functions **2028/2028** — all exit 0 (flag-OFF = no behavior change).

## SELF-REVIEW (evidence, not assertion)
- [x] **KEYSTONE held?** Routing (which connector) moved to the model (find-match Hermes description + system-prompt directive). The deterministic commit (`execute`→`ctx.hooks.findMatch`→V16 + `pa-tool-calls` ledger) stayed deterministic. ✔
- [x] **Deleted load-bearing deterministic logic?** No — nothing deleted this phase (flag-gated additive change). The regex remains the flag-OFF default. ✔
- [x] **Process-intact eval:** 5/5 — prescreen FSM all-asked/no-skip/terminal-once, onboarding no-skip, trigger parse, candidate×job idempotency+dedup. ✔
- [x] **Conversation-quality vs P0 baseline:** the EN job-search abstain (P0 tool-choice 2/3) is now a find-match call (the Hermes description + strict fix). Agent-path canary 3/3. No abstention/extraction regression (P0 llm-runner still 4 PASS + 1 expected-RED). ✔
- [x] **Added behavior as a connector, not a new regex branch?** Yes — job-search routing is now the model choosing the existing `find-match` connector; the change added a flag + a prompt directive + a dispatch-skip, NOT a new regex router. ✔
- [x] **connector.execute returns a verdict + LLM narrates it?** `FIND_MATCH_CONNECTOR.execute` returns `{ok,source,reason,jobCount,summary,message}`; the agent narrates it (canary turn-2 reply composed from the verdict). ✔
- [x] **Terminal idempotency keyed once?** Unchanged from P0 (no terminal-commit code touched). ✔
- [x] **Kept the output normalizer; only deleted eval-proven-redundant voice?** Nothing deleted; normalizer untouched. ✔
- [x] **Regression green?** orch 1803/1803, connectors 29/29, functions 2028/2028. ✔ (flag-OFF = no behavior change)
- [x] **Receipts present:** canary output, strict-schema SDK proof, eval-layer outputs, regression counts. No deploy (production-Claire change → Adam-gated; flag default-OFF). ✔
- [x] **LOC delta:** **+~340 / -3** this phase (canary 130 + flag/wiring 65 + connector description/schema + planning docs). Net ADD — the collapse (−~9,586 voice + −regex routers) is staged: P1 ships the *mechanism*; the deletion lands after the flag ramps in production. Tracked against the ~9,586→~500-1000 target for later phases.

### Honest gaps (next targets)
1. **Literal deletion staged, not done** — `handleCompletedUserJobSearchRequest` + the `job_search` arbiter owner + `FIND_MATCH_NARRATION` remain (flag-OFF path). Delete after the flag ramps to 100% in production (gate already green). This is the deliberate deviation; Adam may direct immediate deletion.
2. **Side-effect re-homing pending for the deletion** — `composeNoMatchReply` grounded V16-counter copy + `startPostMatchRetentionAfterJobRecs` must move to connector-verdict narration / a post-turn hook before the handler is deleted (under the flag, the agent narrates the verdict but the grounded no-match copy + retention auto-kickoff aren't yet re-homed).
3. **Multi-owner dispatch** — the handler also ran for `fallback_claire`/`explicit_explanation`; flag-ON skips it for those too (they fall to the agent loop, which is intended) — verify in the flag-ON ramp.
4. **Flag-ON integration test** — the canary proves the agent pattern; a full processInboundEvent flag-ON integration test (dispatch-skip → agent loop → find-match) would harden the wiring beyond code review + the flag-OFF regression.
5. **set-matching-preferences** still has optional-field schemas (would 400 under strict if the agent calls it) — the systemic Zod→strict-JSON adapter fix is deferred (P5/connector hardening).
