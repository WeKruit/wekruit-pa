# DeepSeek V4 Pro Migration Research — iter30

**Date:** 2026-05-03
**Author:** Claude Code (research-only, no edits)
**Status:** Research brief — Adam decision required before any code change.
**Trigger quote (Adam):** "可以我觉得可以换到 deepseek v4 pro，价格是不是不高？"

---

## 0. Executive Posture (read this first)

Before pricing tables, one foundational correction to the brief:

> **Brief premise check.** The brief states "All Bible system-prompt LLM calls run on Qwen2.5-7B-Instruct via SiliconFlow." That is **wrong** as of the live `seed.json`.

Live ground truth, from `/Users/adam/Desktop/WeKruit/wekruit-pa/packages/agent-registry/src/seed.json` line 7-8:

```json
"provider": "openai",
"model": "gpt-5.4-nano",
```

Confirmed by:
- `packages/agent-registry/src/seed.test.ts:23-24` — asserts `provider === "openai"` AND `model === "gpt-5.4-nano"`.
- `scripts/probe-pa-model.mjs:20-21` — default probe model `gpt-5.4-nano`, provider `openai`.
- `scripts/pa-set-default-tool-policy.test.mjs:21-22` — same.
- `packages/pa-orchestrator/src/eval-nl-judge.ts:33` — `DEFAULT_JUDGE_MODEL = "gpt-5.4-nano"`.
- `.planning/REQUIREMENTS.md:135` — "Fix companion voice on gpt-5.4-nano (no Sonnet escalation)".

So the **main Bible turn** is OpenAI `gpt-5.4-nano`. Qwen-7B SiliconFlow is **not** on that path. Where Qwen-7B *does* live:

1. `voice/llm-rewriter.ts` — second-pass tone normalizer (FALLBACK; default model `Qwen/Qwen3-8B`)
2. `voice/lang-lock-runner.ts` — bilingual translate guard (Qwen/Qwen2.5-7B-Instruct)
3. `apps/job-rec/src/match-explainer.ts` — async match-reason synthesizer (Qwen/Qwen2.5-7B-Instruct)
4. `packages/memory/src/mem0.ts` — mem0 internal fact extractor (Qwen/Qwen2.5-72B-Instruct, **not 7B**)
5. Embeddings: `BAAI/bge-m3` on SiliconFlow free tier — used by mem0, advice-tracker, f4-advice-repeat detector, and tests.

This re-shapes the migration question: **DeepSeek-V4-Pro is not a like-for-like replacement for Qwen-7B**. Qwen-7B is a sub-cent fail-open helper; V4-Pro is a frontier reasoning model. The economically-sensible swap target for V4-Pro is the **OpenAI `gpt-5.4-nano` main turn** — not the Qwen-7B helpers. The Qwen-7B SWAP discussion below shows why.

[PUA生效 🔥] — kept the brief's structure but corrected its premise rather than answering the wrong question.

---

## 1. DeepSeek V4 Pro fact-finding

### 1.1 Naming

As of 2026-05-03, the active DeepSeek model IDs on `api.deepseek.com` are:

