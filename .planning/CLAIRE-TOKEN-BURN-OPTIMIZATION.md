All load-bearing anchors are verified verbatim in the repo: `extractUsage` (openai-agents-adapter.ts:183-259) reads only inputTokens/outputTokens/totalTokens and drops cached details; `RunAgentTurnUsage` (types.ts:82-91) has no cached field; the orchestrator generically copies every defined `usage` field into `usagePatch` then `pa_turns.usage` (index.ts:4651-4664); `pa.spend.daily` logs only input/output (index.ts:4642-4645); cost-logger has no nano entry and no cached dimension (cost-logger.ts:73-110); canonical nano price is $0.15/$0.60 (agent-rank-prompt.ts:48); history limit is 40 (firestore-session.ts:41); dev phone is +14243201960. The `claire-agent/` files live on the unmerged thin branch (cited as such in the plan).

# Claire Token-Burn Optimization Plan (2026-06-01)

## 1. Executive Summary

**The single biggest lever is byte-stable Agent `instructions`.** Today `buildClairePrompt(...)` is passed straight into `Agent.instructions` and bakes five per-turn-varying inputs (`canary`, `modeDirective`, `globalContext`, `prescreenContext`, `pendingStep`) into the head of the request. Because the OpenAI Responses API auto-caches only the **longest common token prefix** of the serialized request — and `instructions` is serialized *first*, before the growing transcript (`openaiResponsesModel.js:2168-2192`) — every byte change in `instructions` busts the cache for the **entire** request, including the entire replayed transcript. Result: cache-hit rate is effectively ~0% and we re-pay full input price for the ~3-6K static prompt **plus** the whole transcript on every inbound turn and on every inner loop iteration (`run.js:342-348`).

Fixing this (split the prompt into a byte-identical static head + a per-turn `system`-role input item placed *after* the cached transcript) is projected to cut **input-token cost ~37%** ($2.85 → ~$1.78/day at a realistic 50% hit rate) and **total LLM cost ~29%** ($3.71 → ~$2.64/day) at steady state (~264 active users). The win scales linearly as the pool grows, so the percentage holds past 264.

A close-coupled prerequisite: **cache hits are currently invisible** — `extractUsage` drops `usage.inputTokensDetails.cached_tokens` (`openai-agents-adapter.ts:193-210`), so we cannot even measure the lever. Surfacing `cachedInputTokens` is the cheapest, lowest-risk change in this plan and unblocks all measurement.

---

## 2. Root-Cause Recap

Two independent mechanisms drove the burn:

1. **Unbounded inner loop — NOW CAPPED.** The agent loop re-sends the full prompt + growing transcript + tool outputs each iteration, up to `maxTurns` = 8 (`claire-agent/agent.ts:36-56,381-385`, unmerged thin branch). This is a multiplier on every other cost: an 8-iteration turn re-pays the full input 8×. The cap exists, but compounds the next problem.

2. **Zero prompt caching — instructions mutate every turn.** OpenAI auto-caches prefixes ≥1024 tokens at a 50-90% discount, 5-min-to-1-hour TTL (`developers.openai.com/api/docs/guides/prompt-caching`). The cache keys off the longest common token prefix. Our `instructions` field (the prefix head) changes every turn because `buildClairePrompt` concatenates STATIC sections first (PERSONA, langLine, REPLY_FORMAT, VOICE, US_SCOPE, PREFERENCES, DELIVERY, SCHEDULING) then a DYNAMIC tail (`canary`, `modeDirective`, `globalContext`, `prescreenContext`, `pendingStep`) then FEWSHOT (`claire-agent/prompt.ts:390-417`). The dynamic tail — and FEWSHOT positioned after it — breaks prefix stability turn-to-turn, so neither the static prompt **nor** the replayed transcript that follows it ever caches.

3. **Telemetry blind spot.** Even where caching *could* engage, `extractUsage` reads only `inputTokens/outputTokens/totalTokens` and never reads `inputTokensDetails`, so `cached_tokens` never reaches `pa_turns.usage` (`packages/agent-runtime/src/openai-agents-adapter.ts:193-210`, confirmed: the loop reads `u.inputTokens/u.outputTokens/u.totalTokens` only). We are flying blind on the exact metric we want to move.

---

## 3. The Byte-Stable-Instructions Refactor

