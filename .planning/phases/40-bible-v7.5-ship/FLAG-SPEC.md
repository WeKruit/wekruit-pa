# Phase 40 T4 — `paHumanizeRuntimeEnabled` Feature Flag Spec

> [🟠 阿里味] **抓手清晰**: 一个 umbrella flag 控制 Phase 35-38 + Phase 40 prefix-cache 的 production 激活. Default 0% bucket. Adam 通过 dashboard / `setFlag` SDK 控制 1/10/50/100% rollout. **闭环到底**: kill switch 也定义好了.

**Owner:** P9-C (Phase 40 T4)
**Adam-owed:** apply via `admin-bootstrap.ts` SEED_FLAGS (consolidated in WIRE-IN-PATCH.md Section 8).

---

## 1. Flag definition

```ts
// admin-bootstrap.ts SEED_FLAGS append entry
{
  key: "paHumanizeRuntimeEnabled",
  value: false,                         // default OFF for all users
  type: "bool",
  scope: "perUser",                     // allowlist beats blocklist beats default
  allowlist: [],                        // Adam fills via dashboard at rollout time
  blocklist: [],
}
```

| Field | Value | Why |
|-------|-------|-----|
| `key` | `paHumanizeRuntimeEnabled` | Standard Phase 24.5 camelCase boolean key naming |
| `type` | `bool` | Compatible with `getFlag()` return + supports `bucketStrategy.variants[].value` of boolean |
| `scope` | `perUser` | Allowlist for early beta users (Adam's cohort); blocklist for ban abusers |
| `value` | `false` | Default OFF — 0% bucket = nobody gets the v1.4 humanize stack until Adam ramps |
| `allowlist` | `[]` | Adam fills with internal-test phone numbers at rollout time |
| `blocklist` | `[]` | Reserved for emergency disable per-user |

---

## 2. Rollout BucketStrategy cookbook

Adam controls ramp via `setFlag(db, "paHumanizeRuntimeEnabled", false, opts)`
where `opts.bucketStrategy.variants[].weight` defines the % rollout.
**Always supply `actor` + `reason` for the audit row.**

### 2.1 — Phase 0 (default — no rollout) — installed by SEED_FLAGS

`paHumanizeRuntimeEnabled = false` for everyone (no bucketStrategy).
Equivalent to all users seeing legacy behavior. Phase 35-38 modules built but inactive.

### 2.2 — Phase 1 (1% rollout) — first canary

```ts
import { setFlag } from "@pa/pa-persistence/feature-flags"

await setFlag(db, "paHumanizeRuntimeEnabled", false, {
  actor: "adam@wekruit.com",
  reason: "Phase 40 T4 rollout — 1% canary (humanize-runtime first prod traffic)",
  bucketStrategy: {
    method: "userIdHash",     // deterministic per-user — same user always same arm
    variants: [
      { name: "off", weight: 99, value: false },
      { name: "on",  weight: 1,  value: true  },
    ],
  },
})
```

**Monitor for 24h:** dashboard 5 metrics — AI tell-tale rate / drift_p95 / length_compliance / repeat_advice / latency_p99. Hold position if any metric regresses vs baseline-rev00056.md.

### 2.3 — Phase 2 (10% rollout)

```ts
await setFlag(db, "paHumanizeRuntimeEnabled", false, {
  actor: "adam@wekruit.com",
  reason: "Phase 40 T4 rollout — 10% (1% canary clean for 24h)",
  bucketStrategy: {
    method: "userIdHash",
    variants: [
      { name: "off", weight: 90, value: false },
      { name: "on",  weight: 10, value: true  },
    ],
  },
})
```

### 2.4 — Phase 3 (50% rollout)

```ts
await setFlag(db, "paHumanizeRuntimeEnabled", false, {
  actor: "adam@wekruit.com",
  reason: "Phase 40 T4 rollout — 50% (10% clean for 48h)",
  bucketStrategy: {
    method: "userIdHash",
    variants: [
      { name: "off", weight: 50, value: false },
      { name: "on",  weight: 50, value: true  },
    ],
  },
})
```

### 2.5 — Phase 4 (100% rollout — full deploy)

```ts
await setFlag(db, "paHumanizeRuntimeEnabled", true, {
  actor: "adam@wekruit.com",
  reason: "Phase 40 T4 rollout — 100% (50% clean for 72h, all 5 metrics within target)",
  bucketStrategy: null,  // remove bucket — direct boolean true
})
```

After 100% hold-stable for 1 week, the bucketStrategy can be permanently retired and `paHumanizeRuntimeEnabled` flag itself can be deprecated (kept as kill switch).

---

## 3. Kill switch (emergency)

If 5-metric monitoring shows regression at ANY rollout phase:

### 3.1 — Dashboard kill (preferred)

`/admin/flags` → `paHumanizeRuntimeEnabled` → set value `false`, no bucketStrategy.
TTL 30s — all CFs see the new value within 30 seconds.

### 3.2 — Env kill (fastest, no Firestore dependency)

Set `PA_FUNCTIONS` env var `paHumanizeRuntimeEnabled=1` to FORCE TRUE (legacy emergency override per Phase 24.5 SDK).

Wait — that's the ENABLE override. For DISABLE we use:

`PA_HUMANIZE_RUNTIME_DISABLED=true` env var — short-circuited at the wire-in call site (see WIRE-IN-PATCH.md Section 6) BEFORE the Firestore `getFlag()` lookup. Restart of CFs picks it up; faster than Firestore propagation if Firestore itself is degraded.

### 3.3 — Per-user blocklist (surgical kill)

```ts
await setFlag(db, "paHumanizeRuntimeEnabled", false, {
  actor: "adam@wekruit.com",
  reason: "kill switch — user X reporting regression",
  blocklist: ["+19999990001"],  // user phone number
})
```

Blocklist beats allowlist beats bucket beats default (per Phase 24.5 SDK).

---

## 4. Wire-in call site (where the flag is checked)

Inside `voice/llm-rewriter.ts` `rewriteIfOff` — gates Phase 35-38 module activation + Phase 40 prefix-cache. Full wire-in spec in `WIRE-IN-PATCH.md` Section 6.

Pseudo-code:

```ts
// Inside rewriteIfOff, before detector pass + after rewrite:
const humanizeRuntimeEnabled = await getFlag(
  db,
  "paHumanizeRuntimeEnabled",
  { userId, env: process.env }
)
if (!humanizeRuntimeEnabled) {
  // Pre-Phase-40 behavior — skip detectors, skip imperfection-injector,
  // skip FSM directive, skip memory-policy, skip prefix-cache.
  return { text: cleaned, rewriteApplied: true, reason: "rewritten" }
}
// Else: full v1.4 humanize stack — detectors → injector → FSM → memory → cache.
```

Within the same flag, individual sub-flags can stay (`PA_DETECTORS_ENABLED`,
`PA_FSM_ENABLED`, etc.) for surgical rollback of one component without
disabling the umbrella. Standard pattern: umbrella + sub-flags both default
OFF in seed; both flip ON together at full rollout.

---

## 5. Validation checklist (Adam pre-rollout)

- [ ] `migrate-bible-v7.5-to-handbook --live` ran successfully (handbook v2 in Firestore)
- [ ] WIRE-IN-PATCH.md Sections 1-7 applied to llm-rewriter.ts (Phase 35+36+37+38+40 wire-ins)
- [ ] SEED_FLAGS append entry merged + `paAdminBootstrap?action=seedFlags` ran
- [ ] Phase 39 external benchmarks (Adam-owed) ran + Claire stack ≥ Qwen-72B raw on ≥ 1 of 5
- [ ] Phase 40 final-audit-report.md metric 1+2+4 PASS (deterministic gates)
- [ ] Adam P0 LLM judge budget approved + metric 3 baseline locked (target ≥ 70%)
- [ ] Adam P1 BGE_API_KEY wired + metric 5 baseline locked (target < 5%)
- [ ] Crisis red-team auto-test (Phase 40 T3) wired into CI — fail-build on < 20/20

After all checkboxes: ship Phase 1 (1% canary) per §2.2.

---

> [🟠 阿里味] **闭环到底**: 一个 umbrella flag + 4 ramp phases + 3 kill switches + 7 pre-rollout checks. Adam 拿这份就能 ship. 证据说话.
