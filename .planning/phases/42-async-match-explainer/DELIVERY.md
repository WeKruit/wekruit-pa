# Phase 42 — Stream-F — Async Match-Explainer (closes TD-H13-1)

**Status**: D1–D6 ship-ready
**Date**: 2026-05-02
**Owner**: P7 (Stream-F)
**Predecessor**: Phase 41 (H13 friend-tone opener — commit `bc8863c`)

## What shipped

A cheap async LLM-composed match-reason layer that produces grounded one-sentence explanations like:

> Senior Product Manager @ Stripe (SF) ~$280k — 你 NEUROVA 那段 payments 管线的活儿和 Stripe 这个支付平台 PM 直接对得上

Replaces H13's token-overlap heuristic (which emits empty for ~80% of corpus rows because production JDs lack the `requiredSkills` field — TD-H13-1).

## Architecture

```
Daily cron (paJobRecDaily) → runDailyJobRecBatch
  → ... existing pool query → cosine rerank → cross-encoder rerank
       → dedupe → anti-bias → top-3 selection ...
  → IF paFriendToneOpenerEnabled (default ON):
      pushCtx = loadDailyPushContext(...)
      IF paMatchExplainerEnabled (default OFF, ramp via allowlist):
          for each top-3 job (sequential):
              cache = pa-job-rec-explanations/{userId}__{jobId}__{language}
              IF cache hit (within 7d TTL): use cached reason
              ELIF daily budget exceeded: skip → empty reason
              ELSE: chat(Qwen-7B, 5s timeout, 80 max_tokens, T=0.4)
                    → sanitize → write cache → increment ledger
          inject reasonsMap into pushCtx.reasons (Map<jobId, string>)
      body = formatDailyPushBody(rankedJobs, pushCtx)
        → formatJobLineWithReason prefers ctx.reasons[jobId] over H13 heuristic
```

## Files

### NEW

| File | Purpose |
|------|---------|
| `apps/job-rec/src/match-explainer.ts` | Pure logic: explainMatch(), prompt, cache, cost ledger, fail-open |
| `apps/job-rec/src/__tests__/match-explainer.test.ts` | 11 tests (6 brief + 5 helper-coverage) |
| `EXPLAINER-SAMPLES.md` (root) | Sample prompts + outputs (zh + en) |
| `.planning/phases/42-async-match-explainer/{DELIVERY.md, NOTES.md}` | This + decision log |

### MODIFIED

| File | Change |
|------|--------|
| `apps/job-rec/src/daily-batch.ts` | DailyPushContext.reasons?: Map; formatJobLineWithReason prefers it; runDailyJobRecBatch wires explainer behind `paMatchExplainerEnabled` flag; new deps `matchExplainerChatImpl` + `matchExplainerDailyBudgetUsd` |
| `apps/job-rec/src/index.ts` | Re-export explainer surface |
| `apps/job-rec/src/__tests__/daily-batch.test.ts` | +3 tests (flag-OFF regression, flag-ON happy, fail-open) |
| `apps/functions/scripts/run-daily-now-rematch-h13.mjs` | Additive: when env `PA_MATCH_EXPLAINER_FORCE_ON=1`, exercise explainer path; bytewise unchanged otherwise |

## Feature flags

| Key | Default | Purpose |
|-----|---------|---------|
| `paJobRecEnabled` | per-user allowlist | Existing — gates daily-batch entirely |
| `paFriendToneOpenerEnabled` | true | Existing (H13) — gates friend-tone formatter |
| **`paMatchExplainerEnabled`** | **false** | **NEW (Phase 42) — gates LLM explainer** |

Ramp plan: allowlist 1% → 10% → 50% → 100% with one-day soak between steps. Default-off ensures bytewise zero regression.

## Cost configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `SILICONFLOW_API_KEY` | — | SF auth (chain: also `PA_OPENAI_AGENT_API_KEY`, `PA_SILICONFLOW_API_KEY`) |
| `SILICONFLOW_BASE_URL` | `https://api.siliconflow.cn/v1` | Override for staging |
| `PA_MATCH_EXPLAINER_DAILY_BUDGET_USD` | `1.0` | Daily ceiling (per cost-ledger doc) |

