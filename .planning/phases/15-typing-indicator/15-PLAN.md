# Phase 15 — Typing Indicator / Delivery Feel — PLAN

Sequence: 15.1 → 15.2 → 15.3 → 15.4 → 15.5
All sub-phases are markdown-only deliverables until 15.2 (which produces code under a feature flag).

---

## 15.1 — Investigation: typing-indicator API availability

**WHY:** Confirm or refute the pre-finding that no free-tier API exposes a real iMessage typing indicator without violating Phase 1's chat.db red line. Picking the wrong path here wastes 2–3 days of P8 work.

**WHAT:** A 1-page written verdict in `.planning/phases/15-typing-indicator/15.1-VERDICT.md` answering:
1. Does `@photon-ai/imessage-kit` v3 (free tier) expose a typing-indicator method? Check `dist/index.d.ts` exports + README + npm changelog up to today (2026-04-26).
2. Does the AppleScript Messages dictionary (`/System/Applications/Messages.app/Contents/Resources/Messages.sdef`) expose any `typing` / `is typing` / status property on `chat` or `service`?
3. Are there any non-chat.db, non-private-framework routes (CoreSimulator, IMCore introspection, etc.) usable from a sandboxed Node process with Full Disk Access only?
4. Verdict: **REAL** (route X) **/ PARTIAL** (route X with caveat Y) **/ NONE** (chunked-simulation only).

**WHERE:** Read-only investigation. Touches no production files. Output is markdown only.
- Read: `node_modules/@photon-ai/imessage-kit/dist/index.d.ts`, `node_modules/@photon-ai/imessage-kit/README.md`, `package.json`.
- Read (system): `/System/Applications/Messages.app/Contents/Resources/Messages.sdef` via `cat`.
- Web search: "@photon-ai/imessage-kit typing indicator" with current year (2026) for any post-cutoff release.

**HOW MUCH:** ~3h. One P8, no P7. Single agent.

**DONE:**
- File `15.1-VERDICT.md` exists, has all 4 questions answered, ends with one of: `VERDICT: REAL`, `VERDICT: PARTIAL`, `VERDICT: NONE`.
- If verdict is REAL or PARTIAL, the doc cites the exact API signature and license terms.

**DON'T:** Don't propose paid/commercial dependencies (Advanced iMessage Kit) without flagging them as "P10 decision required". Don't touch chat.db. Don't write any code.

---

## 15.2 — Implementation: chosen path with rollback flag

**WHY:** Ship the perceived-latency reduction. Path determined by 15.1 verdict.

**WHAT:** Two sub-tracks, mutually exclusive, picked from 15.1:

### 15.2a — IF VERDICT == NONE (expected): Chunked-message simulation

- New `apps/macos-imessage-worker/src/chunker.ts`:
  - Pure function `planChunks(text: string, opts?): { chunks: string[], delaysMs: number[] }`.
  - Implements split heuristic from CONTEXT §3c (paragraph → sentence → single-message floor at 60 chars).
  - Never splits inside fenced code blocks or markdown link syntax.
  - Caps at 3 chunks. Returns `delaysMs.length === chunks.length - 1`.
- Modify `apps/macos-imessage-worker/src/outbox.ts` `processOutboundJob`:
  - After claim, if `process.env.PA_TYPING_INDICATOR_DISABLED !== "true"` and `body.length > 60`, call `planChunks(body)`, then loop `sdk.send` per chunk with `await sleep(delaysMs[i])` between.
  - On any chunk send error: mark outbound `failed` with chunk index in error message, do NOT retry remaining chunks.
  - On success: mark `sent` once **all** chunks succeed; persist `chunkPlan` (count + delaysMs) to the outbound doc for operator visibility.
- Modify `apps/macos-imessage-worker/src/index.ts` `handleDirectMessage`:
  - Same chunked path for the inline `sdk.send({ to: msg.chatId, text: reply })` call after `runAgentTurn`.
- Extend `packages/core-types/src/index.ts` `OutboundMessageSchema`:
  - Add `chunkPlan?: { count: number, delaysMs: number[] }` (optional).
  - Additive only; no migration.

### 15.2b — IF VERDICT == REAL: Real typing indicator

- Add `setTyping(chatId, on: boolean)` wrapper around the route 15.1 found.
- Wrap `runAgentTurn` call site in both `handleDirectMessage` and `processOutboundJob`:
  - `setTyping(on)` immediately before LLM call.
  - `try { ... } finally { setTyping(off) }`.
  - 30s setTimeout fallback to force-clear typing if `runAgentTurn` hangs.
