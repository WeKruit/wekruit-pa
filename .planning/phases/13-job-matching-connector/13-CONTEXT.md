# Phase 13 — Job-Matching Connector (Reactive Path)

> Status: P9 v1. Phase 12 (proactive outbound) is **explicitly skipped**
> per user instruction. Phase 13 is a **reactive-only** path: user asks
> for matches → PA invokes `wekruit-matching` in the same turn → renders
> reply → asks follow-ups. Markdown only — production code is P8 territory.

## 0. North-star anchor

PA = personal job-search PA. Phase 13 closes the first user-facing job
discovery loop:

> User: "帮我看看有什么岗位匹配 / find me jobs that fit my background /
> 最近有没有推荐机会"
>
> PA (LLM): picks `wekruit-matching` tool → connector calls real WeKruit
> backend at `PA_MATCHING_URL` with `{userId, query, ...}` → backend
> returns ranked role list → PA renders top-N + asks one clarifying
> follow-up.

Everything else (proactive nudges, batch outreach, persona rewrite based
on match results) stays out of scope.

## 1. Architecture lock (carry-forward, do not relitigate)

These constraints come from prior phases. Phase 13 INHERITS them; do not
weaken them.

- **A1 (Phase 10.5)** — Default agent runtime is the OpenAI Agents SDK.
  Connectors reach the LLM via `buildSdkTools` in
  `packages/agent-runtime/src/openai-agents-adapter.ts` line 154. New
  connectors registered in `connectorRegistry` are auto-bridged when
  added to the agent's `allowedConnectors`.
- **A2 boundary (Phase 11)** — The Agents SDK turn receives only
  `{systemPrompt, memoryBlock/systemInputs, history, userMessage}`. It
  NEVER receives Firestore handles, Mem0 keys, or `userId` directly.
  Phase 13's connector executes inside `runConnector` where
  `ConnectorContext.userId` IS available — that's the orchestrator-side
  resolution boundary, not the SDK boundary.
- **A4 (Phase 11 identity contract §3.2)** — Phase 13 matching
  connector receives `userId` only. It does NOT touch Mem0/Qdrant
  directly. If the backend wants persona facts, it does its own
  Firestore read scoped on `userId`.
- **Phase 10.5 T8** — Default agent has `toolPolicy: "allowlist"`,
  `allowedConnectors: ["current-info", "remember-fact"]`,
  `toolBudgetPerTurn: 3`. Phase 13 extends the allowlist; budget=3 is
  preserved (covers the "记住 X 然后看岗位" multi-tool turn).
- **Phase 10.5 hot-fix #4** — OpenAI Responses API rejects tool schemas
  where `required` does not list every property. All Phase 13 schemas
  MUST list every property in `required`. Optional fields are encoded
  as `T | null` with `required` true, NOT as Zod `.optional()`.
- **Phase 11.1** — Persona card is `userId`-keyed Firestore-only.
  Matching backend reads persona facts (if it wants) the same way:
  `userId`-scoped `pa_memory_facts`. The formatted persona card is
  read-only context, never a filter.
- **`PA_RESET` orchestrator guard** — Untouched by Phase 13. Reset
  flow does not interact with matching.

## 2. Identity contract (Phase 13-specific)

Authoritative: identity contract at
`.planning/phases/11-persona-identity-injection/11-IDENTITY-CONTRACT.md`
§3.2 row "Phase 13 matching connector". Reproduced here for
self-containment:

| Surface | Value | Source |
|---------|-------|--------|
| Connector input → backend | `{userId, query, filters?}` | `userId` from `ConnectorContext.userId` (Firestore canonical); `query` from LLM tool args |
| Backend → persona facts (optional) | `pa_memory_facts` where `userId == userId` AND `status == "confirmed"` | Backend's own Firestore admin read, OR a thin internal read endpoint owned by the backend team. **NOT proxied by the connector.** |
| Connector audit row | `pa_tool_calls` keyed on `userId`, `turnId` | Existing `runConnector` audit pattern |

