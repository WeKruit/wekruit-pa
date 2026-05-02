# v1.5 Budget & Cost-Control Audit

**Date:** 2026-05-02 · **Scope:** all v1.5 streams · **Mode:** read-only.
**Brief constraint (Adam):** "budget AS LOW AS POSSIBLE — prefer free."

---

## 1. Cost-tracking inventory (where + what)

| # | Mechanism | File | Persists to | What it tracks |
|---|---|---|---|---|
| L1 | Match-explainer ledger | `apps/job-rec/src/match-explainer.ts:444` | Firestore `pa-cost-ledger/match-explainer__YYYYMMDD` | `totalUsd`, `callCount` per UTC day, SiliconFlow Qwen-7B |
| L2 | Phase-39 bench ledger | `apps/eval/external-benchmarks/lib/cost-ledger.mjs` | local JSON (persistPath) | per-call charges + `BudgetExceededError` enforcement |
| L3 | `pa.spend.daily` log metric | `apps/functions/src/instrumentation/cost-logger.ts:60` + `packages/pa-orchestrator/src/index.ts:1430` | Cloud Logging → log-based metric | per-orchestrator-turn token spend |
| L4 | Mac-mini matching pipeline | wekruit-matching repo | (out of repo) | **costUsd hard-coded 0** — V1.5-ROLLOUT.md tech-debt #21 |

`logTokenSpend()` is **defined but only called inside cost-logger.ts itself** in this repo; orchestrator emits a hand-rolled `pa.spend.daily` log line. Functions-side embedding calls (`paReverseMatch.ts:84`, `job-rec-daily.ts:51`) do NOT call `logTokenSpend` — embed spend is invisible to L3.

---

## 2. Hard-cap enforcement table

| Cap | Value | Where enforced | Verdict |
|---|---|---|---|
| Match-explainer daily | $1/day USD (env `PA_MATCH_EXPLAINER_DAILY_BUDGET_USD`) | `match-explainer.ts:460` short-circuits → returns "" + emits `match_explainer_budget_skip` | **ENFORCED**, fail-open. One call may tip ledger by ~$0.00002 (documented). Test coverage: `match-explainer.test.ts:325`. |
| Phase-39 bench total | $25 USD (env `PA_BENCH_MAX_BUDGET_USD`) | `cost-ledger.mjs:133` throws `BudgetExceededError` pre-charge | **ENFORCED** with hard throw. Caller in `run-all.mjs:156` aborts arm. |
| Coalescer hard cap | 12,000 ms wait | `apps/functions/src/coalesce/buffer.ts:57` `HARD_CAP_MS` | **TIME-cap, not $-cap.** Bounds Cloud Tasks invocations per turn; $0 cost path (CT free 1M/mo). |
| Coalescer force-fire | 5 messages | `buffer.ts:55` `FORCE_FIRE_MESSAGE_COUNT` | **ENFORCED.** Same purpose. |
| Reverse-match bulk notify | 5 users/call | `reverse-match.ts:62` `REVERSE_MATCH_BULK_NOTIFY_CAP` | **ENFORCED** at `paReverseMatch.ts:451`. Bounds Sendblue fan-out, not embed spend. |
| Sendblue circuit breaker | 5 consecutive failures → 60s open | `apps/functions/src/sendblue/send-reaction.ts:84` | **ENFORCED.** Stops API-call-spam cascade. |
| `pa.spend.daily` alert | $10/day | `infra/cloud-logging/alert-policies.yaml` | **ALERT-only**, not a hard cap. Operator must materialize log-metric (READMEd). No automatic shutoff. |

---

## 3. Projected vs actual spend (per stream, 100 users)

Source: `.planning/V1.5-ROLLOUT.md:154` table + Phase-39 `apps/eval/external-benchmarks/results/aggregate-report.json`.

| Stream | Projected $/mo | Actual | Source | Cap | Headroom |
|---|---|---|---|---|---|
| F (match-explainer) | $0.60/mo | UNKNOWN (Firestore read denied — gcloud ADC expired) | L1 ledger doc | $1/day = $30/mo | $29.40/mo cap headroom |
| Phase-39 benchmarks (one-shot) | $2.41 | **$0.4322** (15 benchmarks across 3 arms) | `aggregate-report.json` | $25 | $24.57 — 1.7% used |
| A2 (mini webhook) | $0/mo | UNKNOWN | — (CF Gen2 free tier) | none | implicit free 2M invocations/mo |
| D (coalescer) | $0/mo | UNKNOWN | — (Cloud Tasks free 1M/mo) | none | implicit free tier |
| E (safety) | $0/mo | $0 (verified — pure JS, no LLM) | code review | n/a | n/a |
| H (reverse-match) | $0.0001/JD | UNKNOWN — embed spend untracked | — | bulk-notify=5 users | embed cost path is invisible |
| Mac-mini matching | UNKNOWN | UNKNOWN | rollout #21: `costUsd = 0` hard-coded | none | Anthropic + Firecrawl spend invisible |
| Total v1.5/mo | **~$0.60/mo** | **>=$0.4322 one-time + UNKNOWN/mo** | | | |

