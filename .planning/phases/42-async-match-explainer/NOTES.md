# Phase 42 — Decision Log + Engineering Notes

## Why inline an SF chat shim instead of importing apps/eval/external-benchmarks/lib/sf-client.mjs

`sf-client.mjs` is a one-shot benchmarking client with raw single-call semantics, no caching, no abstraction over base-url, and an optimization profile aimed at sequential 1000-conv bench loops. The match-explainer needs the OPPOSITE shape: short prompts, hard 5s timeout, conservative max_tokens, a soft retry-free fail-open path, and a model-agnostic `ChatImpl` test seam.

Cross-importing prod `apps/job-rec` from `apps/eval/external-benchmarks` is the wrong dependency direction (eval should consume prod, not vice-versa). Pulling sf-client into a shared package would have grown scope.

The inline shim is ~30 lines and reuses the env-var chain identically:
```
SILICONFLOW_API_KEY → PA_OPENAI_AGENT_API_KEY → PA_SILICONFLOW_API_KEY
```

If we ever need a 3rd consumer of SF chat in prod, promote to a `@pa/sf-client` package.

## Why Map<jobId, string> instead of array index

`DailyPushContext.reasons?: ReadonlyMap<string, string>` is keyed by `job.id` so re-orderings between H13 dedupe / anti-bias / final slice and the explainer fan-out can't desync the reason↔job pairing. Array index would require careful "explainer runs AFTER all reordering" plumbing.

## Why sequential per-user explainer calls (not Promise.all)

Sequential keeps the daily-budget check authoritative. `Promise.all([3 jobs])` would race all three reads of the same ledger doc and could overshoot budget by 3× on the boundary call. The latency cost: 3 × ~500ms = 1.5s per user, fine for an offline cron with a 60s CF budget.

If we ever need parallel: switch the ledger to `FieldValue.increment` + add a soft pre-check token bucket.

## Why fail-open everywhere

H13 already established the contract: empty reason → formatter renders clean line `Title @ Company (loc) ~$Xk`. So the explainer can fail-open cleanly. We deliberately do NOT cache empty strings — that would poison the next-day call when the LLM's transient failure has resolved.

## Why budget read-only at decision time

```
read currentTotalUsd → if >= budget: skip → else: call → write actual cost
```

This means a single boundary call CAN tip the daily total over $budget by ~$0.00002. Acceptable trade-off: matches SiliconFlow's after-the-fact billing semantics, and the worst-case overshoot at 1000 calls/day is $0.02. Anything stricter requires a 2-phase commit (read-then-charge-then-write) which adds a ledger round-trip on the cold path.

## Why client-side TTL guard despite Firestore TTL

Firestore TTL deletion is async and eventual — docs can survive several minutes past `ttlAt`. The explainer honors `ttlAt` client-side (`Date.parse(data.ttlAt) > now`) so a stale doc lingering after the GC clock can't return a 7-day-old reason.

## Why minimum reason length 8 chars

Empirically Qwen-7B can return refusal-style noise like `"-"`, `"无"`, `"对得上"`, `"OK"`. Below 8 chars is almost certainly a non-answer. Sanitize to "" → fail-open.

## Why 140-char max + Array.from for slicing

`String.slice()` cuts CJK surrogate pairs incorrectly. `Array.from(s)` materializes code-points; we slice that and re-join. 140 chars is generous (typical reason is 30-60 chars) but bounds runaway outputs.

## Out-of-domain observations (recorded for P8 routing)

While reading the tree:
- `apps/job-rec/src/cross-encoder-rerank.ts` has +286 lines uncommitted (Stream I startup-bias work). 2 tests `strong-yes user reorders startup ahead of FAANG` and `bilingual startup keyword detection` were intermittently failing in earlier mixed-WIP runs; both green when run as a clean suite. **Not in Phase 42 WHERE — flagged for P8.**
- `apps/functions/src/__tests__/matching-pipeline-complete.test.ts` is untracked / untouched. **Not in Phase 42 WHERE — flagged for P8.**
- `packages/pa-safety/src/index.ts` modified, `packages/pa-safety/src/safety-check.test.ts` untracked. **Not in Phase 42 WHERE — flagged for P8.**

## Open questions (not blocking ship)

1. Should `recentBullet` be auto-pulled from `parsedCandidateResumes.experiences[0].description` inside `loadDailyPushContext`? Today the explainer accepts it via input, but the daily-batch wiring doesn't populate it. Adding a 220-char snippet should boost reason quality further. **Deferred to a follow-up phase.**
2. Should we A/B test "explainer reason" vs "H13 heuristic reason" by writing both to outbound docs (in a non-user-visible field) for later eval? Adam's preference is ship-don't-ask, so deferring instrumentation.
