# Phase 26 — Productionize P0 (公测 hard gate) — CONTEXT

**Owner P9:** P9-Prod-Ops (autonomous)
**Depends on:** Phase 24.5 ships (rate-limit consumes `getFlag('paRateLimitPerUserEnabled')`)
**Parallel with:** Phase 25 (zero file overlap)
**P10 strategy:** `.planning/v1.2-p10-strategic-cut.md`
**ROADMAP entry:** `.planning/ROADMAP.md` lines 401-413

## 底层逻辑 (P10 quote)

> 公测 gate — rate-limit / quota / cost / rollback 4 项 ops 债务必须还. 没还完不能开公测. 这 phase 是底线工程.

## Success criteria (P10 locked)

1. **Per-user rate-limit**: ≤ N msg/min (default N=20) enforced at `paSendblueWebhook` entry. Gated by `getFlag('paRateLimitPerUserEnabled', { userId })` — Adam test number → blocklist → bypass; prod users → enforced.
2. **Sendblue Free tier daily-quota monitor**: CF reads daily outbound count from `pa_outbound`, soft alert at 80% of quota (Adam-configurable threshold; assume 1000/day for Free tier), hard block at 100% with audit event in `pa_audit_events` (action=`quota.hardblock`).
3. **Cloud Logging dashboard** exposing per-CF latency p50/p95, error rate, gpt-5.4-nano spend (tokens × current price). Cost alert email when daily spend > $10. Dashboard config-as-code in `infra/cloud-logging/`.
4. **agent-registry version pinning**: env override `PA_AGENT_REGISTRY_VERSION` reads desired Bible version from `seed.json`'s versioned entries (or pins to a Firestore `agents/{slug}/versions/{v}` doc). One-click rollback via flag change.

## Architectural decisions (P10 locked)

- **Rate-limit storage**: Firestore `pa_rate_limit/{userId}_{minuteBucket}` with TTL 5min auto-delete (token bucket counter doc). Atomic increment via `FieldValue.increment(1)`.
- **Quota counter**: Daily aggregate doc `pa_outbound_daily/{YYYYMMDD}` incremented on each successful send. Resets at midnight UTC.
- **Cost telemetry**: emit log entry `pa.spend.token` per LLM call with structured fields (`model`, `inputTokens`, `outputTokens`, `priceUsd`). Cloud Logging metric extracts → alert policy.
- **Version pinning**: agent-registry already supports versioned seed entries; this phase adds the env-var resolver + Firestore override doc shape.

## Out-of-scope

- DO NOT build self-evolve cron (Phase 27)
- DO NOT migrate to Sendblue paid tier (cost discussion is Adam decision)
- DO NOT add new logging deps (Cloud Logging is GCP native via firebase-functions)
- DO NOT touch Phase 24.5 SDK (consume only)
- DO NOT touch Phase 25 dashboard pages
- DO NOT touch sendblue/voice uncommitted Adam files beyond rate-limit hook insertion

## Risks

- R1: rate-limit false-positive on test number — mitigated by perUser blocklist in flag (Adam's E.164 added on first deploy)
- R2: quota counter race on burst sends — Firestore transaction or `increment(1)` atomic semantic handles it
- R3: Cost alert noise — start at $10/day threshold, tune from soak data