- Track active typing state in a `Map<turnId, abortHandle>` to prevent orphans on concurrent turns.

### Both 15.2a and 15.2b

- Rollback flag `PA_TYPING_INDICATOR_DISABLED=true` short-circuits the new path back to the existing single-message `sdk.send`.
- **Default value of the flag in `.env.template`: `PA_TYPING_INDICATOR_DISABLED=true`** (default-OFF per CONTEXT §6 recommendation; P10 to confirm).

**WHERE (file domain):**
- WRITE: `apps/macos-imessage-worker/src/chunker.ts` (NEW)
- WRITE: `apps/macos-imessage-worker/src/outbox.ts`
- WRITE: `apps/macos-imessage-worker/src/index.ts`
- WRITE: `packages/core-types/src/index.ts` (`OutboundMessageSchema` additive)
- WRITE: `apps/macos-imessage-worker/.env.template` (flag default)
- READ ONLY: `packages/pa-orchestrator/src/index.ts` (verify suppressOutbound path untouched)
- DO NOT TOUCH: anything under `packages/pa-broker/src/outbound-queue.ts` (enqueue stays as-is)

**HOW MUCH:** ~1 day. One P8. No P7 needed (file domain is small).

**DONE:**
- `pnpm -w typecheck` clean.
- `pnpm -w test` green (existing outbox.test.ts must still pass).
- Manual smoke from a separate worker process: send a 500-char reply, observe 2–3 chunks delivered with 800–1500ms gaps to a real iMessage account.
- Manual smoke with `PA_TYPING_INDICATOR_DISABLED=true`: identical single-message behavior to today's `main`.

**DON'T:**
- Don't change chat.db open mode from `readonly: true`.
- Don't add any new outbound enqueue API surface — Phase 15 is **delivery** only, not enqueue.
- Don't touch `packages/pa-orchestrator/src/index.ts` `suppressOutbound` logic.
- Don't ship without the rollback flag.

---

## 15.3 — Worker tests

**WHY:** Lock invariants: chunking timing, suppressOutbound preservation, rollback flag effectiveness, error-mid-chunk failure mode.

**WHAT:**
- `apps/macos-imessage-worker/src/chunker.test.ts` (NEW):
  - Splits 500-char paragraph reply into 2–3 chunks at `\n\n` boundaries.
  - Splits 200-char sentence reply at `. ` when no paragraph exists.
  - Returns single chunk for ≤60 char reply.
  - Never splits inside `\`\`\`code\`\`\`` fence.
  - Never splits inside `[label](url)`.
  - `delaysMs` length === `chunks.length - 1`, all values ∈ [800, 1500].
- `apps/macos-imessage-worker/src/outbox.test.ts` (EXTEND):
  - Chunked path: 3 chunks observed, `sleep` mocked, total elapsed-fake-time within expected range.
  - Mid-chunk send error: outbound marked `failed`, no remaining chunks attempted.
  - `PA_TYPING_INDICATOR_DISABLED=true`: single `sdk.send` call, no chunker invocation.
- `packages/pa-orchestrator/src/index.test.ts` (VERIFY existing T5 still green):
  - `suppressOutbound: true` harness scenarios still produce zero `pa_outbound` rows. Re-run, no edits.

**WHERE:**
- WRITE: `apps/macos-imessage-worker/src/chunker.test.ts`
- WRITE: `apps/macos-imessage-worker/src/outbox.test.ts` (extension)
- READ ONLY: `packages/pa-orchestrator/src/index.test.ts`

**HOW MUCH:** ~4h. Same P8 as 15.2 (avoid context-switch).

**DONE:**
- All new + existing tests green via `pnpm -w test`.
- Coverage on `chunker.ts` ≥ 95%.
- T5 (suppressOutbound) explicit assertion line confirmed in test output.

**DON'T:** Don't replace existing T5 — only verify it still passes.

---

## 15.4 — Dashboard surface

**WHY:** Operators need to see when a turn was delivered chunked vs single-shot, so support tickets like "user got message in pieces" don't surprise the on-call.

