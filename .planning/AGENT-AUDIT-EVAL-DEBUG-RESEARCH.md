# Making Thin Claire Less Black-Box: Audit, Eval & Debug Research

_Research report for Adam — 2026-06-04. Scope: the thin Claire agent (`apps/functions/src/claire-agent/*`, SDK `@openai/agents` 0.8.5). Problem statement: "it's too black box and I'm not happy with the behavior sometimes."_

---

## 1. TL;DR

- **Core problem: there is no single per-turn record of *why* Claire did what she did.** To answer "why did Claire say/not-say X for user U at time T" you must hand-correlate ~5–10 separate Cloud Logging lines across **two** Cloud Functions (`onPaInbound` and `paMessageCoalescer`, which use *different* log prefixes), then cross-read Firestore. Nothing joins them. The inbound text isn't logged, the delivered reply isn't logged, the tool sequence is **thrown away** (`toolCalls: []` is hardcoded), and suppressed bubbles vanish into a transient 120-char log line.

- **The SDK already builds a full per-turn span tree (LLM calls, tool calls, guardrails) — and we throw it away every turn.** Tracing is ON by default but export is silently disabled because `configureClaireSdk()` (`sdk.ts:126`) sets the chat key via `setDefaultOpenAIKey` but never calls `setTracingExportApiKey`. The prod log literally says `No API key provided for OpenAI tracing exporter. Exports will be skipped.` **This is the single highest-leverage, lowest-effort win.**

- **Highest-leverage move #1 — a per-turn DECISION TRACE doc.** Extend the doc we *already* write (`PA_COLLECTIONS.turns/{eventId}`, `cutover.ts:453`, currently usage-only) to capture `input → mode → tools → suppressed → delivered → why`. One Firestore read answers the black-box question. Most fields are already in scope at that call site.

- **Highest-leverage move #2 — turn on the export + populate `toolCalls`.** One-line export enable in `sdk.ts:126`, plus map the SDK's `res.newItems` into the `toolCalls` field instead of returning `[]` (`agent.ts:658/781/981/997`). Together with move #1 this gives both an in-house queryable trace and the OpenAI Traces dashboard.

- **Highest-leverage move #3 — turn real transcripts into a regression corpus + binary LLM-judge run async.** The eval harness exists (`apps/eval/thin-claire/`) but **no real-agent leg blocks the deploy gate** and there's **no corpus of real failed turns**. Parameterize the one-off `repro-cutover.mjs` into a generic `replay-event.mjs <eventId>`, seed a `transcript-fixtures/` dir from every MEMORY.md incident, and run a **binary** (not Likert) LLM-judge async in a Cloud Function — never blocking the iMessage reply.

---

## 2. Where it's black-box today

### What telemetry exists (the good news)
- **~150 distinct structured log events** via `log(event, payload)` → `logger.info('[thin-claire][onPaInbound] '+event)` (`index.ts:1243`, `:1468`) and `[coalesce]` (`paMessageCoalescer.ts:111`).
- **Mode selection IS observable** — `mode-selector.ts` logs the chosen pattern richly (`mode.onboarding_active`, `mode.prescreen_thin`, `mode.cv_parsed_pitch_*`, `mode.linkedin_just_connected`, `mode.gmail_nudge`, etc.).
- **Dedup/suppression is logged** — `delivery.ts:249/:253` emit `claire.dedup.near_dup_suppressed {scope, bubble:first 120 chars}`.
- **Anti-silence fallback is traceable** — `agent.ts:935/:968/:977/:988` (`claire.anti_silence_fallback.*`).
- **One durable per-turn artifact exists** — `PA_COLLECTIONS.turns/{eventId}` (`cutover.ts:453`) with `{userId, sessionId, mode, handledBy, usage}`. Keyed on `eventId`. **This is the natural home for a decision trace** — but today it's usage-only.
- **Durable transcript** — `pa-messages`, written by the **outbox** after delivery (`outbox.ts:493`), reconstructs the literal user↔assistant text per session.

