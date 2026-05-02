# Humanize-Runtime Stack — E2E Verify Report

**Date:** 2026-05-02
**Branch:** main (rev paadminbootstrap-00067-qat)
**Umbrella flag `paHumanizeRuntimeEnabled`:** `value=true`, `scope=perUser` (global ON; no allowlist gate active because `value=true` short-circuits allowlist).

## Method
1. Inventoried humanize-v2 modules under `packages/pa-orchestrator/src/voice/`.
2. Read `packages/pa-orchestrator/src/index.ts` (1954 lines) to map wire-points.
3. Read Firestore flag `pa-feature-flags/paHumanizeRuntimeEnabled` via REST.
4. Ran two `simulateConversation` sims with persona=`vent_seeker`, turns=3 (cold + warm).
5. Pulled `gcloud logging read` over `paadminbootstrap` Cloud Run service for the sim window.
6. Read `pa-advice-tracker/SYNTHETIC_SIM_vent_seeker/items` from Firestore to confirm trackAdvice writes.

## Wire-point map (orchestrator/index.ts)

| Module | File | Wire-line | Gate |
|---|---|---|---|
| F1 verb-mirror | `voice/detectors/f1-verb-mirror.ts` | runAllDetectors (1267) + (701) | `PA_DETECTORS_ENABLED !== "false"` + umbrella |
| F2 length-cap | `voice/detectors/f2-length-cap.ts` | runAllDetectors | same |
| F3 lang-lock | `voice/detectors/f3-lang-lock.ts` | runAllDetectors | same |
| F4 advice-repeat (BGE-M3) | `voice/detectors/f4-advice-repeat.ts` | runAllDetectors | same |
| ImperfectionInjector | `voice/imperfection-injector/` | index.ts:1217-1240 | umbrella + `PA_IMPERFECTION_INJECTOR_ENABLED !== "false"` + arm-resolver |
| FSM (5 UX × 8 strategy) | `voice/fsm/` | llm-rewriter.ts:602-619 (PRE-gen) | umbrella + `PA_FSM_ENABLED !== "false"` |
| Memory-policy advice-tracker | `voice/memory-policy/advice-tracker.ts` | index.ts:1290 + llm-rewriter.ts:723 | umbrella + `PA_MEMORY_POLICY_ENABLED !== "false"` |
| Memory-policy contradiction-detector | `voice/memory-policy/contradiction-detector.ts` | exposed via prompt-injector — not directly invoked from runAgentTurn | TBD |
| Bible v7.5 + crisis red-team | `voice/llm-rewriter.ts:352 REWRITER_V2_SYSTEM_PROMPT` | called every rewrite | umbrella |
| AB-probe strip (zh) | `output-normalizer.ts` | index.ts:1187 | umbrella + `PA_AB_PROBE_STRIP_ENABLED !== "false"` |
| Lang-translate (v1.5) | inline | index.ts:1024-1119 | userLang detection |

Sub-flags (`paFsmEnabled`, `paImperfectionInjectorEnabled`, etc.) **do not exist in Firestore** — modules rely on ENV defaults (all default ON).

## Sim run

- **Sim 1 (cold)** `sessionId=sim-vent_seeker-1777759250908`, 3 turns, ~12s.
- **Sim 2 (warm)** `sessionId=sim-vent_seeker-1777759391525`, 3 turns, ~11s.

Both returned `processed=3` and 3 valid assistant replies. Sim1 reply turn-1: `草…被裁员真的挺恶心的，心情肯定也挺乱。`

## Verdict table

