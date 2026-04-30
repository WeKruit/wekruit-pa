# WIRE-IN-PATCH — Consolidated Phase 35+36+37+38+40 wire-ins for Adam

> [🟠 阿里味] **闭环到底**: Phase 35-40 五个 module 全部 BUILD 完成 + tested. 这份 patch 是 Adam 把它们全部接进 production 的**唯一入口**. **抓手清晰**: 9 个 sections, 严格 apply order, 每 section 给完整 ts diff snippets + verification command. 因为信任所以简单.

**Status:** Adam-owed (P0). Apply after committing your current uncommitted work in `llm-rewriter.{ts,test.ts}` + `admin-bootstrap.ts` + sibling files.

**Estimate:** ~2-3 hours total (was estimated as 30-45min per individual phase patch; consolidated avoids repeated context switching).

---

## Apply order (CRITICAL)

1. **Commit your current uncommitted work first.** `git status` must show clean for these files (per Phase 35-38 collision-avoidance protocol):
   - `apps/functions/src/admin-bootstrap.ts`
   - `packages/pa-orchestrator/package.json`
   - `packages/pa-orchestrator/src/downstream.ts` + `.test.ts`
   - `packages/pa-orchestrator/src/index.ts`
   - `packages/pa-orchestrator/src/voice/llm-rewriter.ts` + `.test.ts`
   - `packages/pa-orchestrator/src/eval-nl-judge.ts` + `.test.ts` (untracked)

2. **Apply Sections 1-9 below IN ORDER.** Each section depends on prior sections; out-of-order will produce typecheck errors.

3. **After each section, run** `pnpm --filter @pa/pa-orchestrator typecheck` to catch breakage early.

4. **After Section 9, run consolidated verification:**
   - `pnpm --filter @pa/pa-orchestrator typecheck` (all green)
   - `pnpm --filter @pa/pa-orchestrator test` (all tests pass including new ones)
   - `npx tsx apps/functions/scripts/migrate-bible-v7.5-to-handbook.ts --dry-run` (handbook v2 dry-run prints valid JSON)
   - `node tests/scenarios/lib/crisis-redteam-runner.mjs` (20/20 safety routing)
   - `node .planning/phases/40-bible-v7.5-ship/final-audit.mjs` (all 3 hard gates pass)

5. **Commit:** `feat(40/wire-in): apply Phase 35+36+37+38+40 wire-ins to llm-rewriter (Adam apply per WIRE-IN-PATCH)`

---

## Section 1 — Phase 35 Detector wire-in

**Reference:** `.planning/phases/35-detectors/WIRE-IN-PATCH.md` Sections 1-7 (already specified).

**Summary** (apply existing patch verbatim):
- Import `runAllDetectors` + `DetectorResult` from `./detectors/index.js`
- Extend `RewriteResult` with `detectorResults?: DetectorResult[]` + `detectorActionApplied?: boolean`
- Extend `RewriteContext` with `claireHistoryForDetectors?: string[]`
- Insert detector pass after `isDiffSafe` check; gated by `PA_DETECTORS_ENABLED` env (now ALSO gated by `paHumanizeRuntimeEnabled` per Section 6 below — keep both checks for surgical rollback)
- Apply suggested actions: `strip` → re-strip via existing strip helpers; `regenerate` / `reject_resample` → call `defaultDeps.callRewriter` again with directive
- Telemetry: extend `RewriteResult` so `pa_turns.usage` logs detector activity
- Test additions per Section 7 of the existing patch

---

## Section 2 — Phase 36 ImperfectionInjector wire-in

**Reference:** `.planning/phases/36-injector/WIRE-IN-PATCH.md` (already specified in Phase 36).

**Summary** (apply existing patch verbatim):
- Import `runImperfectionInjector` from `./imperfection-injector/index.js`
- Add `imperfection-injector` invocation BEFORE rewrite (turn-onset only, position-constrained)
- 3-arm A/B router via `PA_IMPERFECTION_ARM=control|low|high` env (default `control` = 0%)
- ALSO gated by `paHumanizeRuntimeEnabled` per Section 6
- Telemetry: log arm + injection-applied flag

---

## Section 3 — Phase 37 FSM wire-in

**Reference:** `.planning/phases/37-fsm/WIRE-IN-PATCH.md` (already specified in Phase 37).