---

## 4. Untracked spend paths (real risk)

1. **OpenAI embeddings** — `apps/functions/src/job-rec-daily.ts:51` (CV embed lazy-compute) and `apps/functions/src/paReverseMatch.ts:84` (JD embed per match) call `client.embeddings.create` with **no `logTokenSpend` instrumentation**. ~$0.0001/call, but at >10k/day = ~$30/mo invisible.
2. **Mem0 OSS internal LLM calls** — `packages/memory/src/mem0.ts` uses Mem0's fact-extraction pipeline; mem0ai chat model + embedding model run *inside* the SDK. **Zero hooks, zero ledger.**
3. **Mac-mini Anthropic + Firecrawl spend** — V1.5-ROLLOUT.md tech-debt #21 calls this out: `costUsd` is hard-coded 0 in `worker.py:enrich_pending` + `run_jd_enrichment.py`. Real spend (~Haiku per JD + Firecrawl credits) is currently INVISIBLE on dashboards.
4. **SiliconFlow re-roll inside Claire stack** — Phase-39 budgets a 10% re-roll overhead but does NOT correlate that to a per-user-turn ledger; only the bench harness sees it. Production runtime path (`pa-orchestrator`) emits `pa.spend.daily` log lines but no Firestore-side per-user ledger.
5. **`logTokenSpend()` is dead code in this repo** — defined in `cost-logger.ts:60` but never imported outside its own test surface. The orchestrator emits the structured log inline (`pa-orchestrator/src/index.ts:1430`) — duplicate code paths, only one is used.

---

## 5. Recommendations for v1.6

1. **Wire `logTokenSpend` into all OpenAI/SiliconFlow callers.** Concretely: `paReverseMatch.embedJd` + `job-rec-daily.computeUserEmbedding` + Mem0 wrapper. Single import, log-metric backfill, no infra change.
2. **Add a Firestore daily `pa-cost-ledger/global__YYYYMMDD` doc** that aggregates ALL streams (not just match-explainer). Use `FieldValue.increment` per ROLLOUT tech-debt #10 — handles parallel CF fan-out.
3. **Convert `pa.spend.daily` $10/day alert to a hard cap** (Cloud Function checks ledger before LLM call, fail-closed). Today it's monitoring-only.
4. **Mac-mini cost plumbing** (ROLLOUT #21) — track Anthropic input/output tokens in `enrichment/worker.py` and convert Firecrawl `credits_used → USD` in `run_jd_enrichment.py`.
5. **Per-user budget** — match-explainer's $1/day is global. A single rogue user can starve the rest. Add per-user secondary cap (e.g. $0.05/user/day).

---

## 6. UNKNOWNs (could not verify in read-only mode)

- Actual L1 ledger total for last 7 days — `gcloud auth application-default print-access-token` returns `invalid_grant`. Re-auth required to query `pa-cost-ledger`.
- Actual coalescer `pa-message-coalesce-buffer` daily fire count vs CT free-tier ceiling (1M/mo).
- Actual `pa.spend.daily` aggregate from Cloud Logging (would need `gcloud logging read` with valid ADC).
- Mem0/Qdrant internal LLM token consumption — SDK does not expose usage hooks in current integration.

---

## 7. Bottom line

- **Hard caps that ENFORCE today:** match-explainer $1/day (✓), Phase-39 $25 (✓), coalescer 12s+5msg (✓), reverse-match bulk=5 (✓), Sendblue breaker (✓).
- **Hard cap that is alert-only:** `pa.spend.daily` $10/day — no automatic shutoff.
- **Largest blind spots:** OpenAI embeddings (functions-side), Mem0 internal calls, Mac-mini Anthropic/Firecrawl. None are tied to a ledger.
- **Phase-39 bench** is the only stream with verified actual-vs-projected: **$0.4322 actual vs $2.41 projected** (well under $25 cap, 1.7% used).
- **v1.5 monthly target ($0.60/mo)** is plausible but **unverifiable end-to-end** until embeddings + Mem0 + Mac-mini paths are instrumented.