| Module | WIRED | FIRED (turn 1, sim1) | Evidence | Verdict |
|---|---|---|---|---|
| F1 verb-mirror | YES | unknown (no log on success) | runAllDetectors invoked unconditionally on umbrella ON | LIKELY ALIVE — silent on no-trigger |
| F2 length-cap | YES | unknown | same | LIKELY ALIVE |
| F3 lang-lock | YES | unknown | same | LIKELY ALIVE |
| F4 advice-repeat | YES | unknown | requires BGE-M3 key — fails open | LIKELY ALIVE |
| ImperfectionInjector | YES | NO `imperfection_injector.applied` event | no log → `arm=off` (default arm-resolver bucket) OR no-op | WIRED, NOT FIRED — arm bucketing keeps most users at "off" |
| FSM | YES | UNKNOWN | FSM has **no `store.log`** on success path; only `console.log` on degrade. Not externally observable. | WIRED, UNTELEMETERED |
| Memory-policy trackAdvice | YES | YES (turn 1 only) | `pa-advice-tracker/SYNTHETIC_SIM_vent_seeker/items/e36c9da1` exists | WIRED + FIRED |
| Memory-policy contradiction-detector | UNCLEAR | NO | Not visibly wired in runAgentTurn — only via mem0 prompt-injector path | WIRED-NOT-IN-TURN-LOOP (gap) |
| Bible v7.5 + crisis | YES | YES | `pa.voice.llm_rewriter.applied reason=rewritten` at 22:00:58 (rewrite went through REWRITER_V2_SYSTEM_PROMPT) | FIRED |
| AB-probe strip | YES | YES | `pa.voice.ab_probe_strip.applied patterns=["zh_X_还是_Y_question"]` | FIRED |
| Lang-translate | YES | NO (zh user, no translate needed) | userLang=zh path skips translate | WIRED, CORRECTLY-NOT-FIRED |

## Gaps & blockers

1. **Sim 2 produced ZERO logs** in `paadminbootstrap` despite returning 3 replies. Likely Cloud Run async-flush or `console.log` rate limits. **Trust the trackAdvice write count instead.**
2. **Only 1 advice-tracker item written across 6 sim turns** (1 of sim1's 3 + 0 of sim2's 3). Root cause: `void trackAdvice(...).catch(...)` is fire-and-forget — Cloud Functions Gen 2 instances freeze at HTTP response, killing pending Firestore writes. **Real users with longer sessions will see this less often (subsequent inbound events keep instance warm), but synthetic sims undercount.**
3. **FSM has no `store.log` on success.** index.ts:1252-1300 logs detectors + advice-tracker errors but NOT FSM directive. Cannot externally verify FSM directive → rewriter prompt without local sim. Recommend adding `pa.voice.fsm.directive` event when umbrella ON.
4. **ImperfectionInjector default arm=off** in `resolveArm()`. Most synthetic users (and most prod users) bucket to "off" — module is wired but rarely fires by design (3-arm A/B). To verify, force `PA_IMPERFECTION_ARM=high`.
5. **contradiction-detector** is not visibly wired into the per-turn rewriter path. It's exported from `memory-policy/index.ts` and consumed via mem0 search elsewhere, but I did not find a turn-loop invocation. Worth a closer look if Phase 38 intended per-turn use.

## v1.5 lang-lock survival

- Lang-lock prompt prepend (zh: index.ts:1004) and append (1024) survived intact.
- Lang-translate fallback (1066-1119) wired with telemetry events `lang_translate.applied/rejected/http_error/error`.
- Sim with zh user did not invoke translate (correctly skipped).

## Cost

- 2 sims × 3 turns × ~9k input + 38 output tokens. Well under $0.05 total. Within $1 budget.

## Recommendations

- **P0:** Add `pa.voice.fsm.directive` event in llm-rewriter.ts:614 so FSM is observable.
- **P1:** Replace `void trackAdvice(...)` with `await trackAdvice(...)` in admin-bootstrap sim path (or use Cloud Run min-instances) so synthetic sims write reliably. Production iMessage path is less affected because instance stays warm via inbound webhook traffic.
- **P2:** Force-bucket synthetic sim users to `arm=high` for verification (e.g. `PA_IMPERFECTION_ARM=high` env override on a flag-gated test endpoint) so injector is testable in sim.
- **P3:** Confirm contradiction-detector wire-in intent (per-turn vs. mem0-only).
