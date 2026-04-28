# Phase 24.5 — PLAN (P8 execution)

**Topology:** 4 sub-tasks, **serial in a single P8** (general-purpose). Strong dependency chain — parallel would need stubs.

## Sub-task breakdown (4 commits)

### T1: SDK + Firestore schema + cache + unit tests
**Files:** `packages/pa-persistence/src/feature-flags.ts` (new), `packages/pa-persistence/src/feature-flags.test.ts` (new), `packages/pa-persistence/src/index.ts` (export only)

Deliverables:
- `getFlag(key, ctx?: { userId?, env? }): Promise<FlagValue>` — Firestore read with 30s TTL Map cache + env-var emergency override (env=`1` → return `true` as bool)
- `setFlag(key, value, opts: { actor, reason })` — write flag + audit event in single transaction
- `revertFlag(key, opts: { actor, reason })` — read last audit event for key, write back oldValue
- Cache: `Map<string, { value: FlagValue, expiresAt: number }>`, key includes ctx hash for perUser
- perUser resolution: blocklist beats allowlist beats default value
- Unit tests: cache hit ≥95% over 1000 calls, perUser blocklist precedence, env override, ttl expiry, revert reads correct prev value

DONE:
- `npm run test --workspace=@pa/pa-persistence` 全绿 + cache hit-rate 测试 ≥95%
- `npm run typecheck --workspace=@pa/pa-persistence` 无报错
- `npm run build --workspace=@pa/pa-persistence` 成功

Commit msg: `feat(24.5/T1): pa_feature_flags SDK + 30s TTL cache + audit (P9-Infra)`

### T2: CF migration — 4 env-var sites → getFlag()
**Files:**
- `apps/functions/src/sendblue/outbox.ts` (PA_CHANNEL_LEGACY)
- `apps/functions/src/proactive-sweep.ts` (PA_PROACTIVE_DISABLED)
- `packages/pa-orchestrator/src/index.ts` + `packages/pa-orchestrator/src/voice/mirror-injection.ts` (PA_VOICE_MIRROR_DISABLED) — **CHECK git status — voice files have uncommitted Adam work, ONLY add getFlag wrapper, do not touch existing logic**
- `apps/functions/src/index.ts` (new entry for `paRateLimitPerUserEnabled` — wire reading site only, actual rate-limit enforcement is Phase 26)

Pattern: replace `process.env.X === "1"` with `await getFlag('X', { env: process.env })`. Keep env-var as emergency override INSIDE getFlag (already SDK behavior from T1) — call sites just call getFlag. Existing tests must keep passing (env-var sets still work via override).

DONE:
- `npm run test --workspace=@pa/functions` 全绿
- `npm run test --workspace=@pa/pa-orchestrator` 全绿
- `npm run build --workspace=@pa/functions` 成功
- grep: zero `process.env.PA_CHANNEL_LEGACY` outside `feature-flags.ts` (other than tests)
- Adam's uncommitted voice/sendblue files diff stays minimal (only added await getFlag wrappers, no logic change)

Commit msg: `feat(24.5/T2): migrate 4 env-vars to getFlag() (P9-Infra)`

### T3: Dashboard /admin/flags page
**Files:**
- `apps/dashboard-web/src/pages/Flags.tsx` (new)
- `apps/dashboard-web/src/lib/flags-api.ts` (new — Firestore client wrapper)
- `apps/dashboard-web/src/App.tsx` (add route + nav link)

Deliverables:
- List all flags from `pa_feature_flags` collection
- Inline edit value (type-aware: checkbox for bool, input for string/number, JSON textarea for json)
- Edit allowlist/blocklist (chip input for perUser scope)
- "Revert to previous" button (reads last audit row, calls revertFlag)
- Audit history drawer per-flag (last 20 events)
- Save action calls Firestore write directly using existing dashboard auth (callable functions OR direct firestore SDK following existing pattern in `lib/memoryAdmin.ts`)

DONE:
- `npm run build --workspace=@pa/dashboard-web` 成功
- `npm run typecheck --workspace=@pa/dashboard-web` 通过 (NO new TS errors vs main)
- Manual smoke: open /admin/flags, list shows seed flags, edit a bool flag, audit row appears in Firestore (Adam will validate post-deploy)

Commit msg: `feat(24.5/T3): /admin/flags dashboard page (P9-Infra)`

### T4: Initial flag seeding script + final integration test
**Files:**
- `apps/functions/scripts/seed-feature-flags.ts` (new — idempotent seed; only writes if doc absent)
- `.planning/phases/24.5-feature-flag-infra/SEED.md` (Adam runbook for first deploy)

Seeds 6 flags listed in CONTEXT.md "Initial flag seeds" table.

DONE:
- `npm exec --workspace=@pa/functions -- tsx scripts/seed-feature-flags.ts --dry-run` prints planned writes (NOT executed — Adam runs live)
- SEED.md documents: (a) how to run seed live, (b) emergency env-var override syntax, (c) how to verify Adam test number bypass

Commit msg: `feat(24.5/T4): seed-feature-flags script + Adam runbook (P9-Infra)`

## Final integration verification (P9 acceptance gate)

After all 4 commits, P9 runs:

```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa
npm run test --workspace=@pa/pa-persistence
npm run test --workspace=@pa/functions
npm run test --workspace=@pa/pa-orchestrator
npm run build --workspace=@pa/dashboard-web
npm run typecheck --workspace=@pa/dashboard-web
npm exec --workspace=@pa/functions -- tsx apps/functions/scripts/seed-feature-flags.ts --dry-run
git log --oneline -10
git status
```

All green + 4 commits visible + sendblue/voice uncommitted Adam work UNTOUCHED → ship.

## Estimated time

1.5–2 dev-day. Single P8, sonnet/inherit, no model upgrade.
