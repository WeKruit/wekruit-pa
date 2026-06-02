All load-bearing claims confirmed against live code. The research is accurate: `addItems` skips `system` (line 203) and `user` (line 204-209) items; `getItems` maps only user/assistant rows; `find_match` returns `jobs: string[]` (compose-only); `compaction.ts` is a no-op stub with no callers; `extractUsage` never reads cached tokens; `resolveClaireMaxTurns` is the env-clamp pattern to mirror. Writing the plan.

# Claire Agent Cost Optimization — Non-Breaking (2026-06-01)

**Owner:** orchestrator · **Branch:** `thin-PB` · **Scope:** thin Claire only (`apps/functions/src/claire-agent/**`, `packages/agent-runtime/**`)
**Hard constraint (Adam):** NO breaking changes to Claire behavior. Only `breakingRisk: NONE` and `LOW` items may ship. Every recommendation below is tagged.
**Status:** validated against live code on `thin-PB` (file:line confirmed); supersedes the non-breaking subset of `.planning/CLAIRE-COST-OPTIMIZATION-COMPLETE-PLAN.md`.

---

## 1. Framing — this is SECONDARY

Conversation cost is **minor**. Firestore evidence: `pa_turns` ≈ 0 in the last 24h; per Adam the dominant cost is **job enrichment**, not the Claire agent loop. So:

- **The main fix is enrichment** (separate workstream, not in scope here).
- This doc is a **secondary** optimization with one governing rule: **do not change what Claire does or says.** A cost win that risks any behavioral regression is rejected, even if cheap.
- Because the workload is already ~0, the absolute dollar savings here are small. The value is (a) **instrumentation** so the cost is no longer invisible, and (b) **prompt caching**, which is information-preserving and pays off automatically if/when conversation volume grows. We ship the safe, additive parts and **defer everything that alters model-visible context or adds an LLM call.**
- `maxTurns` cap already shipped (`resolveClaireMaxTurns`, `agent.ts:52-56`, used at `agent.ts:385`). It is byte-stable (deterministic from env) and orthogonal to everything below — no action needed.

---

## 2. SHIP-NOW (breakingRisk NONE / LOW)

Two changes. Ship **2A first and alone** (it is the measurement that proves 2B). Both confined to the thin path.

### 2A. `cached_tokens` instrumentation — `breakingRisk: NONE`

Pure-additive telemetry. Surfaces the exact metric the caching work moves; without it, 2B's GREEN cannot be proven on the live path.

**Why it's non-breaking:** read-only. New **optional** field; absent field = unchanged prior behavior. No prompt, tool, session, or control-flow change.