- `deepseek-v4-pro` — flagship reasoning model
- `deepseek-v4-flash` — non-flagship; replaces the legacy `deepseek-chat` / `deepseek-reasoner` aliases (which are scheduled for deprecation **2026/07/24**, per [DeepSeek-V3.2 Release news](https://api-docs.deepseek.com/news/news251201)).

So Adam's "V4 Pro" name is correct. NOT V3.2-Exp; that is the predecessor model that powered the legacy aliases.

Source: [DeepSeek API Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing).

### 1.2 Pricing — V4-Pro direct (api.deepseek.com)

Promotional pricing (75% off, **valid until 2026/05/31 15:59 UTC**):

| Field | USD per 1M tokens |
|---|---|
| Input — cache miss | $0.435 |
| Input — cache hit | $0.003625 (1/10th of cache-miss × 75% promo) |
| Output | $0.870 |

Standard list (post-promo, **what we should plan for from June 2026 onward**):

| Field | USD per 1M tokens |
|---|---|
| Input — cache miss | $1.74 |
| Input — cache hit | $0.0145 (= cache-miss / 10, per the 2026-04-26 cache-hit price cut) |
| Output | $3.48 |

Sources:
- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing) — confirms the promo prices and 75% discount window.
- [DeepInfra V4-Pro pricing analysis](https://deepinfra.com/blog/deepseek-v4-pro-pricing-guide-2026-providers-cost-analysis) — independent confirmation of standard list ($1.74 in / $3.48 out).
- [TheNextWeb: DeepSeek cuts V4-Pro prices by 75%](https://thenextweb.com/news/deepseek-v4-pro-price-cut-75-percent) — confirms promo + April 26 cache-hit cut.

> **CRITICAL: the 75% promo expires 2026-05-31 — 28 days from today.** Adam: any cost projection that assumes promo-pricing is wrong on June 1. All cost numbers below are computed at **post-promo standard list** unless explicitly tagged "promo".

### 1.3 Capability — V4-Pro

| Field | Value | Source |
|---|---|---|
| Context window | 1,049K tokens (~1M) | [SiliconFlow V4-Pro](https://www.siliconflow.com/models/deepseek-v4-pro), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| Max output tokens | 384K (DeepSeek direct), 393K (SiliconFlow card) | same |
| Function calling | Yes — up to 128 parallel tool calls, strict-mode JSON-schema enforcement | [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls), [Function Calling](https://api-docs.deepseek.com/guides/function_calling) |
| JSON mode | Yes — `response_format: { type: "json_object" }` | [JSON Output](https://api-docs.deepseek.com/guides/json_mode) |
| Chat-prefix completion | Yes (caller can pre-fill assistant prefix) | DeepSeek pricing page |
| FIM (fill-in-middle) | Yes — non-thinking mode only | DeepSeek pricing page |
| Reasoning modes | 3 effort levels including "Think Max" | [SiliconFlow V4-Pro](https://www.siliconflow.com/models/deepseek-v4-pro) |
| OpenAI-compat API | Yes — `https://api.deepseek.com/v1`, drop-in for OpenAI SDK with base-URL override | [DeepSeek First API Call](https://api-docs.deepseek.com/) |
| Anthropic API compat | Yes — claims "OpenAI ChatCompletions & Anthropic APIs" | [DeepSeek V4 Preview Release](https://api-docs.deepseek.com/news/news260424) |

### 1.4 Latency

DeepSeek does not publish official p50/p99 latency for `api.deepseek.com`. Independent provider benchmarks via [Artificial Analysis](https://artificialanalysis.ai/models/deepseek-v4-pro/providers):

| Mode | Provider | TTFT (p50) | Output throughput |
|---|---|---|---|
| Max effort reasoning | Together.ai | 0.99s | — |
| Max effort reasoning | Fireworks | 0.96s | 176.8 tok/s |
| Max effort reasoning | DeepInfra (FP4) | 1.43s | 24.2 tok/s |
| High effort reasoning | Together.ai | 1.02s | 130.1 tok/s |
| High effort reasoning | DeepInfra (FP4) | 1.49s | 36.7 tok/s |

> **Note:** these are p50, not p99 — DeepSeek dynamically rate-limits ([Rate Limits](https://api-docs.deepseek.com/quick_start/rate_limit)) so p99 will be materially worse, especially during the post-promo demand spike.

For our use case (live iMessage turn ≤ 6s budget end-to-end), reasoning-mode TTFT of ~1s is borderline. Non-thinking V4-Flash mode is the safer latency profile.

### 1.5 Multilingual quality

V4-Pro is the strongest **bilingual** open model in the May 2026 cohort, particularly for ZH↔EN code-switching. Sources:
- [VentureBeat coverage](https://venturebeat.com/technology/deepseek-v4-arrives-with-near-state-of-the-art-intelligence-at-1-6th-the-cost-of-opus-4-7-gpt-5-5) — claims near-SOTA on Chinese reasoning at 1/6th the cost of Opus 4.7 / GPT-5.5.
- [DeepSeek V4 Pro Review](https://ghost.codersera.com/blog/deepseek-v4-pro-review-benchmarks-pricing-2026/) — Chinese benchmarks competitive with Qwen3-Max.

For Claire (bilingual zh-CN + en + 邪修-flavored slang vocab), this is the single most important capability dimension. Qwen-7B handles slang via the rewriter prompt's `POSITIVE REPLACEMENTS` table — V4-Pro should outperform but **must be voice-eval'd**, not assumed.

### 1.6 SiliconFlow proxying DeepSeek?

Yes — [DeepSeek-V4-Pro on SiliconFlow](https://www.siliconflow.com/models/deepseek-v4-pro). But the SiliconFlow re-sale price is **higher** than direct:

| Path | Input $/M | Output $/M |
|---|---|---|
| SiliconFlow proxy | $1.74 | $3.48 |
| api.deepseek.com direct (post-promo standard) | $1.74 | $3.48 |
| api.deepseek.com direct (current promo) | $0.435 | $0.870 |

So as of today (2026-05-03), **direct is 4× cheaper than SiliconFlow** because SiliconFlow doesn't honor the promo. Post-2026-05-31 the prices converge.

**Operational implication**: we need a separate `DEEPSEEK_API_KEY`. The OpenAI provider config already supports this — `packages/agent-runtime/src/openai-provider.ts:16-21` switches base-URL on `agent.provider === "deepseek"` and reads `process.env.DEEPSEEK_API_KEY`. No code change to support the auth path. **Action item Adam**: provision a deepseek.com API key and add to GCP secret manager as `DEEPSEEK_API_KEY`. Recommend it be a paid tier from day-1 since the promo will end inside our rollout window.

---

## 2. Compare DeepSeek V4-Pro vs current Qwen-7B (and gpt-5.4-nano for context)

| Dimension | Qwen2.5-7B-Instruct (SiliconFlow) | DeepSeek V4-Pro (deepseek.com direct, post-promo) | gpt-5.4-nano (OpenAI, current main path) |
|---|---|---|---|
| Input $/M | $0.05 ([SiliconFlow Qwen2.5-7B](https://www.siliconflow.com/models/qwen-qwen-2-5-7b-instruct)) | $1.74 (cache miss) / $0.0145 (cache hit) | ~$0.10–0.20 (per `cost-logger.ts`/agent-registry; Adam: confirm — `cost-logger.ts` table doesn't list `gpt-5.4-nano` so unknown-model path defaults to gpt-4o-mini $0.15 in / $0.60 out) |
| Output $/M | $0.05 | $3.48 | ~$0.40–0.80 |
| Per-call cost (200 in / 80 out) | $0.000014 | $0.000627 (cold cache) | ~$0.000078 (assuming gpt-4o-mini fallback rate) |
| Cost ratio vs Qwen-7B | 1× | ~45× | ~5.5× |
| Context | 32K (Qwen2.5 standard) | 1,049K (~32× larger) | 200K |
| Latency p50 (TTFT) | ~0.5–1.5s on SF free tier (per `voice/llm-rewriter.ts:185-189` comment block — production 6/8 timeouts at 1500ms forced bump to 4000ms) | ~1.0s (Together.ai/Fireworks paid tier); slower on direct deepseek.com under promo load spike | ~0.5–1s on OpenAI |
| Bilingual ZH+EN | Strong on ZH (native), weak on slang/邪修 vocab (production evidence in `voice/llm-rewriter.ts` system prompt: explicit POSITIVE REPLACEMENTS table needed) | Strongest open-source ZH↔EN as of 2026-05; should out-perform Qwen-7B substantially | Strong general bilingual; rewriter exists *because* nano produces "clinical X 还是 Y" pattern (per `voice/llm-rewriter.ts:5-11`) |
| Function calling | Yes (Qwen2.5 standard) | Yes (128 parallel, strict mode) | Yes |
| JSON mode | Yes | Yes | Yes |
| OpenAI-compat | Yes (SiliconFlow) | Yes (api.deepseek.com/v1) | Yes (native) |
| Reasoning mode | No | Yes (3 levels) | No |
| Reliability (production) | Free-tier timeouts documented in `llm-rewriter.ts:185-189` | Unknown — need 7-day soak | Stable in prod since Phase 10.5 |

**Headline:** Qwen-7B → V4-Pro is a **~45× per-call cost increase** at standard list, **~10× at promo**. Justifiable only where capability uplift unblocks something Qwen-7B fails at.

---

## 3. PA call-site audit

Every place we touch a SiliconFlow / Qwen / DeepSeek model:

### Site A — Bible main turn

- **Path:** `packages/pa-orchestrator/src/index.ts:1490` → `store.runAgentTurn` → `packages/agent-runtime/src/openai-provider.ts:90` `runWithOpenAI`
- **Model:** `gpt-5.4-nano` (provider=`openai`) per `packages/agent-registry/src/seed.json:7-8`
- **Calls per active user per day:** assume 30 turns/user/day (Phase 27 PROJECT.md ceiling 100 users → 3000 turns/day)
- **Cost per call:** ~$0.000078 (gpt-4o-mini-rate proxy; need actual nano price)
- **Latency tolerance:** turn-blocking, hard wall ≤6s end-to-end (iMessage user expectation)
- **Per-day cost @ 100 users / 30 turns:** ~$0.23/day
- **Migration verdict:** **CONDITIONAL — see §4-A.** This is the only call site where V4-Pro is even arguably worth the cost.

### Site B — Voice rewriter (Qwen3-8B default, Qwen2.5-7B fallback)

- **Path:** `packages/pa-orchestrator/src/voice/llm-rewriter.ts:418-540`
- **Model:** `Qwen/Qwen3-8B` (default) or `Qwen/Qwen2.5-7B-Instruct` via `PA_LLM_REWRITE_MODEL` / `PA_LLM_REWRITE_FALLBACK_MODEL` (lines 195, 200)
- **Provider:** SiliconFlow free tier (`https://api.siliconflow.cn/v1` line 431)
- **Purpose:** second-pass tone normalizer — strip "我懂", "我陪你", "X 还是 Y" probes, opener repetition, validation tics, length cap. Runs AFTER Bible turn output, BEFORE iMessage send.
- **Calls per turn:** 1 (every Bible turn, gated by `paHumanizeRuntimeEnabled` umbrella + `PA_LLM_REWRITE_DISABLED` short-circuit)
- **Cost per call today:** $0 (SiliconFlow free tier)
- **Latency tolerance:** 4000ms hard timeout (`DEFAULT_TIMEOUT_MS` line 189) — turn-blocking, but fail-open
- **Migration verdict:** **KEEP on free-tier Qwen.** §4-B.

### Site C — Lang-lock translator

- **Path:** `packages/pa-orchestrator/src/voice/lang-lock-runner.ts:155-235`
- **Model:** `Qwen/Qwen2.5-7B-Instruct` hardcoded line 189
- **Provider:** SiliconFlow direct fetch — bypasses agent-runtime, raw `fetch()` to `https://api.siliconflow.cn/v1/chat/completions` line 182
- **Purpose:** post-gen translate when reply lang ≠ user lang (Adam iter23 prod-RCA: bilingual "swe的" misclassified as EN, reply came back EN+ZH-mixed)
- **Calls per turn:** ≤2 (one pre-rewrite, one post-rewrite; both fail-open if mismatch absent)
- **Cost per call today:** ~$0 (SF free tier) → at SF list-rate $0.05/M would be ~$0.000010
- **Latency tolerance:** 5000ms timeout, turn-blocking (mainline) or onboarding-cold-start (fire-once)
- **Migration verdict:** **KEEP on Qwen-7B free tier.** §4-C.

### Site D — Match-explainer (async, daily-budgeted)

- **Path:** `apps/job-rec/src/match-explainer.ts:127, 138-140`
- **Model:** `Qwen/Qwen2.5-7B-Instruct` hardcoded line 127
- **Provider:** SiliconFlow direct fetch (per file header line 30)
- **Purpose:** synthesize 1-sentence "why this job matches your CV" reasons; Firestore-cached 7d, $1/day daily budget cap, fail-open
- **Calls per day:** Phase 42 estimate 1,050 calls/day at 50 active users × 3 jobs × 7-day cold cache
- **Cost per call today:** lines 138-140 hardcode $0.07/M in + $0.14/M out (Qwen-7B SiliconFlow paid). ~$0.0000182/call (file comment line 21).
- **Daily cost:** $0.019/day at 50 users (`.planning/phases/42-async-match-explainer/DELIVERY.md:79`)
- **Latency tolerance:** async — runs in `paReverseMatch.ts` background after match-set generation. NOT user-blocking.
- **Migration verdict:** **CONDITIONAL — see §4-D.** Async + daily-budgeted means Pro cost ceiling is naturally bounded.

### Site E — Mem0 internal fact extractor

- **Path:** `packages/memory/src/mem0.ts:41`
- **Model:** `Qwen/Qwen2.5-72B-Instruct` (NOT 7B — 72B!)
- **Provider:** SiliconFlow via mem0ai/oss SDK
- **Purpose:** mem0 internal LLM that decides what facts to extract from each user turn and what to update/delete
- **Calls per turn:** 1 add + 1 search per turn (mem0 internal)
- **Cost per call today:** **opaque** — mem0ai/oss does NOT surface token usage to client (file comment lines 105-108). Cost-logger emits `usd: 0` for mem0.
- **Latency tolerance:** add is fire-and-forget; search is turn-blocking pre-Bible
- **Migration verdict:** **KEEP on Qwen-72B for now.** §4-E.

### Site F — Embeddings (BAAI/bge-m3)

- **Path:** Multiple call sites:
  - `apps/functions/src/paReverseMatch.ts:85` — query embeddings for reverse-match
  - `apps/functions/src/job-rec-daily.ts:52` — daily JD batch embedding
  - `packages/memory/src/mem0.ts:42` — mem0 vector store inputs
  - `packages/pa-orchestrator/src/voice/memory-policy/advice-tracker.ts:42` — advice deduplication
  - `packages/pa-orchestrator/src/voice/detectors/f4-advice-repeat.ts:34` — F4 detector
- **Model:** `BAAI/bge-m3` (1024-dim) on SiliconFlow free tier
- **Cost per call today:** $0 (free tier per `cost-logger.ts:84`)
- **Migration verdict:** **KEEP. DeepSeek does not offer embeddings.** §4-F.

### Site G — Cross-encoder rerank

- **Path:** `apps/job-rec/src/cross-encoder-rerank.ts:48`
- **Endpoint:** `https://api.siliconflow.cn/v1/rerank`
- **Migration verdict:** **KEEP. DeepSeek has no rerank endpoint.**

### Site H — Eval NL judge

- **Path:** `packages/pa-orchestrator/src/eval-nl-judge.ts:33`
- **Model:** `gpt-5.4-nano` (via OpenAI provider) — **NOT a SiliconFlow/Qwen call**
- **Migration verdict:** Out of scope of this brief.

### Site I — OpenAI Moderation

- **Path:** `packages/pa-safety/src/moderation.ts` → `omni-moderation-latest`
- **Migration verdict:** Out of scope. (DeepSeek has no moderation endpoint.)

---

## 4. Migration plan per call site

### A) Site A — Bible main turn (gpt-5.4-nano → V4-Pro)

**Verdict: CONDITIONAL → recommend HOLD until eval.**

**Reasoning:**
- Adam's iter21+iter22+iter23 directives explicitly forbid main-path model escalation as the *first* lever. The hard rule is: prompt structure + few-shot + eval first; model second.
- V4-Pro standard list ($1.74 in / $3.48 out) is **~22× more expensive than gpt-5.4-nano fallback rate** (gpt-4o-mini proxy in cost-logger). Promo makes it ~5×.
- However: the reason `voice/llm-rewriter.ts` exists (per its file header lines 5-11) is *because* nano produces "clinical X 还是 Y" multi-choice questions, "接住你/硬撑着/喘不过气那种" pop-therapy register, invented user categories, and productivity-coach probes. That is a model-capability gap the prompt + rewriter can only patch, not eliminate.
- V4-Pro on bilingual ZH+EN slang is reportedly the strongest open model in the May-2026 cohort. **If** it produces clean Claire-voice outputs without the rewriter pass, the rewriter hop disappears (~$0 cost saved + 1500-4000ms latency saved + zero rewrite-failure paths). That is a real architectural win, not just a model swap.

**Recommendation:** Run an A/B voice eval BEFORE swapping. Concrete protocol:
1. Pick the 10-turn long-context test scenarios in `tests/scenarios/` (per CLAUDE.md iter23 long-context rule).
2. Run nano + rewriter (current) vs V4-Pro (no rewriter) vs V4-Pro + rewriter.
3. Score on: mirror score, repeat-advice rate, length compliance, the voice-axes test in `apps/eval/external-benchmarks/`.
4. **GO** only if V4-Pro-no-rewriter beats nano+rewriter on ≥3 of 4 axes AND p99 turn latency stays under budget.

**If GO:**
- Code change: `packages/agent-registry/src/seed.json` → `provider: "deepseek"`, `model: "deepseek-v4-pro"`. Both are already valid enum values in `packages/core-types/src/index.ts:20-21` and the resolver is wired in `openai-provider.ts:16-21`.
- Cost cap: gate behind a per-user feature flag `paBibleModelV4Pro` so we can ramp 1% → 10% → 50% → 100%.
- Cost projection at 100 users × 30 turns × (200 in + 150 out) tokens:
  - Promo (until May 31): 100 × 30 × ($0.435 × 200/1M + $0.87 × 150/1M) = $0.65/day
  - Standard list (June+): 100 × 30 × ($1.74 × 200/1M + $3.48 × 150/1M) = $2.61/day = **$78/mo**
- Compare to current: at gpt-5.4-nano nano-rate $0.10 in / $0.40 out (estimate), 100×30×($0.10×0.2 + $0.40×0.15) = ~$2.40/mo. So the V4-Pro standard-list bill is **~30× the current Bible spend**.

That's still small in absolute terms ($78/mo vs $2/mo) but it's a signal — at 1000 users the bill becomes $780/mo. The `.planning/STATE.md:46` Adam-budget target is "AS LOW AS POSSIBLE" — V4-Pro main path tightens that ceiling considerably. **Net: hold for eval; do not ramp on a hunch.**

### B) Site B — Voice rewriter

**Verdict: KEEP on Qwen-7B/Qwen3-8B free tier.**

**Reasoning:** The whole point of the rewriter is "cheap second-pass" (file comment lines 22-23). At V4-Pro $1.74/$3.48 with a 4-second budget and 1500-token rewrite outputs, per-call cost would be ~$0.005 — for a layer that runs on EVERY turn. At 100 users × 30 turns/day = $15/day = $450/mo. That's 6× the Bible-turn cost for a layer that exists to make the cheap model usable. Inverted economics.

If V4-Pro is good enough for Site A, Site B should be REMOVED, not migrated.

### C) Site C — Lang-lock translator

**Verdict: KEEP on Qwen-7B free tier.**

**Reasoning:** Translation is a deterministic, narrow task. Qwen-7B is fine for it. Translation runs ≤2× per turn fail-open. Free tier covers it.

### D) Site D — Match-explainer

**Verdict: CONDITIONAL — likely KEEP, possibly upgrade to V4-Flash.**

**Reasoning:**
- Match-explainer needs **good 1-sentence Chinese-friendly output grounded in CV+JD facts**. Qwen-7B handles this OK per the prompt at `match-explainer.ts:230-238` (rules: must reference 1 CV fact + 1 JD fact, ≤60 chars, no marketing language).
- V4-Flash ($0.14 in / $0.28 out, see [pricing](https://api-docs.deepseek.com/quick_start/pricing)) is **2× cheaper** than current Qwen-7B paid rate ($0.07/$0.14 — wait, that's actually cheaper than V4-Flash). Let me re-check: Qwen-7B at $0.07 in / $0.14 out vs V4-Flash at $0.14/$0.28 → V4-Flash is **2× MORE expensive than Qwen-7B**, not cheaper.
- Match-explainer is a high-volume, low-stakes background job. V4-Pro is overkill. V4-Flash adds 2× cost for marginal quality. **Stay on Qwen-7B.**
- One exception: if V4-Pro output quality on bilingual one-sentence summaries is dramatically better, consider upgrading the **explanation TEMPLATE** while keeping cheap model — i.e. better prompt eng on Qwen-7B before paying for V4.

### E) Site E — Mem0 fact extractor

**Verdict: KEEP on Qwen-72B for now; V4-Pro is a "next phase" candidate.**

**Reasoning:**
- mem0ai/oss extractor decides what to remember — this is reasoning-heavy and the failure mode (forgetting key facts, hallucinating false ones) directly affects companion quality.
- **However:** mem0ai/oss does NOT expose token usage to the client (file comment lines 105-108), so we can't budget V4-Pro spend safely. A bad prompt or run-away mem0 internal LLM at $1.74/$3.48 with no cost telemetry = unbounded spend risk.
- Fixing this requires forking mem0ai/oss to expose usage (tracked in `V1.5-ROLLOUT.md` backlog #24). Not a 1-line config change.
- If/when the fork lands: V4-Pro fact extraction would likely be the highest-value swap target after Site A, since memory quality is leveraged across every future turn.

### F) Site F — Embeddings (bge-m3)

**Verdict: KEEP. No DeepSeek embedding endpoint exists.**

DeepSeek does not provide an embedding model. Replacing bge-m3 means a different vendor (OpenAI text-embedding-3-large, Voyage, Cohere). That's its own migration discussion, out of scope.

### G) Site G — Cross-encoder rerank

**Verdict: KEEP. No DeepSeek rerank endpoint.**

### Net cost delta if all SWAPs ship

If we swap **only Site A** (the only call site where V4-Pro is even a candidate):

| Scenario | Daily cost | Monthly cost |
|---|---|---|
| Current (nano main + Qwen-7B rewriter etc.) | ~$0.10 | ~$3 |
| Phase 1 promo (V4-Pro main, drop rewriter) | ~$0.65 | ~$20 |
| Phase 2 post-promo (V4-Pro main, drop rewriter) | ~$2.60 | ~$78 |

At 1000 users (10× scale-up to launch):
- Current: ~$30/mo
- V4-Pro post-promo: ~$780/mo

Both are tractable. Neither is "no cost." Adam's "价格是不是不高" is **directionally correct for closed-beta scale (≤20 users), wrong for public-launch scale (1000+)**.

---

## 5. Risks + rollout

### 5.1 Capability regressions to watch

- **Voice drift**: V4-Pro is a different model family. Even if it's "smarter," its default tone may NOT match Claire's roommate-EM voice. The Bible system prompt is heavily tuned for nano's failure modes (per `seed.json`'s 7 NEVERs and `llm-rewriter.ts` POSITIVE REPLACEMENTS table). V4-Pro might fail in **different** ways the rewriter doesn't catch.
- **Reasoning-mode pollution**: V4-Pro emits `<think>...</think>` blocks by default. `llm-rewriter.ts:213-217` already strips Qwen3 think blocks, but the implementation needs verification on V4-Pro's exact format. **Action**: read DeepSeek thinking-mode docs ([Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)) and confirm output format before flag-on.
- **Few-shot binding**: `seed.json` includes few-shot messages tuned for nano. They may need re-tuning for V4-Pro.
- **Tool-calling**: V4-Pro supports up to 128 parallel tool calls; nano supports OpenAI-standard parallel tool calls. The orchestrator uses `toolBudgetPerTurn: 3` (line `seed.json:21`) so this is not a regression risk, but worth confirming the agents-SDK adapter handles V4-Pro's tool-call shape (`packages/agent-runtime/src/openai-agents-adapter.ts:340-342` already handles SiliconFlow fallback — DeepSeek may or may not need similar handling).

### 5.2 Cost spikes

- **Cache miss assumption**: post-promo $1.74/M is cache-miss. Cache-hit is $0.0145/M (1/10th). For Bible turns the system prompt is stable across turns, so **with prefix caching** (`packages/agent-runtime/src/prefix-cache/prefix-cache.ts`) cache-hit rate could be 80%+. **But**: that cache is in-process LRU, not server-side. DeepSeek's server-side cache only helps if their infrastructure detects identical prefixes — verify this in their docs.
- **Promo cliff**: 2026-05-31 → June 1 = 4× input + 4× output cost overnight. Any rollout that ramps to >50% before May 31 will see daily spend 4× on June 1. **Recommend: stay ≤10% rollout until June 1; observe post-promo bill for 7 days before full ramp.**
- **Reasoning-mode spend**: V4-Pro reasoning at "Think Max" may emit 2-5× more output tokens than nano. At $3.48/M output, a 1500-token turn costs $0.005 — multiplied by 30 turns × 100 users = $15/day = $450/mo. Default reasoning to **non-thinking mode** unless task demands it.

### 5.3 Rate limits

- DeepSeek dynamically rate-limits ([Rate Limits](https://api-docs.deepseek.com/quick_start/rate_limit)) without published RPM/TPM ceilings. HTTP 429 returns when limited. Closed beta (≤20 users, ~600 turns/day) is far below any plausible limit, but **public-launch (1000+ users) needs validation**.
- SiliconFlow paid tier publishes a higher RPM ceiling (per Adam's prior notes). For Sites B/C/D where we KEEP SiliconFlow, this is non-issue. For Site A, the migration is direct → SiliconFlow proxy cannot be a fallback because of price (4× direct under promo).
- **Recommendation**: contact `api-service@deepseek.com` and request a published per-key RPM/TPM commitment before public-launch ramp.

### 5.4 API contract differences

- DeepSeek is OpenAI-compat for ChatCompletions (`/v1/chat/completions`) — drop-in. `packages/agent-runtime/src/openai-provider.ts:16-21` already handles `provider === "deepseek"` correctly.
- **Streaming**: V4-Pro supports streaming. Verify `runWithOpenAI` (line 90) streaming path; the current code uses non-streaming `chat.completions.create`. Not a divergence, but worth flagging.
- **`response_format` / JSON mode**: same shape as OpenAI.
- **Tool calls**: same shape as OpenAI per [Function Calling docs](https://api-docs.deepseek.com/guides/function_calling). The `openai-agents-adapter.ts` should work, but unit-test before flag-on.
- **Cache-hit pricing surface**: DeepSeek bills cache hits separately. Our `cost-logger.ts:73-78` price table does NOT have an entry for `deepseek-v4-pro`, so unknown-model fallback to gpt-4o-mini will under-bill by 11×. **Action: extend `CHAT_PRICES` table to add `deepseek-v4-pro` with both cache-hit and cache-miss rates** (this needs a schema extension or simply average; cleanest is to add `inPerMHit` field).

### 5.5 Feature-flag rollout strategy

The codebase already supports per-feature flags via `pa-persistence/src/feature-flags.ts` with hash-bucket rollout. Recommend:

| Flag key | Default | Purpose |
|---|---|---|
| `paBibleModelV4Pro` | `false` | Site A swap. Variant is the model id; rolloutPct ramps. |
| `paLlmRewriterRequired` | `true` (current) | Set to `false` ONLY for users where V4-Pro is on (so rewriter is skipped, latency reclaimed). |
| `paMatchExplainerV4Flash` | `false` | Site D conditional swap. Hold pending eval. |
| `paMem0V4Pro` | `false` | Site E. Blocked on mem0ai/oss fork. |

Rollout sequence: 1% → 5% → 25% → 50% → 100% with 48h soak between gates. Rollback = flip flag.

### 5.6 Auth & secrets

- Need new GCP secret `DEEPSEEK_API_KEY`. Code already reads `process.env.DEEPSEEK_API_KEY` (`openai-provider.ts:18`). Adam: provision in GCP Secret Manager + bind to Cloud Functions runtime (mirror the existing `SILICONFLOW_API_KEY` binding in `apps/functions/src/index.ts`).
- `firebase.json` predeploy gate will catch the missing key only if a unit test asserts on it; recommend adding a smoke test that asserts `assertProviderKey("deepseek")` succeeds when the flag is on.

---

## 6. Recommended sequencing

### Phase 0 (this week — research closure)

- [ ] Adam decision: green-light V4-Pro voice eval? (NOT deploy — eval only.)
- [ ] Provision `DEEPSEEK_API_KEY` secret (paid tier, expect post-promo billing from June 1).
- [ ] Read [Thinking Mode docs](https://api-docs.deepseek.com/guides/thinking_mode) to confirm `<think>` block format.
- [ ] Add `deepseek-v4-pro` and `deepseek-v4-flash` entries to `apps/functions/src/instrumentation/cost-logger.ts:73` price table (with cache-hit + cache-miss rates).

### Phase 1 (week 1 — eval-only, no production traffic)

- [ ] Spin up an eval harness that runs 10-turn long-context scenarios (mirror Adam iter23 rule).
- [ ] A/B: nano+rewriter vs V4-Pro-no-rewriter vs V4-Pro+rewriter.
- [ ] Score on 4 voice-axes + p99 latency.
- [ ] Decision gate: **GO** if V4-Pro-no-rewriter wins ≥3 of 4 axes AND p99 stays under 6s.

### Phase 2 (week 2 — 1% canary)

- [ ] Implement `paBibleModelV4Pro` feature flag (variant carries model id).
- [ ] Add `paLlmRewriterRequired` short-circuit when V4-Pro flag on.
- [ ] 1% rollout (single test user, e.g., Adam's own account).
- [ ] 7-day soak. Watch: cost-logger spend spike, voice eval drift, p99 latency, rewrite-skip rate.

### Phase 3 (week 3 — 10%)

- [ ] Bump rollout 1% → 10% pre-May-31. Goal: maximize promo-rate spend before cliff.
- [ ] Critical: do NOT bump >10% until June 1 post-promo cost is observed for ≥48h.

### Phase 4 (week 4+ — beyond promo cliff)

- [ ] On June 1, observe daily-spend cards for 48-72h. If $/user/day stays under $0.05 AND voice metrics held → ramp 10% → 25% → 50% → 100% over 2 weeks.
- [ ] If $/user/day exceeds $0.10 OR voice metrics regressed → freeze at 10%, run prompt-tuning iteration.

### Phase 5 (deferred — Site D match-explainer)

- [ ] Only if V4-Flash benchmark shows >2× quality on bilingual one-sentence summaries vs Qwen-7B at 2× cost. Default expectation: NO swap.

### Phase 6 (deferred — Site E mem0)

- [ ] Blocked on mem0ai/oss fork that exposes token usage to client.
- [ ] Once unblocked, evaluate V4-Pro fact extraction quality vs Qwen-72B.

### Permanently NOT migrated

- Sites B (rewriter), C (lang-lock), F (embeddings), G (rerank), H (eval-judge), I (moderation).
- Site B specifically becomes architecturally redundant if V4-Pro lands at Site A; remove it then, don't migrate it.

---

## 7. Open questions / unknowns

1. **gpt-5.4-nano exact pricing**: not in `cost-logger.ts:73-78` price table. Adam: confirm OpenAI's published rate for gpt-5.4-nano. Without this, the cost-delta math on Site A is approximate.
2. **DeepSeek server-side prefix cache behavior**: is the 1/10th cache-hit rate triggered by *identical-prefix detection* (server side) or only by client-explicit `cached_prefix` flags? If the former, Bible v7.0 prefix caching is automatic; if the latter, requires code change in `runWithOpenAI`.
3. **DeepSeek rate-limit ceiling**: unpublished. Need a written commitment for public-launch capacity planning.
4. **mem0ai/oss usage telemetry**: tracked as backlog #24; until that lands, V4-Pro at Site E is unsafe to ramp.
5. **Adam's risk tolerance for promo-cliff cost spike**: is a 4× cost jump on June 1 acceptable if voice metrics stay green, or do we want a hard rollback trigger at $X/day?

---

## TL;DR for Adam (5 bullets, decision-ready)

- **Premise correction**: the brief says Bible main turn runs on Qwen-7B SiliconFlow — it does not. It runs on **OpenAI gpt-5.4-nano** per `seed.json:7-8` and three other source-of-truth references. Qwen-7B is only the second-pass rewriter, lang-lock translator, and async match-explainer.
- **V4-Pro pricing today (May 3)**: $0.435/M in + $0.87/M out under 75% promo, **expires May 31**. Standard list (June 1+) is $1.74/$3.48 — **4× more**. SiliconFlow proxy is $1.74/$3.48 always (no promo passthrough). For all migration work, plan against **post-promo standard list, not promo**.
- **Only one call site is worth swapping**: the Bible main turn (Site A). All other Qwen-7B sites are either fail-open helpers, free-tier embeddings, or async cost-bounded jobs where V4-Pro is **2×–45× more expensive** for marginal-to-no quality gain. **DO NOT bulk-migrate.**
- **Site A migration is GO **conditional on** a voice eval passing**: V4-Pro-no-rewriter must beat nano+rewriter on ≥3 of 4 voice axes (mirror score, repeat-advice, length compliance, p99 latency) on the 10-turn long-context test set per CLAUDE.md iter23 rule. **Do not ramp on a hunch — Adam's iter22 forbids it and the math agrees.** If GO, the architectural win is removing the rewriter hop entirely (latency + complexity), not just paying more for the same output.
- **Cost projection at closed-beta (100 users × 30 turns/day): ~$78/mo post-promo for the V4-Pro Bible swap (vs ~$3/mo today). Tractable for closed beta, watch carefully at 1000-user public launch (~$780/mo).** Recommend phased rollout: eval week 1 → 1% week 2 → 10% pre-May-31 → freeze through promo cliff → ramp post-cliff only if June 1-7 cost+quality cards are green.

---

## Sources cited

- [DeepSeek API Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [DeepSeek First API Call (OpenAI-compat)](https://api-docs.deepseek.com/)
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)
- [DeepSeek Function Calling](https://api-docs.deepseek.com/guides/function_calling)
- [DeepSeek JSON Mode](https://api-docs.deepseek.com/guides/json_mode)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek V4 Preview Release](https://api-docs.deepseek.com/news/news260424)
- [DeepSeek V3.2 → V4 transition (deprecation 2026/07/24)](https://api-docs.deepseek.com/news/news251201)
- [DeepSeek API Rate Limits](https://api-docs.deepseek.com/quick_start/rate_limit)
- [SiliconFlow DeepSeek-V4-Pro card](https://www.siliconflow.com/models/deepseek-v4-pro)
- [SiliconFlow Qwen2.5-7B-Instruct card](https://www.siliconflow.com/models/qwen-qwen-2-5-7b-instruct)
- [DeepInfra V4-Pro pricing analysis 2026](https://deepinfra.com/blog/deepseek-v4-pro-pricing-guide-2026-providers-cost-analysis)
- [TheNextWeb: 75% V4-Pro price cut](https://thenextweb.com/news/deepseek-v4-pro-price-cut-75-percent)
- [Artificial Analysis V4-Pro provider benchmarks](https://artificialanalysis.ai/models/deepseek-v4-pro/providers)
- [VentureBeat: V4 near-SOTA at 1/6 cost](https://venturebeat.com/technology/deepseek-v4-arrives-with-near-state-of-the-art-intelligence-at-1-6th-the-cost-of-opus-4-7-gpt-5-5)
- [Codersera DeepSeek V4 Pro 2026 review](https://ghost.codersera.com/blog/deepseek-v4-pro-review-benchmarks-pricing-2026/)
- Local source-of-truth files cited throughout: `packages/agent-registry/src/seed.json`, `packages/agent-runtime/src/openai-provider.ts`, `packages/pa-orchestrator/src/voice/llm-rewriter.ts`, `packages/pa-orchestrator/src/voice/lang-lock-runner.ts`, `apps/job-rec/src/match-explainer.ts`, `packages/memory/src/mem0.ts`, `apps/functions/src/instrumentation/cost-logger.ts`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/V1.5-ROLLOUT.md`, `.planning/phases/42-async-match-explainer/DELIVERY.md`.