Forbidden:
- Connector MUST NOT pass `mem0UserId` to the matching backend.
- Connector MUST NOT proxy Mem0/Qdrant queries on the backend's behalf.
- Backend MUST NOT receive any field that allows it to reseat the
  user's persona (no rewrite endpoint into `pa_memory_facts`).
- The matching backend is **read-only** on persona; writes stay owned
  by `remember-fact` (user-explicit) and admin-confirmed proposals.

## 3. Backend assumption

Phase 13 ASSUMES `PA_MATCHING_URL` will resolve to a WeKruit-internal
HTTP service shipped by a separate backend team. This phase does NOT
implement that backend.

What Phase 13 ships in this repo:
1. Production-grade `wekruit-matching` connector (rich schemas, retry,
   audit, degraded mode).
2. Default-agent `allowedConnectors` extension via the Phase 10.5 T8
   migration script pattern.
3. Auto-wired SDK tool bridge (no adapter edit; existing
   `buildSdkTools` picks up new registry entries).
4. Production scenario `tests/scenarios/scenarios/job-matching-zh.yaml`
   exercising the tool-call path (assertions tolerant of backend
   stub/degraded mode).
5. Dashboard surface — `pa_tool_calls` rows for `wekruit-matching`
   already render via the existing Connectors panel; Phase 13 verifies
   rank+score appear in `resultSummary` truncation and adds a panel
   filter for `connectorName === "wekruit-matching"` if missing.
6. Production deploy + REST verify + live harness.

What Phase 13 does NOT ship:
- The matching backend itself (separate repo, separate team).
- A backend stub in the production runtime. Stubs are dev/CI only.
- Any persona-rewrite path triggered by match results.

## 4. Degraded-mode contract

When `PA_MATCHING_URL` is unset OR the backend returns non-2xx OR the
backend times out:

- The connector returns `{ok: false, source: "wekruit-matching",
  reason, summary}` — never throws inside `execute` (per Phase 10.5
  remember-fact convention: throwing prevents the LLM from apologizing
  to the user).
- The orchestrator's `runConnector` already records the failure as a
  `tool_call_completed` audit with `ok: false` and stores
  `resultSummary` truncated to 1000 chars.
- The LLM receives the JSON-stringified result and is expected to say
  something like "暂时没法拿到匹配结果，稍后再试". Scenario assertions
  must tolerate this fallback wording.

## 5. Success criteria (goal-backward)

| Criterion | How verified |
|---|---|
| 1. LLM autonomously picks `wekruit-matching` for job-discovery user intent | scenario `job-matching-zh.yaml` asserts a `wekruit-matching` row in `pa_tool_calls` for the discovery turn |
| 2. Connector input includes `userId` (never `mem0UserId`); backend gets identity contract right | unit test on connector `execute`; manual curl recipe in 13-PLAN §6 |
| 3. Strict-mode tool schema (every property in `required`) | adapter integration test runs against OpenAI Responses API; degraded-mode dev scenario succeeds without 400-tool-schema-error |
| 4. Default-agent allowlist contains `wekruit-matching` after migration | `pa-set-default-tool-policy.mjs` extension produces `allowedConnectors: ["current-info", "remember-fact", "wekruit-matching"]`; idempotent |
| 5. Tool-budget interaction safe (multi-tool turn) | scenario asserts `记住 X 然后看岗位` produces 2 tool calls within budget=3, both succeed |
| 6. Dashboard renders matching invocations with rank+score | manual screenshot in 13-VERIFICATION |
| 7. Rollback flag works | `PA_MATCHING_DISABLED=true` removes connector from runtime allowlist without Firestore edit |
| 8. Harness `pa_outbound = 0` for the new scenario | assertion in scenario; matches Phase 11.1 / 10.5 baseline |

## 6. Out of scope (locked)

