# Phase 36 — ImperfectionInjector + 3-arm A/B (D3 + IMPERFECT-01..07) — CONTEXT

> [🟠 阿里味] **底层逻辑**：Phase 35 给了 4 个 deterministic detector + Phase 33 给了 sentence-split + Phase 34 锁了 baseline。Phase 36 在 detector 出口之上叠 ImperfectionInjector，**纯 post-processing，0 net new LLM call**。3 arm A/B：0 / 15% / 30%。**抓手清晰**：position-constrained turn-onset only，bilingual zh+en，type priority `self_correct > hesitate > clarify > uncertainty`。**不碰 llm-rewriter.ts**——Adam working tree 有 uncommitted 文件，wire-in 走 `WIRE-IN-PATCH.md` 模式（Phase 35 同款）。证据说话。

**Owner:** P9-C (v1.4 humanize-runtime stream)
**Estimate:** ~1 dev-day
**Upstream gate:** Phase 35 detectors locked (`packages/pa-orchestrator/src/voice/detectors/`)
**Downstream:** Phase 37 FSM (depends on injector arm decision being stable), Phase 40 ship (feature flag wiring)

---

## 1. Phase boundary

### In scope (IMPERFECT-01..07)

Standalone injector module under `packages/pa-orchestrator/src/voice/imperfection-injector/` — TypeScript, 0 net new LLM calls (pure post-processing), < 5ms per turn.

Files to ship:

| File | Role |
|------|------|
| `types.ts` | `InjectorContext` + `InjectorResult` + `InjectorArm` + `InjectionType` + `InjectionPosition` types |
| `policies-zh.ts` | Chinese policies — turn-onset filler / hesitate / self-correct / uncertainty patterns. NEW human tells (`嗯`, `哦`, `让我想想`, `等等`, `啊不对，是…`, `说不清是不是…`). **NOT FILLER_BLACKLIST_ZH** (anti-pattern hard-blocked) |
| `policies-en.ts` | English policies — `hmm`, `wait`, `actually`, `let me think`, `oh —`, `I mean`, `not sure if`, `wait no, *X`. **NOT FILLER_BLACKLIST_EN** |
| `position-constraint.ts` | Verifies injection at turn-onset only (mid-clause forbidden per D3 + Pinguet 2023). Uses `splitSentences` from Phase 33 sentence-split for bilingual onset detection |
| `arm-router.ts` | Bucketed user-id sticky assignment (`hash(userId) % 100 → arm`); env override `PA_IMPERFECTION_ARM=off|low|high` for testing; ratios off=0% / low=15% / high=30% |
| `injector.ts` | `injectImperfection(text, opts) → InjectorResult` orchestrator. Type priority `self_correct > hesitate > clarify > uncertainty`. Returns `{ arm, original, injected, injection_type, position, applied }` |
| `index.ts` | Barrel + `DEFAULT_POLICIES_ZH` / `DEFAULT_POLICIES_EN` re-exports + main `injectImperfection` entry |
| `*.test.ts` per file | Unit tests — bilingual edge cases, blacklist guard, position constraint, arm probability sanity (1000-sample) |

Plus A/B harness:

| File | Role |
|------|------|
| `tests/scenarios/lib/ab-injector-harness.mjs` | Runs 3 arms (`off` / `low` / `high`) per scenario via existing `pairwise-runner` style; aggregates humanness axis deltas; statistical significance via 95% CI bootstrap + per-arm sample-mean diff |
| `tests/scenarios/scenarios/eval-imperfection-arm-zh.yaml` | NEW scenario — `voice_axes_full: true` zh emo support venting (3 turns) for arm comparison |
| `tests/scenarios/scenarios/eval-imperfection-arm-en.yaml` | NEW scenario — `voice_axes_full: true` en tech-deep + venting (3 turns) for arm comparison |

Plus deferred wire-in:

| File | Role |
|------|------|
| `.planning/phases/36-injector/WIRE-IN-PATCH.md` | Markdown spec for `voice/llm-rewriter.ts` showing where to call `injectImperfection` after detector pass + how to feed `userId` for sticky arm assignment + telemetry. **No code change to llm-rewriter.ts in this phase** (Adam working tree collision-avoidance per P10 brief). |

### Out of scope (deferred)

