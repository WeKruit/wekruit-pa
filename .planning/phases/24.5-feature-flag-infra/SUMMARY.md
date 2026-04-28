# Phase 24.5 — Feature Flag Infra (SUMMARY)

**Status:** Shipped 2026-04-28
**Owner:** P9-Infra (autonomous via 2 parallel P8 agents)

## Commits (4)

| Task | Hash | Description |
|---|---|---|
| T1 | `2339ed8` | pa_feature_flags SDK + 30s TTL cache + audit |
| T2 | `c220d2b` | migrate 4 env-vars to getFlag() |
| T3 | `534adbc` | /admin/flags dashboard page |
| T4 | `f7008b4` | seed-feature-flags script + Adam runbook |

## Verification (P9 acceptance gate, all green)

- `pnpm --filter @pa/pa-persistence test` → 11 pass / 0 fail (cache hit-rate 0.990 ≥ 0.95 target)
- `pnpm --filter @pa/pa-orchestrator test` → 151 pass / 0 fail
- `pnpm --filter @pa/functions` build exit 0; tests pass (hmac.test.ts pre-existing failure from Adam uncommitted, not Phase 24.5)
- `pnpm --filter @pa/dashboard-web build` + typecheck exit 0
- `grep` confirms 0 `process.env.PA_*` reads in non-test source outside SDK
- Adam's 3 uncommitted files (`apps/functions/build.mjs` / `sendblue/hmac.ts` / `sendblue/webhook.ts`) byte-identical to start

## Adam owner steps (post-merge)

1. **Configure Firestore TTL** on `pa_rate_limit` collection's `expiresAt` field (Phase 26 dependency)
2. **Run seed live**: `pnpm exec tsx apps/functions/scripts/seed-feature-flags.ts` (drops `--dry-run`) — creates 6 initial flags
3. **Add Adam test number** to `paRateLimitPerUserEnabled.blocklist` via `/admin/flags` UI
4. **Deploy CF**: `firebase deploy --only functions:pa-orchestrator --project wekruit-5f89b`

## Notes

- Voice mirror migration is pure wrapper: new `isVoiceMirrorDisabledFlag(db, env)` async helper added next to existing sync `isVoiceMirrorDisabled(env)`; orchestrator calls flag wrapper BEFORE `computeMirrorForTurn`, leaving that function's logic untouched
- T2 added optional `db?: Firestore` field to `SweepStore`/`ProactiveTurnStore`/`OrchestratorStore` so production wires live handle while existing test fakes get `makeNoopFirestoreForFlag()` stub for env-emergency-override
- `paRateLimitPerUserEnabled` reading site wired in `onPaInbound` with telemetry-only `logger.debug`; Phase 26 enforces