**Goal:** make `Agent.instructions` an *identical byte string* on every turn and every inner-loop iteration, and relocate 100% of per-turn variance into a `system`-role input item placed **after** the cached transcript, immediately **before** the new user message (highest-salience position, so grounding is preserved).

### Why this works mechanically
- `instructions` and `input` are separate request fields; `instructions` serializes first (`openaiResponsesModel.js:2168-2171`). Stable `instructions` → the whole static head caches.
- With a session, prepared input = `[...history, ...newInputItems]`; new items append **after** the cached transcript (`sessionPersistence.js:251-260`). A per-turn system context item in `newInputItems` therefore sits *after* the transcript prefix, so the transcript stays byte-stable and cacheable.
- `run()` accepts an `AgentInputItem[]`: a string becomes one user message, an array is spread as-is (`items.js:22-27`). A `{role:'system'}` item is valid protocol (`protocol.js:298`).
- `FirestoreSession.addItems` skips system items and SDK user items — only assistant output persists (`packages/agent-runtime/src/firestore-session.ts:202-209`) — so the ephemeral per-turn context never pollutes the durable `pa-messages` transcript.
- Tool schemas are already byte-stable: names/descriptions are static literals; per-turn `prescreenPrompts/judgeContext` ride on `execute()` closures + `ctx`, not the JSON schema (`claire-agent/tools/process-tools.ts:245-438`); fixed compose order (`tools/index.ts:21-28`).

### Exact change points (claire-agent files live on the unmerged thin branch)

**EDIT POINT 1 — `claire-agent/prompt.ts:390-417` `buildClairePrompt`:** split into two builders.
- `buildClairePrompt(opts)` returns ONLY the byte-stable static prompt: PERSONA, langLine, REPLY_FORMAT, VOICE, US_SCOPE, PREFERENCES, DELIVERY, SCHEDULING, a **static** mode-shape description, FLEXIBILITY, FEWSHOT. Remove `globalContext`, `prescreenContext`, `pendingStep`, `canary`, and the per-turn `modeDirective` bits from this string.
- `buildClaireTurnContext(opts): string` returns the dynamic block: the `CONTEXT — …` line, the `PRESCREEN CONTEXT` block, the `PENDING STEP` line, and the per-turn `modeDirective` turnLine that varies with `currentStep/onboardingSlot/awaitingAnswer/prescreenPrompts`.
- Effort: **M** (mechanical split; section strings already exist as named consts). Risk: **med**.

**EDIT POINT 2 — `claire-agent/agent.ts:138-163` `buildClaireAgent`:** set `instructions` to the static-only `buildClairePrompt` (drop dynamic opts at 146-153; keep only mode+lang for the static mode-shape). Add `modelSettings: { promptCacheRetention: '24h', providerData: { prompt_cache_key: \`claire:${ctx.userId}\` } }` to `agentConfig` (`ModelSettings` exposes both — `model.d.ts:206-225`) so consecutive inbound turns from the same candidate route to the same warm prefix and retention spans the session. Effort: **S**. Risk: **med**.

**EDIT POINT 3 — `claire-agent/agent.ts:376-385` `runClaireTurn`:** replace
```
run(agent, turnText, {...})
```
with
```
run(agent, [
  { type:'message', role:'system', content: buildClaireTurnContext({...}) },
  { type:'message', role:'user',   content: turnText },
], { session, maxTurns })
```
where the turn-context opts are `{globalContext, prescreenContext, pendingStep, currentStep, onboardingSlot, awaitingAnswer, prescreenPrompts, mode, canary}`. Effort: **S**. Risk: **med**.

### Before / after prompt shape

| | BEFORE | AFTER |
|---|---|---|
| `instructions` (cache-prefix head) | `PERSONA…SCHEDULING` + **canary + modeDirective + globalContext + prescreenContext + pendingStep** + FEWSHOT — **mutates every turn** | `PERSONA…SCHEDULING + static-mode-shape + FLEXIBILITY + FEWSHOT` — **byte-identical every turn** |
| transcript (`input` head) | follows mutating instructions → **never caches** | follows stable instructions → **caches, grows with hits on turns 2+** |
| per-turn dynamic data | inside `instructions` | `{role:'system'}` input item, **after** transcript, **before** user message (uncached tail, ~hundreds of tokens) |
| durable transcript pollution | n/a | none — `addItems` drops system+user items (`firestore-session.ts:202-209`) |