**WHAT:**
- In `apps/dashboard` operations queue (the operator-facing outbound list), render a small badge on rows where `chunkPlan` is present: e.g., `chunked · N` (N = `chunkPlan.count`).
- Tooltip on hover: "Sent as N chunks with delays Xms / Yms" (read from `chunkPlan.delaysMs`).
- Single-chunk and pre-15 rows render unchanged (no badge).

**WHERE:**
- Locate the operations-queue list component in `apps/dashboard/src/...` (15.4 first task is to read the existing surface — likely `apps/dashboard/src/app/operations/...` from Phase 4 — and identify the row component).
- WRITE: that one row component file + any badge sub-component.
- READ ONLY: rest of dashboard.

**HOW MUCH:** ~3h. One P8 (different file domain from 15.2 — can run in parallel with 15.3 once 15.2 lands).

**DONE:**
- Operator can visually distinguish chunked rows in the queue.
- No regression on rows without `chunkPlan` (renders identically to today).
- Dashboard typecheck + lint clean.

**DON'T:**
- Don't add filter/sort by chunk count — out of scope, ticket later if needed.
- Don't surface `chunkPlan` to end users.

---

## 15.5 — Production scenario validation

**WHY:** Closing-the-loop: prove both flag positions behave correctly on real (or staging) iMessage delivery.

**WHAT:** Two scenarios in `tests/scenarios/` (or wherever Phase 14 / production scenario harness lives), runnable against a staging iMessage account:

### Scenario A — flag-enabled (default, single-message)

- `PA_TYPING_INDICATOR_DISABLED=true`
- Send a 600-char webSearchTool reply through the worker.
- Assert: exactly **one** message arrives at the test peer, body matches the assistant reply byte-for-byte.
- Assert: `pa_outbound` row has no `chunkPlan` field (or `chunkPlan` is undefined).

### Scenario B — flag-disabled (chunked)

- `PA_TYPING_INDICATOR_DISABLED=false`
- Send the same 600-char reply.
- Assert: **2 or 3** messages arrive at the test peer.
- Assert: total of all chunk bodies (joined with chunk-boundary text or with whitespace per the chunker contract) reconstructs the original reply.
- Assert: `pa_outbound` row has `chunkPlan.count ∈ {2, 3}` and `delaysMs.length === count - 1`.
- Assert (timing): observed wall-clock between first and last chunk arrival ≥ sum(delaysMs) − 200ms.

### Suppression cross-check

- Run Phase 14-style harness scenario with `rawMeta.harness.suppressOutbound = true` while flag-disabled.
- Assert: zero `pa_outbound` rows written (i.e., chunking did not bypass suppression).

**WHERE:**
- WRITE: `tests/scenarios/15-typing-indicator/scenario-a.mjs`, `scenario-b.mjs`, `scenario-suppression.mjs` (paths align with existing scenario harness — to be confirmed in 15.5 kickoff).
- READ ONLY: production worker + Firestore staging.

**HOW MUCH:** ~4h. Same P8 as 15.2/15.3 for context retention.

**DONE:**
- All three scenarios pass against staging.
- Test report file `15.5-PROD-VALIDATION.md` lists peer used, message bodies, timing observations.
- Sign-off line from P9: "Ready for P10 default-flip decision."

**DON'T:**
- Don't run against the production Firestore project — use staging only until P10 flips the default.
- Don't run scenario B at high volume — 3 runs is enough.

---

## Cross-cutting

### Parallelization

- 15.1 must complete before 15.2.
- 15.2 must complete before 15.3 / 15.5 (they exercise the new code).
- 15.4 can run in parallel with 15.3 after 15.2 lands (different file domain: dashboard vs worker tests).

### Failure modes & rollbacks

- **At merge:** flag default is `disabled=true` → zero behavior change for end users.
- **In production:** if anything goes wrong post-flip, ops sets `PA_TYPING_INDICATOR_DISABLED=true` in the worker's environment and restarts the worker. Single-message behavior restored within one process restart (~10s).
- **Schema rollback:** `chunkPlan` is optional and additive; no migration needed if we revert the worker code.

### P9 self-PUA checks

- If 15.2 returns and `outbox.test.ts` still has the **exact** original assertions, P9 must re-issue 15.3 with explicit added-test list — Task Prompt was under-specified.
- If P8 touches `packages/pa-orchestrator/src/index.ts`, halt: WHERE was violated; suppressOutbound is an orchestrator concern, not a worker concern.
- If P8 changes chat.db open mode, halt: red line violated, revert before any other review.
