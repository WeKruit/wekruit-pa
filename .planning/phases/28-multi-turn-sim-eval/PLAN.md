# Phase 28 — PLAN (5-task spec)

**Status:** Ready to spawn (no hard gate; orthogonal to Phase 27).
**Strategy doc:** `CONTEXT.md` (this dir).

**Total estimate:** ~3.5 dev-day, single P8 sequential. T1 → T2 → T3 → T4 → T5 (each consumes prior).

---

## T1 — User-persona library

**Goal:** Encode 5 personas (`anxious_grad`, `formal_em`, `chatty_curious`, `vent_seeker`, `hype_announcer`) as importable modules with system prompt + opening message + behavior rules + expected Claire mode per turn.

**Files:**
- `packages/pa-orchestrator/src/eval/sim-personas/index.ts` (new) — registry export
- `packages/pa-orchestrator/src/eval/sim-personas/anxious-grad.ts` (new)
- `packages/pa-orchestrator/src/eval/sim-personas/formal-em.ts` (new)
- `packages/pa-orchestrator/src/eval/sim-personas/chatty-curious.ts` (new)
- `packages/pa-orchestrator/src/eval/sim-personas/vent-seeker.ts` (new)
- `packages/pa-orchestrator/src/eval/sim-personas/hype-announcer.ts` (new)
- `packages/pa-orchestrator/src/eval/sim-personas/types.ts` (new) — `Persona` interface

**Detailed deliverables:**
1. `Persona` interface: `{ id, profile, systemPrompt, openingMessage, behaviorRules: string[], expectedModeByTurn?: ('vent'|'celebrate'|'ask'|'chat')[] }`
2. Each persona ~150 token system prompt — written in second person ("You are an anxious grad student…"), explicit register rules, explicit refusal of out-of-character drift.
3. `behaviorRules` must include the 1-line rule from CONTEXT.md (e.g. anxious_grad always ends with follow-up question).
4. Registry index exports `PERSONAS: Record<PersonaId, Persona>` and `PERSONA_IDS: PersonaId[]`.
5. No live LLM calls in this task — pure data files + types.

**DONE verification:**
```bash
pnpm --filter pa-orchestrator typecheck
pnpm --filter pa-orchestrator test -- sim-personas
# expect 5 personas registered, types pass
node -e "console.log(Object.keys(require('./packages/pa-orchestrator/dist/eval/sim-personas').PERSONAS))"
# expect: [ 'anxious_grad', 'formal_em', 'chatty_curious', 'vent_seeker', 'hype_announcer' ]
```

**Estimated time:** ~0.5 day.

---

## T2 — Simulation runner

**Goal:** Orchestrate persona-LLM × Claire alternately for K turns. Capture full transcript with role + content + timing + token counts.

**Files:**
- `packages/pa-orchestrator/src/eval/sim-runner.ts` (new) — main runner
- `packages/pa-orchestrator/src/eval/sim-runner.types.ts` (new) — `SimRun`, `SimTurn` types
- `packages/pa-orchestrator/src/eval/persona-llm.ts` (new) — wrapper that calls gpt-5.4-nano with persona system prompt + transcript-so-far → next user turn
- `apps/eval/voice/run_sim.py` (new) — Python entry point that drives the TS runner via `tsx` and consumes the JSON transcript output

**Detailed deliverables:**
1. `runSim({ personaId, K=8, bibleVersion })` → returns `{ runId, persona, turns: SimTurn[], startedAt, finishedAt, totalTokens }`.
2. Turn loop:
   - Turn 0 = persona's `openingMessage` (no LLM call needed).
   - Odd turns (1, 3, 5, …) = Claire (in-process orchestrator call).
   - Even turns (2, 4, 6, …) = persona-LLM call with full transcript-so-far in messages array.
