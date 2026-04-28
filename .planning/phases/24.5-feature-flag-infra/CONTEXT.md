# Phase 24.5 — Feature Flag Infrastructure (CONTEXT)

**Owner P9:** P9-Infra (autonomous)
**P10 strategy:** `.planning/v1.2-p10-strategic-cut.md` (locked 2026-04-28)
**ROADMAP entry:** `.planning/ROADMAP.md` lines 369-383

## 底层逻辑 (P10 quote)

> 散点 env-var 不能管 perUser flag, 必须收编成 feature flag infra. 横线 cross-cutting, 必须先 land. P26 rate-limit / P25 dashboard toggle / P27 self-evolve enable 都调 `getFlag()`.

## Schema (locked, do not deviate)

`pa_feature_flags/{key}`:
```
{
  key: string,                                    // doc id
  value: boolean | string | number | object,
  type: "bool" | "string" | "number" | "json",
  scope: "global" | "perEnv" | "perUser",
  allowlist: string[],                            // userId[] (perUser)
  blocklist: string[],                            // userId[] (perUser)
  bucketStrategy: BucketStrategy | null,          // optional A/B (24.5/AB)
  updatedAt: Timestamp,
  updatedBy: string,                              // dashboard user email
  reason: string,                                 // free text
  version: number                                 // monotonic, ++ on each write
}
```

`BucketStrategy` (additive, optional — added in P8 24.5/AB, commits
`046eb0e` SDK + `de20938` UI + `<this>` docs):
```
{
  method: "userIdHash" | "random",
  variants: [
    { name: string, weight: number /* 0..100 */, value: FlagValue }
  ]                                               // weights MUST sum to 100
}
```

Resolution order in `getFlag(key, ctx)`:
1. Env emergency override (`process.env[key] === "1" | "true"`)
2. perUser blocklist (returns false)
3. perUser allowlist (returns true)
4. **bucketStrategy** (if present + variants non-empty):
   - `userIdHash`: `djb2(userId + "::" + key) mod 100` → cumulative-weight bucket
     (deterministic — same user always sees same variant; cacheable)
   - `random`: `Math.random() * 100` → bucket (NOT cached — would freeze the
     first roll for the 30s TTL window)
5. Default `doc.value`

Reader tolerates weight drift (sum != 100): the last variant absorbs any gap.
`setFlag` validates `Math.abs(sum - 100) <= 0.01` at write time and throws
otherwise. Existing flag docs without `bucketStrategy` continue to behave
identically — schema is purely additive.

Note (CF propagation): pa-persistence is bundled into Cloud Functions only
when CF is re-deployed. SDK changes (T1) take effect on next CF redeploy;
hosting deploys (T2) deliver the dashboard editor immediately.

`pa_audit_events` (write-only on flag CRUD; reads do NOT audit):
```
{
  actor: string,
  action: "flag.create" | "flag.update" | "flag.revert",
  key: string,
  oldValue: any,
  newValue: any,
  reason: string,
  ts: Timestamp
}
```

## Success criteria (P10 locked)

1. `getFlag(key, ctx)` SDK callable from CF + dashboard-web
2. `pa_feature_flags/{key}` Firestore collection with above schema
3. Dashboard `/admin/flags` page: list / edit / revert / audit history
4. 30s TTL in-memory cache, ≥95% hit rate (unit tested)
5. Migrate 4 env-vars to flags: `PA_CHANNEL_LEGACY` / `PA_PROACTIVE_DISABLED` / `PA_VOICE_MIRROR_DISABLED` / new `paRateLimitPerUserEnabled`. Env retained as emergency override (env=`1` short-circuits flag read)
6. Per-user bypass tested with Adam test number (blocklist takes precedence over allowlist)
7. CRUD writes audit row to `pa_audit_events`

## Architectural decisions (P10 locked)

- **存哪**: Firestore (NOT Remote Config — adds dep surface)
- **缓存**: 30s TTL in-process Map<key, {value, expiresAt}> (NOT 5min — kill-switch can't wait)
- **API**: single `getFlag(key, ctx: { userId?, env? }): Promise<FlagValue>` entry point
- **Emergency override**: env-var = `1` short-circuits to legacy `true`. Allows hot kill-switch without Firestore write.
- **Revert**: dashboard "Revert to previous" reads last `pa_audit_events` row → writes back. ≤30s network-wide propagation.

## Initial flag seeds (must be created on first deploy)

| key | type | scope | default | replaces |
|---|---|---|---|---|
| `PA_CHANNEL_LEGACY` | bool | global | `true` (current macOS-worker authority) | env `PA_CHANNEL_LEGACY` |
| `PA_PROACTIVE_DISABLED` | bool | global | `false` | env `PA_PROACTIVE_DISABLED` |
| `PA_VOICE_MIRROR_DISABLED` | bool | global | `false` | env `PA_VOICE_MIRROR_DISABLED` |
| `paRateLimitPerUserEnabled` | bool | perUser | `true` (Adam test number on blocklist) | (new — Phase 26 input) |
| `selfEvolveEnabled` | bool | global | `false` (Phase 27 hard-gate) | (new — Phase 27 input) |
| `voiceEvalAutoRerun` | bool | global | `false` (Phase 25 input) | (new) |

## Out-of-scope (DO NOT do)

- DO NOT touch sendblue/voice uncommitted Adam work in `git status`
- DO NOT deploy to CF (Adam owner step)
- DO NOT remove env-var fallback (emergency override is intentional)
- DO NOT add Remote Config / LaunchDarkly dep
- DO NOT auto-merge anything

## Risks

- R1: 30s TTL kill-switch perceived slow — mitigation: env-var override + dashboard "Force flush" button (writes a no-op flag bump to invalidate cache)
- R2: perUser flag explosion — mitigation: schema requires explicit allowlist/blocklist (no regex / wildcards in v1)