### What's missing (the black box)
| Gap | Evidence | Why it hurts |
|---|---|---|
| **No single per-turn decision trace** | nothing joins `thin_claire.*` + `mode.*` + `claire.dedup.*` + tool logs + `turn_usage` | "why did Claire do X" = hand-correlate ~5–10 lines across 2 CFs by timestamp |
| **Tool-call sequence is discarded** | `toolCalls: []` hardcoded at `agent.ts:658, 781, 981, 997`; SDK `res.newItems` read only for `finalOutput`+usage (`agent.ts:757–764`) then dropped | no authoritative list of which tools ran in a turn |
| **Tool calls not in transcript** | `firestore-session.ts extractItemBody` (102–143) drops `function_call`/`function_call_output` | `pa-messages` shows clean chat, zero machinery |
| **SDK trace export disabled & un-exported** | zero `setTracingExportApiKey`/`setTraceProcessors`/`getGlobalTraceProvider` anywhere; `configureClaireSdk()` (`sdk.ts:126`) sets only the chat key (`sdk.ts:136 setDefaultOpenAIKey`) | the span tree the SDK builds in memory is generated then dropped every turn; prod warning `Exports will be skipped` |
| **Inbound user text not logged** | `cutover.ts` logs only `eventId/userId/mode` | can't reconstruct the trigger from logs alone |
| **Delivered reply text not logged** | `finalText` computed (`agent.ts:809`) but never logged; `thin_claire_handled` (`cutover.ts:481`) carries no body | must read `pa-messages`/`pa-outbound` to see what was sent |
| **Suppressed bubbles leave no durable trace** | `pa-messages` records only *delivered* text (`outbox.ts:493`); a dedup-dropped bubble only appears in a transient 120-char log line | "Claire went silent / dropped my message" is undiagnosable after the fact |
| **No correlation id in tool logs** | per-tool logs (`pa.claire.find_match`, `prescreen.score.recorded`, `pa.proactive.*`) emit payloads without `eventId` | stitching a tool log to its turn relies on `userId`+timestamp — ambiguous under coalescing/concurrency |
| **Per-turn directive not captured** | `turnContext` built `agent.ts:~700–727` (pitch/hold/linkedin-just-connected variant) injected into `run()` but never logged | can't see which instruction the model got for a misfired turn |
| **Logs split across two CFs** | `onPaInbound` (`index.ts:1243`) vs `paMessageCoalescer` (`:111`) use different prefixes | the same logical turn lands under different prefixes depending on coalescing |
| **No admin/debug surface** | `/admin/match-debug` exists for matching; no `/admin/claire-turns` | Adam must use raw Cloud Logging + Firestore console |

### Eval/replay gaps
- **The predeploy gate never exercises the real thin agent end-to-end.** `firebase.json` runs `process-intact-runner.mjs` (no model), `runner.mjs` (self-described **FALSE-GREEN**, 1 fixture), `real-seam-gate.mjs` (extractor-only, 2 fixtures, **self-skips with exit 0** when no key). `runClaireTurn`, mode-selector routing, tool orchestration, and composed reply text are gated by **zero blocking legs**. A keyless deploy ships with **no real-model assertion at all**.
- **No regression corpus of real transcripts.** Fixture counts are tiny (6 process + 1 conversation + 2 real-seam + 5 llm = 14 total). The `repro-*.mjs` scripts hardcode a single `eventId`/`uid` (`repro-cutover.mjs:18`, `repro-match-live.mjs:14`) and must be hand-edited per incident.
- **LLM-judge output is advisory-only, never blocking.** A turn whose *tags* are correct but whose *words* are bad (the exact "behaved badly" class) cannot fail any gate.
- **The canonical "simulate before merge" runner tests the wrong path.** `runner-local.mjs` imports `processInboundEvent` from `@pa/pa-orchestrator` (**legacy**) and never references `maybeRunThinClaire`/`claire-agent`.
- **Stale surfaces confuse the map** — `external-benchmarks/claire-stack-adapter.mjs` still targets the retired orchestrator voice stack; `intent-matrix-results/` holds dated 2026-05-03 dumps.

---

## 3. The biggest single win

**Ship a per-turn DECISION TRACE doc AND enable the already-built SDK export. These are complementary, not either/or.** Do both; the decision trace is the in-house source of truth, the SDK export is a free UI on top.

### 3a. Per-turn decision trace (in-house, queryable) — the #1 move

We already write one durable doc per turn keyed on `eventId`. The plumbing, the fail-open wrapper, and the call site all exist:

```ts
// cutover.ts:452–465 (today — usage only)
await db.collection(PA_COLLECTIONS.turns).doc(eventId).set({
  userId, sessionId, mode, handledBy: 'thin_claire',
  usage: { inputTokens, outputTokens, totalTokens, cachedInputTokens, turnsUsed },
  createdAt,
})
```

**Extend it to the full turn shape** (most fields are already in scope at this call site via `decision.*`, `turnResult`, `deliverResult`):

```ts
{
  eventId, userId, sessionId, createdAt, latencyMs,
  inboundText,                       // NEW — the trigger (today logged nowhere)
  mode,                              // chosen pattern (already have)
  deferReason | suppressReason,      // why legacy/why silent
  directiveFlags: {                  // which turnContext variant the model saw (agent.ts:~700-727)
    postParsePitch, enrichmentInFlight, offerFirstKickoff, linkedinJustConnected, ...
  },
  toolCalls: [{ name, args, output, ok }],   // NEW — see 3b, currently []
  bubblesComposed: number,
  bubblesSuppressed: [{ scope, text }],      // NEW — dedup-dropped bubbles (today evaporate)
  bubblesDelivered: [...],
  guardrail: { tripped, kind } | null,
  usage, handledBy,
}
```

This single doc answers **"why did Claire do X for user U at time T"** in **one Firestore read** — no Cloud Logging spelunking, no cross-CF prefix juggling, no `userId`+timestamp guessing. It is also the only place a **suppressed** bubble survives (today it dies in a transient log line). Write it fail-open exactly like the current `turns` write.

### 3b. Populate `toolCalls` instead of returning `[]`

The data is already on the SDK result; we just discard it.

```ts
// agent.ts:757 — res.newItems is read for finalOutput + usage, then dropped.
// Map function_call / function_call_output items → {name,args,output,ok}
// and return them in ClaireRunResult instead of the hardcoded:
//   agent.ts:658, 781, 981, 997  →  toolCalls: []
```

This feeds both the decision-trace doc (3a) and the structured log line (below). **Zero new SDK calls** — it's reading a field we already have in hand.

### 3c. Enable the SDK trace export (one line, removes the prod warning)

Root cause (verified): `configureClaireSdk()` calls `setDefaultOpenAIKey(apiKey)` (`sdk.ts:136`) which populates `_defaultOpenAIKey` (the chat client key) — a **different variable** from the tracing key. The tracing exporter reads `getTracingExportApiKey()` → `_defaultTracingApiKey` (set **only** by `setTracingExportApiKey`) → falls back to `loadEnv().OPENAI_API_KEY`. Neither is set, so it logs `Exports will be skipped` and `continue`s.

```ts
// sdk.ts:126, right after the existing setDefaultOpenAIKey(apiKey):
if (apiKey) (sdk.setTracingExportApiKey as ((k: string) => void) | undefined)?.(apiKey)
```

**Serverless durability caveat (must-do companion):** `BatchTraceProcessor` flushes on a 5s *unref'd* timer and `onTraceEnd` is a no-op. A short CF invocation can freeze before the timer fires → spans never POST even with the key set. So **`await getGlobalTraceProvider().forceFlush()` at the end of `runClaireTurn`** (after `run()` at `agent.ts:734`), in a fail-open try/catch.

**Naming/grouping/PII:** thread `{workflowName:'claire-turn', groupId: sessionId, traceMetadata:{userId,mode}, traceIncludeSensitiveData:false}` into the `run()` opts (`agent.ts:734`). Without `workflowName`/`groupId` traces are unnamed/ungrouped; without `traceIncludeSensitiveData:false` full candidate message bodies (PII, phone, resume) ship to OpenAI.

> **In-house-only alternative if OpenAI egress of message content is a concern:** register a custom `TracingProcessor` via `addTraceProcessor(new BatchTraceProcessor(firestoreExporter))` that writes `span.toJSON()` to Firestore. Use `addTraceProcessor` (not `setTraceProcessors`) to keep BOTH the OpenAI dashboard and the Firestore mirror. But the decision-trace doc (3a) already gives the in-house artifact, so the OpenAI dashboard is the cheap bonus, not the primary store.

---

## 4. Eval plan

Goal: **turn real failures into a growing regression corpus, score conversation quality with a validated binary judge, and monitor production async.** Build on the existing `apps/eval/thin-claire/` harness — `_claire-bundle.mjs` already solves the hard part (loading the real `claire-agent` with the correct zod@4 SDK).

