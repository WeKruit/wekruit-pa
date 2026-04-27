# Phase 15 — Typing Indicator / Delivery Feel — CONTEXT

Status: planning
Owner: P10 (sponsor) → P9 (tech lead) → P8 implementation
Independent of: 11.3 (identity migration), 14 (eval harness), 12 (proactive outbound)
Source repo: `/Users/adam/Desktop/WeKruit/wekruit-pa` @ `main` `9a5466e`

## 1. Phase goal

Reduce **perceived** latency on long PA turns. Post Phase-10.5 cutover (Responses API + SDK Session), turn p90 is ~5–15s on current-info turns hitting `webSearchTool`. Users currently see a single delayed message with zero feedback during that window. We will deliver one of:

- (preferred-if-feasible) **Real iMessage typing indicator** routed through whatever API the macOS worker can reach without violating the Phase-1 chat.db red line.
- (fallback) **Chunked-message simulation**: split outbound reply at sentence/paragraph boundaries into 2–3 chunks with realistic inter-chunk delay, optionally preceded by a short "…" pre-message.

The reply *content* is unchanged. Only the **delivery feel** changes.

## 2. Investigation required FIRST (15.1)

This phase **must not** start coding until 15.1 produces a written verdict on:

### 2a. macOS Messages.app typing-indicator surface area

Three candidate routes, evaluated against existing codebase (worker uses `@photon-ai/imessage-kit` v3 + AppleScript send via `tell application "Messages"`):

1. **Photon SDK** — `@photon-ai/imessage-kit` v3 (free tier) README explicitly states:
   > "Looking for advanced features like threaded replies, tapbacks, message editing, unsending, **live typing indicators**? Check out Advanced iMessage Kit and contact us at daniel@photon.codes."
   
   **Verdict (pre-confirmed):** Free Photon SDK v3 does **NOT** expose typing-indicator. Advanced kit is a paid/closed product. Treat as not-available unless P10 separately approves a commercial dependency.

