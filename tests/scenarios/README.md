# PA Scenario Harness

Phase 2 deliverable: a scenario-driven harness that exercises the **real**
production PA stack (Firestore broker → Cloud Function → pa-orchestrator →
Mem0 OSS / Qdrant / SiliconFlow → transcript path) without writing to
`~/Library/Messages/chat.db`.

## Why broker injection (not chat.db)

The harness writes a synthetic broker iMessage event directly to
`pa_inbound_events` with `rawPayload.kind = "imessage"` plus harness metadata
(see **Outbound suppression** below) so real iMessage delivery is not queued.

We get end-to-end coverage of the Cloud Function, orchestrator, Mem0, Qdrant,
SiliconFlow, and transcript path without:

- Touching the read-only `chat.db` (worker permission territory).
- Mocking the LLM (Mem0 fact extraction depends on real model behavior).
- Simulating Qdrant (production semantic memory must be exercised).
- Relying on the Mac worker to send messages (harness does not enqueue normal outbound when suppression is on).

## Outbound suppression (default)

Every harness-built inbound event sets:

```js
harness: { runner: "tests/scenarios/runner.mjs", suppressOutbound: true }
```

The Cloud Function forwards this into orchestrator `rawMeta.harness`. When
`suppressOutbound === true`, the orchestrator still appends the assistant turn
to **`pa_messages`** but **does not** call `enqueueOutbound` — so **no
`pa_outbound` document** should be created for that turn with
`idempotencyKey` `outbound-<inbound_event_id>` (orchestrator uses the full `pa_inbound_events` doc id, e.g. `outbound-harness_8f3c…`).

**How to confirm `pa_outbound` stayed at zero for a harness turn**

1. Note the inbound event id from runner stderr (format `harness_<uuid>`) or from Firestore `pa_inbound_events`.
2. In Firestore, query collection **`pa_outbound`** for `idempotencyKey == outbound-<that_same_inbound_id>` (e.g. `outbound-harness_8f3c…`). **Expect no document** when suppression is active.
3. Transcript proof still appears under **`pa_messages`** with `idempotencyKey` `out-<inbound_event_id>`.

If you intentionally disable suppression or run against a **non-harness**
participant without safeguards, treat that as a **real outbound** risk — not the default path.

## Scenario format

```yaml
id: <stable id>
description: <human-readable purpose>
locale: zh-CN | en-US | ja-JP | mixed
agentId: <pa_agents/{id}> | default
participant: "+1XXXXXXXXXX"          # broker key — use reserved range unless allowlisted
chatId: "iMessage;+1XXXXXXXXXX"
testMode: true | false               # optional; enables reset scenarios
turnTimeoutMs: 30000                 # inbound event → succeeded/completed
replyTimeoutMs: 120000               # optional; wait for pa_messages assistant row (default 120s)
turnRetries: 2                       # optional; 429 / rate-limit retries (default 2)
retryBackoffMs: 30000                # optional; base backoff in ms (default 30000)
verifySuppressOutbound: true         # optional; after each turn, assert no pa_outbound for this event when suppressOutbound (default true)
turns:
  - user: <message body>
    assert:
      # Reply-content axes (rule-based, free)
      reply_min_length: <int>
      reply_contains_any: [string, ...]    # at least one substring must match
      reply_not_contains_any: [string, ...]  # none may match (case-insensitive)
      reply_matches_any: [regex, ...]       # at least one regex must match (flags iu)
      reply_not_matches_any: [regex, ...]   # no regex may match (flags iu)

      # Phase 14.1 — telemetry-backed axes (rule-based, free)
      tool_call_required: ["web_search"]   # all named tools must appear in pa_turns.usage.hostedToolCalls
      tool_call_forbidden: ["web_search"]  # named tools must NOT appear
      usage_max_input_tokens: 5000          # fail if pa_turns.usage.inputTokens > N
      usage_max_total_tokens: 10000         # fail if pa_turns.usage.totalTokens > N
      persona_facts_present: true | false   # checked BEFORE the turn fires; pa_memory_facts where status=confirmed

      # Phase 14.2 — judge axis (LLM-as-judge, costs money, gated by PA_RUN_EVAL=1)
      judge:
        criterion: "reply is concise and friendly"
        threshold: 0.7                       # confidence floor; verdict=fail always fails
```

### Regex assertions

- **`reply_matches_any`** — At least one pattern must match the full reply (JavaScript `RegExp` with `iu`).
- **`reply_not_matches_any`** — If any pattern matches, the turn fails. Use for boundary tests (e.g. forbidding stale movie titles when no live search exists).