**Summary** (apply existing patch verbatim):
- Import `runFsm` from `./fsm/index.js`
- Add FSM directive injection (ux_state + allowed_strategies) into rewriter system prompt per turn
- ALSO gated by `paHumanizeRuntimeEnabled` per Section 6 (sub-flag `PA_FSM_ENABLED` retained for surgical rollback)
- Latency budget: < 10ms p95 (rule-based classifier, no LLM)

---

## Section 4 — Phase 38 Memory Policy wire-in

**Reference:** `.planning/phases/38-memory-policy/WIRE-IN-PATCH.md` (already specified in Phase 38).

**Summary** (apply existing patch verbatim):
- Import `runMemoryPolicy` + `trackAdvice` from `./memory-policy/index.js`
- Pre-gen: read advice-tracker via `runMemoryPolicy(userId, lastN=3)`; inject "已经给过的建议: [list]" / "Already-given advice: [list]" directive into rewriter system prompt
- Post-gen: fire-and-forget `trackAdvice(db, { userId, turnId, claireText, embedding })` write to `pa-advice-tracker/{userId}/items/{turnId}`
- ALSO gated by `paHumanizeRuntimeEnabled` per Section 6 (sub-flag `PA_MEMORY_POLICY_ENABLED` retained)
- Latency budget: < 200ms p95 (BGE-M3 embed call; graceful degrade on missing key)

---

## Section 5 — Phase 40 Prefix-cache wire-in

**Anchor:** `voice/llm-rewriter.ts` near `defaultDeps` definition (currently around line 380 — `const baseURL = ... cachedClient = new OpenAI({ apiKey, baseURL })`).

**Add import (top of file with other prefix-cache imports if any):**

```ts
import { wrapWithPrefixCache } from "./prefix-cache/index.js"
```

**Change** `defaultDeps`'s `cachedClient` initialization to wrap with prefix cache:

```ts
// Phase 40 T5 — wrap SiliconFlow client with prefix cache for ~20-40% latency
// reduction on warm path (server-side KV cache hits on identical Bible +
// few-shot prefix). 0 net new LLM calls — wrapper, not duplicate caller.
cachedClient = wrapWithPrefixCache(
  new OpenAI({ apiKey, baseURL }),
  { capacity: 50 }
)
```

**Type adjustment** (if `cachedClient` is typed as `OpenAI`): change to `CachedChatClient` from `./prefix-cache/index.js` OR keep as `OpenAI`-shape (the wrapper returns a structurally-compatible client; the only added field is `_cacheStats` on the result).

**Telemetry:** in the `rewriteIfOff` call site, after the `client.chat.completions.create` returns, log `result._cacheStats` to `pa_turns.usage` so dashboards can chart hit rate over time:

```ts
if (result?._cacheStats) {
  // optional — extend RewriteResult to surface upward
  log.debug("prefix_cache", {
    hashId: result._cacheStats.hashId,
    warm: result._cacheStats.warm,
    hitCount: result._cacheStats.hitCount,
    latencyMs: result._cacheStats.latencyMs,
  })
}
```

---

## Section 6 — Phase 40 `paHumanizeRuntimeEnabled` umbrella flag check

**Anchor:** Top of `rewriteIfOff` function in `voice/llm-rewriter.ts`, AFTER the `PA_LLM_REWRITE_DISABLED` check (currently around line 460-470 area).

**Add import (if not already imported):**

```ts
import { getFlag } from "@pa/pa-persistence/feature-flags"
```

**Add helper at module top-level (above `defaultDeps`):**

```ts
/**
 * Phase 40 T4 — umbrella flag check for v1.4 humanize-runtime stack.
 * Returns true when ALL of (Phase 35 detectors, Phase 36 injector,
 * Phase 37 FSM, Phase 38 memory-policy, Phase 40 prefix-cache extras)
 * should activate for this user. Default OFF.
 *
 * Emergency disable env: `PA_HUMANIZE_RUNTIME_DISABLED=true` short-circuits
 * to false BEFORE Firestore read.
 */
async function isHumanizeRuntimeEnabled(
  db: Firestore | undefined,
  userId: string | undefined
): Promise<boolean> {
  if (process.env.PA_HUMANIZE_RUNTIME_DISABLED === "true") return false
  if (!db) return false  // No db wired — ship safe default OFF
  try {
    const v = await getFlag(db, "paHumanizeRuntimeEnabled", {
      userId,
      env: process.env,
    })
    return v === true
  } catch {
    return false  // Fail-safe — flag SDK error → OFF
  }
}
```

