# PA Scenario Harness

Phase 2 deliverable: a scenario-driven harness that exercises the **real**
production PA stack (Firestore broker → Cloud Function → pa-orchestrator →
Mem0 OSS / Qdrant / SiliconFlow → outbound) without writing to
`~/Library/Messages/chat.db`.

## Why broker injection (not chat.db)

The harness writes a synthetic broker iMessage event directly to
`pa_inbound_events` with `rawPayload.kind = "imessage"` plus harness metadata
that suppresses real outbound delivery. We get end-to-end coverage of the
Cloud Function, orchestrator, Mem0, Qdrant, SiliconFlow, and transcript path
without:

- Touching the read-only `chat.db` (worker permission territory).
- Mocking the LLM (Mem0 fact extraction depends on real model behavior).
- Simulating Qdrant (production semantic memory must be exercised).
- Enqueueing a `pa_outbound` job that the Mac worker would send through
  iMessage.

## Scenario format

```yaml
id: <stable id>
description: <human-readable purpose>
locale: zh-CN | en-US | ja-JP | mixed
agentId: <pa_agents/{id}> | default
participant: "+1XXXXXXXXXX"          # broker key — match a test handle
chatId: "iMessage;+1XXXXXXXXXX"
testMode: true | false               # optional; enables reset scenarios
turnTimeoutMs: 30000
turns:
  - user: <message body>
    assert:
      reply_min_length: <int>
      reply_contains_any: [string, ...]    # at least one must match
      reply_not_contains_any: [string, ...]  # none may match
      reply_matches_any: [regex, ...]       # at least one regex must match
      reply_not_matches_any: [regex, ...]   # no regex may match
```

Future assertion types (Phase 3+):

- `memory_search_min: <int>` — orchestrator stats showed at least N hits.
- `qdrant_recall_contains: [text, ...]` — Qdrant payload sweep verifies
  semantic memory persisted (requires Qdrant admin client — Phase 3).
- `tool_call_blocked: <connector_id>` — verifies safety policy denied a
  connector escalation attempt.

## Running

```bash
# Single scenario
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node tests/scenarios/runner.mjs tests/scenarios/scenarios/memory-recall-zh.yaml

# Whole directory
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node tests/scenarios/runner.mjs tests/scenarios/scenarios/

# Env-gated npm test integration. This intentionally requires an explicit
# production-harness opt-in because it writes broker events to Firestore.
PA_RUN_SCENARIOS=1 GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  npm test
```

Scenarios should use the reserved `+1999999xxxx` test range. The runner maps
reserved numbers to a fresh test participant on each run so rate limits and
semantic memory do not leak between reruns. Set `PA_SCENARIO_KEEP_PARTICIPANTS=1`
only when you intentionally need the exact number in the YAML. To run against a
real test handle, set `PA_SCENARIO_ALLOWED_PARTICIPANTS` to that exact
comma-separated participant list.

Output is a single JSON document on stdout (suitable for CI
consumption). Per-scenario progress goes to stderr.

Exit codes: `0` all pass, `1` any failure, `2` invalid invocation.

## What's not here yet

- Additional locale scenarios beyond zh / en / ja / mixed — the runner is
  locale-agnostic.
- Adversarial / safety scenarios (prompt injection, memory poisoning,
  tool escalation) — overlaps with `tests/promptfoo/`. Decision is to
  drive them through the same runner once Qdrant/safety assertions land.
- Qdrant semantic-memory inspection — Phase 3 dashboard work surfaces
  Qdrant payloads; the runner can then poll memory directly instead of
  relying on reply text alone.
- Cross-user / memory-leak scenarios — Phase 3.
- garak / PyRIT integration — Phase 4+.

## Conventions

- Scenarios are deterministic about *participants* (use a dedicated
  E.164 in the test range) but tolerant of *reply wording* (model output
  varies). Prefer `reply_contains_any` over exact string match.
- Memory-recall scenarios must run sequentially (no parallel turns
  within a scenario). Different scenarios can run in parallel only if
  they use different `participant` values, otherwise Mem0 partitions
  collide.
- `testMode: true` scenarios create or update the scenario participant's
  `pa_users` record with `testMode = true` so `__PA_RESET__` can be tested
  without a manual CLI bootstrap.
- Cleanup is intentionally NOT performed by the runner — we want the
  Firestore docs and Qdrant memories to remain for forensic inspection
  after a failure. Operator script (TBD Phase 3) will sweep
  `harness_*` ids on demand.