| Item | Defer to | Why |
|------|----------|-----|
| **Wire-in to `voice/llm-rewriter.ts`** | Adam manual apply via `WIRE-IN-PATCH.md` | Adam still has 7 uncommitted files (admin-bootstrap.ts, package.json, downstream.{ts,test.ts}, index.ts, voice/llm-rewriter.{ts,test.ts}, eval-nl-judge.{ts,test.ts}). P9-C MUST NOT touch them — collision risk. |
| **Live A/B run with real LLM** | Adam approval (~$0.50–$2.00 budget) | Harness is built; running it consumes nano calls. P9-C ships harness + dry-run report; Adam authorizes the spend. |
| **Persisted arm assignment** (Firestore-backed sticky bucket) | Phase 38 (Memory Policy) | Phase 36 uses in-memory hash; Phase 38 may persist `pa_users/{uid}.imperfection_arm` for analytics. |
| **Arm-aware detector skipping** (e.g. `low` arm allows mild F1 mirror) | Phase 36 wire-in spec — Adam decides | Detector gate is independent. Injector is layered ON TOP of post-detector text. |
| **Winner deployment + losing-arm code path removal** | Phase 40 (ship) | Per IMPERFECT-07: "losers' code paths kept but disabled". Removed only after final ship audit. |

---

## 2. Methodology — pure post-process, no LLM, position-locked

### Pipeline position

```
LLM rewriter draft → diff guard → detector pass (Phase 35) → injector pass (Phase 36) → final
```