2. **AppleScript Messages dictionary** — There is **no public `typing` / `is typing` property** on `chat` or `service` in the Messages.app AppleScript dictionary. (Confirmed via Photon SDK's own AppleScript builder at `node_modules/@photon-ai/imessage-kit/dist/index.cjs` lines ~1613–1670 — only `send` is implemented.) **Verdict: NOT AVAILABLE.**

3. **Direct chat.db write** — This would route through `~/Library/Messages/chat.db`. Phase 1 locked chat.db as **read-only** (worker opens via `better-sqlite3` with `{ readonly: true, fileMustExist: true }`). **HARD RED LINE — not eligible.**

### 2b. AppleScript-only constraint

The worker outbound path is 100% AppleScript-driven through Photon SDK's `sender`. There is no IMCore / private framework / Messages-internal IPC surface we can reach without (a) a paid Photon Advanced license, or (b) writing to chat.db. Both are out of scope for this phase.

### 2c. Implication for 15.1 verdict

Investigation is expected to **confirm** the pre-finding above and produce a 1-page written verdict. If 15.1 surfaces a new free-tier path (e.g., a Photon v3 minor release adding typing, or an AppleScript trick missed here), 15.2 chooses real-typing path. **Otherwise 15.2 is forced to chunked simulation.** Pre-finding probability: chunked is the path.

## 3. What 15 ships

Single PR, single rollout flag, no schema migrations on user-visible records.

### 3a. Feature

One of (decided by 15.1):
- **Real typing indicator** if a free-tier route is found in 15.1 — sent at turn-start, cancelled on turn-completion or turn-error.
- **Chunked-message simulation** otherwise — see §3c parameters.

### 3b. Rollback flag — HARD REQUIREMENT

Env var: `PA_TYPING_INDICATOR_DISABLED=true`
- When set: feature is fully disabled; outbound returns to single-message send identical to today's `outbox.processOutboundJob` and `handleDirectMessage` `sdk.send` path.
- Default value (opt-in vs opt-out) is a **P10 decision** — see §6.

### 3c. Recommended chunked-simulation parameters (assuming fallback)

| Param | Recommended | Rationale |
|---|---|---|
| Chunk count | 2–3 (capped at 3) | Two chunks for replies < 240 chars; three for 240–1000; never more than 3 to avoid spam feel. Replies > 1000 chars stay at 3 chunks (variable length tail). |
| Split heuristic | Prefer `\n\n` paragraph; fall back to `. `/`! `/`? ` sentence boundary; never split mid-word; never split inside a code block or markdown link. |
| Inter-chunk delay | 800–1500 ms, sampled uniform random per gap | Matches human typing cadence research (avg ~40 wpm reading-aloud equivalent ≈ 1.2s/sentence). |
| Pre-message ("…") | **OFF by default**; opt-in via `PA_TYPING_PREMESSAGE=true` | Pre-message creates an extra row in transcript and feels gimmicky if not ML-tuned. Document but don't ship on. |
| Single-chunk floor | If reply ≤ 60 chars **OR** has zero clean split point, send as one message (no chunking) | Avoids splitting "ok 👍" into two messages. |

### 3d. Surfaces touched (file domain — for parallelization check)

Worker path:
- `apps/macos-imessage-worker/src/outbox.ts` — chunked send loop (NEW logic in `processOutboundJob`), respects rollback flag.
- `apps/macos-imessage-worker/src/index.ts` `handleDirectMessage` — chunked send for the inline reply path (the `sdk.send({ to: msg.chatId, text: reply })` call).
- (NEW) `apps/macos-imessage-worker/src/chunker.ts` — split heuristic + delay scheduler, pure function + unit-testable.

Schema (additive only, no migration):
- `packages/core-types/src/index.ts` `OutboundMessageSchema` — add optional `chunkPlan?: { count, delaysMs }` and `chunkIndex?: number` for operator visibility (optional, defaulted absent on read).

Dashboard:
- `apps/dashboard` operations queue — render chunk progress badge if `chunkPlan` present.

Tests:
- `apps/macos-imessage-worker/src/outbox.test.ts` extension — chunked timing, suppressOutbound preserved, kill-switch works.
- `apps/macos-imessage-worker/src/chunker.test.ts` (NEW).

### 3e. suppressOutbound preservation — HARD CONSTRAINT

`suppressOutbound` lives in `packages/pa-orchestrator/src/index.ts` (`rawMeta.harness.suppressOutbound === true` blocks `enqueueOutbound`). Phase 15 changes are **downstream** of `enqueueOutbound`: if zero `pa_outbound` rows are written, zero chunks are sent. **Test 15.3 must assert that harness scenarios continue to write zero `pa_outbound` rows** even with the chunked path enabled.

### 3f. Real-typing cancellation (only if 15.1 finds a route)

If real typing is implemented:
- Indicator is set at the start of `runAgentTurn` (before LLM call).
- Indicator is **cleared in a `finally` block** wrapping `runAgentTurn`, including on thrown errors.
- A turn-id-keyed map prevents orphan typing state across concurrent turns.
- A 30s hard timeout auto-clears any indicator (defensive against worker crash).

## 4. Out of scope

- Phase 12 outbound (proactive sends from operator dashboard) — separate phase.
- Phase 14 eval harness instrumentation — typing/chunking is feel-only, not evaluation-graded.
- Phase 11.3 identity migration — no overlap with worker outbound path.
- Web channel chunking — iMessage only for this phase.
- Read-receipt manipulation — explicitly deferred.

## 5. Hard red lines (re-asserted)

1. **Markdown only** — no code in this phase's planning docs.
2. **Do NOT write to `~/Library/Messages/chat.db`** — Phase 1 red line, still locked. Worker opens chat.db `readonly: true`; that property MUST NOT be changed.
3. **Chunked simulation MUST preserve `suppressOutbound`** — zero `pa_outbound` rows = zero chunked sends.
4. **Real typing indicator MUST be cancellable on turn error** — no orphan typing state.
5. **Rollback flag is mandatory** — no implementation lands without `PA_TYPING_INDICATOR_DISABLED=true` kill switch.

## 6. Open P10 decisions (document, don't decide here)

- **Default opt-in vs opt-out**: P9 recommendation = ship **default-OFF** (`PA_TYPING_INDICATOR_DISABLED` defaults to `true` for first 7 days, flip to `false` after telemetry shows zero error spike). Rationale: chunking changes user perception of the product surface; we want a soft launch and an instant "off" if any user complains.
- **Pre-message "…"**: P9 recommendation = **OFF**.
- **Photon Advanced commercial license**: P9 recommendation = **defer** unless 15.1 surprises us with a free-tier path.

## 7. Single-PR safety

Phase 15 is **single-PR safe**. All changes are:
- Additive on `OutboundMessageSchema` (optional fields).
- Localized to `apps/macos-imessage-worker/src/{outbox,index,chunker}.ts` + tests + a dashboard read-only badge.
- Gated behind `PA_TYPING_INDICATOR_DISABLED` (default-on per §6 recommendation → no production behavior change at merge).

## 8. Dependency on Phase 11.3

**No.** Phase 11.3 touches persona/identity injection inside `runAgentTurn` and agent-runtime. Phase 15 touches the *delivery* layer downstream of the assistant text. Zero file overlap. **15 may merge before, after, or in parallel with 11.3.**