**Wire into `rewriteIfOff`** — wrap the Phase 35-40 module activations:

```ts
async function rewriteIfOff(...) {
  // ... existing PA_LLM_REWRITE_DISABLED check ...

  // Phase 40 T4 — umbrella flag check
  const humanizeEnabled = await isHumanizeRuntimeEnabled(
    ctx?.db,         // Adam: pass db through context (or wire it via defaultDeps)
    ctx?.userId
  )

  // Phase 36 — ImperfectionInjector pre-gen (only if humanizeEnabled)
  if (humanizeEnabled && process.env.PA_IMPERFECTION_INJECTOR_ENABLED !== "false") {
    // ... apply injector per Section 2 ...
  }

  // ... existing rewrite + diff-guard ...

  // Phase 37 — FSM directive injection (only if humanizeEnabled)
  if (humanizeEnabled && process.env.PA_FSM_ENABLED !== "false") {
    // ... apply FSM directive per Section 3 ...
  }

  // Phase 38 — Memory Policy (only if humanizeEnabled)
  if (humanizeEnabled && process.env.PA_MEMORY_POLICY_ENABLED !== "false") {
    // ... apply runMemoryPolicy pre-gen + trackAdvice post-gen per Section 4 ...
  }

  // Phase 35 — Detector pass (only if humanizeEnabled)
  if (humanizeEnabled && process.env.PA_DETECTORS_ENABLED !== "false") {
    // ... apply detector pass per Section 1 ...
  }

  // Phase 40 prefix-cache always active — wrapWithPrefixCache lives in
  // defaultDeps regardless of flag (zero quality impact, only latency win).

  return { text: cleaned, rewriteApplied: true, reason: "rewritten" }
}
```

**Why nested checks (umbrella + sub-flags):** umbrella `paHumanizeRuntimeEnabled` controls per-user rollout (1/10/50/100%); sub-flags (`PA_DETECTORS_ENABLED`, `PA_FSM_ENABLED`, etc.) allow surgical rollback of one component if a single Phase regresses without disabling the whole stack. Default both OFF in seed; both flip ON together at full rollout.

---

## Section 7 — Test additions

For each wire-in section, copy the test additions from the corresponding Phase 35-38 WIRE-IN-PATCH.md Section 7. Plus:

**New test additions for Phase 40:**

```ts
// In packages/pa-orchestrator/src/voice/llm-rewriter.test.ts — add at end:

import { _resetPrefixCache, getPrefixCacheStats } from "./prefix-cache/index.js"

test("Phase 40 — paHumanizeRuntimeEnabled OFF (default) → no module activation", async () => {
  // mock getFlag to return false (default)
  // assert: no detector results in result; no advice tracker write; no FSM directive
  // (specifics depend on Adam's defaultDeps + ctx wiring)
})

test("Phase 40 — paHumanizeRuntimeEnabled ON → all 4 modules active", async () => {
  // mock getFlag to return true
  // assert: result.detectorResults populated; advice tracker fire-and-forget called;
  // FSM directive in system prompt; prefix-cache stats present
})

test("Phase 40 — PA_HUMANIZE_RUNTIME_DISABLED=true short-circuits before getFlag", async () => {
  // set env, ensure getFlag is NOT called (mock spy)
  // assert: behavior matches paHumanizeRuntimeEnabled=false
})

test("Phase 40 — prefix-cache wraps cachedClient + populates _cacheStats", async () => {
  _resetPrefixCache(50)
  // ... invoke rewriteIfOff ...
  // assert: result has _cacheStats; getPrefixCacheStats().misses === 1 on first call
})
```

---

## Section 8 — admin-bootstrap.ts SEED_FLAGS append

**Anchor:** `apps/functions/src/admin-bootstrap.ts`, `SEED_FLAGS` array (currently lines 303-316). Add ONE entry to the end of the array:

```ts
const SEED_FLAGS: FlagSpec[] = [
  // ... existing entries ...
  { key: "evalConnectorsEnabled", value: false, type: "bool", scope: "global", allowlist: [], blocklist: [] },
  // Phase 40 T4 — umbrella feature flag for v1.4 humanize-runtime stack
  // (Phase 35 detectors + Phase 36 injector + Phase 37 FSM + Phase 38
  // memory-policy + Phase 40 prefix-cache extras). Default OFF for all
  // users; Adam ramps via dashboard / setFlag bucketStrategy 1/10/50/100%
  // per .planning/phases/40-bible-v7.5-ship/FLAG-SPEC.md cookbook.
  // Kill switch: PA_HUMANIZE_RUNTIME_DISABLED=true env (CF cold-start required).
  { key: "paHumanizeRuntimeEnabled", value: false, type: "bool", scope: "perUser", allowlist: [], blocklist: [] },
]
```