### 4a. Real-transcript regression corpus (the missing asset)
- Create `apps/eval/thin-claire/transcript-fixtures/` — each fixture = `{ eventId, seeded pa-users/pa-messages state, inbound turns, expected (state assertions + quality floors) }`.
- **Seed it from every incident already in MEMORY.md**: offer-first state poison, LinkedIn double-callback double-pitch, match-reply tool-output leak, skills-clobber re-parse, prescreen string-start. Each becomes a permanent fixture so it can never silently regress again.
- Source new fixtures from the `dump-*.mjs` helpers (`dump-outbound-tail`, `dump-event-replies`, `dump-session-tail`) + error analysis (4d).
- **N-1 replay** (industry best practice, Hamel): feed the first N-1 turns of a real conversation, assert the Nth turn deterministically. Far higher signal than synthetic multi-turn data because it reproduces real bugs.

### 4b. Wire a real-agent leg into the BLOCKING predeploy gate
- `eval-canary-twoturn.mjs` already drives real `runClaireTurn` over a fake Firestore + dry-run transport and asserts named prod regressions. **Add it to `firebase.json` predeploy** with the *same graceful-skip-without-key contract* `real-seam-gate.mjs` uses — keyed CI blocks on agent-level regressions, keyless local deploys still pass. This closes the "zero blocking real-agent legs" gap.

### 4c. Conversation-quality scoring — binary, validated, mostly async
- **Binary, not Likert.** One judge question per conversation: *"Did Claire meet the candidate's goal?"* plus 2–3 binary sub-checks for top failure modes: `askedPiiBeforeConsent`, `skippedFirstInterview`, `returnedToAdminDomain`, `wallOfQuestions`. Binary beats the prior mirror-score/Likert drift checks for reliability (adjacent Likert points are subjectively inconsistent).
- **Validate the judge against ~50 hand-labeled conversations (TPR/TNR) before trusting it.** Judges are biased by prompt phrasing, response length, answer position — and can **reward-hack** (scores rise while users complain). Keep a frozen gold set; re-check judge↔human agreement every time the judge prompt or model changes. Every HITL correction writes a labeled fixture (matches the `CorrectionEvent` flywheel rule).
- **Convert `judge.mjs` from advisory→blocking on the safety/format subset only** (markdown/AI-disclosure/length-bloat = block; mirror/novelty = warn). Reuse the existing `judge.mjs` forced-tool schema + cost ledger (`PA_EVAL_MAX_RUN_USD`) and `voice-axes.mjs` — this is wiring, not new infra.
- Promote `eval-sim-multiturn.mjs` (12-turn real `runClaireTurn` + drift axes) to a per-PR **measured** number, even if non-blocking at first.

### 4d. Online monitoring (the silent-regression catcher)
- Run the binary judge **asynchronously in a scheduled Cloud Function over the last day's transcripts** — reuse `paQaEvaluatorWeekly` + existing cron infra. **Never block the iMessage reply.**
- Alert via the existing `PA_SLACK_ALERT_WEBHOOK` when binary pass-rate drops — catches silent regressions from prompt/model/tool-API drift.
- **Weekly error analysis on real Sendblue transcripts is the highest-leverage practice and needs zero new infra** (transcripts already in Firestore): one person reads ~100 real conversations, journals failures, clusters into a taxonomy, counts frequencies. This drives every other eval decision. It **cannot be outsourced to an LLM** (lacks product/tribal context; SOTA failure-attribution is <10% accurate).

### 4e. Housekeeping
- Relabel/retire stale surfaces: point `external-benchmarks/claire-stack-adapter.mjs` at `runClaireTurn` or mark legacy; archive `intent-matrix-results/` 2026-05-03 dumps; add a one-paragraph "which harness covers the thin agent" index to `apps/eval/thin-claire/README.md`.

---

## 5. Debug workflow (replay a bad prod turn locally)

**Today:** possible but not ergonomic — `repro-cutover.mjs:18` hardcodes a single `eventId`, `repro-match-live.mjs:14` hardcodes a `uid`. Each new bug needs a bespoke hand-edited script. But both correctly drive the **real** agent against **real** Firestore via `_claire-bundle.mjs` — the plumbing for a generic CLI is ~30 lines from being parameterized.

