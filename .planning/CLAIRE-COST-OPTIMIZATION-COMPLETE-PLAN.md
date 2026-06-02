# Claire Cost Optimization — Complete Plan (caching + context engineering)

**Date:** 2026-06-01 · **Owner:** orchestrator · **Branch:** `claude/thin-PB`
**Goal:** cut the @openai/agents `gpt-5.4-nano` token burn from ~10× the pre-SDK architecture back toward ~1.5–2×, **keeping the agentic loop and all LLM flexibility** — by adding the three disciplines the rebuild skipped: caching, context engineering, tool hygiene. Every step is **measured**, not claimed.

This supersedes the cache-only draft (`CLAIRE-TOKEN-BURN-OPTIMIZATION.md`) and folds in the context-engineering levers Adam approved (#1 caching + #2 context engineering).

---

## 0. The cost model — where the 10× comes from

```
cost = inbounds × (calls per inbound) × (tokens per call)
```

The pre-SDK system won on `calls/inbound = 1` and small context. The agent SDK multiplied **both** other factors, with three missing disciplines:

| Multiplier | Mechanism (verified) | Discipline that fixes it |
|---|---|---|
| **calls/inbound** | Agent loop: up to `maxTurns` model calls/turn, each a full request (`agent.ts:360` run, capped at 8 today) | tool hygiene + tight cap (P3) |
| **tokens/call — repeated** | Zero caching: `instructions` mutates every turn (`prompt.ts:390-417` bakes globalContext/prescreenContext/pendingStep/canary into the head) → busts the prefix cache for the **whole** request incl. the replayed transcript | **byte-stable prefix → caching (P1)** |
| **tokens/call — working set** | 40 raw messages replayed every call (`firestore-session.ts:45` `DEFAULT_HISTORY_LIMIT=40`), compaction is a **no-op stub** (`compaction.ts`), and fat tool outputs (`find_match` returns full `rawJobs` — `matching-tools.ts:626`) ride every later iteration | **context engineering (P2)** |

**The compounding insight:** caching discounts *every repeated token × every loop iteration*. On a loopy workload that's the dominant lever — a 5-step turn becomes `1 full prompt + 4 near-free cached continuations`. We pay full freight today only because the prefix never caches.

---

## 1. Plan at a glance — phased, sequenced, each gated on measurement

| Phase | What | Lever | Risk | Gate before next phase |
|---|---|---|---|---|
| **P0** | Instrumentation — surface `cached_tokens`, `tokens/turn`, `turnsUsed` per mode | (measure) | XS | telemetry visible in `pa_turns.usage` |
| **P1** | Byte-stable `instructions` → prompt caching | #1 (dominant) | med | `cached_tokens` > 0 and rising on turn 2+ |
| **P2** | Context engineering — window + compaction + tool-output truncation | #2 | med | `tokens/turn` drops, no quality regression |
| **P3** | Tool hygiene + tight loop (mode-scoped tools, `maxTurns`→5, kill filler tools) | #3 | med-high | `turnsUsed` p50 ≤ 2, p95 ≤ 4 |

**Rule: P0 ships first and alone.** You cannot optimize what you can't see; today `cached_tokens` is dropped on the floor (`extractUsage`, `openai-agents-adapter.ts:183-259`). Measure → optimize → re-measure each phase.

---

## P0 — Instrumentation (ship first, XS, zero behavior change)

**Why:** `extractUsage` reads only `inputTokens/outputTokens/totalTokens` and never reads `usage.input_tokens_details.cached_tokens`, so the exact metric we're moving is invisible.

**Edits:**
1. `packages/agent-runtime/src/openai-agents-adapter.ts` `extractUsage` (~:193-210) — also read `u.inputTokensDetails?.cachedTokens` (SDK camelCases it) / `u.input_tokens_details?.cached_tokens` and sum into `usage.cachedInputTokens`.
2. `packages/agent-runtime/src/types.ts` `RunAgentTurnUsage` — add `cachedInputTokens?: number`. (`turnsUsed?`/`maxTurnsExceeded?` already added in the runaway fix.)
3. `apps/functions/src/index.ts` (~:4642-4664) — copy `cachedInputTokens` into `pa_turns.usage` (the generic usagePatch already forwards defined fields) and add a `cached`/`mode` dimension to `pa.spend.daily` so we can see hit-rate per mode.

**Verify:** one dev-phone turn → `pa_turns.usage.cachedInputTokens` present (≈0 pre-P1). **This is the RED in the RED→GREEN we'll prove in P1.**

---

## P1 — Byte-stable `instructions` → prompt caching (the dominant lever)

**Goal:** make `Agent.instructions` an **identical byte string** every turn + every inner-loop iteration, and relocate 100% of per-turn variance into a `{role:'system'}` input item placed **after** the cached transcript (highest-salience position, grounding preserved). Then the static head **and** the growing transcript both cache; each turn pays full price only for the newest increment.

**Why it works mechanically:** `instructions` serializes first; OpenAI auto-caches the longest common token prefix (≥1024 tokens). Stable `instructions` → static head caches. With a Session, new input items append *after* the cached transcript → the transcript stays a stable prefix and caches too. `FirestoreSession.addItems` persists assistant output only (`firestore-session.ts:196-209`), so the ephemeral per-turn context item never pollutes the durable transcript.

**Edit points (claire-agent, thin branch):**
- **EP1 — `prompt.ts:390-417` split `buildClairePrompt`:**
  - `buildClairePrompt(opts)` → ONLY the byte-stable static prompt: PERSONA, langLine, REPLY_FORMAT, VOICE, US_SCOPE, PREFERENCES, DELIVERY, SCHEDULING, a **static** mode-shape, FLEXIBILITY, FEWSHOT. Drop `globalContext`/`prescreenContext`/`pendingStep`/`canary`/per-turn `modeDirective`.
  - `buildClaireTurnContext(opts): string` → the dynamic block (the `CONTEXT —` line, `PRESCREEN CONTEXT`, `PENDING STEP`, the per-turn `modeDirective` turnLine).
- **EP2 — `agent.ts:119-141` `buildClaireAgent`:** `instructions: buildClairePrompt(staticOpts)`; add `modelSettings: { promptCacheRetention: '24h', providerData: { prompt_cache_key: \`claire:${ctx.userId}\` } }` so a candidate's consecutive turns hit the same warm prefix.
- **EP3 — `agent.ts:360` `run()`:** replace `run(agent, turnText, {session, maxTurns})` with
  ```ts
  run(agent, [
    { type:'message', role:'system', content: buildClaireTurnContext({...}) },
    { type:'message', role:'user',   content: turnText },
  ], { session, maxTurns })
  ```
  Same for `proactive.ts:326`.

**Caveat to verify, not assume:** confirm tool schemas are byte-stable across turns (names/descriptions static; per-turn `prescreenPrompts/judgeContext` ride on `execute()` closures, not the JSON schema). If any tool schema varies per turn it also busts the cache — fix or accept.

**Verify (RED→GREEN):** dev-phone ≥3-turn convo → `pa_turns.usage.cachedInputTokens` jumps from ~0 (P0 RED) to a large fraction of input on turn 2+. **Gate: no GREEN, no P2.**

---

## P2 — Context engineering (shrink the working set)

Three independent edits; each measured by `tokens/turn`.

- **2.1 Transcript window 40 → ~12–16.** `firestore-session.ts:45` `DEFAULT_HISTORY_LIMIT=40` (or pass `historyLimit` from `session.ts` where `FirestoreSession` is constructed). 40 raw messages × every call is the biggest uncached chunk. Pair with 2.2 so older context isn't lost, just summarized. Tune by mode (prescreen may need more grounding than triage).
- **2.2 Wire the compaction stub.** `compaction.ts` is a no-op TODO. Wire the existing **mem0** compaction so a long session injects a short rolling **summary** of pre-window turns (as one `system` context item, alongside the P1 turn-context item) instead of replaying everything. mem0 already holds durable memory — reuse it, don't build a new summarizer.
- **2.3 Truncate fat tool outputs.** `find_match` returns full `rawJobs` into the agent context (`matching-tools.ts:626`) — full JD/objects that then ride every later loop iteration. Return only the fields the LLM needs to **compose** (title, company, one-line why, id), cap `ranked`/`candidates` arrays to top-K (3–5). Audit other tools for fat returns (prescreen `process-tools`, scheduling already returns compact labels).

**Verify:** `tokens/turn` p50 drops materially; run a ≥10-turn scenario (per CLAUDE.md long-context check) and confirm no drift/quality regression (mirror score, no lost grounding, prescreen still references prior answers).

---

## P3 — Tool hygiene + tight loop (keep agentic, trim the waste)

Only after P1/P2 are measured. Keeps the loop — trims its waste.
- **Mode-scoped tools:** build the per-mode agent with only its 1–3 tools (onboarding tools in onboarding, etc.) instead of all ~15 every call — smaller schema payload + fewer spurious tool calls + fewer iterations.
- **`maxTurns` 8 → 5** once `turnsUsed` telemetry (P0) shows p95 ≤ 4 for legit flows. Kill filler/"continue" tools (`send_status_then_continue`) that re-loop without ending the turn.
- **`parallelToolCalls`** for the rare 2-action turn so it's 2 calls, not 4 sequential iterations.

---

## Verification & rollout

- **Canary first:** dev phone `+14243201960` (`isCanaryUser`) — every phase ships dev-gated, measured live, before any wider ramp (per the canary rule).
- **Predeploy real-seam gate** (real `gpt-5.4-nano`) must stay green each phase.
- **Long-context scenario** (≥10 turns) per phase — drift + grounding check.
- **Before/after table** kept in this doc: `cachedInputTokens`, `inputTokens/turn`, `turnsUsed` p50/p95, `$/day`, per mode.

## Cost model (to be filled with real P0 numbers)

| Metric | Now (est.) | After P1 | After P1+P2 | After P1+P2+P3 |
|---|---|---|---|---|
| input tokens / turn | full ~5–6K + 40-msg transcript, ×N iters | static head cached (~50–90% off repeat) | + small window + truncated tools | + fewer iters |
| cache hit rate | ~0% | high on turn 2+ | high | high |
| calls / inbound | up to 8 | up to 8 | up to 8 | ≤5, p50 ≤2 |
| $/day (264 users) | baseline 10× | — | — | target ~2× |

(Real numbers go in once P0 telemetry lands — we optimize against measured, not estimated.)

## Risks
- P1: moving context out of `instructions` could weaken grounding if the turn-context item is positioned wrong → place it as the LAST item before the user message (highest salience); verify with the prescreen-grounding scenario.
- P2.1: too-small a window drops needed context → tune per mode, gate on the long-context scenario.
- P2.2: mem0 summary latency/quality → it's async/cached; fail-open to the window if summary missing.
- P3: mode-scoped tools could miss a cross-mode action → keep a small shared core toolset.

## Sequenced action list
1. **P0 instrument** (surface `cachedInputTokens` + per-mode dims) → deploy → read one dev turn. *(gate: telemetry visible)*
2. **P1 caching** (EP1/EP2/EP3 + cache key/retention) → deploy dev-canary → prove `cached_tokens` RED→GREEN on a 3-turn convo. *(gate: GREEN)*
3. **P2 context** (window + wire compaction + truncate `find_match`) → deploy → `tokens/turn` drop + 10-turn no-drift. *(gate: drop + no regression)*
4. **P3 tool hygiene** (mode-scope tools, `maxTurns`→5, kill filler) → deploy → `turnsUsed` p50≤2. *(gate: p95≤4)*
5. Fill the cost table with measured before/after; decide if a deterministic fast-path (last-resort #4 lever) is even needed — likely not, if P1+P2 land.