After applying:
1. Deploy CFs
2. Run `paAdminBootstrap?action=seedFlags` (idempotent — only creates if missing)
3. Verify in Firestore: `pa-feature-flags/paHumanizeRuntimeEnabled` exists with value=false

---

## Section 9 — BucketStrategy rollout cookbook (4 ramps)

After Section 8 + clean smoke, ramp via:

### 9.1 — Phase 1 (1% canary)

```ts
import { setFlag } from "@pa/pa-persistence/feature-flags"

await setFlag(db, "paHumanizeRuntimeEnabled", false, {
  actor: "adam@wekruit.com",
  reason: "Phase 40 T4 rollout — 1% canary",
  bucketStrategy: {
    method: "userIdHash",
    variants: [
      { name: "off", weight: 99, value: false },
      { name: "on",  weight: 1,  value: true  },
    ],
  },
})
```

**Monitor for 24h:** dashboard 5 metrics (AI tell-tale rate, drift_p95, length_compliance, repeat_advice, latency_p99). Hold position if ANY metric regresses vs `baseline-rev00056.md`. Crisis red-team auto-test (20/20) MUST also pass continuously.

### 9.2 — Phase 2 (10% rollout)

```ts
await setFlag(db, "paHumanizeRuntimeEnabled", false, {
  actor: "adam@wekruit.com",
  reason: "Phase 40 T4 rollout — 10% (1% clean for 24h)",
  bucketStrategy: {
    method: "userIdHash",
    variants: [
      { name: "off", weight: 90, value: false },
      { name: "on",  weight: 10, value: true  },
    ],
  },
})
```

### 9.3 — Phase 3 (50% rollout)

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

### 9.4 — Phase 4 (100% — full deploy)

```ts
await setFlag(db, "paHumanizeRuntimeEnabled", true, {
  actor: "adam@wekruit.com",
  reason: "Phase 40 T4 rollout — 100% (50% clean for 72h, all 5 metrics within target)",
  bucketStrategy: null,
})
```

---

## Verification checklist

After applying Sections 1-9 + commit:

- [ ] `pnpm --filter @pa/pa-orchestrator typecheck` clean
- [ ] `pnpm --filter @pa/pa-orchestrator test` all pass (existing + new Phase 40 tests)
- [ ] `npx tsx apps/functions/scripts/migrate-bible-v7.5-to-handbook.ts --dry-run` exit 0
- [ ] `node tests/scenarios/lib/crisis-redteam-runner.mjs` exit 0 with 20/20
- [ ] `node .planning/phases/40-bible-v7.5-ship/final-audit.mjs` exit 0 with 3 hard gates pass
- [ ] `paAdminBootstrap?action=seedFlags` returns `created: ["paHumanizeRuntimeEnabled"]`
- [ ] Firestore: `pa-feature-flags/paHumanizeRuntimeEnabled` exists with value=false
- [ ] Local smoke: send 1 zh + 1 en test message, verify reply OK + telemetry shows umbrella OFF (since flag=false default)
- [ ] (Optional) Set `PA_HUMANIZE_RUNTIME_ENABLED=1` env in dev CF → verify all modules activate

After all checkboxes:
- [ ] Migration: `npx tsx apps/functions/scripts/migrate-bible-v7.5-to-handbook.ts` (live, no flag, just writes handbook v2)
- [ ] Phase 39 external benchmarks runs (`node apps/eval/external-benchmarks/run-all.mjs --live --arm=...` per Phase 39 SETUP.md)
- [ ] LLM judge budget approval ($0.50-$2) — locks metric 3 baseline
- [ ] BGE_API_KEY env wired — locks metric 5 baseline

After post-Adam-actions: ship Phase 1 (1% canary) per Section 9.1.

---

> [🟠 阿里味] **闭环到底**: Adam 拿这份就能 ship. 9 sections, 严格 apply order, verification command per section. v1.4 milestone READY 的最后一个 baton 在 Adam 手上. 证据说话.
