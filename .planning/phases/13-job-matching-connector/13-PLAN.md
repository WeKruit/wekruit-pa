# Phase 13 Plan — Job-Matching Connector (Reactive Path)

> Status: P9 v1. Reactive only. Phase 12 proactive outbound is skipped
> per user instruction. Markdown only — production code is P8 territory.

## 0. Architecture lock (carry-forward)

See `13-CONTEXT.md` §1. Reproducing only the rules that bind file-
domain isolation here:

- Connector registry lives in `packages/pa-connectors/src/index.ts`.
  The skeleton already exists (lines 39–46, 100–132). 13.1 replaces
  the schemas and `execute` in place — same file, same export name.
- SDK tool bridge in `packages/agent-runtime/src/openai-agents-adapter.ts`
  line 154 (`buildSdkTools`) auto-picks up registry changes via
  `AgentTurnTool[]`. **No adapter edit is needed in Phase 13.** 13.3
  is a verification-only task (test that the existing bridge handles
  the new schema).
- Default-agent record migration uses the Phase 10.5 T8 pattern at
  `scripts/pa-set-default-tool-policy.mjs`. 13.2 extends the target
  set; same script, same idempotency contract.
- `pa-orchestrator` is **not edited** in Phase 13. Connector resolution
  uses the existing `runConnector(name, args, ctx)` path. `userId`
  flows in via `ctx.userId` already populated by the orchestrator from
  `event.userId`.

## 1. File-domain isolation map

| Task | Owns (writes) | Reads only | Notes |
|------|---------------|------------|-------|
| 13.1 | `packages/pa-connectors/src/index.ts`, `packages/pa-connectors/src/index.test.ts` (extends) | `packages/core-types`, `packages/pa-safety`, identity contract doc | Schema + execute rewrite for `wekruit-matching` only. Other connectors untouched. |
| 13.2 | `scripts/pa-set-default-tool-policy.mjs`, `scripts/pa-set-default-tool-policy.test.mjs` | `seed.json` for sanity | Extend `forwardTarget.allowedConnectors` to include `"wekruit-matching"`. Rollback target unchanged. |
| 13.3 | `packages/agent-runtime/src/openai-agents-adapter.test.ts` (extends) | `packages/agent-runtime/src/openai-agents-adapter.ts` (read only) | Verification-only; tests new schema flows through `buildSdkTools` and produces a strict-mode-compliant tool definition. **No code edit to the adapter.** |
| 13.4 | `tests/scenarios/scenarios/job-matching-zh.yaml` (NEW) | harness runner (no edits) | Production scenario. `suppressOutbound: true` per Phase 9. |
| 13.5 | `apps/dashboard/...` (TBD by P8 read-first) | `pa_tool_calls` shape | Dashboard filter for `connectorName === "wekruit-matching"` IF missing. P8 reads dashboard panel first, escalates if a structural change is needed. |
| 13.6 | `.planning/phases/13-job-matching-connector/13-VERIFICATION.md` (NEW) | production logs | Deploy + REST verify + harness sweep. |

13.1, 13.2, 13.4, 13.5 edit different files → can run in PARALLEL waves.
13.3 reads 13.1's output → serial after 13.1. 13.6 is the closing wave.

## 2. Tradeoff for connector input shape

**Question:** Should `wekruit-matching` accept just `query: string`, or
include structured `filters` (location, role-type, seniority)?

- **(a) `{query: string}` only.** Simplest. Backend parses NL out of
  the query string. Matches today's skeleton.
