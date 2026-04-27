# Phase 20 — Output Normalizer (CONTEXT)

**Date:** 2026-04-27
**Milestone:** v1.1 Pre-Launch Hardening + Companion Brain
**Requirements:** NORM-01 .. NORM-08
**Status:** Planning

---

## Why This Phase Exists

**Pain witnessed 2026-04-27** (production iMessage thread, not synthetic):

PA replied with:

```
**特斯拉一季度业绩上升** ([axios.com](https://axios.com/2026/04/26/tesla-q1?utm_source=openai&utm_medium=referral))
```

What the user saw on iMessage:

```
**特斯拉一季度业绩上升** ([axios.com](https://axios.com/2026/04/26/tesla-q1?utm_source=openai&utm_medium=referral))
```

iMessage does **not** render markdown. Asterisks render as literal asterisks. Bracketed link syntax renders as literal brackets. UTM params leak the upstream search provider (`utm_source=openai`) to the user. This is the single most damaging "robotic" signal the product currently emits — worse than filler phrases, because it visibly breaks the "texting a friend" frame Phase 18 is rebuilding.

## Problem Framing

The LLM (gpt-5.4-nano) is markdown-trained. Even with Phase 18's positive instruction *"You write plain text — like texting a friend. No bold, no bullets, no markdown,"* and even with plain-text `mes_example` few-shots, the model **will** intermittently emit markdown — especially when:

1. Citing sources from `current-info` connector (web_search returns markdown-formatted citations)
2. Listing >2 items (the model defaults to bullets)
3. Quoting/emphasizing key phrases (defaults to `**bold**`)

**Therefore:** Phase 18 is the carrot (positive voice instruction in prompt). Phase 20 is the stick (deterministic normalizer at orchestrator exit). Both ship; both are needed.

## Channel-Agnostic by Design

The normalizer runs at **orchestrator exit, before outbox enqueue** — not inside the iMessage worker. This means:

- Dashboard playground replies are normalized (operators see what users will see)
- Future Sendblue path (Phase 21) gets normalization for free
- Future web fallback (P1) gets normalization for free
- Proactive turns (Phase 22) are normalized identically to reactive turns

If we put normalization in the iMessage worker, every new channel would re-implement it (or skip it).

## User Decisions (Locked)

These are extracted from the milestone framing + roadmap, not a separate `/gsd:discuss-phase` session — Phase 20 is mechanical (regex rules + tests), not discretionary.

### D-01: Normalizer location is `packages/pa-orchestrator/src/output-normalizer.ts`
Channel-agnostic. Runs at orchestrator exit.
**Locked because:** NORM-01 requirement; future-channel reuse.

### D-02: Public API is `normalizeForIMessage(input: string, opts?: NormalizeOpts): NormalizeResult`
Returns `{ text: string, chunks?: string[], droppedTracking: string[], wasOverLength: boolean }`.
**Locked because:** Caller (orchestrator) needs to know if output was chunked (multiple outbox rows) vs single-message.

### D-03: Length cap = 600 characters; chunk-split via Phase 15 chunker
Reuse `planChunks()` from `apps/macos-imessage-worker/src/chunker.ts`. Do NOT re-implement.
**Locked because:** NORM-06; chunker is battle-tested with code-fence/link-protection invariants we'd otherwise re-derive.

**Caveat:** Phase 15 chunker lives under `apps/macos-imessage-worker/`. Phase 21 will deprecate that app. We extract `planChunks` to a shared package (or duplicate to `packages/pa-orchestrator/`) as part of this phase to avoid creating a new cross-app dependency on a soon-deprecated module.

### D-04: UTM strip list is exhaustive and explicit
Strip these query params (case-insensitive):
`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `gclid`, `fbclid`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`, `ref`, `ref_src`.
Track which were dropped → return in `droppedTracking[]` for audit.
**Locked because:** NORM-03; exhaustive list prevents leak whack-a-mole.

### D-05: List markers: `- ` and `* ` → `· ` (CJK middle dot)
Numbered lists (`1.`, `2.`) preserved as-is.
**Locked because:** NORM-04; `· ` reads natively in zh and en; numbered lists carry semantic order the user might depend on.

### D-06: Eval rubric extension
Add 5th axis `iMessage_render_safe` to `tests/scenarios/judge.mjs`. Auto-fail (score = 0, hard fail) on regex match of:
- `\*\*.+?\*\*` (markdown bold)
- `\[.+?\]\(.+?\)` (markdown link syntax)
- `^[\-\*]\s` per line (markdown list marker — but only after normalizer should run; this catches normalizer bugs)

**Locked because:** NORM-07; auto-fail (not soft-score) because rendering literal asterisks is unrecoverable.

