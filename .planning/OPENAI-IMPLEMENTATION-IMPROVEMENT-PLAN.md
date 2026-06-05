# OpenAI Implementation Improvement Plan

**Scope:** the whole server-side OpenAI surface — conversation runtime (Claire agent, pitch, conversation extractor), parsing/enrichment (resume parser, job-tag enricher, CV-ingest), embeddings, async rerank, plus the client/key/health/eval infra around them. Server-side only (`apps/functions/**`, `packages/**`). The candidate/admin SPAs (`apps/pa-landing`, `apps/dashboard-web`) do not call OpenAI directly and are out of scope except where a candidate-facing error message originates server-side.

**Authored:** 2026-06-04. Repo root (read): `/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/thin-PB`.

**Hard constraints honored throughout:**
- **No regex-classifies-text-into-enum** (absolute repo rule). Every proposal keeps extraction as "LLM picks the enum, code validates membership." JSON-schema `strict` mode is *server-side validation of enum membership*, not regex classification — it does **not** introduce the banned pattern. The `isRetryable` regex (`packages/pa-resume-parser/src/retry.ts:11-24`) and the skill-string normalizers (`packages/pa-job-tag-enricher/src/enricher.ts:80-130`) are retry-classification / output-cleanup, not text→enum tagging, so they are not in scope of the rule.
- **Behavior-compatible by default.** Anything that can change observable behavior is flagged with an explicit strong reason + the tradeoff.
- **Single canonical model/vocab sources** per CLAUDE.md D1-D16; no new model tiers introduced on hot paths.

---

## 1. Executive summary

The repo's **resume parser** (`packages/pa-resume-parser`) is already the gold-standard pattern: 3 retry layers, per-tier `maxRetries` (`router.ts:44-48`), provider fallback (`router.ts:108-178`), and Responses-API `json_schema` `strict:true` (`providers/openai-responses.ts:91-98`). Every problem below clusters in the paths that **diverge from that pattern**. The 7 highest-leverage moves, each one line with expected benefit:

1. **[FLAGSHIP P0] Migrate the conversation extractor + JSON judges from free-form `json_object` to `json_schema` strict** (`conversation-extractor-runtime.ts:139-147`) → kills the recurring silent `parse_error` → whole-`tagPatch`-dropped class we hit **twice this session** (numeric salary, `preferenceHardness`); matcher stops silently starving.
2. **Add `timeout` + explicit `maxRetries` to every raw `new OpenAI(...)` in a request path** (pitch `compose-pitch.ts:209`, embeddings `embeddings.ts:176`, CV single-shot `cv-ingest.ts:534`) → removes the invisible 10-minute SDK-default timeout that can hang a live Sendblue turn.
3. **Add resilience to embeddings (retry + bounded timeout)** (`embeddings.ts:213-231`) → the only parse-class path with zero retry layers, on a synchronous ingest path; a transient 5xx currently silently zeroes the semantic vector.
4. **Route the legacy single-shot CV parse through the v2 router** (`cv-ingest.ts:511-561`) → the most consequential single LLM call in the funnel gains tier fallback + outer backoff for free, collapsing two parse implementations into one (closes D11).
5. **Remove the two residual `process.env.OPENAI_API_KEY` fallbacks** (`conversation-extractor-runtime.ts:80-81`, `enricher.ts:135-136`) → closes the last two instances of the "poisoned-key → whole-platform 401" foot-gun from the 2026-06-01 incident.
6. **Eval & sim overhaul (promptfoo + real-failure corpus + judge validation + online conversation eval)** → pitch quality and long-context drift (the two things Adam flags most) get their first blocking real-model regression net; the unwired binary judge gets a calibration number. **This is the headline — full plan in Section 4.**
7. **Batch + content-hash dedup embeddings** (`embeddings.ts:215-218`, `backfill-user-embeddings.ts`) → cuts the fastest-growing cost line; reinit/re-parse of unchanged CV text becomes free.