- **(b) `{query: string, filters?: {...}}`.** Lets the LLM extract
  structured filters from the user message and pass them explicitly.
  Better UX downstream (backend doesn't re-NLP).
- **(c) `{query, locale, filters}`.** Adds locale for zh/en/ja
  disambiguation.

**Decision: (b) with explicit-required encoding.** Rationale:
- LLMs ARE good at extracting "杭州前端2年经验" → `{location:
  "Hangzhou", role: "frontend", years: 2}`. Letting the model pre-
  structure saves a backend round-trip.
- Locale is recoverable from `query` plus the agent's locale config
  (we don't ship multi-language matching backend in v1, so adding
  `locale` now is premature).
- Per Phase 10.5 hot-fix #4: every property in `required`. Encode
  `filters` as `filters: FiltersObject` where `FiltersObject` itself
  has every property required, with optional values typed as `T |
  null` (NOT `.optional()`).

## 3. Tasks (P8 prompts, six-element form)

### 13.1 — Tighten `wekruit-matching` connector input/output schemas + execute

- **WHY (Goal):** Ship a production-grade connector with strict-mode-
  compatible schemas, retry, and degraded-mode fallback. Closes
  Criterion 2 + 3 + part of 7 in 13-CONTEXT §5.
- **WHAT (Inputs):**
  - File: `packages/pa-connectors/src/index.ts` lines 39–46 (input/
    output schemas) and 100–132 (`execute`).
  - Identity contract `13-CONTEXT.md` §2.
  - Phase 10.5 hot-fix #4 strict-schema rule.
  - Existing `runConnector` audit pattern (lines 234–334).
- **WHERE (Scope):** ONLY `packages/pa-connectors/src/index.ts` and
  `packages/pa-connectors/src/index.test.ts`. Do NOT touch any other
  connector definition. Do NOT touch `pa-safety` or `runConnector`.
- **HOW MUCH (Contract):**
  - **Input schema (Zod):**
    ```
    MatchingInputSchema = z.object({
      query: z.string().min(1).max(500),
      filters: z.object({
        location:    z.string().nullable(),  // not .optional()
        roleType:    z.string().nullable(),
        seniority:   z.string().nullable(),
        yearsOfExp:  z.number().int().min(0).max(60).nullable(),
      }),
    })
    ```
    Every field, including every key inside `filters`, is `required`
    (Zod `.nullable()` keeps the key required at the JSON Schema level).
    Verify by inspecting the generated schema in 13.3.
  - **Output schema (Zod):**
    ```
    MatchingOutputSchema = z.object({
      ok:     z.boolean(),
      source: z.literal("wekruit-matching"),
      reason: z.string().nullable(),         // null on success, string on error
      summary: z.string(),                   // human-readable, ≤ 1000 chars
      roles:  z.array(z.object({
        roleId:    z.string(),
        title:     z.string(),
        company:   z.string(),
        fitScore:  z.number().min(0).max(1),
        summary:   z.string(),
        applyUrl:  z.string().nullable(),
      })).max(5),
    })
    ```
    Cap `roles` at 5 to bound LLM context. `applyUrl` may be null when
    the backend doesn't surface a deeplink yet.
  - **`execute(input, ctx)`:**
    1. If `process.env.PA_MATCHING_DISABLED === "true"` OR
       `process.env.PA_MATCHING_URL` is unset: return
       `{ok: false, source: "wekruit-matching", reason:
       "matching_service_not_configured", summary: "暂时无法获取匹配
       结果，请稍后再试。", roles: []}`. **Do NOT throw.**
    2. POST to `PA_MATCHING_URL` with body
       `{userId: ctx.userId, query: input.query, filters:
       input.filters}`. Auth header is `Bearer
       ${process.env.PA_MATCHING_TOKEN}` when set.
    3. Timeout: 8000ms via `AbortController`. Phase 10.5 baseline
       for `current-info` is similar; matching adds 1 retry on
       network/5xx (NOT on 4xx).
    4. Retry: ONE retry, exponential 250ms, on `AbortError | network
       error | status >= 500`. Do NOT retry on 4xx.
    5. Parse the backend payload as JSON. Backend contract:
       `{roles: Role[]}`. If JSON parse fails OR shape mismatch:
       return `{ok:false, reason: "backend_payload_invalid", summary:
       "匹配服务返回异常，已记录。", roles: []}`.
    6. On success: clamp `roles.length <= 5` (slice). Stringify
       summary as `"匹配到 N 个岗位：" + comma-joined titles` truncated
       to 200 chars. Return full structured `roles`.
  - **Auth/secret handling:** `PA_MATCHING_TOKEN` MUST flow only via
    the `Authorization` header. Do NOT log it. The existing `redact`
    helper (line 225) already strips fields matching `/token|secret/i`
    in `argsRedacted`; verify the connector input does NOT include the
    token (it doesn't — token is env-only).
  - **Existing `redact` helper covers `argsRedacted`** but the input
    schema includes `userId` only via `ctx`, never `args` — so PII
    leakage is bounded by Phase 10.5 redaction rules.
- **DONE (Verification):**
  - `npm test -w @pa/pa-connectors` passes new tests covering:
    (1) `PA_MATCHING_URL` unset → degraded `ok:false` with
    `reason: "matching_service_not_configured"`, no fetch issued.
    (2) `PA_MATCHING_DISABLED=true` overrides even when URL is set
    → degraded path.
    (3) Backend 200 OK with valid `{roles: [...]}` → `ok:true`,
    `roles.length <= 5`, summary mentions count.
    (4) Backend 500 → 1 retry, then `ok:false` with
    `reason: "backend_5xx"`.
    (5) Backend 400 → no retry, `ok:false`,
    `reason: "backend_4xx"`.
    (6) Backend timeout (mock AbortController) → 1 retry then
    `ok:false`, `reason: "backend_timeout"`.
    (7) Backend returns malformed JSON → `ok:false`,
    `reason: "backend_payload_invalid"`.
    (8) Body sent to backend includes `userId`, `query`, `filters`
    in that shape — assert via fetch mock.
  - Connector NEVER throws inside `execute`. Test (4)–(7) all
    return cleanly.
  - `npm run build:all` clean.
- **DON'T (Red lines):**
  - Do NOT pass `mem0UserId` to the backend. `ConnectorContext` does
    not even expose it; verify by reading `ConnectorContext` type
    (line 14).
  - Do NOT use Zod `.optional()`. Use `.nullable()` so the JSON
    Schema `required` array stays full.
  - Do NOT throw inside `execute`. Throwing breaks the LLM apology
    path (per remember-fact precedent).
  - Do NOT add Mem0/Qdrant calls in the connector. Backend handles
    its own persona reads via Firestore.
  - Do NOT log `PA_MATCHING_TOKEN`. Do NOT include it in the request
    body. Header only.
  - Do NOT raise the budget cap or modify `runConnector`. Budget=3
    is a Phase 10.5 lock.
  - Do NOT change `name` or `version` keys; downstream audit and
    dashboard filters depend on `"wekruit-matching"` as the literal
    name.

### 13.2 — Extend default-agent allowlist to include `wekruit-matching`

- **WHY (Goal):** LLM can autonomously call the matching connector.
  Closes Criterion 4 in 13-CONTEXT §5.
- **WHAT (Inputs):**
  - `scripts/pa-set-default-tool-policy.mjs` line 58 (`forwardTarget`).
  - `scripts/pa-set-default-tool-policy.test.mjs` (extend).
- **WHERE (Scope):** ONLY those two files. Do NOT touch the rollback
  target. Do NOT touch any other migration script.
- **HOW MUCH (Contract):**
  - Forward target becomes:
    ```
    allowedConnectors: Object.freeze([
      "current-info",
      "remember-fact",
      "wekruit-matching",
    ]),
    toolBudgetPerTurn: 3,
    ```
  - Rollback target unchanged (`allowedConnectors: []`,
    `toolBudgetPerTurn` left as-is).
  - Idempotent re-run: if a Firestore record already has
    `["current-info", "remember-fact", "wekruit-matching"]` (any
    order, set-equal), `action === "noop"`.
  - Existing tests for set-equality and budget-drift detection still
    pass; add three new tests:
    - Forward applies to a doc with `["current-info","remember-fact"]`
      (Phase 10.5 baseline) — patch adds `"wekruit-matching"`.
    - Forward is noop when doc already contains all three (any order).
    - Forward overwrites a doc with budget=1 — set to 3.
- **DONE (Verification):**
  - `node --test scripts/pa-set-default-tool-policy.test.mjs` passes.
  - Dry-run against staging: `node scripts/pa-set-default-tool-policy.mjs
    --plan` prints expected diff `["current-info","remember-fact"] →
    ["current-info","remember-fact","wekruit-matching"]`.
- **DON'T (Red lines):**
  - Do NOT touch `toolPolicy` (already `"allowlist"`).
  - Do NOT touch the rollback path. (Rollback removes ALL tools, that
    contract stays. Phase-13-specific rollback uses
    `PA_MATCHING_DISABLED` env, NOT a Firestore rewrite.)
  - Do NOT change `toolBudgetPerTurn` from 3.

### 13.3 — Verify SDK tool bridge handles new schema (test only)

- **WHY (Goal):** Confirm `buildSdkTools` produces a strict-mode-
  compatible tool definition for the new richer schema. Closes
  Criterion 3 (strict-mode tool schema).
- **WHAT (Inputs):** `packages/agent-runtime/src/openai-agents-adapter.ts`
  line 154 (`buildSdkTools`). The new `MatchingInputSchema` from 13.1.
- **WHERE (Scope):** ONLY
  `packages/agent-runtime/src/openai-agents-adapter.test.ts` (extend).
  Do NOT edit the adapter.
- **HOW MUCH (Contract):**
  - New test: build an `AgentTurnTool[]` with the matching tool's Zod
    parameters; pass through `buildSdkTools`; inspect the underlying
    `tool()` SDK call's emitted JSON Schema (or assert `parameters`
    is set to the Zod object reference).
  - Sanity test: every key in `MatchingInputSchema.shape` is in the
    Zod object's required keys list (no `.optional()` slipped in).
    Use Zod's `_def.shape` introspection or compile to JSON Schema
    via `zod-to-json-schema` if already a dev dep.
  - If there's no easy way to introspect the JSON Schema in-process,
    fall back to a manual pre-merge verification: deploy to staging,
    run a one-shot turn that triggers the tool, verify no
    `400 invalid_function_parameters` in the response.
- **DONE (Verification):**
  - `npm test -w @pa/agent-runtime` passes new test.
  - `npm run build:all` clean.
- **DON'T (Red lines):**
  - Do NOT edit `openai-agents-adapter.ts`. If the test reveals the
    bridge cannot handle nested objects in strict mode, ESCALATE — do
    not patch the adapter without P9 review (this would touch a
    Phase-10.5-locked file).

### 13.4 — Production scenario `job-matching-zh.yaml`

- **WHY (Goal):** Closes Criterion 1, 5, 8 in 13-CONTEXT §5. Live
  regression coverage of the reactive job-matching path.
- **WHAT (Inputs):** Existing scenarios `remember-fact-zh.yaml` and
  `tool-budget-stress-zh.yaml` as templates. Harness runner default
  `suppressOutbound: true`. Reserved test handle (Phase 9 convention).
- **WHERE (Scope):** create
  `tests/scenarios/scenarios/job-matching-zh.yaml`. NO runner edits.
  If the harness DSL lacks a way to assert "a `wekruit-matching` row
  exists in `pa_tool_calls`", FALL BACK to `reply_contains_any`
  matchers and flag the runner gap as a Phase 14 follow-up. Do NOT
  invent a new YAML matcher.
- **HOW MUCH (Contract):**
  - Six turns:
    1. `__PA_RESET__` → assert reply contains `"测试记忆已清空"`.
    2. `请记住 我是前端工程师，2年经验，在杭州` → assert reply
       acknowledges (`记住|好的|知道|OK|ok`). Plants confirmed facts
       so the matching backend has signal.
    3. `帮我看看有什么岗位匹配` → assert
       `reply_min_length: 1`, and (if the harness supports it)
       `tool_call_required: ["wekruit-matching"]`. Otherwise assert
       `reply_contains_any` covers BOTH success and degraded-mode
       wording: `["岗位", "匹配", "暂时", "稍后"]`.
       The reply MUST be tolerant of the backend stub's output.
    4. `记住 我对远程岗位也开放，然后再帮我看看` → multi-tool turn.
       Assert `reply_min_length: 1`. Verifies budget=3 covers
       `remember-fact` + `wekruit-matching` in one turn. (If harness
       supports `tool_calls_count_max: 3`, set it; otherwise rely on
       `pa_tool_calls` audit row count in 13.6 manual verify.)
    5. `最近有没有推荐机会` (locale-natural rewording) → assert
       `reply_min_length: 1`. Confirms the LLM picks the connector
       even with different phrasing.
    6. `谢谢` → assert `reply_min_length: 1`,
       `reply_not_contains_any: ["岗位", "匹配"]` — confirms the LLM
       does NOT call the connector for non-discovery turns.
  - `suppressOutbound: true` (default).
  - `turnTimeoutMs: 90000` (Phase 10.5 baseline).
  - `agentId: default`. `participant: "+19999990013"` (next reserved
    test handle slot — verify against Phase 9 reserved list before
    write).
- **DONE (Verification):**
  - `npm run scenarios -- job-matching-zh` passes against staging
    once 13.1 + 13.2 land.
  - Cumulative `pa_outbound` across all scenarios remains 0.
  - `pa_tool_calls` for turns 3, 4, 5 each contain at least one row
    with `connectorName === "wekruit-matching"`.
  - Turn 6 has zero `wekruit-matching` rows.
- **DON'T (Red lines):**
  - Do NOT flip `suppressOutbound` (Phase 9 hardening).
  - Do NOT introduce new YAML matcher fields.
  - Do NOT seed facts via direct Firestore write — turn 2 must
    exercise the `remember-fact` connector path.
  - Do NOT add a turn that explicitly asks the LLM to use a tool
    name (e.g. `"call wekruit-matching"`) — that's a prompt-injection
    smell and would mask whether the LLM autonomously picks the tool.

### 13.5 — Dashboard surface verification + filter

- **WHY (Goal):** Operators can see `wekruit-matching` invocations
  with rank+score per turn. Closes Criterion 6 in 13-CONTEXT §5.
- **WHAT (Inputs):** Existing dashboard Connectors panel. P8 must
  read the panel code first (likely `apps/dashboard/...`) before
  scoping edits — exact path unknown to P9 at planning time, P8
  resolves via grep on `pa_tool_calls` consumers in `apps/dashboard`.
- **WHERE (Scope):** ONLY dashboard source files. Do NOT touch
  `pa_tool_calls` schema, `runConnector`, or any orchestrator file.
  If the existing panel already supports per-connector filtering,
  this task is verification-only (screenshot in 13.6).
- **HOW MUCH (Contract):**
  - If the panel already filters by `connectorName`: VERIFY-ONLY,
    no code change. Capture a screenshot of `wekruit-matching` rows
    rendering with `resultSummary` containing role titles + fit
    scores.
  - If the panel does NOT filter by `connectorName`: add a filter
    chip / dropdown that supports the existing connectors plus
    `wekruit-matching`. Source the connector list from the registry
    keys (do NOT hardcode).
  - DO NOT add a new sub-tab dedicated to matching. Reuse the
    existing Connectors panel; consistency over feature creep.
- **DONE (Verification):**
  - Manual screenshot in `13-VERIFICATION.md` showing a
    `wekruit-matching` row with fit-score visible in
    `resultSummary` (truncated to 1000 chars by `runConnector`).
  - `npm run build:all` clean (dashboard included).
- **DON'T (Red lines):**
  - Do NOT modify `pa_tool_calls` write shape.
  - Do NOT add a new Firestore index without P9 review (cost +
    deploy-coupled change).
  - Do NOT add real-time listeners if the panel is currently
    polling — match existing convention.

### 13.6 — Production deploy + REST verify + live harness

- **WHY (Goal):** Phase 13 ships to prod. Closes Criteria 7, 8.
- **WHAT (Inputs):** Merged 13.1 + 13.2 + 13.3 + 13.4 + 13.5.
- **WHERE (Scope):** create
  `.planning/phases/13-job-matching-connector/13-VERIFICATION.md`.
  Operations only — no code.
- **HOW MUCH (Contract):**
  1. Pre-deploy: ensure `PA_MATCHING_DISABLED` is unset; ensure
     `PA_MATCHING_URL` is either unset (production starts in
     degraded mode) OR points to the WeKruit-internal staging URL
     coordinated with the backend team.
  2. Deploy Cloud Functions.
  3. Run `node scripts/pa-set-default-tool-policy.mjs` against
     production to extend the allowlist. Capture the diff output
     (should write `wekruit-matching`).
  4. Run `npm run scenarios -- job-matching-zh` against production
     reserved test handle. Capture pass/fail per turn.
  5. Run the existing scenario suite (current-info-live-{zh,en,ja},
     memory-recall-{zh,en,ja,mixed}, remember-fact-zh,
     persona-card-zh, reset-integration-zh, tool-budget-stress-zh)
     to confirm zero regressions. Cumulative `pa_outbound = 0`.
  6. Manual REST probe via the live harness REST endpoint (Phase 9
     pattern) — verify a single turn produces a `pa_tool_calls`
     row with `connectorName: "wekruit-matching"` and
     `policyDecision: "allow"`.
  7. Test rollback flag: set `PA_MATCHING_DISABLED=true` in
     production env, restart, run scenario turn 3 — assert reply
     uses degraded wording, `pa_tool_calls` row has
     `status: "completed"` and `resultSummary` contains
     `"matching_service_not_configured"` reason.
  8. Unset the flag. Final smoke test.
- **DONE (Verification):** `13-VERIFICATION.md` documents each step
  with output snippets, commit SHAs, and Cloud Functions revision IDs
  per Phase 10.5 verification template.
- **DON'T (Red lines):**
  - Do NOT roll back via Firestore edit. Use `PA_MATCHING_DISABLED`
    env-var only (the connector's runtime guard from 13.1).
  - Do NOT skip the existing scenario regression sweep.
  - Do NOT deploy 13.1 without 13.2 (would leave the connector code
    live but unreachable — harmless but wastes a deploy slot).

## 4. Identity flow contract (reproduced from 13-CONTEXT §2)

```
LLM tool call
  └─ runConnector("wekruit-matching", {query, filters}, ctx)
        └─ ctx.userId  (Firestore canonical, set by orchestrator
                        from event.userId)
              └─ POST PA_MATCHING_URL
                    body = {userId, query, filters}
                    NO mem0UserId, NO Mem0/Qdrant access

Backend (separate repo, separate team):
  reads pa_memory_facts WHERE userId == userId AND status == confirmed
  (its own Firestore admin client, NOT proxied by the orchestrator)
  returns {roles: Role[]}
```

Connector NEVER:
- Passes `mem0UserId` to the backend.
- Reads Mem0/Qdrant on the backend's behalf.
- Accepts a backend-proposed persona rewrite. (Persona writes are
  owned by `remember-fact` only.)

## 5. Backend stub for testing

Phase 13 does NOT implement the matching backend. For dev/CI we accept
two modes:

- **Default (degraded):** `PA_MATCHING_URL` unset. Connector returns
  `ok:false, reason: "matching_service_not_configured"` cleanly. The
  production scenario in 13.4 must tolerate this via
  `reply_contains_any` covering both success and degraded wording.
- **Local stub (optional, dev-only):** Engineer runs a 30-line
  `tools/local-matching-stub.mjs` that responds 200 with two fake
  roles. Document the stub command in `13-VERIFICATION.md` Appendix
  A. The stub is NOT shipped to production; it lives in `tools/`
  (or `scripts/dev/`) and is gitignored from prod build outputs.
  Phase 13 does NOT add a Cloud Functions stub endpoint.

CI: GitHub Actions runs the connector unit tests (13.1) which use
`fetch` mocks — no live backend required. The harness scenario in
13.4 is staged against production and tolerates degraded mode, so
CI does not block on a backend.

## 6. Goal-backward verification matrix

| 13-CONTEXT criterion | Closed by |
|---|---|
| 1. LLM autonomously picks `wekruit-matching` for job-discovery intent | 13.4 turns 3, 5 (`reply_contains_any` + post-hoc `pa_tool_calls` row check in 13.6) |
| 2. Connector input includes `userId`, never `mem0UserId` | 13.1 unit test (8); ConnectorContext type review (compile-time) |
| 3. Strict-mode tool schema | 13.1 schema definition + 13.3 bridge test + 13.6 live REST probe |
| 4. Default-agent allowlist contains `wekruit-matching` | 13.2 migration script + 13.6 step 3 dry-run capture |
| 5. Tool-budget interaction safe (multi-tool turn) | 13.4 turn 4 + 13.6 manual `pa_tool_calls` count |
| 6. Dashboard renders matching invocations | 13.5 verification screenshot in 13.6 |
| 7. Rollback flag works | 13.6 step 7 |
| 8. Harness `pa_outbound = 0` for the new scenario | 13.4 + 13.6 step 5 |

## 7. Rollout strategy

**Single PR is NOT safe.** Three logical groupings; ship as 2 PRs:

- **PR-1 (code-only):** 13.1 + 13.3. Connector implementation +
  bridge test. Mergeable independently because the new connector is
  not yet in any agent's allowlist — adding code to the registry is
  a no-op until 13.2 runs. PR-1 also avoids forcing a dashboard
  edit in the same review.
- **PR-2 (operations + scenario):** 13.2 + 13.4 + 13.5. Migration
  script extension + production scenario + dashboard surface. This
  PR is the "go-live" gate; reviewer should confirm 13.6 deploy plan
  is ready before merge.
- **13.6** is operations only; runs after PR-2 lands. Produces
  `13-VERIFICATION.md`.

Why not single PR: combining a connector behavior change with an
allowlist migration in one merge would mean any rollback requires
both code revert + Firestore migration revert, doubling the rollback
surface.

## 8. Rollback plan

Two independent kill switches, in order of preference:

1. **`PA_MATCHING_DISABLED=true`** (env var). Connector returns
   degraded mode regardless of `PA_MATCHING_URL`. No redeploy
   required — Cloud Functions env var change + restart. Recovery
   time: < 5 minutes. Use this for runtime issues (bad backend
   behavior, schema regression).
2. **Rerun migration with rollback target.** Removes ALL tools from
   the allowlist (Phase 10.5 T8 inheritance). Use only if the
   connector itself is fundamentally broken AND env-var path also
   fails. Side effect: `current-info` and `remember-fact` are also
   removed — operator must accept this blast radius.

Forward path: once Phase 13 is stable for ≥ 1 week with
`PA_MATCHING_URL` pointing at the real backend, `PA_MATCHING_DISABLED`
flag stays in place but is unset. Phase 14 eval may prune it after a
clean window.

## 9. Risk register (severity-ordered)

See 13-CONTEXT §8 for the full register. Summary of P9-tracked top
three:

| Risk | Severity | Carry-over from CONTEXT? |
|---|---|---|
| Real backend doesn't exist on Phase 13 ship date | HIGH | yes |
| LLM over-calls `wekruit-matching` | MEDIUM | yes — 13.4 turn 6 probes the negative case |
| Tool schema rejected by Responses API at runtime | MEDIUM | yes — 13.3 catches at unit boundary, 13.6 catches at integration |

## 10. Wave plan

- **Wave A (parallel):** 13.1 (P8-A) + 13.4 scenario stub draft (P8-B).
- **Wave B (serial after Wave A):** 13.3 verification test against
  the merged 13.1 schema.
- **Wave C (parallel after Wave A):** 13.2 migration extension
  (P8-C); 13.5 dashboard verify/filter (P8-D, reads dashboard panel
  first to scope WHERE).
- **Wave D (closing):** 13.6 deploy + verify (operations).

## 11. Phase 13 + 11.3 + 14 + 15 deploy sequencing (recommendation)

Phase 11.3 (mem0UserId migration) is in flight in a parallel session.
Phase 13 reads `userId` only — does NOT depend on 11.3's full deploy.
Recommended ordering for clean P10 deploys:

1. **11.3.1 + 11.3.2 land first** (resolver helper + schema doc).
   Phase 13 starts after these merge.
2. **Phase 13 PR-1 lands** (connector code + bridge test). No
   production behavior change yet.
3. **11.3.3 (orchestrator wire-up + drift logging) lands.** Coupled
   to orchestrator file; we want this in production observed for
   ≥ 24h before 13's PR-2 changes the allowlist.
4. **Phase 13 PR-2 lands + 13.6 deploys.** `wekruit-matching` enters
   the allowlist. Production now has both 11.3 partition routing
   and matching connector live. Backend can stay unset
   (degraded mode) until the matching backend team is ready.
5. **Phase 14 (eval harness) starts in parallel** with 13.6 — it
   consumes 13.4's scenario YAML. Phase 14 does NOT block 13's deploy.
6. **Phase 15 (typing indicator)** is presentation-only and can
   ship anytime after 11.3 fully lands; it doesn't interact with
   13's connector path.

Hard gates:
- 13 MUST ship after 11.3.1 + 11.3.2 (identity contract finalized).
- 13 SHOULD ship after 11.3.3 (clean orchestrator baseline) but
  CAN ship before if 11.3.3 slips, because 13 doesn't touch
  `pa-orchestrator/src/index.ts`.
- 14 MUST NOT block 13. 13 ships in degraded mode by default;
  baseline metrics from 14 can be collected later.
- 15 is independent.

