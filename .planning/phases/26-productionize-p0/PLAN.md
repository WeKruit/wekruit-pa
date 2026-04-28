# Phase 26 — PLAN (P8 execution, post-24.5, parallel with 25)

**Topology:** 4 sub-tasks. T1+T2 serial (rate-limit + quota build on each other for shared infra), T3+T4 parallel-able with T1/T2.
**For MVP single-P8 run:** serialize T1 → T2 → T3 → T4.
**Spawn condition:** Phase 24.5 SUMMARY.md committed + acceptance gate green.

## Sub-task breakdown

### T1: Per-user rate-limit at paSendblueWebhook
**Files:**
- `packages/pa-persistence/src/rate-limit.ts` (new)
- `packages/pa-persistence/src/rate-limit.test.ts` (new)
- `apps/functions/src/sendblue/webhook.ts` (insert hook — minimal touch since Adam has uncommitted work; add 1 await call at entry)
- `apps/functions/src/sendblue/__tests__/webhook.test.ts` (extend if exists; new file otherwise)

Deliverables:
- Token bucket: `pa_rate_limit/{userId}_{minuteBucket}` doc with `{ count, expiresAt }`. TTL field configured via Firestore TTL policy on `expiresAt`.
- `checkAndIncrementRateLimit(db, userId, { limit=20, windowSec=60 }) → { allowed, remaining }`
- Webhook entry calls `await getFlag('paRateLimitPerUserEnabled', { userId })`; if true → call rate-limit; if exceeded → return 429 + emit audit `rate_limit.exceeded`
- Adam test number on `paRateLimitPerUserEnabled` blocklist → flag returns false → bypass

DONE:
- `npm run test --workspace=@pa/pa-persistence`
- `npm run test --workspace=@pa/functions` (webhook test exercises 21 messages in 1 min → 21st returns 429)
- Adam's existing webhook.ts uncommitted diff stays minimal (1-line insert + import)

Commit: `feat(26/T1): per-user rate-limit (flag-gated) at sendblue webhook (P9-Prod-Ops)`

### T2: Sendblue daily-quota monitor + hard-block
**Files:**
- `packages/pa-persistence/src/outbound-quota.ts` (new)
- `apps/functions/src/sendblue/outbox.ts` (insert quota check — minimal touch on Adam's file)
- `apps/functions/src/sendblue/__tests__/outbox.test.ts` (extend)

Deliverables:
- `pa_outbound_daily/{YYYYMMDD}` doc; on each successful send `increment(1)`
- `getDailyOutboundCount(db, date) → number`
- Outbox: before send, check count vs `getFlag('sendblueDailyQuota')` (number type, default 1000). At 80% emit `quota.soft` audit; at 100% block + audit `quota.hardblock`.
- New flag `sendblueDailyQuota` added to seed-feature-flags.ts (extends Phase 24.5 seed list)

DONE:
- `npm run test --workspace=@pa/functions`
- Outbox test: simulate 800 sends → expect soft alert; 1000 sends → expect hard block + audit row

Commit: `feat(26/T2): sendblue daily quota monitor + hard-block at 100% (P9-Prod-Ops)`

### T3: Cloud Logging dashboard config + cost alert
**Files:**
- `infra/cloud-logging/dashboard.json` (new — Cloud Monitoring dashboard config-as-code)
- `infra/cloud-logging/alert-policies.yaml` (new — cost alert >$10/day)
- `infra/cloud-logging/README.md` (new — Adam apply runbook: gcloud monitoring dashboards create / alert policy create)
- `apps/functions/src/instrumentation/cost-logger.ts` (new — structured log helper)
- Extend 1 LLM call site to demonstrate `logTokenSpend({ model, inputTokens, outputTokens })` — pick an existing site (e.g. orchestrator nano call), surgical insert

Deliverables:
- Dashboard JSON includes: per-CF latency p50/p95, error rate, daily LLM spend
- Alert policy YAML includes condition `metric.type = "logging.googleapis.com/user/pa.spend.daily" AND value > 10`
- README documents `gcloud monitoring dashboards create --config-from-file=dashboard.json`

DONE:
- File presence + JSON/YAML lint (`jq . infra/cloud-logging/dashboard.json` / `python -c "import yaml; yaml.safe_load(open('infra/cloud-logging/alert-policies.yaml'))"`)
- `npm run build --workspace=@pa/functions`
- Adam runs gcloud apply post-merge (P9 gate = file correctness, not live deploy)

Commit: `feat(26/T3): cloud logging dashboard + cost alert config-as-code (P9-Prod-Ops)`

### T4: agent-registry version pinning
**Files:**
- `packages/agent-registry/src/version-resolver.ts` (new)
- `packages/agent-registry/src/version-resolver.test.ts` (new)
- `packages/agent-registry/src/index.ts` (export)
- `apps/functions/src/index.ts` (wire `PA_AGENT_REGISTRY_VERSION` env into orchestrator init — minimal touch on Adam's file)

Deliverables:
- Resolver order: `getFlag('agentRegistryVersion')` (string) → `process.env.PA_AGENT_REGISTRY_VERSION` → `seed.json` default version
- If resolver returns `firestore:agents/{slug}/versions/{v}` form, fetch from Firestore; else treat as seed.json key
- Tests cover: env override, flag override, fallback to default

DONE:
- `npm run test --workspace=@pa/agent-registry`
- `npm run typecheck --workspace=@pa/agent-registry`

Commit: `feat(26/T4): agent-registry version pinning + Firestore override (P9-Prod-Ops)`

## P9 acceptance gate

```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa
npm run test --workspace=@pa/pa-persistence
npm run test --workspace=@pa/functions
npm run test --workspace=@pa/agent-registry
npm run build --workspace=@pa/functions
jq . infra/cloud-logging/dashboard.json
git log --oneline -10
git status
```

4 commits + green + Adam files untouched + new flag `sendblueDailyQuota` in seed list.

## Estimated time

3 dev-day. Single P8, sonnet/inherit.

## Adam owner steps (post-merge)

1. Apply Cloud Logging dashboard: `gcloud monitoring dashboards create --config-from-file=infra/cloud-logging/dashboard.json --project=wekruit-5f89b`
2. Apply alert policy: `gcloud alpha monitoring policies create --policy-from-file=infra/cloud-logging/alert-policies.yaml`
3. Add Adam test E.164 to `paRateLimitPerUserEnabled` blocklist via /admin/flags
4. Verify Sendblue quota threshold matches actual Free tier limit (assumption: 1000/day — confirm with Sendblue support)