- **Phase 12 proactive outbound** — Skipped per user instruction.
  Phase 13 is reactive only; the connector fires only when the LLM
  decides to call it within a user-initiated turn.
- **Phase 14 eval** — Parallel; eval harness consumes Phase 13's
  scenario output but is owned by Phase 14.
- **Phase 15 typing indicator** — Parallel; presentation-layer only.
- **Persona REWRITE based on match results** — The matching backend
  is read-only on persona (§2). If a user accepts a recommendation,
  any new fact is written through the existing `remember-fact`
  user-explicit path on a subsequent turn, NOT inferred by the
  backend.
- **Multi-tenant org-level matching** — Same exclusion as Phase 11
  identity contract §6.
- **Group chats / fan-out outbound** — Same exclusion as Phase 11.

## 7. Phase 11.3 dependency

Phase 11.3 is in flight in a parallel session and ships
`mem0UserId` resolver + schema doc.

Phase 13 ships AFTER 11.3.1 (resolver helper) and 11.3.2 (schema doc)
land — but **does NOT block on 11.3's full 3-deploy completion**.
Reason: matching uses `userId` only. The connector never resolves a
Mem0 partition key. The only 11.3 artifact Phase 13 reads is the
identity contract (already in place).

If 11.3 slips beyond 11.3.2, Phase 13 can still ship — escalate to
P10 only if 11.3.1 (resolver helper) is delayed enough that the
identity contract document itself is rewritten.

## 8. Risk register (severity-ordered)

| Risk | Severity | Mitigation |
|---|---|---|
| Real backend doesn't exist on Phase 13 ship date | HIGH | Connector ships in degraded mode by default. `PA_MATCHING_URL` unset → connector returns `ok:false` with a clean reason. Live harness + production scenario tolerate degraded reply. Backend wire-up is a follow-up env-var change, not a redeploy. |
| LLM over-calls `wekruit-matching` (every turn) | MEDIUM | Tool description discourages calls without explicit user job-discovery intent. Tool-budget=3 caps catastrophic loops. Phase 14 eval will baseline call frequency. |
| Tool schema rejected by Responses API at runtime | MEDIUM | All schemas use Zod objects with every key in `required`. Optional fields encoded as `T | null` per Phase 10.5 hot-fix #4. Pre-merge integration test runs against the real Responses API in the live harness. |
| Privacy: confirmed facts shared with backend without explicit user consent | MEDIUM | Backend reads `pa_memory_facts` ONLY for the same `userId` whose turn triggered the call. Audit row in `pa_tool_calls` is the operator's record. Per-user opt-in / consent-banner pattern is FLAGGED as a Phase 16 follow-up — NOT shipped in 13. |
| Multi-tool turn (记住 X + 看岗位) blows tool budget | LOW | Existing budget=3 covers up to 3 tool calls per turn. Scenario explicitly probes this and asserts both calls succeed. |
| Backend returns malformed payload | LOW | `outputSchema.parse(rawResult)` in `runConnector` catches schema drift; reduces to `connector_error` audit; LLM receives error and apologizes. |
| Identity drift (connector called with stale userId) | LOW | `ConnectorContext.userId` flows from `event.userId` set by `pa_broker` at inbound time. Same path as `remember-fact`. No new drift surface. |
| `pa_tool_calls` table grows unboundedly | LOW | Existing audit pattern; no new sink. Operations dashboard already paginates. |

## 9. Glossary

- **Reactive path** — The connector fires only inside the user's
  current turn, in response to the LLM's tool call decision. No timer,
  no scheduler, no proactive scan.
- **Degraded mode** — `PA_MATCHING_URL` unset OR backend unreachable.
  Connector returns `ok:false` cleanly; LLM apologizes; no crash.
- **`pa_tool_calls`** — Firestore collection that stores every
  connector invocation (allow/deny/run/complete/fail). Existing
  surface; Phase 13 just adds rows of `connectorName ==
  "wekruit-matching"`.
