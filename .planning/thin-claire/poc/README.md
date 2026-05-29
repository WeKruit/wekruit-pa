# Thin Claire POCs — proven seed specs (real model, no deploy)

These three runnable POCs are the **verified blueprint** for the thin-Claire
rebuild. Each was run against real `gpt-5.4-nano` and asserts side-effects
in-process (no Firestore, no Sendblue, no deploy). They are the executable
spec the rebuild copies — not throwaway demos.

## Run them

```bash
source ~/.zshrc && nvm use 24
# resolve the SDK from the orchestrator-runtime package (apps/eval has no node_modules)
cd .planning/thin-claire/poc
ln -sf ../../../packages/agent-runtime/node_modules ./node_modules   # @openai/agents + zod live here
# key is read from repo-root .env (PA_OPENAI_AGENT_API_KEY)
node poc-v1-core.mjs        # core loop: avoid-SWE → drop SWE (deterministic verdict)
node poc-v2-delivery.mjs --eval   # delivery: mark-read/typing/tapback/status, 4/4
node poc-v3-full.mjs        # FULL: delivery+tools+onboarding+prescreen+scoring+flex+guardrail, 7/7
```

(`@openai/agents` v0.8.5. The reaction reflex uses the event-emitter API
`agent.on('agent_tool_start', cb)` — NOT an `AgentHooks` method override; the
method-override form silently never fires in 0.8.5. Verified firing order:
`agent_tool_start → execute`.)

## What each POC proves

### poc-v1-core.mjs (169 LOC) — the loop + the 717 bug, fixed
- `Agent({instructions, tools})` + `run(agent, input, {session})` is the whole loop.
- `set_matching_preferences.execute` is a deterministic REDUCER: "only X" REPLACES
  the role set, "avoid Y" writes `negativeRoleFunction` AND removes Y from the
  positive set. The exact failure the 10k-LOC prod path showed on the 424 canary
  (added product, kept software_engineering) — PASS here.
- Deterministic verdict: SWE removed, product present, negative axis set,
  internship→full_time. Real model, multi-turn `MemorySession`.

### poc-v2-delivery.mjs (250 LOC) — the delivery layer is thin
- mark-read = a deterministic reflex fired on every inbound BEFORE `run()`.
- typing = `agent.on('agent_tool_start')` 3-line reflex, fires before the slow tool.
- "send a status bubble, then the slow tool, then the result" = a `send_status_then_continue`
  tool the LLM calls.
- tapback-vs-text-vs-no-reply = LLM-decided tools (`react_to_user` / `no_reply`),
  description-routed — REPLACES the `conversation-action-arbiter` regex.
- `--eval` asserts the exact channel event sequence per scenario. 4/4 PASS.

### poc-v3-full.mjs (328 LOC) — every layer, 7/7 PASS
- A delivery + B tools (find_match / set_prefs / remember / schedule(dedup) / privacy).
- **C onboarding FSM** — reducer-owned: `ask_next_onboarding_question` +
  `record_onboarding_answer`; the reducer rejects out-of-order, so the LLM CANNOT
  skip slots. Walks all slots, completes.
- **C prescreen FSM + scoring** — `ask_next_prescreen_question` +
  `score_prescreen_answer`. Scoring = an **LLM judge sub-agent INSIDE the tool**
  proposes a 0-1 score + evidence (side-effect); the **reducer** records it,
  advances, and at the end does the deterministic PASS/FAIL rollup. The LLM never
  declares pass/fail. Terminal commits exactly once.
- **C3 flexibility (the hard one)** — single agent, NO handoff: mid-prescreen
  "show me jobs first" is answered, prescreen state is untouched, the pending
  question resumes. Proves "interrupt + resume" needs no sub-agent round-trip.
- **C2 idempotency** — post-terminal re-score rejected; `explain_prescreen_outcome`
  reads stored scores without re-running the screen.
- **D guardrail** — `inputGuardrails` tripwire blocks injection; no normal reply.

## The KEYSTONE these POCs enforce (do not violate in the rebuild)

The LLM only PROPOSES (answer text, a judge score, a tool choice). Deterministic
REDUCER code DECIDES every state transition (next question, PASS/FAIL rollup,
commit-once, dedup, out-of-order rejection). "Reducer = code; the judgement it
consumes (did they answer / how good) = LLM in a tool." This is CLAUDE.md's
"LLM never directly controls state transitions" made concrete.

## What the POCs do NOT cover (must be wired in the real build)

In-memory stand-ins that become real modules in the rebuild:
- `db.tags` → real `pa-users.tags` via `applyPartialUserTags` (sole writer).
- find_match fake jobs → `queryMatchingJobsV16`.
- `MemorySession` → a Firestore `Session` (5 methods over `pa-messages`).
- channel stub → Sendblue (send / typing / mark-read / tapback).
- prescreen questions/rubric hard-coded → loaded from `pa-jobs` prescreen config.
- judge inline → existing `screening-evaluation` / `eval-nl-judge`.
- mem0 semantic recall + compaction (long-context) — not in POC; required.