**Target workflow:**

1. **Reproduce in one command.** Parameterize `repro-cutover.mjs` → `node apps/eval/thin-claire/replay-event.mjs <eventId> [--dry-run]`. Loads real Firestore + `_claire-bundle.mjs`, runs `maybeRunThinClaire(dryRun:true)` with full log capture. "The agent behaved badly here" becomes one command instead of editing a file.
2. **See exactly why, in one read.** Open the per-turn decision-trace doc (Section 3a) for that `eventId`: `inboundText → mode → directiveFlags → toolCalls[] → bubblesSuppressed[] → bubblesDelivered[] → guardrail`. No Cloud Logging cross-correlation.
3. **See the span tree (optional).** With export on (3c), open `platform.openai.com/traces`, filtered by `groupId = sessionId` — the LLM generation (input+output), each tool span (input+output), and guardrail spans nested under one named `claire-turn` trace.
4. **Add the bad turn to the corpus.** Capture state via `dump-*.mjs`, drop it into `transcript-fixtures/` (4a) — the bug is now a permanent regression test.
5. **Determinism caveat.** For replay to be truly deterministic, log `model id + temperature/top_p/seed` per LLM call (cheap to add now, expensive to retrofit). Without them, replay silently diverges.

**Also build a minimal admin viewer (P2):** `/admin/claire-turns` reading the decision-trace docs + `pa-messages` by `userId`/session — "show me this user's last N turns and why each reply happened" — so Adam is self-serve instead of using the Firestore console.

---

## 6. Best-practice tooling

The trace data model the industry standardized on (trace = one workflow with `workflow_name`/`trace_id`/`group_id`; spans = nested timed ops of type Agent/Generation/Function/Handoff/Guardrail/Custom) **is exactly what `@openai/agents` already emits.** We already produce it — we just don't export it.

| Platform | Strengths | Fit for us |
|---|---|---|
| **OpenAI Traces** | Zero-install (SDK default exporter); span tree UI; free with an OpenAI key even on non-OpenAI models | **Yes — enable first.** One-line win (3c). Weak on eval/dataset/regression/drift; PII egress unless scrubbed. Tracing visibility ≠ an eval system. |
| **Langfuse** | Open-source leader, self-hostable (Postgres+ClickHouse), framework-agnostic via OTEL, documented `@openai/agents` integration, generous free tier, dataset + online-eval + drift | **Recommended add-on** for a small team that also needs evals. Drop-in via one `addTraceProcessor()`; keep transcripts in Firestore AND mirror spans. Scrub PII in the processor first. |
| **Arize Phoenix** | Open-source, strongest eval/drift/embedding stats | Overkill now; revisit if embedding-drift analysis becomes a need. |
| **Braintrust** | Eval-first | Defer — heavier than a single conversational agent warrants. |
| **Helicone** | Drop-in proxy, simplest install | Useful if you want LLM-call logging without SDK changes; redundant once SDK export + decision trace land. |
| **Datadog/Honeycomb** | Enterprise OTEL | Defer. |

**Recommendation for a small team on Firebase + `@openai/agents` + Sendblue:**

> **Firestore transcripts (have) + per-turn decision-trace doc (3a) + `@openai/agents` built-in spans, exported (3c) and optionally mirrored to self-hosted Langfuse via one `addTraceProcessor()` + N-1 replay in the scenario runner (extend) + a binary validated LLM-judge run async in a Cloud Function (extend `paQaEvaluatorWeekly`).**