3. Persona-LLM uses gpt-5.4-nano + temperature 0.8 + persona system prompt. No tools, no web search.
4. Claire side calls existing orchestrator turn handler in-process (no HTTP). Bible version pinned via `bibleVersion` param.
5. Transcript serialized to JSON with full turn objects + per-turn latency + token counts.
6. Crash safety: if either LLM call throws, runner persists partial transcript + error reason; downstream judge can still score what was captured.
7. CLI helper: `pnpm sim:run --persona vent_seeker --turns 8 --bible v7.0` → writes `eval-results/sim/{runId}.json`.

**DONE verification:**
```bash
pnpm --filter pa-orchestrator test -- sim-runner
# integration smoke (live LLM, low cost ~$0.02)
PA_RUN_SIM=1 pnpm sim:run --persona vent_seeker --turns 4
# expect: eval-results/sim/<runId>.json with 4 turns, 2 from persona, 2 from Claire
jq '.turns | length' eval-results/sim/*.json
```

**Estimated time:** ~1 day.

---

## T3 — `ConversationalGEval` multi-turn metric extension

**Goal:** Extend Phase 24's DeepEval setup with 6 multi-turn metrics judged on full transcripts.

**Files:**
- `apps/eval/voice/test_voice_sim.py` (new) — pytest entry, parametrized over (persona × metric)
- `apps/eval/voice/metrics/multi_turn.py` (new) — 6 `ConversationalGEval` metric definitions
- `apps/eval/voice/judges/claude_judge.py` (no change — reuse existing)
- `apps/eval/voice/conftest.py` (modify, minor) — add `PA_RUN_SIM` guard parallel to `PA_RUN_EVAL`

**Detailed deliverables:**
1. 6 metrics from CONTEXT.md (VoiceConsistency, ModeSwitchFluidity, NoProbeRegression, NoOilinessCumulative, FirstPersonOpenerDensity, MemoryScaffoldingTrigger), each with `criteria` describing pass/fail conditions on the *full* transcript.
2. Each metric uses `ConversationalGEval` (not single-turn `GEval`) and reads the entire `ConversationalTestCase.turns` list.
3. Threshold = 0.7 (≥3.5/5). Configurable via `CLAIRE_SIM_THRESHOLD` env.
4. `test_voice_sim.py` parametrizes over `PERSONAS × METRICS` (5 × 6 = 30 test cases). Loads sim transcripts from `eval-results/sim/*.json` (from T2 or pre-recorded fixtures).
5. Cell-level pass/fail emitted as pytest output + aggregate matrix written to `eval-results/sim-matrix-{timestamp}.json`.
6. Reuse `ClaudeOpus45Judge` singleton (cost-control already in place via Phase 24).

**DONE verification:**
```bash
PA_RUN_SIM=1 deepeval test run apps/eval/voice/test_voice_sim.py -n 4
# expect: 30 test cases run, matrix file written
jq '.cells | length' eval-results/sim-matrix-*.json   # expect 30
# k-filter: only one persona
PA_RUN_SIM=1 deepeval test run apps/eval/voice/test_voice_sim.py -k vent_seeker
```

**Estimated time:** ~0.5 day.

---

## T4 — Result persistence + dashboard tab

**Goal:** Sim runs persisted to Firestore `pa_voice_sim_runs`. Dashboard `/voice` page gets new "N-round Sim Eval" tab listing runs + drill-into-transcript view.

**Files:**
- `apps/functions/src/sim-eval-publisher.ts` (new) — small CF / script that ingests `eval-results/sim-matrix-*.json` + transcript files into Firestore
- `apps/dashboard-web/src/pages/Voice.tsx` (modify) — add tab "N-round Sim Eval"
- `apps/dashboard-web/src/components/voice/SimRunList.tsx` (new) — list view
- `apps/dashboard-web/src/components/voice/SimRunDetail.tsx` (new) — drill into single transcript with per-turn judge scores
- Firestore: `pa_voice_sim_runs/{runId}` schema `{runId, persona, bibleVersion, K, turns[], cellScores: {voiceConsistency, modeSwitchFluidity, …}, aggregateScore, createdAt, gitSha?}`