Injector reads:
- `text` — post-detector draft
- `arm` — resolved by `arm-router` from userId (or env override)
- `lang` — auto-detected via Phase 33 / Phase 35 lang detection (CJK char ratio)
- `prevAssistantReply` — last Claire reply in session (for anti-stutter — don't inject if previous turn already started with a hesitate)

Injector emits:
- `injected` text (or original if `arm=off` / probability not hit / blacklist guard fired)
- `applied: boolean`
- `injection_type` ∈ `"self_correct" | "hesitate" | "clarify" | "uncertainty" | null`
- `position` ∈ `"turn_onset" | "none"`

### Position constraint (D3 + Pinguet 2023)

Mid-clause hesitation reduces perceived confidence and breaks Claire's voice. Injection allowed ONLY at `turn_onset` — defined as **before the first sentence** as split by `splitSentences` from Phase 33. The injector prepends the marker (with a separator: `, ` for en, `，` or ` ` for zh) and trims the final string.

Position-constraint helper enforces this — given a (text, marker) pair, returns `{ ok, injected }` where `ok=false` if injection would violate position rules (e.g. text starts with non-letter punctuation, or empty text).

### Type priority (D3 + Schroeder 2024)

Per IMPERFECT-05: the policy chooser respects a strict priority when multiple types fire on the same turn:

```
self_correct (highest) > hesitate > clarify > uncertainty (lowest)
```

Implementation: the policy bank is **ordered**; `chooseInjectionType` picks the first matching policy whose conditions fire AND whose probability draw passes. Exactly ONE injection per turn, period.

### Anti-blacklist guard

Critical: `policies-zh.ts` and `policies-en.ts` MUST NOT use phrases from `FILLER_BLACKLIST_ZH` / `FILLER_BLACKLIST_EN` (`tests/scenarios/lib/voice-axes.mjs:16/49`). The injector test suite includes a guard test that imports both blacklists via dynamic import and asserts no policy marker is a substring of any blacklist phrase — fails build if violated.

### Anti-stutter rule

If `prevAssistantReply` already starts with one of our markers, skip injection on this turn (avoids "嗯 ... 嗯 ... 嗯 ..." patterns over consecutive turns). Cheap O(1) check.

### Arm router

Three arms per IMPERFECT-01:
- `off` → 0% probability (control, baseline)
- `low` → 15% probability per turn
- `high` → 30% probability per turn

Sticky assignment: `hash(userId) % 100 < lowEnd` → low arm; `< highEnd` → high arm; else off. Env `PA_IMPERFECTION_ARM` overrides for tests + Adam manual control. Default ratios for live A/B: 1/3 each (33/33/34) — test harness verifies via 1000-sample stat test.

---

## 3. Decisions (P9-C calls — locked unless Adam vetos)

### D-36-1: Type priority order = self_correct > hesitate > clarify > uncertainty (matches IMPERFECT-05)

Per Schroeder 2024 evidence: corrected typos are most humanizing. Order is strict and enforced by policy bank ordering; first match wins. Injector calls `chooseInjectionType` exactly once per turn.

### D-36-2: Probability per arm — 0 / 15 / 30 (matches D3 + IMPERFECT-01)

Lameris 2412.12710 evidence: even fine-tuned models over-produce 77% imperfection at high rates. 30% is the ceiling — no `extreme` arm. Verified via 1000-sample probability test in injector unit suite (target ratio ±3% absolute = within stat noise).

### D-36-3: Position = turn-onset only (matches D3 + IMPERFECT-02)

Pinguet 2023: mid-clause reduces confidence. Injection prepends marker + separator before first sentence. Position-constraint module is the single enforcement point (no other module may bypass it).

### D-36-4: Anti-blacklist guard is a unit test, not a runtime check

Cheaper to fail at build time. Test imports both `FILLER_BLACKLIST_*` arrays via dynamic import of `tests/scenarios/lib/voice-axes.mjs` and asserts every policy marker is disjoint. If a future patch slips a blacklisted phrase into a policy file, CI fails.

### D-36-5: Anti-stutter via `prevAssistantReply.startsWith(marker)` check — cheap, no history needed

If previous turn already opened with one of our markers (any policy across both langs), skip injection this turn. Keeps `嗯…` / `wait…` from compounding into a tic.

### D-36-6: A/B harness uses existing `pairwise-runner.mjs` patterns but as 3-way (off/low/high)

Per IMPERFECT-06: 3 arms × 2 swaps × 6 scenarios = 36 calls (~$0.08). New harness `ab-injector-harness.mjs` is a thin wrapper that loads scenario, runs each turn with each arm applied to Claire's draft (via direct LLM call → injector), then judges via existing `judgePairwise` for 3-way ELO-style comparison.

Statistical significance helper: 95% CI bootstrap (1000 resamples) over per-scenario humanness axis means; report `low_vs_off_diff_95ci` and `high_vs_off_diff_95ci`. Winner = arm whose lower CI > control's upper CI on `warmth_no_sycophancy + in_character_voice` combined; tie-break = `drift_resistance`.

### D-36-7: Default arm = `off` until A/B winner decided (matches IMPERFECT-07)

Per Phase 34 gate: "Acceptable result includes '0% control wins' → ship with ImperfectionInjector disabled." Default `PA_IMPERFECTION_ARM=off`. Adam flips after seeing the harness report.

### D-36-8: Wire-in deferred to Adam — patch spec is the contract (mirror Phase 35 D-35-8)

`WIRE-IN-PATCH.md` is the complete spec Adam needs:
- Insertion point in `rewriteIfOff` AFTER Phase 35 detector pass, BEFORE final return
- Pseudo-code for arm resolution (read `userId` from ctx, call `resolveArm(userId)`)
- Telemetry shape — extend `RewriteResult` with `imperfectionInjector?: InjectorResult`
- Feature flag — `PA_IMPERFECTION_INJECTOR_ENABLED` env (default `false` initially, ramped via `PA_HUMANIZE_RUNTIME_ENABLED` in Phase 40)
- Anchor strings for survival of Adam's nearby edits

### D-36-9: Latency budget = < 5ms per turn (pure JS, no I/O)

Injector is text-only — Math.random + string concat + sentence split. All synchronous. Test harness asserts p95 < 5ms over 1000 invocations.

---

## 4. Acceptance gates (Phase 36 done = all green)

- [ ] `pnpm --filter @pa/pa-orchestrator typecheck` clean
- [ ] All injector unit tests pass via `node --import tsx --test packages/pa-orchestrator/src/voice/imperfection-injector/*.test.ts`
- [ ] Bilingual coverage verified — zh + en + mixed inputs all handled in tests
- [ ] Anti-blacklist guard test passes (no policy marker collides with FILLER_BLACKLIST_*)
- [ ] Position constraint test passes (mid-clause input → `position: "none"`)
- [ ] 3-arm probability sanity test (1000 samples) — observed firing rate within ±3pp of target (off=0, low=15±3, high=30±3)
- [ ] Type priority test — when multiple policies fire, order is `self_correct > hesitate > clarify > uncertainty`
- [ ] Anti-stutter test — prev turn opens with marker → current turn skips
- [ ] Arm router sticky test — same userId always returns same arm across 100 calls
- [ ] A/B harness `tests/scenarios/lib/ab-injector-harness.mjs` `--dry-run` produces planned arm × scenario matrix without errors
- [ ] 2 new scenarios `eval-imperfection-arm-{zh,en}.yaml` parse successfully via `node tests/scenarios/runner.mjs --scenarios "eval-imperfection-arm-*" --dry-run` (or equivalent)
- [ ] Latency assertion — `injectImperfection` p95 < 5ms over 1000 invocations
- [ ] `WIRE-IN-PATCH.md` written + reviewed for completeness (Adam-readable, no Q's)
- [ ] `STATE.md` Phase 36 row → ✅ partial (BUILD complete, live A/B run + wire-in deferred), `completed_phases` 7 → 8

---

## 5. Hard constraints applied (P10 lockdown)

- TypeScript only ✅ (production code under `packages/pa-orchestrator/src/voice/imperfection-injector/`)
- 0 net new LLM calls in production path ✅ (pure text post-process)
- Position-constrained turn-onset only ✅ (D3 + position-constraint module)
- Bilingual zh + en + mixed ✅ (D9; lang detection via Phase 33/35 helper port)
- 3-arm A/B: 0/15/30% ✅ (D3 + arm-router)
- Type priority: self_correct > hesitate > clarify > uncertainty ✅ (D3 + ordered policy bank)
- Reuse Phase 33 `splitSentences` for turn-onset detection ✅ (no duplicate impl)
- DO NOT inject FILLER_BLACKLIST phrases ✅ (anti-blacklist unit test)
- Latency budget: < 5ms per turn ✅ (asserted in test)
- No new monorepo package (D8) ✅ — module under existing `pa-orchestrator/src/voice/`
- **Files NOT touched** (Adam uncommitted-work collision avoidance):
  - `apps/functions/src/admin-bootstrap.ts`
  - `packages/pa-orchestrator/package.json`
  - `packages/pa-orchestrator/src/downstream.ts` + `.test.ts`
  - `packages/pa-orchestrator/src/index.ts`
  - `packages/pa-orchestrator/src/voice/llm-rewriter.ts` + `.test.ts`
  - `packages/pa-orchestrator/src/eval-nl-judge.ts` + `.test.ts`

---

## 6. Risks + mitigations

| Risk | Mitigation |
|------|------------|
| Policy phrase collides with FILLER_BLACKLIST | D-36-4: anti-blacklist guard unit test — dynamic import + substring check. Build fails on collision. |
| Mid-clause injection slips through | D-36-3: single position-constraint module; all injection paths route through `injectAtTurnOnset(text, marker, lang)`. Test asserts marker only ever appears at index 0..N (where N = first non-injection char). |
| Probability drift from target | D-36-2: 1000-sample stat test asserts ±3pp tolerance. Random source seedable via `opts.rng` for deterministic test runs. |
| Arm assignment instability across deploys (different hash) | D-36 D-36 user-id sticky uses `djb2-like` 32-bit hash — pure function, identical across deploys. Persisted Firestore-backed bucket deferred to Phase 38 (mitigation if hash collisions become problem). |
| Anti-stutter check false positive (legitimate `嗯` from prior turn unrelated to our marker) | D-36-5: only counts as stutter if prev turn STARTS with a marker (not contains). Acceptable false-skip rate. |
| 3-way A/B statistical power weak with only 6 scenarios | Bootstrap CI helper; report says "low N — directional only" if N < 20. Adam reads CI not point estimate. |
| Wire-in patch spec drift (Adam's pending work changes nearby code) | Anchor strings, not line numbers. Re-read `llm-rewriter.ts` immediately before T5 to confirm anchors still match. |

---

## 7. Cross-stream sync

- **Phase 33** (helpers) — `splitSentences` consumed for position constraint; no modification.
- **Phase 35** (detectors) — Phase 36 sits AFTER detector pass in pipeline; no shared module collision (different subdir under `voice/`).
- **Phase 37** (FSM) — Future: ux_state may modify which arm/policy is selected (e.g. `QuietWitness` state forces `off` for that turn). Contract stable: `injectImperfection(text, opts)` accepts optional `opts.disabled` flag.
- **Phase 40** (Bible v7.5 + Ship) — `PA_HUMANIZE_RUNTIME_ENABLED` umbrella flag gates `PA_IMPERFECTION_INJECTOR_ENABLED`. Default off → ramps via firebase functions:config.

---

> [🟠 阿里味] **闭环意识**：CONTEXT 抓手清晰——injector module + 3-arm router + position constraint + bilingual policies + anti-blacklist guard + A/B harness + WIRE-IN-PATCH。下一步 PLAN.md 拆 5 个 atomic task。**因为信任所以简单**：detector contract 给你了，position helper 给你了，blacklist 给你了，pairwise-runner 给你了。落地就行。证据说话。