**Canary caveat (carry into PR description, not code):** folding `CANARY_TAPBACK` into `instructions` *unconditionally* would change behavior for non-canary users (new product behavior → Adam-gated per the canary rule). **Safer alternative:** keep canary OUT of `instructions`; emit the `CANARY_TAPBACK` directive only inside the per-turn system context when `isCanaryUser`. Non-canary prefix stays universal and byte-stable; canary users get a stable-per-user prefix. Also: move only DATA into the system item, never behavioral RULES; keep `prescreenContext` + `prescreenPrompts` in the per-turn system item on every prescreen turn (verify FSM still grounds probes). `outputType` (`ClaireReplySchema`) lives in `text.format`, not `instructions`, so the multi-bubble `{messages:string[]}` contract is unaffected.

---

## 4. Ranked Secondary Levers

| # | Lever | Change point | Impact | Effort | Risk |
|---|---|---|---|---|---|
| **S1** | **Idempotency claim/lease** on the turn loop | Add a transactional claim/lease at the top of `maybeRunThinClaire` before `runClaireTurn` (reuse `claimBrokerEvent`/`isInboundLeaseExpired` in `cutover.ts`); make `onPaInbound` swallow rather than re-throw thin-path errors *after* a send. `onPaInbound`/coalescer call `maybeRunThinClaire` with no claim/lease and `onDocumentCreated` is at-least-once → retries re-run the whole loop (`apps/functions/src/index.ts:1371-1389`). | **High** — eliminates the largest uncapped multiplier: duplicate full-turn re-runs on the slowest, most expensive turns | Medium | Medium — set lease > `RUN_TIMEOUT_MS` (100s); keep fail-open-to-legacy |
| **S2** | **Mode-scoped tool schemas** | Pass `opts.mode` into `buildClaireTools` and switch (`tools/index.ts:21-28`); don't ship prescreen+scheduling+onboarding schemas on triage turns | Medium — cuts per-iteration tool-schema payload ~½ on common turns | Low | Low — keep `find_match` available right after onboarding completes |
| **S3** | **Lower transcript replay window 40 → ~12-16** | `historyLimit` on `makeClaireSession`/`FirestoreSession` (`DEFAULT_HISTORY_LIMIT = 40`, `firestore-session.ts:41`) | Medium — shrinks the linearly-growing transcript re-sent up to 8× per inbound | Low | Medium — validate on a 10+-turn scenario before lowering aggressively (this is the byte-stable region that *should* cache; trim, don't destabilize) |
| **S4** | **Mode-gate static prompt blocks** | Reorder `buildClairePrompt` to include SCHEDULING/DELIVERY collab blocks only by mode; cache static persona+few-shot | Low-Med — trims the ~8K fixed prompt re-sent every iteration | Low-Med | Medium — gate behind long-context eval; ship incrementally **(note: this can fragment the cache prefix across modes — apply only after S0/§3 land and the per-mode hit-rate is measured)** |
| **S5** | **Verify prescreen judge runs ≤1×/reply** | Confirm the judge fires once per answer; fold into main turn output for low-stakes questions | Low-Med — removes an extra nano call per prescreen answer | Medium | Medium — grading drives PASS/FAIL; keep a separate judge for high-stakes competencies |

Ordering rationale: **S1 first among secondaries** — dedup is a raw multiplier independent of caching and protects every other lever. **S2/S3** are cheap, safe payload trims. **S4/S5** touch behavior/grading and are gated behind eval.

---

## 5. Verification

### 5a. Surface `cached_tokens` (prerequisite — do first)
In `extractUsage` (`packages/agent-runtime/src/openai-agents-adapter.ts:183-259`), accumulate cached tokens alongside the existing sums. Widen the local `r.usage` shape from `{inputTokens,outputTokens,totalTokens}` to also include `inputTokensDetails?: Record<string, number>`; read `r.usage.inputTokensDetails` (SDK object — populated at `openaiResponsesModel.js:2240-2245`) and defensively `r.usage.input_tokens_details` (raw wire), summing `.cached_tokens`. Add `cachedInputTokens?: number` to `RunAgentTurnUsage` (`types.ts:82-91`) and set it guarded: `if (cachedInputTokens > 0) usage.cachedInputTokens = cachedInputTokens` (matches the existing `> 0` filter at adapter.ts:240-242 and the Phase-10-bug-#2 undefined filter at `index.ts:4653`). Optionally surface `cacheHitRatio = cachedInputTokens / inputTokens`.

**No orchestrator change needed:** `index.ts:4651-4664` copies *every defined* `usage` field into `usagePatch` → `pa_turns.usage` via `updateTurn` (confirmed: `for (const [k, v] of Object.entries(usage)) if (v !== undefined) usagePatch[k] = v`). The new field auto-propagates to Firestore.
Effort: **Low** (~15 lines, two files). Risk: **Very low** (additive, best-effort, `> 0`-guarded).

### 5b. Before/after harness
1. **Unit layer.** Add to `openai-agents-adapter.test.ts` (existing `__forTesting` seam + 6 token-sum tests at adapter.ts:366-372 / test:118-225) a case feeding `rawResponses[].usage.inputTokensDetails = {cached_tokens: N}` and asserting `usage.cachedInputTokens === N`. Add an `index.test.ts` round-trip (mirror the `pa_turns.usage` test at `index.test.ts:2038-2113`) asserting `usagePatch.usage.cachedInputTokens` persists.
2. **Byte-stability unit test (regression guard).** Assert `buildClairePrompt(staticOpts)` returns an **identical** string for two turns that differ in `globalContext/prescreenContext/pendingStep/onboardingSlot/awaitingAnswer/canary`. Locks the invariant so the prefix can never drift again. (No current test asserts prompt content/layout — `canary.test.ts:16-17` only checks `CANARY_UIDS` — so the surface is small.)
3. **Input-shape test (grounding + no-pollution).** Stub `run()` to capture its 2nd arg; assert it's an array whose last item is `{role:'user',content:turnText}` and second-to-last is `{role:'system'}` carrying `globalContext/prescreenContext`; assert `FirestoreSession.addItems` is NOT asked to persist that system item.
4. **Read-only canary measurement script.** Query `pa-turns` where `userId` == dev-phone owner, bucketed by `completedAt`, computing `cacheHitRate = sum(cachedInputTokens)/sum(inputTokens)`, `avg inputTokens/turn`, `$/turn`. Run a BEFORE window (current code), deploy the §3 change to **+14243201960 only**, run an AFTER window.
5. **Live cache + drift check.** Run a ≥10-turn scenario via `tests/scenarios/runner-local.mjs`, read `response.usage.input_tokens_details.cached_tokens` across turns (expect growth on turns 2+), and pair with the existing long-context drift check (mirror score, repeat-opener, length per CLAUDE.md). **Read actual reply text** — scenario "pass" is not proof.

### 5c. Canary rollout
Deploy §3 + §5a behind the standing dev-only-new-behavior scope: **+14243201960** (`DEV_BYPASS_PHONE`, `candidate-inbound-resolve.ts:16`). Gate to advance: **cacheHitRate must rise from ~0% to >40%** on the canary with **no reply-quality regression**. Caveat: OpenAI only caches prefixes >1024 tokens, so bucket out any turn whose input prefix is <1K (those legitimately show 0 cached). The §3 change is behavior-neutral and reversible; the canary is read-only-measured before any wider ramp (which stays Adam-gated).

---

## 6. Cost Model — Current vs Projected

**Framing correction:** the **1.2B input-tokens/day** figure was the **Jun-1 spike**, not steady state. Model steady state at **~264 active users**, **~12 turns/user/day** (≈3,168 turns/day), **~6,000 input tok/turn** (≈3K static prefix + ~3K accumulated cached transcript), **~450 output tok/turn** → **~19.0M input tok/day**, **~1.43M output tok/day**. Prices: gpt-5.4-nano **$0.15/M in, $0.60/M out** (in-repo canonical, `agent-rank-prompt.ts:48`), cached input at OpenAI's standard 25%-of-input rate = **$0.0375/M**.

| Scenario | Cached input | Uncached input | Output | Input $/day | Total $/day | vs BEFORE |
|---|---|---|---|---|---|---|
| **BEFORE (0% cache credited)** | 0 | 19.0M × $0.15 | 1.43M × $0.60 | **$2.85** | **$3.71** | — |
| Conservative (35% hit) | 6.65M × $0.0375 = $0.249 | 12.35M × $0.15 = $1.853 | $0.86 | $2.10 | **~$2.96** | **−20%** |
| **Target (50% hit)** | 9.5M × $0.0375 = $0.356 | 9.5M × $0.15 = $1.425 | $0.86 | **$1.78** | **~$2.64** | **−29%** (input −37.5%) |
| Stretch (65% hit) | 12.35M × $0.0375 = $0.463 | 6.65M × $0.15 = $0.998 | $0.86 | $1.46 | **~$2.32** | **−37%** |

Per-turn input cost at 50% hit: **$0.0009 → $0.00056**. The ~$1/day input saving scales **linearly** with user growth, so the % win holds as the pool grows past 264.

**Wire it into the ledger (currently invisible):**
- `estimateUsdCost` has **no** gpt-5.4-nano entry and **no** cached dimension — it falls through to `DEFAULT_CHAT_PRICE` = gpt-4o-mini $0.15/$0.60 (`apps/functions/src/instrumentation/cost-logger.ts:73-110`, confirmed: `CHAT_PRICES` lacks nano; falls to default). Add `"gpt-5.4-nano": { inPerM: 0.15, outPerM: 0.6, cachedInPerM: 0.0375 }` and change the chat branch to `cost = (inputTokens - cachedInputTokens)/1e6*0.15 + cachedInputTokens/1e6*0.0375 + outputTokens/1e6*0.6`.
- The `pa.spend.daily` structured log reads only `inputTokens/outputTokens` (`index.ts:4642-4645`, confirmed), so add the cached dimension there too or savings stay invisible in dashboards.
- **Re-confirm the 25% cached rate against the live OpenAI nano list price at deploy time** (the repo's $0.15/$0.60 base is internal and may lag list). Publish the table parametrically in hit-rate; replace the 6K-in/450-out/12-turn estimates with **canary-measured values** (§5) before quoting a hard $/day.

---

## 7. Sequenced Action List

### P0 — Measure (unblocks everything; ship first)
1. **`extractUsage` surfaces `cachedInputTokens`** (`openai-agents-adapter.ts:183-259`) + `cachedInputTokens?: number` on `RunAgentTurnUsage` (`types.ts:82-91`). Persistence is automatic via `index.ts:4651-4664`. *(Low effort, very low risk.)*
2. **Unit tests:** adapter cached-token case + `index.test.ts` round-trip (mirror `index.test.ts:2038-2113`). *(Low.)*
3. **Read-only canary BEFORE-window script** over `pa-turns` for +14243201960. *(Low.)*

### P1 — The lever (the 29% win)
4. **Byte-stable refactor** — EDIT POINTS 1-3 (`prompt.ts:390-417`, `agent.ts:138-163`, `agent.ts:376-385`): static-only `instructions` + per-turn `{role:'system'}` context item after the transcript; canary handled per the safer-alternative (per-turn-context only, `isCanaryUser`). *(M effort, med risk.)*
5. **Byte-stability + input-shape regression tests** (§5b.2, §5b.3). *(S/M.)*
6. **Cost-logger:** add nano + `cachedInPerM` to `CHAT_PRICES`/`estimateUsdCost` (`cost-logger.ts:73-110`) and the cached dimension to `pa.spend.daily` (`index.ts:4642-4645`). *(Low.)*
7. **Deploy to +14243201960 canary only;** run ≥10-turn scenario via `runner-local.mjs`, read actual replies + `cached_tokens` growth; run AFTER-window script. **Gate: hit rate >40%, no quality regression.** *(Adam-gated for any wider ramp.)*

### P2 — Secondary levers (after P0/P1 prove the cache engages)
8. **S1 idempotency claim/lease** at top of `maybeRunThinClaire` + swallow post-send thin errors in `onPaInbound` (`index.ts:1371-1389`). *(Highest secondary impact — do first in P2.)*
9. **S2 mode-scoped tool schemas** (`tools/index.ts:21-28`). *(Low/Low.)*
10. **S3 transcript window 40 → 12-16** (`firestore-session.ts:41`), validated on a 10+-turn scenario. *(Low/Med.)*
11. **S4 mode-gated static prompt blocks** — only after per-mode cache hit-rate is measured (risk of fragmenting the prefix). *(Eval-gated.)*
12. **S5 prescreen judge ≤1×/reply** — gated behind PASS/FAIL re-calibration. *(Eval-gated.)*