**Cross-cutting theme (the spine of this plan): structured outputs.** JSON mode (`response_format:{type:"json_object"}`) only guarantees *syntactically valid JSON*, not your shape — `json_schema` + `strict:true` makes required-key and enum-membership a **server-side guarantee** ([docs](https://developers.openai.com/api/docs/guides/structured-outputs)). The repo already proves the pattern works (resume parser). Adopting it on the extractor and JSON judges is the single change that eliminates a documented, recurring, silent data-loss class — hence **P0**.

**Model-currency finding (no action needed on hot paths):** nano extraction (`gpt-5.4-nano`), mini pitch (`gpt-5.4-mini`, `compose-pitch.ts:21`), and `text-embedding-3-small` (1536d, `embeddings.ts:216`) are all the current OpenAI-recommended models as of June 2026. `text-embedding-3-large` exists but is 6.5× the price for marginal recall — **not** recommended. Scattered legacy `gpt-4.1-*` IDs in fallback/eval/recovery paths are supported and low priority (Change Q-4). The `@openai/agents` SDK is ~3 minors behind, but bumping is risky (zod v3/v4 split + Cloud-Run boot fix keyed to `^0.8.5`, `sdk.ts:1-89`) — **do not bump** unless tool-search is specifically wanted (Section 6).

---

## 2. Current request flow

**Inbound path (traced):** `paSendblueWebhook` (`apps/functions/src/sendblue/webhook.ts`) verifies HMAC → idempotent inbound event → `onPaInbound`/coalescer → `maybeRunThinClaire` (`cutover.ts:37`, flag `paThinClaireEnabled`). `cutover.ts` branches: **cv-parsed re-entry + canary** → `composePitchTurn` (call #3); **all other turns** → `runClaireTurn` (`agent.ts:657`, invoked `cutover.ts:385`) → `run(agent,…)` (call #1). The **conversation extractor** (call #2) fires from the LEGACY orchestrator turn handler (`packages/pa-orchestrator/src/index.ts:2727,3404,5918`), NOT the thin path; on thin, canonical tags are written from agent tool-call params via `applyPartialUserTags` (`process-tools.ts:301-360`, `matching-tools.ts:961`).

### Conversation-runtime call sites

| Site | File:line | Model | Structured-output mode | Retry / timeout | Streaming | Caching |
|---|---|---|---|---|---|---|
| **Claire agent** (`run()`) | `claire-agent/sdk.ts:133` (client), `agent.ts:230` (model) | `gpt-5.4-nano` | Responses API, `outputType: ClaireReplySchema` (SDK zod→strict) `agent.ts:261` | SDK defaults (no `timeout`/`maxRetries` on client); outer `Promise.race` `RUN_TIMEOUT_MS=100_000` `agent.ts:180,839-841` | OFF (default `run()`) | static head cached, per-turn context trailing `{role:'system'}` `agent.ts:776-800`, `prompt.ts:690-724` |
| **Conversation extractor** (chat→tags) | `conversation-extractor-runtime.ts:82` (client), `:139-147` (call) | `gpt-5.4-nano` → `claude-sonnet-4-6` fallback | **`chat.completions` + `response_format:{type:"json_object"}`**, `temperature:0`; client-side Zod `.parse` `conversation-extractor.ts:527` | **none** (no `timeout`/`maxRetries`); provider-fallback only; debounced 5 min | OFF | system-first / user-last (cache-optimal order) |
| **Pitch composer** | `compose-pitch.ts:209` (client), `:211-222` (call) | `gpt-5.4-mini` | **`responses.create`, free-form text** (no schema) | **none** on client; retry-once-on-empty `:232-233`; no wrapping timeout | OFF | static `PITCH_SYSTEM` first, profile JSON last (good order) |

### Parsing / embedding / rerank call sites

| Site | File:line | Model | Structured-output mode | Retry / timeout | Notes |
|---|---|---|---|---|---|
| **Resume parser** (v2, gold pattern) | `pa-resume-parser/src/router.ts:44-48`, `providers/openai-responses.ts:91-98` | `gpt-5.4-nano → claude-sonnet-4-6 → gpt-4.1-mini` | Responses `text.format` **`json_schema strict:true`** (Anthropic tier: forced `tool_use`) | **3 layers**: SDK `maxRetries` 2/2/1 + tier fallback + outer `[1s,4s,16s]` (`retry.ts:60-105`) | the model to extend |
| **CV-ingest legacy single-shot** | `cv-ingest.ts:511-561`, `:534` (client) | `gpt-5.4-nano` | Responses `json_schema strict:true` (`CV_JSON_SCHEMA :434-496`) | **none** — no fallback, no outer retry; flag `paResumeParserV2` OFF path | violates D11 (2 impls coexist) |
| **Job-tag enricher** | `pa-job-tag-enricher/src/router.ts:34-38`, `enricher.ts:135` | `gpt-5.4-nano → claude-sonnet-4-6 → gpt-4.1-mini` | `json_schema strict:true` | 3-layer (mirrors parser) | **residual `OPENAI_API_KEY` fallback** `:135-136` |
| **Embeddings (CV)** | `lib/embeddings.ts:173-176`, `:215-218` | `text-embedding-3-small` (1536d) | n/a | **none** — single-try, fail-open null; no batch, no dedup | synchronous at cv-ingest |
| **Embeddings (reverse-match)** | `paReverseMatch.ts:78-101` | `text-embedding-3-small` | n/a | **none** | input sliced 8000 chars |
| **Async rerank (nightly)** | `lib/llm-rerank.ts:213-222` | `Qwen/Qwen2.5-7B-Instruct` (SiliconFlow) | `json_object`, `temperature:0.2`, `max_tokens:1500`; `sanitizeRanked :277-332` | never throws → `{ranked:[]}` | $0 free tier |
| **JD-relative weights** | `lib/jd-relative-weights.ts:147-156` | `claude-sonnet-4-6` (primary) → `gpt-5.4-nano` → Qwen | Sonnet **plain-text JSON** + fence-stripper `:273-285`; OpenAI/Qwen `json_object` | **none** (no SDK timeout); `paLlmRerankNightly timeoutSeconds:540` | highest-cost provider, weakest structured path |

**Provider/key infra:** `apps/functions/src/lib/llm-providers.ts` — `getOpenAIConfig` requires `sk-`-prefixed `PA_OPENAI_AGENT_API_KEY` else null (`:41-47`), returns explicit `baseURL`. No `timeout`/`maxRetries` declared anywhere here; each call site constructs its own client. Two call sites bypass this helper and read the poisoned `OPENAI_API_KEY` (`conversation-extractor-runtime.ts:80-81`, `enricher.ts:135-136`). **One shared key behind every service** — auto-revoked 2026-06-01 → whole-platform 401 (`.planning/INCIDENT-2026-06-01-openai-rotation-hardening.md`).

---

## 3. Proposed changes (grouped by QUALITY / LATENCY / RELIABILITY / COST)

Each change carries `{what · files · steps · benefit · tradeoff · behavior-compatible? · test}`. Priority tag `P0`/`P1`/`P2` reflects impact ÷ effort and risk; sequencing is summarized at the end of this section.

### QUALITY

#### Q-1 (P0, FLAGSHIP) — Migrate the conversation extractor + JSON judges to `json_schema` strict

**What.** The extractor generates with free-form `response_format:{type:"json_object"}` (`conversation-extractor-runtime.ts:142`) → `safeParseJson` (`:112-120`, strips ``` fences) → strict Zod (`conversation-extractor.ts:527`, `ConversationExtractResultSchema`). JSON mode guarantees only syntactically valid JSON, not your shape — so the model can emit a scalar where an array is expected, a number where a string is expected, or an unknown enum, and the strict Zod boundary historically nuked the **entire** tagPatch via `parse_error`. The code comments narrate the history: `conversation-extractor.ts:193` ("`parse_error` → silently returned `{ran:false}`"), `:279` ("malformed axis nuked the ENTIRE tagPatch"), `:407` (".strict() rejected the unknown key → silent parse_error"). Three defensive coercions — `coerceArray` (`:204-214`), `memoryEntities[].value` preprocess (`:306-309`, the numeric-salary bug), `preferenceHardness` `.catch(undefined)` (`:285,294`, the 2026-06-04 bug) — are reactive patches over the same missing server-side guarantee. `json_schema` + `strict:true` makes required-key + enum-membership a provider-side guarantee, so "one bad axis nukes the whole patch" **cannot recur**.

Same legacy `json_object` + `JSON.parse` pattern at: `skill-intent-classifier.ts:236-265`, `guided-open.ts:190,304`, `keyword-set.ts` (nano judge), `prescreen-deps.ts:77,168`, `compaction-run.ts:71`, `prescreen-drift-detector.ts:39`.

**Files.** `packages/pa-orchestrator/src/conversation-extractor-runtime.ts:135-149` (primary). Reference the working pattern at `packages/pa-resume-parser/src/providers/openai-responses.ts:91-98` and `router.ts:79-142`. Then the judge sites above, lowest-churn first.

**Steps.**
1. Derive a JSON Schema from `ConversationExtractResultSchema` — hand-write it mirroring the Zod shape, or use the SDK `zodResponseFormat`/`responses.parse` helper. Strict mode requires every property `required` + `additionalProperties:false`; model each optional axis as `required` with a nullable / `"none"` sentinel (a schema-design task, not a drop-in).
2. Switch the call to chat.completions `response_format:{type:"json_schema", json_schema:{name, strict:true, schema}}` (lowest churn — keeps chat.completions). Optionally move to Responses `text.format` later for the 40-80% better cache utilization on reasoning models ([docs](https://developers.openai.com/api/docs/guides/responses-vs-chat-completions)).
3. Keep the Zod `.parse()` and the existing coercions as defense-in-depth — they become harmless belt-and-suspenders.
4. Roll the same migration to the judge sites once the extractor proves out.

**Benefit.** Eliminates the single most-patched bug family in the repo (silent tag-patch loss → matcher data-starvation). A hallucinated `industrySector` value can never poison the whole extraction again. Highest-value *quality* change because dropped tags degrade matching for that user invisibly.

**Tradeoff.** Schema-design effort — strict forbids `additionalProperties` and bare optionals, so the multi-axis tagPatch must use nullable/sentinel fields. Adding a new axis later needs a schema edit (it already needs a Zod edit — parallel, not net-new friction). Does **not** violate the no-regex rule: the model still LLM-picks the enum; strict only validates membership.

**Behavior-compatible?** Yes for valid outputs (same JSON, same Zod result). The only *changed* behavior is strictly fewer silent drops — the goal. Strong reason: documented recurring production data loss.

**Test.** Drive the real `maybeRunExtractor` seam (per "eval must drive the real seam") on `real-seam-fixtures/salary-memory-entity-parse-error.json` + `mid-onboarding-out-of-slot-capture.json`; assert the durable tag store is written. Add a scalar-vs-array stress fixture and prove RED on `json_object` → GREEN on `json_schema`.

#### Q-2 (P1) — Add real-model pitch + agent-trajectory eval coverage

Pitch quality and long-context drift have zero blocking real-model coverage. This is the headline eval work — **see Section 4 (Steps II-3 through II-6)** for the full design (drivers, fixtures, judge validation). Behavior-compatible (eval-only).

#### Q-3 (P1) — Tighten the JD-relative-weights Sonnet structured path

**What.** JD-rel puts `claude-sonnet-4-6` as tier-1 primary (`jd-relative-weights.ts:147-156`) using plain-text JSON + a markdown-fence stripper (`:273-285`) — a more failure-prone structured path for the highest-cost provider. For the **OpenAI** fallback tier (`gpt-5.4-nano`, `:176-218`), move `json_object` → `json_schema strict` mirroring the small fixed-shape weights object. Leave Qwen on `json_object` (SiliconFlow may not support OpenAI strict; `sanitizeRanked` already defends it well, `llm-rerank.ts:277-332`).

**Files.** `apps/functions/src/lib/jd-relative-weights.ts:176-218` (OpenAI tier). **Test.** Schema test asserting strict rejects an out-of-shape weights object that `json_object` + fence-stripper would have passed. **Behavior-compatible?** Yes for valid outputs.

#### Q-4 (P2) — Sweep legacy `gpt-4.1-*` model IDs (eval-gated)

**What.** Prior-gen IDs remain in fallback/eval/recovery: `gpt-4.1-nano` (`run-context.ts:210`), `gpt-4.1-mini` (`guided-open.ts:40`, resume-parser tertiary `router.ts:47`, eval/recovery scripts). All supported; successor is `gpt-5.4-nano`/`gpt-5.4-mini`. **Steps.** Swap only with the eval harness green per call site — a model swap is a re-eval risk on JSON shape/judgment, not find-replace. Keep the resume-parser tertiary `gpt-4.1-mini` (deliberate provider-diversity hedge) unless eval shows otherwise. **Behavior-compatible?** Not guaranteed — **gate each behind the eval harness.** Lowest priority; not a regression today.

### LATENCY

#### L-1 (P0) — Set explicit `timeout` on raw OpenAI clients in request paths

**What.** Most raw `new OpenAI(...)` clients pass only `{apiKey, baseURL}` and inherit `timeout:600_000` (10 min). In a Sendblue webhook turn, a 10-minute ceiling is effectively unbounded. The agent path is saved by its own 100s `Promise.race` (`agent.ts:180,839-841`), but **pitch and CV single-shot have no ceiling** — a hung `gpt-5.4-mini` responses call can sit up to 600s on the inbound lease (compounded by the in-cutover fixed 12.5s pacing sleeps `cutover.ts:176,180`), risking a double-fire / dropped pitch.

**Files.** `compose-pitch.ts:195-209` (pitch ≤ ~30s), `cv-ingest.ts:534-535` (see R-4), `lib/embeddings.ts:173-176` (≤ ~15s — see R-1), `lib/llm-rerank.ts:174,213`, `lib/qa-judge.ts:139,176`, `lib/jd-relative-weights.ts:176-218` (~60s — see R-3), `lib/sponsorship-inference.ts:297-342`, `cv-ingest/industry-second-pass.ts:231-242`, `enrich-companies-nightly.ts:498`.

**Steps.** Add `timeout` per call site sized to the path. Optionally log `response._request_id` at each site (one line — the supportable handle for OpenAI incident triage; none currently capture it; pure-additive).

**Benefit.** Removes the unbounded-hang risk on live turns; makes per-path latency budgets explicit instead of an invisible 10-min default.

**Tradeoff.** A slow-but-valid call could now abort to the existing fail-open (pitch → legacy agent path `compose-pitch.ts:237`; embeddings → null). Acceptable — every one of these already fail-opens. **Behavior-compatible?** Bounded behavior change with the stated unbounded-hang reason.

**Test.** Per-site unit test with an injected client that delays beyond timeout → assert the existing fallback fires within budget.

#### L-2 (P2) — Bound the JD-rel Sonnet primary timeout below the function budget

**What.** The Sonnet JD-rel client has no SDK timeout, so a stuck request rides the 600s default while holding a concurrency slot until `paLlmRerankNightly`'s `timeoutSeconds:540` kills the whole function (`nightly-rerank.ts:685-693`). **Steps.** Add `timeout: ~60_000` to the Sonnet client so it falls through to the next tier instead of starving the slot. **Behavior-compatible?** Yes for valid outputs; the chain is designed to fall through. **Test.** Inject a Sonnet client that delays > timeout → assert fallthrough to the gpt-5.4-nano tier.

### RELIABILITY

#### R-1 (P0) — Add resilience to embeddings (retry + bounded timeout)

**What.** `computeCvEmbedding` and the reverse-match JD embed are single-try, fail-open-to-null, no SDK `timeout`, no explicit `maxRetries` (`embeddings.ts:213-231`, `paReverseMatch.ts:78-114`). A momentary OpenAI 5xx silently drops the semantic vector for that CV — the 0.10 emb-cosine soft-score term goes dark with no surfaced error. Every other parse-class path has 3 retry layers; embeddings have zero.

**Files.** `apps/functions/src/lib/embeddings.ts:173-176` (client), `:215-218` (call); `apps/functions/src/paReverseMatch.ts:78-101`.

**Steps.** In `defaultEmbeddingClient()` (`embeddings.ts:164-177`) pass `{apiKey, baseURL, maxRetries:2, timeout:15_000}`. `maxRetries:2` matches the SDK default (auto-retries connection errors + 408/409/429/≥500) but makes it explicit; `timeout:15_000` replaces the invisible 10-min default. Mirror in `paReverseMatch.ts`. Keep the existing `try/catch → null` fail-open.

**Benefit.** Recovers the common-case transient 5xx that currently silently zeroes the embedding. Bounds worst-case latency from 10 min to ~15s — matters because `computeCvEmbedding` runs **synchronously at cv-ingest** (`embeddings.ts:6-10`); a hung socket there stalls ingest.

**Tradeoff.** A slow-but-valid call >15s now aborts to null. Mitigated: input capped 8000 chars (`MAX_EMBED_INPUT_CHARS`, `:57`); `text-embedding-3-small` on 8k chars returns well under 15s. **Behavior-compatible?** Retry: yes (matches default). Timeout: bounded change with the unbounded-hang reason.

**Test.** Inject `deps.client` (seam at `:200-202`) whose `embeddings.create` rejects twice then resolves → assert vector returned. Inject a never-resolving client with a short test timeout → assert null within budget.

#### R-2 (P0) — Remove the two residual `process.env.OPENAI_API_KEY` fallbacks

**What.** `llm-providers.ts:8-12` documents `OPENAI_API_KEY` as "poisoned legacy" (overloaded with the SiliconFlow key in prod → the documented 401). Two sites bypass the helper and still read it: `conversation-extractor-runtime.ts:80-81` (and the client is constructed with **no `baseURL`** `:82`, so on the fallback key it hits `api.openai.com` with a SiliconFlow key → 401); `enricher.ts:135-136`.

**Files.** the two lines above. **Steps.** Replace both with `getOpenAIConfig()` (`llm-providers.ts:41-47`) and pass its explicit `baseURL` into the constructor. If null → existing fail-open (extractor `{ran:false}`; enricher skip) rather than a doomed client.

**Benefit.** Closes the last two instances of the exact misconfiguration that caused a whole-platform 401; also fixes the extractor's missing `baseURL`. **Tradeoff.** None of consequence in a correctly-configured env. **Behavior-compatible?** Yes — removes a latent failure mode, not a happy-path. **Test.** Set only `OPENAI_API_KEY` → assert skip (fail-open); set `PA_OPENAI_AGENT_API_KEY` → assert used with correct `baseURL`.

#### R-3 (P1) — Set explicit `maxRetries` on the remaining raw clients

**What.** `cv-ingest.ts:534`, `compose-pitch.ts:209`, `embeddings.ts:176`, etc. silently get `maxRetries:2`. Make it explicit so the latency budget is legible — `2` for fire-and-forget batch, `1` for the live pitch turn where total latency dominates. Behavior-preserving (matches default) but removes a hidden assumption. **Files/Test.** Same set as L-1.

#### R-4 (P1) — Route the legacy single-shot CV parse through the v2 router (close D11)

**What.** `cv-ingest.ts` still carries `defaultLlmExtract` (`:511-561`) — a direct `gpt-5.4-nano` Responses call, no tier fallback, no outer retry, selected per-user by `paResumeParserV2` (`:393`). D11 says cv-ingest must wire the `pa-resume-parser` v2 router. So flag-OFF users get strictly worse reliability for the same spend, and two parse implementations coexist.

**Files.** `cv-ingest.ts:511-561`, `:393`, `:434-496`, `:353`. Target: `packages/pa-resume-parser/src/router.ts:108-178` (`callWithFallback`), the same router `match-nuanced-reason.ts:190` already proved works for a one-field schema.

**Steps.** Make the v2 router the default for **all** users (the parser's `parsedResumeData` mirrors `CV_JSON_SCHEMA`'s intent). Prefer (a) flip `paResumeParserV2` default ON and delete the `defaultLlmExtract` branch — one implementation is the D11 intent; or (b) keep the flag but point its OFF branch at `callWithFallback` too. **Coordinate the flag-default flip with Adam** (Section 6).

**Benefit.** The most consequential single LLM call in the funnel gains Sonnet + gpt-4.1-mini fallback + `[1s,4s,16s]` backoff for free; the repo collapses to one CV-parse implementation. **Tradeoff.** Marginally higher worst-case latency on a tier cascade — acceptable (cv-ingest is async/fire-and-forget). **Behavior-compatible?** Output shape identical; reliability strictly improves; flag-default flip is a product decision. **Test.** A cv-ingest integration test asserting a primary-tier throw now falls through instead of surfacing as a parse failure.

#### R-5 (P2) — Widen the retry classifier to mirror the SDK auto-retry set

**What.** `isRetryable` (`retry.ts:33-46`) checks numeric `.status` for 429/529/5xx but not 408/409, while the OpenAI Node SDK auto-retries connection-errors + 408/409/429/≥500. Layer C (outer backoff) and Layer A (SDK) disagree on 408/409. **Steps.** Add `408`/`409` to the numeric branch. (Retry classification, not text→enum — not in scope of the no-regex rule.) **Behavior-compatible?** Yes — strictly widens retry on already-transient codes. **Test.** Feed `{status:409}` → assert `isRetryable` true and the backoff sequence runs.

#### R-6 (P2, Adam-gated) — Per-service key topology + usage-spike CF

**What.** One shared OpenAI key sits behind conversation, cv-ingest, matching, embeddings, pitch; auto-revoked 2026-06-01 → whole-platform 401 (`.planning/INCIDENT-2026-06-01-openai-rotation-hardening.md` §4-§5). The decision logic is pure + unit-tested (`openai-key-health-logic.ts:81-106,151-174`) and `paOpenAiKeyHealth` is scheduled; the gap is topology + the proposed `paOpenAiUsagePoll` token-spike CF, both unbuilt. **Steps (Adam-gated — touches prod secrets):** split into per-service restricted keys (extend `getOpenAIConfig` to resolve a per-service key defaulting to the shared key); build `paOpenAiUsagePoll`; clean the stray line-1 scratch text ("gh is authenticated…") committed into the incident doc. **Behavior-compatible?** Yes if the shared key remains the default. **Test.** Per-service key resolution defaulting to the shared key when unset.

### COST

#### C-1 (P1) — Batch + content-hash dedup embeddings

**What.** Every embedding is a single-input `embeddings.create` (`embeddings.ts:215-218`, `paReverseMatch.ts:83-86`) — the SDK's array-`input` batching is unused. And no input-hash dedup: a re-parse (repo does this on reinit, MEMORY `reinit_user_cold_gotchas`) recomputes an identical embedding. Embedding volume scales with CV + re-parse + reverse-match; fastest-growing cost line with no guard.

**Files.** `embeddings.ts:215-218`, `backfill-user-embeddings.ts` (batch driver), `paReverseMatch.ts:83-86`.

**Steps.** (1) **Dedup:** persist a sha256 of `summaryText` next to `parsedCandidateResumes/{id}.embedding`; on recompute, if hash unchanged and a vector exists, skip the call and reuse. (2) **Batch:** in `backfill-user-embeddings.ts` send N inputs as one `embeddings.create({input: string[]})` (up to 2048/request); use the **Batch API** ($0.01/M vs $0.02/M) for non-time-sensitive bulk backfill (Section 6). (3) Per-CV sync path stays single-input.

**Benefit.** Cuts spend on the fastest-growing line; dedup makes reinit/re-parse free for unchanged text. **Tradeoff.** Tiny stored hash field; Batch API is async (backfill only, never sync ingest). No quality change — identical text → identical vector (exact dedup). **Behavior-compatible?** Yes. **Test.** Same `summaryText` twice → second call asserts zero `embeddings.create` invocations; backfill test: N inputs → one array call, N vectors in order.

#### C-2 (P2) — Capture pitch token usage / cost

**What.** `compose-pitch.ts:211-228` reads only the text, never `resp.usage` — `gpt-5.4-mini` is the most expensive per-call model in the conversation runtime and the product centerpiece, yet has zero spend observability (contrast the extractor's cost-ledger row `conversation-extractor.ts:507-523` and the agent's `extractClaireUsage` `agent.ts:1120`). **Steps.** Read `resp.usage`, write a cost-ledger row mirroring the extractor's. **Behavior-compatible?** Yes — additive observability. **Test.** Assert a ledger row is written per pitch composition.

### Sequencing (waves)

- **Wave 1 — P0, high impact, low effort:** Q-1 (flagship strict-schema extractor), L-1 + R-3 (timeouts/retries on raw clients), R-1 (embedding resilience), R-2 (key fallbacks).
- **Wave 2 — P1, moderate effort:** R-4 (CV-parse router unification, flag decision), C-1 (embedding dedup/batch), Q-3 (JD-rel OpenAI-tier strict), and the eval overhaul (Section 4) for Q-2.
- **Wave 3 — P2 / Adam-gated:** L-2, R-5, R-6, C-2, Q-4.

Every wave ships behind the existing predeploy gate (`firebase.json:18-30`). Items touching the extractor or CV parse must be verified by driving the **real seam** (`maybeRunExtractor`, cv-ingest), not a stand-in.

---

## 4. Eval & sim overhaul (promptfoo) — THE HEADLINE

Adam concern: "our eval & sim is still not good." The real-seam gate WORKS — it just caught the live `preferenceHardness` data-loss bug this session — but it is THIN: 2 hand-curated fixtures (both now guards for *closed* bugs), a bespoke judge wired into nothing, no online conversation eval, the judge unvalidated against a labeled gold set, and no pipeline turning real failures into fixtures.

Hard rules honored: no regex-classifies-text-into-enum; behavior-compatible (eval-only); every claim anchored to a real file:line.

### 4.0 Current state (verified) — keep vs replace

BLOCKING predeploy gate chain `firebase.json:22-25`, in order:
1. `process-intact-runner.mjs` (`firebase.json:22`) — deterministic HARD gate over **6** fixtures (`process-fixtures/`). Drives **real production reducers**, grades **state not words**. **KEEP — strongest part.**
2. `runner.mjs` (`firebase.json:23`) — self-documented **FALSE GREEN** (`real-seam-gate.mjs:7-17`: applies the fixture-supplied patch to a mock then asserts that same patch; never calls the model, never drives `maybeRunExtractor`). **REMOVE from blocking chain** (Step II-7).
3. `real-seam-gate.mjs` (`firebase.json:24`) — the **honest real-model BLOCKING gate**. Imports production `maybeRunExtractor` from dist (`:138`), runs real `gpt-5.4-nano` over `real-seam-fixtures/` (**2** fixtures), grades the durable tag store (`harness-lib.mjs:151`). Cost-ceiled (`--max-model-calls` default 6, `:109`), wall-clock budgeted (120s, `:110`), **keyless-graceful-skip exit 0** (`:114-123`) unless `PA_REAL_SEAM_REQUIRE_KEY=1` (`:108,116`). **KEEP the mechanism; widen the corpus + add drivers + a judge.** This is the model the whole overhaul extends.

Corpus counts: `process-fixtures/` 6 · `real-seam-fixtures/` 2 · `fixtures/` 1 · `llm-fixtures/` 5 · `bfcl-fixtures/` 8. Online eval today = `paQaEvaluatorWeekly` (`qa-evaluator-weekly.ts:44`): samples only users with `tags.targetRoleFunction` set (`:12`), judges **match quality** via Qwen-7B (thresholds `:93,95`, `MIN_SAMPLE_FOR_ALERT=10 :104`); historically data-starved (`sampleSize≈0`). It does NOT judge conversation/pitch/prescreen experience.

Binary judge `claire-binary-judge.mjs`: `RUBRIC_VERSION="claire-binary-judge-2026-06-04"` (`:78`); 5 checks `goalMet`/`piiBeforeConsent`/`skippedFirstInterview`/`wallOfQuestions`/`adminDomainLeak` (`:33-40`); evidence-anchored anti-reward-hack rules (`:85-98,148-152`); `temperature:0`; fail-open `safeDefault` (`:234`). **Unvalidated** (only a 2-transcript `--selftest` `:340,361`) and **wired into nothing** (`:18` says intentionally unwired "so the rubric can be validated against gold transcripts before anyone trusts it").

Flywheel seams to REUSE (do NOT invent): `pa-correction-events` (`collections.ts:78`), `pa-eval-artifacts` (`:80`), `materializeEvalArtifactForCorrection` (`flywheel-candidate-correction.ts:13,150`), `runCandidateFlywheelCorrection` (already writes a redacted eval artifact per correction, `:150-161`), `pa-messages` transcript store (`collections.ts:8`). `promptfoo` is **not** currently a dependency (verified — no `package.json` references it).

### 4.1 Decisions to confirm BEFORE executing (flagged for Section 6)

- **DE-1 — Adopt promptfoo as a dev/CI dependency?** *Recommended: YES, scoped.* It's the **assertion DSL + PR-reporting + caching layer** wrapping our real-seam drivers via **custom providers** — NOT a replacement for `maybeRunExtractor`/`composePitchTurn`/`runClaireTurn`. *Tradeoff:* one new dev dep (zod4-heavy); install in **`apps/eval` only**, NEVER `apps/functions` runtime — protects the documented zod v3/v4 split (`sdk.ts:1-89`). *If NO:* do Steps II-1/2/3/5/6/7, skip II-4. promptfoo is **additive**, never load-bearing — every BLOCKING gate stays a Node script.
- **DE-2 — Where does online conversation eval run?** *Recommended: a new scheduled CF `paConversationQaDaily`* (sibling to `paQaEvaluatorWeekly`, shares Slack/Mailgun plumbing). Alternative: fold into the weekly CF (cheaper but couples cadence).
- **DE-3 — Labeling labor.** Validating the judge needs ~50 hand-labeled real conversations (~3-4h human, Adam or a teammate). Unavoidable — an unvalidated judge cannot gate or alarm.
- **DE-4 — Real-model gate spend per deploy.** Keep `--max-model-calls` at a deliberate cap (proposed 12) and TIER fixtures so the BLOCKING set stays small; the rest run advisory/online.
- **DE-5 — Judge model.** For online eval over many transcripts, the cheaper `gpt-4.1-mini` grader (grader ≠ subject model). Confirm budget.

### 4.2 Sequenced steps  {what · files/new files · benefit · tradeoff · effort}

Critical path: II-1 → II-2 → II-3 → II-7. Parallel track: II-6 → II-5. II-4 optional/additive.

**Step II-1 — Tier the real-seam corpus + close the keyless-blind deploy hole.** The 2 BLOCKING fixtures are now guards for *closed* bugs (`salary-memory-entity-parse-error.json` description: "EXPECTED RED until the integrator coerces memoryEntities[].value to string … flips GREEN" — fixed at `conversation-extractor.ts:306-309`). Add `tier:"blocking"|"advisory"|"online"` per fixture; only `blocking` drives the deploy exit code. Set `PA_REAL_SEAM_REQUIRE_KEY=1` in the **deploy-machine env only** (keep keyless-skip default in the script) so a box that is *supposed* to have the key fails loud instead of silently shipping with the real-model gate OFF. *Files:* `real-seam-gate.mjs`, `harness-lib.mjs:217` (return `tier`), tag the 2 fixtures, deploy runbook. *Benefit:* blocking gate stays fast/curated; corpus grows without ballooning spend; keyless-blind risk closed. *Effort:* S (½ day).

**Step II-2 — Real-failure corpus mining pipeline (the flywheel made real).** Product-rule #9 + `CorrectionEvent.downstreamEvalCaseCreated:true` are half-built — `runCandidateFlywheelCorrection` already writes a redacted eval artifact per correction (`flywheel-candidate-correction.ts:150-161`). MISSING: a converter `pa-eval-artifacts` → runnable fixture, and the discipline turning every gate-RED / live failure / MEMORY incident into an N-1 replay fixture. Three lanes, all emitting the existing `real-seam-fixtures/*.json` shape (verified: `user_id`, `onboarding_state`, `initial_tags`, `turns:[{inbound,assistant}]`, `expect:{baseline_red, final_tags_includes, grade_criteria}`, graded by `harness-lib.mjs:151`): (1) **gate-RED lane** — the fix PR MUST add a `baseline_red:true` fixture (checklist item); (2) **correction-event lane** — new `scripts/mine-corrections-to-fixtures.mjs` reads recent `pa-eval-artifacts` rows of kind `candidate_profile_correction` (`flywheel-candidate-correction.ts:152`) → draft fixture into `real-seam-fixtures/_inbox/` for review; (3) **MEMORY/incident lane** — new `scripts/new-eval-fixture.mjs <name>` scaffolds a skeleton.

Seed list (this session's failures → first fixtures):

| Incident | MEMORY anchor | Surface | Assertion target |
|---|---|---|---|
| Rec-card image never reaches iMessage | `rec_card_image_delivery.md` | delivery (needs agent driver, II-3) | outbound payload has Sendblue-uploaded `media_url`; renderer `img` present |
| Offer-before-job order | `offer_first_state_poison.md` | agent trajectory | offer-first turn does NOT bootstrap onboarding; next inbound not an answer |
| Pitch founder-miss (line 1 restated title) | `pitch_engine_compose_pitch.md` | pitch (`composePitchTurn`) | line 1 leads with founder/honor/quantified; ≥3 signals; no intern split |
| `preferenceHardness` parse_error (caught THIS session) | `conversation-extractor.ts:285,294` | extractor real-seam | malformed hardness hint does NOT nuke the patch |
| Hi → tapback + silence | `greeting_not_tapback.md` | agent trajectory | a bare greeting ALWAYS gets a TEXT reply; tapback only follows an ack |

*Files:* new `apps/functions/scripts/mine-corrections-to-fixtures.mjs`, `apps/eval/conversation-experience/scripts/new-eval-fixture.mjs`, `real-seam-fixtures/_inbox/`, the 5 seed fixtures, README section. *Benefit:* corpus stops being hand-curated-and-stale; satisfies the unmet product-rule #9 with existing infra. *Effort:* M (2-3 days incl. 5 seed fixtures).

**Step II-3 — Add pitch + agent-trajectory drivers to the real-seam harness.** The blocking gate exercises ONE seam (`maybeRunExtractor`). Add two drivers mirroring "import the production wrapper from dist, run real model, grade output" (`real-seam-gate.mjs:138`, `harness-lib.mjs:217-270`): a **pitch driver** importing `composePitchTurn`/`compose-pitch.ts:195-237` (graded by deterministic shape checks — bubble count, "no fabricated number" via a presence check NOT a regex-into-enum — PLUS the binary judge's pitch rubric), and an **agent-trajectory driver** importing `runClaireTurn` (`agent.ts`, never-throws, `RUN_TIMEOUT_MS=100_000 :180`) graded by the 5 binary-judge checks (deterministic where possible — greeting `noReply` is a failure; PII-string absence is a presence check). Both MUST route through the production wrapper (lazy `createRequire` SDK seam `sdk.ts:1-89`) — never `import { tool } from "@openai/agents"` directly (breaks the zod split). *Files:* new `pitch-seam-driver.mjs` + `pitch-fixtures/`, `agent-seam-driver.mjs` + `agent-fixtures/`, generalize `harness-lib.mjs:217` to a pluggable `driver`. *Tradeoff:* agent turns slower/costlier (up to 100s each) — keep agent fixtures `tier:"online"/"advisory"`, pitch is cheap enough for `blocking`. *Effort:* L (4-5 days).

**Step II-4 — (Optional, DE-1) promptfoo as the assertion / report / cache layer.** IF DE-1=YES: wrap the three drivers as promptfoo **custom providers** for a standard assertion DSL (`is-json`, `javascript`, `llm-rubric`, `assert-set` thresholds, `cost`/`latency` gates), disk caching, and GitHub-Action PR annotation — WITHOUT re-implementing any prompt in YAML (the provider calls the real wrapper). Concrete `apps/eval/promptfoo/promptfooconfig.yaml`:

```yaml
description: WeKruit real-seam evals (extractor · pitch · agent trajectory)
providers:
  - id: file://providers/extractor-provider.mjs   # calls real maybeRunExtractor → durable tags JSON
  - id: file://providers/pitch-provider.mjs        # calls real composePitchTurn → pitch text
  - id: file://providers/agent-provider.mjs        # calls real runClaireTurn → {bubbles, toolCalls}
defaultTest:
  options:
    provider: openai:gpt-4.1-mini                  # GRADER model (≠ subject model; DE-5)
tests:
  - description: "fintech intent → industrySector"
    provider: file://providers/extractor-provider.mjs
    vars: { transcript: "I want fintech roles", onboarding_state: "complete" }
    assert:
      - { type: is-json }
      - type: javascript                            # binary, no flake, no model
        value: JSON.parse(output).industrySector.includes("financial_technology")
      - type: llm-rubric
        value: "Durable tags reflect a fintech industry preference and nothing the candidate did not say."
  - description: "founder profile → founder-led pitch"
    provider: file://providers/pitch-provider.mjs
    vars: { profileFixture: "file://pitch-fixtures/founder.json" }
    assert:
      - type: javascript
        value: output.split("\n").filter(Boolean).length >= 3   # ≥3 bubbles, no intern-split collapse
      - type: llm-rubric
        value: "Line 1 leads with a founder / honor / quantified-impact signal, NOT a restated job title. Weaves ≥3 distinct profile signals. No fabricated numbers."
  - description: "greeting must get a text reply (Hi→tapback regression)"
    provider: file://providers/agent-provider.mjs
    vars: { fixtureFile: "file://agent-fixtures/greeting-text-reply.json" }
    assert:
      - type: javascript
        value: JSON.parse(output).bubbles.length > 0 && !JSON.parse(output).tapbackOnly
      - { type: latency, threshold: 100000 }        # mirror RUN_TIMEOUT_MS (agent.ts:180)
      - { type: cost, threshold: 0.05 }
```

**Gate strategy (preserves keyless-graceful-skip + BLOCKING):** do NOT replace `real-seam-gate.mjs` in `firebase.json` with `promptfoo eval`. `real-seam-gate.mjs` STAYS the BLOCKING gate (owns keyless-skip `:114-123`, cost-ceiling `:109`, wall-clock `:110`, require-key `:116`). promptfoo runs in **PR CI** (`promptfoo/promptfoo-action@v1`, `~/.cache/promptfoo` caching) over the full corpus incl. `llm-rubric`, posts to the PR, never blocks deploy; and **online** (Step II-5), results `promptfoo import`-ed to unify offline+online. *Files:* `apps/eval/promptfoo/promptfooconfig.yaml` + `providers/{extractor,pitch,agent}-provider.mjs`, `.github/workflows/promptfoo-eval.yml`, `apps/eval/package.json` devDep (scoped to `apps/eval` ONLY). *Effort:* M (2-3 days).

**Step II-5 — Online conversation eval (extend the weekly QA loop).** New scheduled CF `paConversationQaDaily` (DE-2): samples recent real Claire transcripts from `pa-messages` (`collections.ts:8`) stratified across onboarding/pitch/prescreen/find_match; runs the **validated** binary judge (II-6); aggregates per-check failure rates; alerts via the SAME Slack/Mailgun plumbing the weekly CF has, same data-thinness guard; emits `promptfoo import`-able JSON. *Files:* new `apps/functions/src/conversation-qa-daily.ts` (mirror `qa-evaluator-weekly.ts`), export in `index.ts`, refactor `judgeConversation` out of `claire-binary-judge.mjs` into an importable lib. *Benefit:* turns online eval from "dark / match-only" into a live conversation-experience monitor — catches the drift Adam keeps hitting. *Tradeoff:* daily judge spend (mitigated by `gpt-4.1-mini` + sampling cap); MUST follow II-6. *Effort:* M (2-3 days).

**Step II-6 — Validate the binary judge vs ~50 hand-labeled real conversations.** Pull ~50 real `pa-messages` conversations stratified across the 5 checks + good/bad outcomes; **human-label** each (DE-3) → gold set `apps/eval/conversation-experience/judge-gold/*.json`; new `scripts/validate-judge.mjs` computes per-check **TPR (recall)** + **TNR (specificity)** + judge↔human **Cohen's κ**; **lock** the evidence-anchored anti-reward-hack rubric (`claire-binary-judge.mjs:85-98,148-152`), bump `RUBRIC_VERSION` (`:78`) on any edit and re-validate (the reward-hacking guard — a rubric edit that raises pass rates but lowers agreement is caught); define a **trust gate** — the judge may gate (II-3) / alert online (II-5) only at per-check TPR ≥ 0.9 AND TNR ≥ 0.9, else advisory-only. *Files:* new `judge-gold/`, `validate-judge.mjs`, refactor `claire-binary-judge.mjs` to export `judgeConversation`. *Benefit:* the judge gets a number, not a vibe; unblocks II-3 and II-5. *Effort:* M (2 days eng + the labeling session).

**Step II-7 — Remove the FALSE GREEN from the blocking chain.** `runner.mjs` (`firebase.json:23`) is branded a FALSE GREEN by its own docstring and `real-seam-gate.mjs:7-17` — pre-declares the extractor patch and asserts it, structurally incapable of catching the regression class it nominally covers, yet runs every deploy emitting a meaningless green. Remove from the predeploy chain (keep the file as documented anti-pattern). **Do AFTER II-3** so real pitch/agent coverage is in place first. *Files:* edit `firebase.json` (delete the `runner.mjs` line `:23`), note in README. *Benefit:* deploy signal becomes honest. *Effort:* S (½ hour).

### 4.3 Coverage matrix (call sites × failure modes, after the plan)

| Surface / call site | Anchor | Failure mode | Today | After plan | Step |
|---|---|---|---|---|---|
| Chat→tag extractor | `conversation-extractor-runtime.ts:78-84`, `conversation-extractor.ts:527` | schema-mismatch silent patch-drop (parse_error) | real-seam BLOCKING (2 stale fixtures) | BLOCKING (widened, mined) + Q-1 strict-schema | II-1,2 + Q-1 |
| Pitch composer | `compose-pitch.ts:195-237` | founder-miss, intern-split, <3 signals, fabricated numbers, fail-open invisible | manual `thin-claire` only | pitch driver BLOCKING + llm-rubric | II-3,4 |
| Agent turn / trajectory | `agent.ts:180,839-841,879` | Hi→tapback, offer-before-job, wall-of-questions, goal-not-met, timeout-fallback | manual canary scripts only | agent driver advisory/online + binary judge | II-3,5,6 |
| Conversation safety | `agent.ts:866-872` | PII-before-consent, admin-domain leak, skipped-interview, injection | runtime tripwire + manual `eval-guardrail.mjs` | binary-judge online (validated) + agent fixtures | II-5,6 |
| Delivery (Sendblue media) | `sendblue/outbox.ts` | rec-card image never reaches iMessage | none | delivery fixture (agent driver → payload assert) | II-2,3 |
| Match quality | `qa-evaluator-weekly.ts:6,93-95` | bad recs / hard-filter recall | weekly online (Qwen-7B), data-starved | unchanged (already covered) | — |
| Conversation experience online | `pa-messages` `collections.ts:8` | live drift on real traffic | DARK | `paConversationQaDaily` (validated judge) | II-5,6 |
| Process integrity (FSM/reducer/idempotency) | `process-intact-runner.mjs`, 6 fixtures | state-machine regressions | deterministic HARD gate ✅ | unchanged (keep — strongest) | — |
| Embeddings / rerank / sponsorship | `embeddings.ts:170`, `llm-rerank.ts:174`, `sponsorship-inference.ts:297` | fail-open-to-null invisible degradation | none | **GAP — out of scope this overhaul** (flag) | — |

**Remaining gaps after the plan (flagged, not in scope):** embedding/rerank/sponsorship/reverse-match LLM sites fail-open to null with no eval signal — silent degradation invisible (R-1 & Q-3 add *resilience*; an *eval* of their output quality is a future slice). Safety/injection has a runtime tripwire + manual `eval-guardrail.mjs` but no BLOCKING gate — promote to blocking only after the judge clears the II-6 trust gate on injection cases.

### 4.4 Definition of done

- Blocking predeploy gate covers extractor + pitch + cheapest agent trajectory with REAL model calls; keyless-graceful-skip preserved; require-key enforced on the deploy box.
- Every gate-RED / live failure / MEMORY incident has a one-command path to a frozen N-1 fixture; the 5 seed fixtures exist.
- The binary judge has a TPR/TNR/κ number vs 50 hand-labeled real convos and only gates/alerts above the trust threshold.
- A daily CF judges real Claire transcripts and alerts on conversation-experience regressions.
- The FALSE GREEN is gone from the blocking chain.
- promptfoo (if adopted) wraps the real seams as providers and posts eval deltas to PRs — without becoming load-bearing for the deploy gate.

---

## 5. Tests / lightweight validation scripts per affected path

| Change | Validation (drive the real seam, prove RED→GREEN where a bug is fixed) |
|---|---|
| Q-1 strict extractor | `real-seam-gate.mjs` over `salary-memory-entity-parse-error.json` + a new scalar-vs-array stress fixture; prove RED on `json_object`, GREEN on `json_schema`. |
| Q-3 JD-rel OpenAI strict | schema test asserting strict rejects an out-of-shape weights object the fence-stripper would have passed. |
| L-1 / R-3 timeouts+retries | per-site unit test: injected client delays beyond timeout → assert the existing fail-open fires within budget; injected client rejects-twice-then-resolves → assert success (retry). |
| L-2 JD-rel Sonnet timeout | injected Sonnet client delays > timeout → assert fallthrough to gpt-5.4-nano tier. |
| R-1 embedding resilience | `embeddings.ts` `deps.client` seam (`:200-202`): reject-twice-then-resolve → vector returned; never-resolve → null within budget. |
| R-2 key fallbacks | set only `OPENAI_API_KEY` → assert skip (fail-open); set `PA_OPENAI_AGENT_API_KEY` → used with correct `baseURL`. |
| R-4 CV-parse router | cv-ingest integration test: primary-tier throw now falls through instead of surfacing a parse failure. |
| R-5 retry classifier | feed `{status:409}` → `isRetryable` true, backoff runs. |
| R-6 key topology | per-service key resolution defaults to shared key when unset. |
| C-1 embedding dedup/batch | same `summaryText` twice → second call asserts zero `embeddings.create`; backfill: N inputs → one array call, N vectors in order. |
| C-2 pitch cost | assert a cost-ledger row written per pitch composition. |
| Eval overhaul (Section 4) | `validate-judge.mjs` TPR/TNR/κ over the gold set IS the test; pitch/agent fixtures self-test; II-1 tiering verified by a deliberately-`advisory` fixture not blocking the exit code. |

**General discipline:** all extractor/CV/pitch/agent changes verified by driving the production wrapper (`maybeRunExtractor`, cv-ingest, `composePitchTurn`, `runClaireTurn`), not a stand-in. Flag-gated changes seed a real flag doc and prove RED→GREEN (avoid the db-less makeStore false-green class, MEMORY `flag_gated_tests_false_green`). Ship behind the existing predeploy gate (`firebase.json:18-30`).

---

## 6. Follow-ups needing PRODUCT or INFRA decisions before implementation

1. **R-4 flag-default flip** (`paResumeParserV2` → ON for all, or point its OFF branch at `callWithFallback`). Changes which CV-parse implementation flag-OFF users get. D11 wants one implementation; recommend the flip, but it's a product call.
2. **R-6 key topology** — splitting the single shared OpenAI key into per-service restricted keys is a prod-secret change only Adam can execute. The incident doc already specifies the design (§4-§5).
3. **C-1 Batch API for backfill** — async (minutes-later) results; fine for backfill, never for sync ingest. Confirm the backfill paths are non-time-sensitive.
4. **DE-1 promptfoo as a dependency** — scoped to `apps/eval` only to protect the zod v3/v4 split (`sdk.ts:1-89`). promptfoo stays additive; the blocking gate stays a Node script.
5. **DE-2 online eval location** — new `paConversationQaDaily` CF vs folding into `paQaEvaluatorWeekly`.
6. **DE-3 labeling labor** — ~50 hand-labeled conversations (~3-4h human) for judge validation; unavoidable.
7. **DE-4 / DE-5 eval spend + grader model** — `--max-model-calls` ceiling, blocking-vs-PR-CI split, `gpt-4.1-mini` grader budget.
8. **PII in traces** — agent tracing is on with `traceIncludeSensitiveData:false` (`agent.ts:811`); online conversation eval (II-5) samples real `pa-messages` — confirm the judge/eval pipeline redacts PII in any persisted artifact (the flywheel materializer already writes *redacted* artifacts, `flywheel-candidate-correction.ts:150-161` — reuse that redaction).

### Explicitly NOT recommended (recorded so a future agent doesn't add reflexively)

- **No model swaps on hot paths** — nano extraction, mini pitch, `text-embedding-3-small` are already current-recommended. `text-embedding-3-large` (3072d, $0.13/M) is 6.5× the cost for marginal recall — not worth it at our volume.
- **No streaming** for the structured/JSON-schema calls — they need the full parsed object; `stream:true` complicates strict-schema extraction (`openai-responses.ts:91-108`) and gives no perceived-latency benefit (Sendblue sends whole bubbles).
- **No `@openai/agents` SDK bump** unless tool-search is specifically wanted — the repo has a hard-won zod v3/v4 split + Cloud-Run boot fix keyed to `^0.8.5` (`sdk.ts:1-89`, MEMORY `zod_v3_v4_split_fix`, `functions_undeployable_sdk_agent_runtime`). A bump risks the zod graph and cold-start boot; gate behind full predeploy + live canary.
- **No new regex text→enum classifiers** anywhere (absolute repo rule). All structured-output proposals keep "LLM picks enum, code validates membership."

---

## 7. Appendix — doc source URLs cited

- Models / pricing: https://developers.openai.com/api/docs/models · https://developers.openai.com/api/docs/models/gpt-5-nano · https://developers.openai.com/api/docs/pricing
- Structured outputs (json_schema strict): https://developers.openai.com/api/docs/guides/structured-outputs
- Responses vs chat.completions: https://developers.openai.com/api/docs/guides/responses-vs-chat-completions
- Prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- Built-in tools (web search, file search, tool search): https://developers.openai.com/api/docs/guides/tools · https://developers.openai.com/api/docs/changelog
- Reliability (retries, timeouts, request IDs): https://github.com/openai/openai-node
- Rate limits / backoff: https://developers.openai.com/api/docs/guides/rate-limits
- Streaming: https://developers.openai.com/api/docs/guides/streaming-responses
- OpenAI Evals → promptfoo migration: https://developers.openai.com/cookbook/examples/evaluation/moving-from-openai-evals-to-promptfoo
- promptfoo: https://www.promptfoo.dev/docs/configuration/reference · https://www.promptfoo.dev/docs/configuration/expected-outputs · https://www.promptfoo.dev/docs/configuration/test-cases · https://www.promptfoo.dev/docs/configuration/datasets · https://www.promptfoo.dev/docs/integrations/github-action
- `@openai/agents` releases: https://github.com/openai/openai-agents-js/releases · https://www.npmjs.com/package/@openai/agents-core

---

## Recommended first slice

Ship **Wave 1 as one PR**: the flagship **Q-1** (extractor → `json_schema` strict, mirroring the resume parser's proven `providers/openai-responses.ts:91-98` pattern) together with the near-one-line resilience trio — **L-1 + R-3** (explicit `timeout`/`maxRetries` on the pitch, embedding, and CV-ingest raw clients), **R-1** (embedding retry+timeout), and **R-2** (delete the two poisoned `OPENAI_API_KEY` fallbacks). These are tightly related (all about the OpenAI client/structured-output seam), all behavior-compatible-by-default, carry no schema-design blocker except Q-1's tagPatch schema (a bounded half-day), and directly close the two failure classes that bit us this session — silent `parse_error` tag-loss and unbounded raw-client hangs. Verify Q-1 by driving the **real** `maybeRunExtractor` seam to prove RED on `json_object` → GREEN on `json_schema`, then start the Section 4 eval overhaul (II-1 corpus tiering + II-6 judge labeling in parallel) so the pitch/agent regression net lands before the next live-drift surprise.
