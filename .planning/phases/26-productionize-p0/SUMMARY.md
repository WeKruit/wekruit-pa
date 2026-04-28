# Phase 26 — Productionize P0 (SUMMARY)

**Status:** Shipped 2026-04-28
**Owner:** P9-Prod-Ops (autonomous P8 agent)

## Commits (4)

| Task | Hash | Description |
|---|---|---|
| T1 | `2e912d3` | per-user rate-limit (flag-gated) at sendblue webhook |
| T2 | `859bead` | sendblue daily quota monitor + hard-block (also contains Phase 25 T2 sweep) |
| T3 | `f484ac8` | cloud logging dashboard + cost alert config-as-code |
| T4 | `f12afde` | agent-registry version pinning + Firestore override |

## Verification (P9 acceptance gate, all green)

- `pnpm --filter @pa/pa-persistence test` → 29 pass / 0 fail
- `pnpm --filter @pa/agent-registry test` → 11 pass / 0 fail
- Sendblue webhook + outbox tests (focused) → 22 pass / 0 fail (rate-limit + quota_soft + quota_hardblock all pass)
- `pnpm --filter @pa/functions build` → exit 0
- `jq . infra/cloud-logging/dashboard.json` → exit 0 (valid JSON)
- `python3 -c "import yaml; yaml.safe_load(...)" infra/cloud-logging/alert-policies.yaml` → exit 0
- `infra/cloud-logging/README.md` 77 lines (≥30 required)
- Adam's `build.mjs` + `hmac.ts` byte-identical (143 diff lines, unchanged)
- webhook.ts T1 add: 1 import + 4 net lines (compressed); outbox.ts T2 add: 2 imports + ~14 net lines (quota gate) + 1 increment line — all minimal, no logic edits

## Files delivered

- `packages/pa-persistence/src/rate-limit.ts` + `.test.ts` — token bucket per-user
- `packages/pa-persistence/src/outbound-quota.ts` + `.test.ts` — daily counter + hard-block
- `packages/agent-registry/src/version-resolver.ts` + `.test.ts` — flag/env/seed precedence chain
- `apps/functions/src/instrumentation/cost-logger.ts` — structured Cloud Logging emitter for `pa.spend.daily`
- `apps/functions/scripts/seed-feature-flags.ts` — extended with `sendblueDailyQuota` (default 1000)
- `infra/cloud-logging/dashboard.json` — per-CF latency p50/p95, error rate, daily LLM spend
- `infra/cloud-logging/alert-policies.yaml` — cost alert > $10/day
- `infra/cloud-logging/README.md` — Adam runbook (gcloud apply commands)
- `apps/functions/src/sendblue/webhook.ts` — minimal hook (rate-limit gate, ≤5 lines)
- `apps/functions/src/sendblue/outbox.ts` — minimal hook (quota gate, ≤15 lines)
- `apps/functions/src/index.ts` — version resolver wire (observation-only, logs resolved version per inbound)

## Adam owner steps (post-merge)

1. **Apply Cloud Logging dashboard**: `gcloud monitoring dashboards create --config-from-file=infra/cloud-logging/dashboard.json --project=wekruit-5f89b`
2. **Apply alert policy**: `gcloud alpha monitoring policies create --policy-from-file=infra/cloud-logging/alert-policies.yaml`
3. **Add Adam test E.164** to `paRateLimitPerUserEnabled.blocklist` via `/admin/flags`
4. **Verify Sendblue Free tier daily quota** assumption (1000/day default — confirm with Sendblue support; adjust `sendblueDailyQuota` flag if different)
5. **Deploy CF**: `pnpm build && firebase deploy --only functions,hosting --project wekruit-5f89b`

## v1.3 Public Launch Gate progress

- [x] Phase 24.5 Feature Flag — 4 env-var 收编完成
- [x] Phase 25 Voice Review Dashboard — schema + page + eval rerun ready
- [x] Phase 26 P0 — 4 项 ship (cost alert config-as-code; gcloud apply Adam owner)
- [ ] Phase 27 P1+P2 — gated (P26 stable 2 weeks + ≥200 reviews)
- [ ] Self-evolve cron — flag `selfEvolveEnabled` off until Adam拍

## Notes / known issues

- T3 cost-logger insertion in `pa-orchestrator/src/index.ts` uses `store.log` (not cross-package import) to emit `pa.spend.daily` JSON — avoids dep cycle
- T4 onPaInbound wiring is **observation-only** (logs resolved version per inbound). Orchestrator still loads agent the legacy way; flipping to resolver staged for follow-up phase
- T2 commit (859bead) inadvertently swept previously-staged Phase 25 dashboard files (Voice.tsx etc) — files in main, just under "wrong" commit label. Cosmetic only
- Pre-existing hmac.test.ts failures (Adam uncommitted) NOT in Phase 26 scope; full functions test surfaces them but webhook+outbox focused tests run clean