### Per-call math (SiliconFlow Qwen-7B at $0.07/M-in + $0.14/M-out)

- Typical prompt: ~200 input tokens, ~30 output tokens
- Per-call cost: `(200 × 0.07 + 30 × 0.14) / 1e6 = $0.0000182`
- $1/day = ~55,000 calls = ~18,000 unique (user, job, language) tuples after 7d cache amortization
- 50 active users × 3 jobs × 7 days (cold-cache week 1) = 1,050 calls = $0.019/day

## Cache schema

**Collection**: `pa-job-rec-explanations` (root, flat — mock-firestore does NOT support subcollections)

**Doc id**: `${userId}__${jobId}__${language}` (use `cacheDocId()` helper; rejects "/" in keys)

**Doc fields**:
```ts
{
  userId: string,
  jobId: string,
  language: "zh" | "en",
  reason: string,            // sanitized, ≤ 140 chars
  createdAt: ISO string,
  ttlAt: ISO string,         // createdAt + 7d
  matchScore?: number,
}
```

**TTL policy** (Firestore-managed, set up by ops):
```
gcloud firestore fields ttls update ttlAt \
  --collection-group=pa-job-rec-explanations
```

The explainer's `explainMatch()` ALSO honors `ttlAt` client-side (returns cache miss when `ttlAt < now`), so a stale doc surviving past 7d does not poison the response.

## Cost ledger schema

**Collection**: `pa-cost-ledger`
**Doc id**: `match-explainer__YYYYMMDD` (UTC, batch-aligned)
**Doc fields**:
```ts
{
  ymd: "20260502",
  totalUsd: number,
  callCount: number,
  lastUpdatedAt: ISO string,
  model: "Qwen/Qwen2.5-7B-Instruct",
}
```

Read-modify-write semantics. The single-process daily cron makes this safe; if we ever fan out to parallel CFs, swap to `FieldValue.increment` (NOTES.md decision-log entry).

## Verification

```bash
cd apps/job-rec
npm run typecheck   # 0 errors
npm test            # 140 pass / 0 fail (was 113 pre-Phase-42 + 27 added)
```

11 new explainer-module tests + 3 new daily-batch wiring tests = 14 net new tests; rest are pre-existing.

## Canary plan

1. **Day 0** (this commit): merge with `paMatchExplainerEnabled = false` — production behavior unchanged.
2. **Day 1**: Set Firestore TTL policy on `pa-job-rec-explanations.ttlAt`.
3. **Day 2**: Add 1 internal user to `paMatchExplainerEnabled.allowlist`. Verify:
   - cron logs include `match_explainer_llm_ok` / `match_explainer_cache_hit`
   - `pa-cost-ledger/match-explainer__YYYYMMDD.totalUsd` < $0.001 with one user
   - outbound body contains a grounded reason (not just `你 X 经验直接对得上` template)
4. **Day 3**: Add 5 closed-beta users; verify cache hit rate climbs across day-2 push.
5. **Day 4**: Flip default `true` for the allowlist tier; soak 1 day.
6. **Day 5**: Open to 100%.

## Rollback

**Hot path** (no deploy, < 1 min):
```bash
gcloud firestore set pa-feature-flags/paMatchExplainerEnabled \
  --project=wekruit-5f89b \
  --data='{"default":false,"allowlist":[]}'
```
Daily cron picks up on next run (UTC midnight). When flag is OFF, runDailyJobRecBatch never calls explainMatch — H13 heuristic resumes — bytewise compatible.

**Code rollback**: revert this commit. No data migration; cached docs are read-only-by-the-explainer; orphaned docs expire via TTL.

## Out-of-domain technical-debt observations (for P8)

While auditing the work tree (read-only), noticed pre-existing modifications outside Phase 42's WHERE:
- `apps/job-rec/src/cross-encoder-rerank.ts` (+286 lines, untested locally) — Stream-I work-in-progress; 2 startup-vs-FAANG tests intermittent in earlier runs
- `apps/job-rec/src/types.ts` (+6 lines) — likely Stream-I size-pref tweaks
- `packages/pa-safety/src/index.ts` — appears to be Stream-I as well

Not addressed here (out of WHERE). Flagging for P8 to route to the right Stream-I owner.
