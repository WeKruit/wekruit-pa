# Phase 27 — Productionize P1+P2 + Self-Evolve Cron — CONTEXT (PLAN-ONLY, GATED)

**Owner P9:** P9-SelfEvolve (NOT spawned yet — gated)
**P10 strategy:** `.planning/v1.2-p10-strategic-cut.md`
**ROADMAP entry:** `.planning/ROADMAP.md` lines 415-433

## ⛔ HARD GATE (all 3 required before P9 spawns P8)

1. ✅ Phase 26 P0 ships AND runs stable for 2 calendar weeks (cost alerts and rate-limit do NOT fire spuriously)
2. ✅ ≥200 voice reviews collected via Phase 25 dashboard (`pa_voice_reviews` count >= 200)
3. ✅ `selfEvolveEnabled` flag explicitly set to `true` by Adam via /admin/flags (audit row in `pa_audit_events`)

Until all 3 are met, this phase remains plan-only. No code commits, no spawning.

## 底层逻辑 (P10 quote)

> 闭环 — 自进化 cron 改 Bible 引发 regression. 缓解: cron 只开 PR + eval gate ≥ baseline 才允许 merge. HITL review 永远在.

## Success criteria (Phase 27 — to be detailed once gate opens)

1. Qwen rewriter circuit breaker: 5 consecutive 404/timeout → flip flag `paVoiceRewriterEnabled` to false, alert Adam, fall back to nano-only output
2. Qdrant ↔ Firestore memory drift cron (daily): emit drift count metric, alert if drift > 1% of total memories
3. CF /health endpoint × 5 (paSendblueWebhook / paSendblueOutbox / onPaInbound / paProactiveSweep / memoryAdmin), each returns `{ok, version, deps: {...}}`
4. SLO definitions + error budget tracking (latency, availability, voice quality)
5. Self-evolve cron (daily): read `pa_voice_reviews` low-rated turns from past 24h, cluster by violation tag, generate Bible patch suggestion, open PR (NEVER push), block merge unless eval gate ≥ baseline. HITL review required.
6. Hermes-style prompt-injection scanner runs on user inputs before agent turn, low-confidence prompt-injection events written to `pa_abuse_events`

## Architectural decisions (locked)

- **Cron PR-only**: cron creates GitHub PR via `gh pr create`. NEVER force-push, NEVER auto-merge.
- **Eval gate**: PR fails CI unless `PA_RUN_EVAL=1 deepeval test run` score ≥ baseline (`eval-results/baseline.json`).
- **Read-only contract**: cron consumes `pa_voice_reviews` schema from Phase 25 — must not require schema changes there.
- **Circuit breaker state**: stored in `pa_circuit_breaker/{name}` doc with `{state, openedAt, attemptCount}`.
- **Drift cron**: scheduled CF `paMemoryDriftCheck`, runs 02:00 UTC daily.
- **Health endpoints**: each CF exports `/health` route returning JSON (no auth required for liveness probe).

## Out-of-scope (forever, not "later")

- ❌ Cron auto-merge — HITL is permanent
- ❌ Model upgrade (gpt-5.4-nano locked by P10)
- ❌ Live A/B testing of evolved Bible (eval gate is the only filter)

## Dependencies on prior phases

- `pa_voice_reviews` from Phase 25 (read-only)
- `pa_feature_flags` from Phase 24.5 (read `selfEvolveEnabled` master switch)
- `pa_audit_events` from Phase 24.5 (write circuit breaker events)
- Cloud Logging from Phase 26 (extend dashboard with self-evolve metrics)

## Spawn checklist (when gate opens)

- [ ] Confirm 2-week soak post-Phase 26 ship
- [ ] Confirm `pa_voice_reviews` count ≥ 200 (`db.collection('pa_voice_reviews').count()`)
- [ ] Confirm `selfEvolveEnabled = true` in `pa_feature_flags` (audit row exists)
- [ ] P9 writes detailed PLAN.md (~6-8 sub-tasks)
- [ ] Spawn P8(s) — likely 2 P8s parallel (1 for cron infra, 1 for circuit breaker + drift)
- [ ] Eval gate baseline frozen at gate-open snapshot

## Estimated time (when unblocked)

5-7 dev-day across 2 parallel P8s.