**Edits:**
1. `packages/agent-runtime/src/openai-agents-adapter.ts` `extractUsage` (~:184-215) — today it sums only `inputTokens/outputTokens/totalTokens` and **never reads cached tokens** (confirmed: no `cachedTokens` read in the loop). Add a read of `u.inputTokensDetails?.cachedTokens` (SDK camelCase) / `u.input_tokens_details?.cached_tokens` and sum into a new `cachedInputTokens`.
2. `packages/agent-runtime/src/types.ts` `RunAgentTurnUsage` (~:100-117) — add `cachedInputTokens?: number`. (`turnsUsed?`/`maxTurnsExceeded?` already present.)
3. **CRITICAL — thin path does NOT use `extractUsage`.** `claire-agent` calls the SDK `run()` directly (`agent.ts:385`) and `ClaireRunResult` (`types.ts:121-125` = `{finalText; toolCalls; deliveredViaTool}`) carries **no usage field**. So the adapter edit above does NOT cover the live conversation path. Additionally:
   - In `agent.ts` after `run()` resolves (~:385-392, currently only `finalOutput` is read), read `res.rawResponses[*].usage` and sum input/output/**cached** tokens.
   - Add an optional `usage` field to `ClaireRunResult` (`types.ts:121-125`) and thread it through to the `pa_turns.usage` write in `cutover.ts` (per-mode dimension so hit-rate is visible by mode).

**Gate:** one dev-phone turn → `pa_turns.usage.cachedInputTokens` present (≈0 pre-2B). Confirm the value originates from the **claire-agent** `run()` result, not only the agent-runtime adapter.

---

### 2B. Byte-stable instructions → prompt caching — `breakingRisk: LOW`

Make `Agent.instructions` an identical byte string every turn + every inner-loop iteration, and re-inject 100% of per-turn variance as a trailing `{role:'system'}` input item placed **after** the Session-replayed transcript. Same information, repositioned (highest-salience). The static head **and** the growing transcript then cache; turn 2+ pays full price only for the newest increment.

**Why it's LOW, not NONE:** it is **information-preserving** but **not byte-identical** model input — the dynamic block moves from an `instructions` segment to a trailing system message (a role/position change). Info-equivalence confirmed on all four moved pieces (`globalContext`, `prescreenContext`, non-onboarding `pendingStep`, canary tapback block). It must be **live-validated, not assumed** — hence LOW. Two control points below keep it LOW.

**Why persistence is safe (the linchpin, confirmed in code):**
- `FirestoreSession.addItems` **skips system items** (`firestore-session.ts:203` `if (extracted.role === "system") continue`) **and skips SDK user input** (`:204-209`) — it persists assistant output only (idempotent on `sha256(sessionId,role,body)`). The ephemeral per-turn system context item is **never** written to the durable `pa-messages` transcript.
- `getItems` → `chatMessageToInputItem` maps **only** `user`/`assistant` rows (`firestore-session.ts:77-100`); a system row could never re-enter the cached prefix even hypothetically. The trailing system item therefore cannot pollute the next turn's prefix.
- This exact shape (trailing system items after Session history, then the user item) is already the proven default path: `openai-agents-adapter.ts:138-147` `buildAgentsInputItems`.

**Edits (claire-agent, thin):**
- **EP1 — `prompt.ts:390-417` split `buildClairePrompt`:**
  - `buildClairePrompt(opts)` → **only** the byte-stable static head: `PERSONA`, `langLine`, `REPLY_FORMAT`, `VOICE`, `US_SCOPE`, `PREFERENCES`, `DELIVERY`, `SCHEDULING`, a **static** mode-shape (`modeDirective`), `FLEXIBILITY`, `FEWSHOT`. Drop `opts.canary`/`opts.globalContext`/`opts.prescreenContext`/non-onboarding `opts.pendingStep` from the head.
  - `buildClaireTurnContext(opts): string` → the dynamic block: the `CONTEXT — ${globalContext}` line (`:404`), `PRESCREEN CONTEXT` (`:405-407`), the non-onboarding `PENDING STEP` line, and the canary tapback block.
  - **Note:** onboarding folds `pendingStep` into its directive (`prompt.ts` `modeDirective`), which is fine to keep in the static head as a *shape*; only the *resolved* per-turn value moves.
- **EP2 — `agent.ts:119-141` `buildClaireAgent`:** `instructions: buildClairePrompt(staticOpts)`. Optionally add `modelSettings: { promptCacheRetention: '24h', providerData: { prompt_cache_key: \`claire:${ctx.userId}\` } }` (see §3.3, optional follow-on).
- **EP3 — `agent.ts:385` `run()`:** replace `run(agent, turnText, {session, maxTurns})` with the array-input form:
  ```ts
  run(agent, [
    { type:'message', role:'system', content: buildClaireTurnContext({...}) },
    { type:'message', role:'user',   content: turnText },
  ], { session, maxTurns: resolveClaireMaxTurns() })
  ```

**Control point 1 — grounding-coupling fix (part of 2B, `breakingRisk: LOW`):** the `modeDirective` prose that stays in the static head literally tells the model to read "the CONTEXT" and references it as positioned **"above"** (`prompt.ts:224-227` "grounded in the CONTEXT's work history (use THIS)", `:236` "If the CONTEXT includes a Resume upload link", `:275-281` "look at the PRESCREEN CONTEXT (their résumé … above)"). After EP1-EP3 the CONTEXT arrives as a **separate trailing system message**, so "above" is wrong. Update the prose so positional references match (drop "above"; say e.g. "the context provided this turn"). Prose-only; keeps the directive. **If skipped, this rises to MED risk** (subtle grounding drift in the résumé-aware onboarding compliment and prescreen call-backs) — so it ships *with* 2B, not after.

**Control point 2 — tool-schema stability audit (part of 2B, `breakingRisk: NONE` to verify):** for the prefix to actually cache, tool names/descriptions/param JSON schemas must be byte-identical across turns. `buildClaireTools(ctx, {prescreenPrompts, judgeContext})` is called per `buildClaireAgent` — confirm per-turn `prescreenPrompts`/`judgeContext` ride on `execute()` closures, **not** in the serialized tool JSON schema. Audit-only (NONE). If a varying schema is found, moving that variance into `execute()` is LOW.

**Gate (RED→GREEN):** dev-phone ≥3-turn convo → `pa_turns.usage.cachedInputTokens` jumps from ~0 (2A RED) to a large fraction of input on turn 2+. **No GREEN → revert 2B.** Plus the §5 10-turn no-drift + grounding check before any ramp past canary.

> **Plan correction:** the existing complete-plan's P1 targets `openai-agents-adapter.ts:extractUsage` / `run()` as the seam. That is the **wrong seam for thin Claire** — thin calls the SDK `run()` directly and bypasses the adapter. All 2A/2B edits above are re-pointed at `claire-agent` accordingly.

---

## 3. SAFE context-engineering subset (NONE / LOW only)

Three levers were evaluated; only one is non-breaking-shippable.

### 3.1 Transcript window override — `breakingRisk: NONE` at default, `LOW` when tuned

Today the **default 40** applies in prod: `makeClaireSession` (`session.ts:18-30`) never passes `historyLimit`, so `FirestoreSession` uses `DEFAULT_HISTORY_LIMIT = 40` (`firestore-session.ts:45`, `getItems` cap at `:179-180`).

**Why shrinking is safe:** durable grounding does **not** live in the transcript window. Name / work-history compliment / top skills / saved canonical matcher prefs are read by `loadGlobalContext` (`agent.ts:194-247`) and injected as the `CONTEXT —` line independent of the window; prescreen prior-answer callbacks ride the separate `prescreenContext` block (`prompt.ts:405-407`). The window only carries recent conversational continuity.

**Ship:** add `resolveClaireHistoryLimit()` mirroring `resolveClaireMaxTurns` exactly (env `PA_AGENT_HISTORY_LIMIT`, clamp e.g. `[8,40]`, **DEFAULT 40 = zero behavior change at deploy**), pass it as `historyLimit` in `makeClaireSession` → `FirestoreSession`. Ship the plumbing **inert at 40**; tune down (e.g. 24) via env **on the dev canary only**, reversible instantly.

- Deploy at default 40: `breakingRisk: NONE` (provably inert).
- Tuned-down value: `breakingRisk: LOW`, env-reversible; only risk is a too-small window dropping a mid-thread reference.

**Gate:** (a) prove inert — identical replies on a 3-turn dev scenario at default 40; (b) set `PA_AGENT_HISTORY_LIMIT=24` on `+14243201960`, run ≥10-turn long-context scenario → no drift (mirror score holds, no lost mid-thread reference, prescreen still references prior answers). Keep 40 as the **production default** until the 10-turn eval is green.

### 3.2 `find_match` output truncation — `breakingRisk: NONE` (no change; already done)

**Already satisfied.** `FindMatchResult.jobs` is already `string[]` compose-ready lines (`types.ts:61-74`); the fat `MatchingJob` `rawJobs` array never leaves the tool closure — it is used only for side-effects (`recordAgentPresentation`, rec card, `lastCollabRoles`) and mapped to `string[]` before return; the tool returns `{ok, recCount, delivered, collabCount, jobs: delivery.delivered ? [] : res.jobs, reason, snapshotTags}` (`matching-tools.ts:944-953`). **No rich job objects reach the agent loop.**

**Action:** documentation-only — mark complete-plan **P2.3 already-satisfied** and correct the stale cost-model row (`CLAIRE-COST-OPTIMIZATION-COMPLETE-PLAN.md:22` claims `find_match returns full rawJobs`; that line is the `recordAgentPresentation` side-effect, not the model-facing return). **Do not edit the return shape** — `deliverRecBubbles` + the `delivered:true → jobs:[]` contract depend on the exact shape; any change there would be MED risk.

### 3.3 Optional follow-ons — `breakingRisk: NONE`

Ship only *after* 2B is GREEN, never as blockers:
- `modelSettings.promptCacheRetention: '24h'` + `prompt_cache_key: claire:{userId}` (EP2) — improves same-user warm-prefix hits; additive. Verify the cache key is namespaced per `userId` (no cross-user prefix sharing).
- `proactive.ts:313-326` reposition — the proactive composer builds a **throwaway agent with no Session** and runs a single directive string. Repositioning context there is harmless but yields ~no cache benefit. **Lowest priority; do not let it block.**

---

## 4. DEFERRED (MED / HIGH — needs Adam, do NOT ship here)

| Item | breakingRisk | Why deferred |
|---|---|---|
| **Wire the mem0 compaction stub** (`compaction.ts:17-20` `maybeCompactSession`) | **MED-HIGH if wired** (NONE as the no-op it is today) | Confirmed dead: **zero callers** (only definition + README); claire-agent mem0 is **add-only** (`mem0Add` in `remember_fact`, `matching-tools.ts`), **no `mem0Search`/retrieval wired**. "Wiring it" means **building a new summarize→inject path** = new LLM call + new model-visible context every long turn + new latency/fail-open semantics = a **behavior change to Claire** (forbidden) that also **adds cost** on the already-~0 workload. Leave as no-op. |
| **`maxTurns` 8 → 5** (tighten loop cap) | **MED** | Changes the loop budget for legit multi-step flows (e.g. prescreen FSM load→judge→record→advance→ask). Only justifiable *after* 2A `turnsUsed` telemetry shows p95 ≤ 4 — and even then it's a behavior-affecting cap, Adam-gated. |
| **Mode-scoped tools** (build per-mode agent with 1-3 tools instead of all ~15) | **MED** | Smaller schema = real savings, but risks a cross-mode action becoming unavailable mid-turn = behavior change. Needs a shared-core toolset design + eval. |
| **Kill filler/"continue" tools** (`send_status_then_continue`) | **MED** | Alters the loop's turn-ending behavior; could change pacing/multi-bubble cadence. |
| **`parallelToolCalls`** for 2-action turns | **MED** | Changes execution semantics of multi-action turns; needs eval for ordering/idempotency. |

These are real future wins but each **changes what Claire sees or does**. None ships under the no-breaking rule without explicit Adam approval + its own canary + a long-session eval proving reply-equivalence vs the current baseline (and, for compaction, a cost check that the extra call is net-positive — unlikely while `pa_turns` ≈ 0).

---

## 5. Gated rollout — instrument → measure → cache → measure

Strict order; each step measured live, dev-canary first, nothing ramps past `+14243201960` without Adam.

1. **2A instrument** (`cachedInputTokens` on the **claire-agent** path + per-mode `pa_turns.usage`) → predeploy real-seam gate green → deploy → read one dev turn. **Gate:** telemetry visible; baseline `cachedInputTokens` ≈ 0 (the RED).
2. **Baseline measure** — capture `inputTokens/turn`, `turnsUsed` p50/p95, `cachedInputTokens` per mode on the canary.
3. **2B caching** (EP1/EP2/EP3 + grounding-coupling prose fix + tool-schema audit) → predeploy real-seam gate green → deploy dev-canary → **prove RED→GREEN**: ≥3-turn convo, `cachedInputTokens` jumps to a large fraction of input on turn 2+. **No GREEN → revert.**
4. **Long-context no-drift gate (CLAUDE.md)** — ≥10-turn scenario on `+14243201960`: mirror score holds, no repeat-advice, length compliance, **résumé-grounded compliment still names the work history**, **prescreen still ties questions to prior answers / real résumé items**. Any drift → revert 2B.
5. **3.1 window plumbing** at default 40 (inert) → deploy → prove identical replies on a 3-turn scenario. Then `PA_AGENT_HISTORY_LIMIT=24` on canary only → 10-turn no-drift gate (step 4 again). Widen only if green; keep 40 as prod default until green.
6. **3.3 optional** (cache key/retention, proactive reposition) only after step 3 GREEN.
7. **Record** before/after `cachedInputTokens` / `inputTokens/turn` / `turnsUsed` p50-p95 / `$/day` per mode in the complete-plan cost table. Re-confirm: conversation remains the **secondary** cost — enrichment is the main fix.

**Every shipped item is NONE or LOW.** All MED/HIGH items (§4) are held for Adam.
