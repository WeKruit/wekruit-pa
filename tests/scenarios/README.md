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
      reply_min_length: <int>
      reply_contains_any: [string, ...]    # at least one substring must match
      reply_not_contains_any: [string, ...]  # none may match (case-insensitive)
      reply_matches_any: [regex, ...]       # at least one regex must match (flags iu)
      reply_not_matches_any: [regex, ...]   # no regex may match (flags iu)
```

### Regex assertions

- **`reply_matches_any`** — At least one pattern must match the full reply (JavaScript `RegExp` with `iu`).
- **`reply_not_matches_any`** — If any pattern matches, the turn fails. Use for boundary tests (e.g. forbidding stale movie titles when no live search exists).

### 429 / rate-limit retries

`runTurnWithRetry` catches errors whose message matches **429**, **rate limit**, or **resource exhausted** (case-insensitive). It retries up to **`turnRetries`** times (default **2** extra attempts after the first), with delay **`retryBackoffMs * (attempt + 1)`** between tries (default base **30000** ms).

## Packaged scenarios

| File | Intent |
|------|--------|
| `memory-recall-zh.yaml` | ZH recall |
| `memory-recall-en.yaml` | EN recall |
| `memory-recall-ja.yaml` | JA recall |
| `memory-recall-mixed.yaml` | Mixed-locale recall |
| `reset-integration-zh.yaml` | `__PA_RESET__` / memory clear path |
| `current-info-boundary-zh.yaml` | **Current-info guardrail** — user asks for recent movies without live search; reply must acknowledge need for **实时检索 / 实时数据源** and must **not** invent stale blockbuster titles |

## Running

Slow stacks (large models, cold start): raise **`turnTimeoutMs`** (waits for inbound to reach `succeeded`) and/or **`replyTimeoutMs`** in the scenario YAML so the run does not flake.

```bash
# Single scenario
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node tests/scenarios/runner.mjs tests/scenarios/scenarios/memory-recall-zh.yaml

# Whole directory
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node tests/scenarios/runner.mjs tests/scenarios/scenarios/

# Env-gated npm test integration. Requires explicit opt-in (writes broker events).
PA_RUN_SCENARIOS=1 GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  npm test
```

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

Exit codes: `0` all pass, `1` any failure, `2` invalid invocation.

## What's not here yet

- Broader adversarial / safety suites (prompt injection, tool escalation) — may share patterns with `tests/promptfoo/` later; same runner, not a second framework.
- Direct Qdrant assertion mode in the runner (optional future; dashboard + API already expose payloads for humans).
- Cross-user memory-leak scenarios — future harness work.

## Conventions

- Prefer **`reply_contains_any`** when wording may drift; use **`reply_matches_any` / `reply_not_matches_any`** when you need precise boundaries.
- Memory-recall scenarios: sequential turns within one scenario; parallel **different** scenarios need **different** `participant` values if they share Mem0 user partitions.
- `testMode: true` ensures the scenario participant’s `pa_users` doc allows `__PA_RESET__` without manual CLI bootstrap.
- Cleanup is **not** automatic — failed runs leave Firestore/Qdrant state for inspection. Ops can sweep `harness_*` ids when needed.