### D-07: Normalizer runs on EVERY orchestrator outbound, including proactive turns
Single integration point in `packages/pa-orchestrator/src/index.ts` immediately before outbox enqueue. No bypass flag.

### D-08: Empty / whitespace-only input passthrough
If input trims to empty, return `{ text: "", chunks: [], droppedTracking: [], wasOverLength: false }`. Caller decides whether to suppress send.

## Deferred (Explicitly NOT in Phase 20)

- **HTML escape / entity decode** — orchestrator output is LLM-generated, not user-supplied; no XSS surface in iMessage rendering
- **Profanity filter** — separate concern; abuse signals (Phase 23) handle policy violations
- **Language-aware chunking** — Phase 15 chunker already handles zh + en sentence boundaries; no new logic
- **Tone normalization** — that's Phase 18's job
- **Mirror layer interaction** — Phase 19 mirror snippet shapes generation; normalizer runs after generation. Independent.

## Integration Point in Orchestrator Turn Flow

Current flow (simplified):

```
inbound event → orchestrator.runTurn()
  → build prompt (system + persona + history + user msg)
  → LLM call (Agents SDK)
  → tool calls (current-info, wekruit-matching, etc.)
  → final assistant message
  → enqueue pa_outbound row(s)            ← Phase 20 inserts BEFORE this
  → broker dispatches to channel
```

New flow:

```
  → final assistant message: rawText
  → normalized = normalizeForIMessage(rawText)
  → if normalized.chunks: enqueue one pa_outbound per chunk
  → else: enqueue single pa_outbound with normalized.text
  → audit: log droppedTracking[] to pa_audit_events if non-empty
```

## Goal-Backward Truths

For "iMessage doesn't render literal markdown" to be true:

- **T1**: Markdown emphasis tokens (`**`, `*`, `__`, `_`, backticks, code fences) never appear in `pa_outbound.text` at orchestrator exit
- **T2**: Markdown link syntax (`[text](url)`) never appears in `pa_outbound.text`; URLs appear as bare URLs
- **T3**: UTM/tracking query params never appear in URLs sent to users
- **T4**: List bullets render as `· ` (middle dot) on both zh and en clients
- **T5**: Whitespace is collapsed (no triple+ blank lines, no trailing whitespace)
- **T6**: Replies >600 chars are split into ≤3 chunks (Phase 15 contract) or truncated gracefully
- **T7**: Eval harness auto-fails any scenario whose final assistant message matches markdown regex
- **T8**: Normalizer is idempotent: `normalize(normalize(x)) === normalize(x)`

## Required Artifacts

- `packages/pa-orchestrator/src/output-normalizer.ts` — module
- `packages/pa-orchestrator/src/output-normalizer.test.ts` — 8+ unit tests
- `packages/pa-orchestrator/src/index.ts` — integration call site
- `packages/pa-orchestrator/src/chunker.ts` (or shared) — extracted from Phase 15
- `tests/scenarios/judge.mjs` — 5th rubric axis added
- `tests/scenarios/output-normalizer.yaml` — golden scenario for the witnessed Tesla case

## Key Links (Most Likely Breakage)

- **Orchestrator → normalizer**: if orchestrator forgets to call normalizer for proactive turn path → markdown leaks. Mitigation: single chokepoint immediately before `enqueueOutbound()`.
- **Normalizer → chunker**: contract assumption — chunker preserves text byte-exact. If normalizer is called AFTER chunker, each chunk gets re-normalized (idempotent, fine). If BEFORE, single normalize then chunk. Decision: normalize FIRST, chunk SECOND (so length cap applies to normalized length, not raw markdown-inflated length).
- **UTM strip → URL parser**: hand-rolled regex on query strings will miss edge cases (encoded `&`, fragment-after-query). Use `URL` constructor + `searchParams.delete()`; fall back to original string if parse fails.
- **Eval rubric → CI**: if `iMessage_render_safe` is added without updating golden baselines, every existing scenario fails. Mitigation: re-run eval after normalizer integration, regenerate baselines.

## Success Criteria

1. `normalizeForIMessage()` exists with locked signature; idempotent.
2. Six normalization rules implemented with the regex patterns documented in PLAN.
3. ≥8 unit tests covering: mixed markdown / UTM-only / nested emphasis / fenced code blocks / >600 char input / empty input / all-Chinese / pure code-fence input.
4. Orchestrator calls normalizer before every outbox enqueue (reactive + proactive paths).
5. Eval rubric has 5th axis `iMessage_render_safe`; auto-fails on the documented regex set.
6. 50-turn production audit (read `pa_outbound` for last 50 turns post-deploy) shows zero markdown leakage and zero UTM params.
7. The witnessed Tesla case is captured as `tests/scenarios/output-normalizer.yaml` and passes.