**Detailed deliverables:**
1. Publisher reads matrix JSON + matching transcript JSON, writes one Firestore doc per run.
2. Dashboard tab: lists last 50 runs newest first; columns = persona, Bible version, aggregate score, created at, git sha (if recorded).
3. Drill view: full transcript with per-turn role badges (user/Claire); side panel with 6 metric scores + judge reasoning text.
4. Filter UI: by persona + by Bible version + by score range.
5. No write path from dashboard — read-only consumer of CI artifacts.

**DONE verification:**
```bash
# publish a sim run
node apps/functions/src/sim-eval-publisher.ts eval-results/sim-matrix-latest.json
# verify Firestore doc
gcloud firestore documents list pa_voice_sim_runs --limit=1
# dashboard build + smoke
pnpm --filter dashboard-web build
pnpm --filter dashboard-web test -- SimRunList SimRunDetail
```

**Estimated time:** ~1 day.

---

## T5 — CI integration

**Goal:** GitHub Actions workflow runs sim-eval when PR has `run-voice-sim` label. Mirrors existing voice-eval workflow paradigm.

**Files:**
- `.github/workflows/voice-sim.yml` (new) — triggered on `pull_request` events with label `run-voice-sim`
- `apps/eval/voice/run_sim_ci.sh` (new) — orchestrates: install deps → run sim for all 5 personas → run pytest matrix → publish results to Firestore (optional, behind secret) → emit GitHub PR comment summary

**Detailed deliverables:**
1. Workflow triggers: `pull_request` with `types: [labeled, synchronize]` AND label includes `run-voice-sim`. Skip if label not present.
2. Steps:
   - checkout + setup node + setup python
   - install pa-orchestrator + apps/eval deps
   - run `pnpm sim:run` for all 5 personas (parallel matrix job)
   - run `deepeval test run apps/eval/voice/test_voice_sim.py`
   - upload `eval-results/sim/*` + matrix as artifact
   - post PR comment with score table + link to artifact
3. Cost control: skip if `PA_NANO_API_KEY` secret missing (fail soft with warning, not hard fail). 
4. Rate cap: workflow uses concurrency group `voice-sim-${{ github.head_ref }}` so re-pushes cancel in-flight runs.
5. Matrix pass/fail: if aggregate < 0.7, workflow fails; otherwise success. PR author + Adam see comment regardless.

**DONE verification:**
```bash
# locally
bash apps/eval/voice/run_sim_ci.sh
# expect: 5 sim runs + matrix + PR comment text written to ./pr-comment.md

# remote: open a PR, apply label `run-voice-sim`, observe Actions run
gh pr create --label run-voice-sim ...
gh run list --workflow=voice-sim.yml
```

**Estimated time:** ~0.5 day.

---

## Sub-task summary

| ID | Title | Dep | Time |
|----|-------|-----|------|
| T1 | User-persona library (5 personas) | none | 0.5d |
| T2 | Simulation runner | T1 | 1d |
| T3 | ConversationalGEval multi-turn metrics | T2 | 0.5d |
| T4 | Persistence + dashboard tab | T3 | 1d |
| T5 | CI integration (label-gated) | T4 | 0.5d |

**Total:** 3.5 dev-day single P8 sequential.

## Hard gate

**None.** Phase 28 is independent of Phase 27. The multi-turn sim-eval is orthogonal regression coverage — it can land any time after Phase 24 ships its judges + thresholds (already done). Useful even pre-launch; especially useful as a pre-merge gate for any future Bible patch (manual or self-evolve).

## Adam decisions still owed

- [ ] Confirm 5-persona roster (CONTEXT.md table) — wording refinements OK
- [ ] Confirm K=8 default
- [ ] Confirm threshold ≥0.7 (≥3.5/5)
- [ ] Confirm label `run-voice-sim` (not always-on CI — too costly per PR)
- [ ] Confirm OK to write transcripts to Firestore (no PII risk since persona is synthetic)