### 429 / rate-limit retries

`runTurnWithRetry` catches errors whose message matches **429**, **rate limit**, or **resource exhausted** (case-insensitive). It retries up to **`turnRetries`** times (default **2** extra attempts after the first), with delay **`retryBackoffMs * (attempt + 1)`** between tries (default base **30000** ms).

### Phase 14.1 — telemetry assertions

| Key | Reads | Pass condition |
|-----|-------|----------------|
| `tool_call_required: string[]` | `pa_turns` row matched by `eventId == event.id`, then `usage.hostedToolCalls[*].name` | every named tool appears at least once |
| `tool_call_forbidden: string[]` | same | no named tool appears |
| `usage_max_input_tokens: number` | `usage.inputTokens` | `inputTokens <= cap` |
| `usage_max_total_tokens: number` | `usage.totalTokens` | `totalTokens <= cap` |
| `persona_facts_present: boolean` | `pa_users` by participant → `pa_memory_facts` where `userId` matches and `status == "confirmed"` | presence matches the boolean |

`persona_facts_present` runs **before** the turn fires (it's testing seed
state, not what the turn produced). The other three run **after** the
turn completes and the `pa_turns` row has been updated by the
orchestrator (Phase 10.5 T9). If the row hasn't been written yet, the
runner polls briefly (~8s) before failing the assertion.

`tool_call_required` reads `usage.hostedToolCalls`, which is the
authoritative source for SDK-hosted tools (e.g. `web_search`).
**Connector-style tools** like `remember-fact` are NOT SDK-hosted and
will not appear there — for those, query `pa_tool_calls` directly per
the Phase 10.5 deferred-audit shape.

All telemetry keys are optional; existing scenarios without them are
unaffected.

### Phase 14.2 — LLM-as-judge

`judge: { criterion, threshold }` invokes a single `gpt-5.4-nano` call
through the OpenAI Responses API with a forced tool-output schema:

```json
{ "verdict": "pass" | "fail", "confidence": 0.0-1.0, "rationale": "..." }
```

Pass condition: `verdict === "pass"` AND `confidence >= threshold`. A
`verdict === "fail"` is always a turn failure regardless of confidence.

**Gating**: judge calls run **only** when `PA_RUN_EVAL=1`. Under
`PA_RUN_SCENARIOS=1 npm test` (or any non-eval invocation), judge
assertions are SKIPPED with a warning so unit-test runs never bill
OpenAI. Use **`npm run eval`** to exercise judge axes.

**Auditability**: every judge call (input criterion, reply, full
response, usage, cost) is appended to
`eval-runs/<runStamp>/judge.jsonl`. A failed verdict shows the
rationale in the runner's per-turn `failures` array so the operator
can sanity-check the model's reasoning before merge-blocking on it.

**Retries**: at most one retry on transient error per call. No
exponential backoff (matches P9 `DON'T` for 14.2).

**Cost ceiling**: `PA_EVAL_MAX_RUN_USD` (default `5`) caps total
estimated spend per run. The runner pre-flights every judge call —
if the next call's projected cost would push the cumulative spend
past the ceiling, the run aborts with a clear message **before** the
call is made. Estimate uses gpt-5.4-nano's illustrative pricing
(`$0.05/M input`, `$0.40/M output`) — see `tests/scenarios/judge.mjs`
constants.

## Packaged scenarios

Production smoke (run on `npm test` when `PA_RUN_SCENARIOS=1`):

| File | Intent |
|------|--------|
| `memory-recall-zh.yaml` | ZH recall |
| `memory-recall-en.yaml` | EN recall |
| `memory-recall-ja.yaml` | JA recall |
| `memory-recall-mixed.yaml` | Mixed-locale recall |
| `reset-integration-zh.yaml` | `__PA_RESET__` / memory clear path |
| `current-info-live-zh.yaml` | Live web-search ZH |
| `current-info-live-en.yaml` | Live web-search EN |
| `current-info-live-ja.yaml` | Live web-search JA |
| `persona-card-zh.yaml` | Phase 11.1 persona-card injection |
| `remember-fact-zh.yaml` | Phase 10.5 T5 LLM-driven `remember-fact` |
| `tool-budget-stress-zh.yaml` | Multi-tool budget probe |

Phase 14 eval-grade (run on `npm run eval`, prefix `eval-`):

