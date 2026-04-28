# Phase 27 — PLAN (PLACEHOLDER — gate not open)

**Status:** Gated. DO NOT spawn P8 until all 3 hard-gate conditions met (see CONTEXT.md).

## Pre-spawn TODO (P9 fills when gate opens)

When Adam flips `selfEvolveEnabled=true` AND ≥200 reviews collected AND P26 stable 2 weeks:

1. P9 reads `pa_voice_reviews` corpus, classifies by tag distribution → informs cron clustering algo
2. P9 finalizes 6-8 sub-task breakdown:
   - T1: Qwen circuit breaker (`packages/pa-orchestrator/src/voice/qwen-breaker.ts` + flag toggle)
   - T2: Qdrant ↔ Firestore drift cron (`apps/functions/src/memory-drift.ts`)
   - T3: 5× CF `/health` endpoints (extend each CF with health route)
   - T4: SLO + error budget tracker (`infra/slo/`)
   - T5: Self-evolve cron infra (`apps/functions/src/self-evolve-cron.ts` — reads reviews, clusters, opens PR)
   - T6: Eval gate CI hook (`.github/workflows/voice-eval-gate.yml`)
   - T7: Hermes-style prompt-injection scanner (`packages/pa-safety/src/prompt-injection.ts`)
   - T8: Integration smoke (synthetic 30-day soak fixture)
3. P9 writes detailed Task Prompts per sub-task (six elements each)
4. P9 spawns 2 P8s in parallel:
   - P8-A: T1, T2, T3, T7 (safety + breaker + drift)
   - P8-B: T4, T5, T6, T8 (cron + SLO + eval gate)

## Acceptance gate (when execution completes)

```bash
# all 6 success criteria from CONTEXT.md exercised
npm run test -ws --if-present
npm run build:all
# eval gate dry-run
PA_RUN_EVAL=1 npm run test:voice
# 5 health endpoints respond
for cf in paSendblueWebhook paSendblueOutbox onPaInbound paProactiveSweep memoryAdmin; do
  curl -s "https://...${cf}/health" | jq .ok
done
```

## Adam decisions still owed (before gate opens)

- [ ] Confirm SLO targets (latency p95 ms? availability %?)
- [ ] Confirm Bible PR review SLA (Adam responds within X hours?)
- [ ] Confirm self-evolve cron schedule (daily 02:00 UTC reasonable?)