Start in-house (decision trace + Firestore — you don't need a platform initially). Add Langfuse only when you want span-tree visualization, distributed annotation, drift stats, or a second agent/handoff appears. **Defer** Braintrust/Arize/Datadog and the multi-agent failure-attribution research tooling — overkill for one conversational agent, and SOTA auto-attribution is <10% accurate so it can't replace human error analysis anyway. Instrument to the **OpenTelemetry GenAI semantic conventions** (`gen_ai.usage.output_tokens` etc.) to stay vendor-neutral — a token spike doubles as a runaway/injection signal.

---

## 7. Prioritized roadmap

| Pri | Move | Effort | Closes |
|---|---|---|---|
| **P0** | **Per-turn decision-trace doc.** Extend `PA_COLLECTIONS.turns/{eventId}` (`cutover.ts:453`) with `{inboundText, mode, deferReason/suppressReason, directiveFlags, toolCalls[], bubblesComposed/Suppressed/Delivered, guardrail, latencyMs}`. | ~0.5–1 day (fields mostly in scope; fail-open write exists) | No single decision trace; inbound/delivered/suppressed not durable |
| **P0** | **Populate `toolCalls`.** Map SDK `res.newItems` (`agent.ts:757`) → `{name,args,output,ok}`; replace hardcoded `[]` at `agent.ts:658/781/981/997`. | ~2–4 hrs | Tool sequence discarded |
| **P0** | **Enable SDK trace export + `forceFlush`.** `setTracingExportApiKey(apiKey)` in `sdk.ts:126`; `await getGlobalTraceProvider().forceFlush()` after `run()` (`agent.ts:734`), fail-open. Ship next functions deploy, verify a turn at `platform.openai.com/traces`. | ~1 hr | SDK span tree dropped every turn; prod `Exports will be skipped` warning |
| **P0** | **Generic replay CLI.** Parameterize `repro-cutover.mjs` → `replay-event.mjs <eventId>`. | ~2–3 hrs (plumbing exists in `_claire-bundle.mjs`) | "Behaved badly here" not reproducible without hand-editing a script |
| **P1** | **One structured turn-summary log line** (`thin_claire.turn_summary {eventId,userId,mode,toolNames,composed,suppressed,delivered,blocked,usage}`) after delivery in `cutover.ts`. | ~1 hr | Logs split across 2 CFs; no single queryable shape |
| **P1** | **Thread `eventId` into every tool's `ctx.log`** (wrap `ctx.log` at `agent.ts:601`). | ~2 hrs | Tool logs un-joinable to their turn |
| **P1** | **Name/group/scrub the SDK trace** — `{workflowName:'claire-turn', groupId:sessionId, traceMetadata, traceIncludeSensitiveData:false}` into `run()` (`agent.ts:734`). | ~1 hr | Unnamed/ungrouped traces; PII egress |
| **P1** | **Real-agent leg in the blocking gate** — add `eval-canary-twoturn.mjs` to `firebase.json` predeploy with graceful-skip-without-key. | ~2–3 hrs | Zero blocking real-agent legs in predeploy |
| **P1** | **Real-transcript regression corpus** — `transcript-fixtures/` seeded from MEMORY.md incidents + N-1 replay runner. | ~1–2 days | No corpus of real failures |
| **P1** | **Binary validated LLM-judge** + frozen 50-conversation gold set; flip `judge.mjs` safety/format subset to blocking. | ~1–2 days | Bad-words turns can't fail any gate; reward-hacking risk |
| **P2** | **Online async monitor** — binary judge over last-day transcripts in a scheduled CF (extend `paQaEvaluatorWeekly`); Slack alert on pass-rate drop. | ~1 day | Silent regressions from prompt/model/tool drift |
| **P2** | **Persist suppressed + composed bubbles** in the decision-trace doc (subsumed by P0 if scoped in). | included in P0 | "Claire went silent" undiagnosable |
| **P2** | **Capture per-turn directive variant** (`agent.ts:~700–727`) in the decision trace. | ~2 hrs | Misfired pitch/hold/linkedin turn not reproducible |
| **P2** | **`/admin/claire-turns` viewer** reading decision-trace docs + `pa-messages`. | ~1–2 days | No self-serve turn-inspection surface |
| **P2** | **Weekly error-analysis ritual** — one person reads ~100 real transcripts, journals → taxonomy → fixtures. | recurring, ~half-day/wk | Highest-leverage practice; drives all other eval work |
| **P3** | **Log model id + temp/top_p/seed per LLM call**; **Langfuse mirror** via one `addTraceProcessor()`; **enrich `guardrail_tripwire`** (`agent.ts:769`) with which guardrail + redacted snippet; relabel stale eval surfaces. | ~0.5–1 day each | Replay determinism; span-tree UI + drift; opaque blocks; confusing eval map |

**Build order:** P0 block first (decision trace + `toolCalls` + export + replay CLI) — these four together convert "black box" into "one read tells you why" and make every later eval move cheaper. Then P1 (gate leg + corpus + binary judge). Then P2 (online monitor + admin viewer + error-analysis ritual). P3 is polish/optional egress.