| File | Axis |
|------|------|
| `eval-persona-drift-zh.yaml` | Persona durability across 7 turns |
| `eval-tool-budget-parallel-zh.yaml` | Three parallel `remember-fact` writes in one turn |
| `eval-hallucination-1900-zh.yaml` | Hallucination guard on unanswerable historical question |
| `eval-tool-choice-cross-lingual-en.yaml` | `web_search` selected on en current-info |
| `eval-tool-choice-cross-lingual-ja.yaml` | `web_search` selected on ja current-info |
| `eval-reset-then-no-recall-zh.yaml` | Reset truly drains persona-card source |
| `eval-prompt-injection-in-fact-zh.yaml` | `remember-fact` does not become a prompt-injection vector |
| `eval-tool-budget-extended-zh.yaml` | Graceful refusal when intent exceeds toolBudgetPerTurn |
| `eval-tone-judge-zh.yaml` | LLM-judge tone audit |

## Running

Slow stacks (large models, cold start): raise **`turnTimeoutMs`** (waits for inbound to reach `succeeded`) and/or **`replyTimeoutMs`** in the scenario YAML so the run does not flake.

```bash
# Single scenario
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node tests/scenarios/runner.mjs tests/scenarios/scenarios/memory-recall-zh.yaml

# Whole directory (production smoke + eval, but judge SKIPPED without PA_RUN_EVAL)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node tests/scenarios/runner.mjs tests/scenarios/scenarios/

# Env-gated npm test integration. Requires explicit opt-in (writes broker events).
PA_RUN_SCENARIOS=1 GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  npm test

# Phase 14.4 — full eval, judge enabled, artifacts to eval-runs/<stamp>/
PA_OPENAI_AGENT_API_KEY=... \
  GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  npm run eval

# Dry-run plan: lists scenarios, projected judge calls, cost estimate.
# Does NOT touch Firestore or OpenAI.
npm run eval -- --dry-run
```

### Cost ceiling abort smoke test

```bash
PA_EVAL_MAX_RUN_USD=0.001 PA_OPENAI_AGENT_API_KEY=... \
  GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  npm run eval
```

The runner aborts on the first judge call whose projected cost would
push cumulative spend past `0.001` USD; summary reports
`aborted: "cost_ceiling_exceeded"`.

### Deterministic run order

When the target is a directory, scenario files are sorted **alphabetically by filename** so CI and local runs match.

### Post-turn outbound check (default)

For each turn, the runner builds `rawPayload.harness.suppressOutbound: true`. Unless the scenario sets `verifySuppressOutbound: false`, after the reply poll the runner queries **`pa_outbound`** for `idempotencyKey == outbound-<inbound_event_id>` and **fails the turn** if any document exists. This catches regressions where suppression stops working.

### Reserved test participants (`+1999999xxxx`)

Scenarios should use the reserved **`+1999999xxxx`** test range. Unless
`PA_SCENARIO_KEEP_PARTICIPANTS=1`, the runner **replaces** each reserved
number with a **fresh random** `+1999999####` per run so rate limits and Mem0
partitions do not leak stale state between reruns.

To pin the exact number from YAML (debug only), set `PA_SCENARIO_KEEP_PARTICIPANTS=1`.

To run against a **real** test handle, set `PA_SCENARIO_ALLOWED_PARTICIPANTS` to
that exact comma-separated participant list (still understand real outbound
if suppression were ever off).

Output is a single JSON document on stdout (suitable for CI consumption).
Per-scenario progress goes to stderr.

Exit codes: `0` all pass, `1` any failure or cost-ceiling abort, `2` invalid invocation.

## What's not here yet

- Broader adversarial / safety suites (prompt injection, tool escalation) — may share patterns with `tests/promptfoo/` later; same runner, not a second framework.
- Direct Qdrant assertion mode in the runner (optional future; dashboard + API already expose payloads for humans).
- Cross-user memory-leak scenarios — future harness work.

## Conventions

- Prefer **`reply_contains_any`** when wording may drift; use **`reply_matches_any` / `reply_not_matches_any`** when you need precise boundaries.
- Memory-recall scenarios: sequential turns within one scenario; parallel **different** scenarios need **different** `participant` values if they share Mem0 user partitions.
- `testMode: true` ensures the scenario participant's `pa_users` doc allows `__PA_RESET__` without manual CLI bootstrap.
- Cleanup is **not** automatic — failed runs leave Firestore/Qdrant state for inspection. Ops can sweep `harness_*` ids when needed.
- Eval-grade scenarios MUST keep at least one rule-based assertion alongside any `judge` axis — never make a turn pass/fail solely on the judge verdict.
