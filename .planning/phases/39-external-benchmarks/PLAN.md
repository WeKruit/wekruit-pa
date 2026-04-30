# Phase 39 — PLAN (5 atomic tasks)

**Status:** Plan-only. Owner P9-C. Total estimate ~1 dev-day. T1 → T2 → T3 → T4 → T5 strict serial. Atomic commit per task.

**Source-of-truth context:** `.planning/phases/39-external-benchmarks/CONTEXT.md`.

**Production code dir:** `apps/eval/external-benchmarks/` (NEW — npm workspace member, ESM .mjs).

**Files NOT touched** (Adam working-tree collision avoidance):
- `apps/functions/src/admin-bootstrap.ts`
- `packages/pa-orchestrator/src/voice/llm-rewriter.ts` + `.test.ts`

---

## T1 — Package skeleton + sf-client + cost-ledger + qwen-7b/72b adapters + tests

**WHERE:**
- `apps/eval/external-benchmarks/package.json` (new) — workspace member `@pa/external-benchmarks`, ESM, scripts `typecheck` / `test` / `bench:dry-run` / `bench:live`. Workspace dep on `@pa/pa-orchestrator`.
- `apps/eval/external-benchmarks/tsconfig.json` (new) — `allowJs + checkJs + noEmit` for typecheck against JSDoc-annotated .mjs.
- `apps/eval/external-benchmarks/.gitignore` (new) — `vendor/`, `results/*.json` (runtime only — keep `results/.gitkeep`).
- `apps/eval/external-benchmarks/lib/sf-client.mjs` (new) — thin SiliconFlow OpenAI-compat wrapper (`chatCompletion({ model, messages, opts })` + `embed({ model, input })`). Reads `SILICONFLOW_API_KEY` / `PA_OPENAI_AGENT_API_KEY` / `PA_SILICONFLOW_API_KEY`.
- `apps/eval/external-benchmarks/lib/cost-ledger.mjs` (new) — `createLedger({ maxBudgetUsd })`, `ledger.charge({ model, inputTokens, outputTokens })` returns running total + throws `BudgetExceededError` when limit hit. Persists to `results/cost-ledger.json`.
- `apps/eval/external-benchmarks/lib/qwen-7b-adapter.mjs` (new) — `createQwen7bAdapter({ ledger })` returns `{ chat({ messages, opts }) → { text, usage, meta } }`. Calls sf-client with `Qwen/Qwen2.5-7B-Instruct`.
- `apps/eval/external-benchmarks/lib/qwen-72b-adapter.mjs` (new) — same shape, `Qwen/Qwen2.5-72B-Instruct`.
- `apps/eval/external-benchmarks/lib/cost-ledger.test.mjs` (new) — accumulation, abort threshold, persistence round-trip.
- `apps/eval/external-benchmarks/lib/sf-client.test.mjs` (new) — env var resolution, request body shape, mock fetch.
- `apps/eval/external-benchmarks/lib/qwen-7b-adapter.test.mjs` (new) — chat shape verification, ledger integration.
- `apps/eval/external-benchmarks/lib/qwen-72b-adapter.test.mjs` (new) — same.
- `apps/eval/external-benchmarks/results/.gitkeep` (new).

**HOW MUCH:** ~2 hours.

**DONE:**
- `npm --workspace @pa/external-benchmarks run typecheck` clean
- `node --test apps/eval/external-benchmarks/lib/cost-ledger.test.mjs apps/eval/external-benchmarks/lib/sf-client.test.mjs apps/eval/external-benchmarks/lib/qwen-7b-adapter.test.mjs apps/eval/external-benchmarks/lib/qwen-72b-adapter.test.mjs` — all pass
- `cost-ledger.test.mjs` covers:
  - `ledger.charge({ model: "Qwen/Qwen2.5-7B-Instruct", inputTokens: 1_000_000, outputTokens: 1_000_000 })` returns `{ totalUsd: 0.21 }` (0.07 + 0.14)
  - 25 charges of 1M+1M tokens does NOT abort (0.21 × 25 = 5.25 < 25)
  - When `total + nextCharge >= maxBudget` → throws `BudgetExceededError`
  - `ledger.snapshot()` round-trips through JSON file
- `sf-client.test.mjs` covers:
  - Env var resolution chain (`SILICONFLOW_API_KEY` first)
  - Mock fetch returns `{ choices: [{ message: { content: "..." }}], usage: {...} }`
  - Throws when no env var set + caller insists on live mode
- `qwen-7b-adapter.test.mjs` covers:
  - `chat({ messages: [{role:"user",content:"hi"}] })` returns `{ text, usage: { inputTokens, outputTokens, costUSD }, meta: { arm: "qwen-7b-raw" } }`
  - Charges ledger on each call
  - Ledger throw bubbles up

**DON'T:**
- DON'T import any of the no-touch files (CONTEXT §5)
- DON'T add Claire stack composition yet (T2)
- DON'T add real benchmark runners yet (T3)
- DON'T modify root `package.json` workspaces array — `apps/*` glob already covers
- DON'T add live-network tests (mock fetch only)

Commit msg: `feat(39/T1): bench package skeleton + sf-client + cost-ledger + qwen-7b/72b adapters (P9-C)`

---

## T2 — Claire-stack-adapter via direct module imports + results-aggregator + tests

**WHERE:**
- `apps/eval/external-benchmarks/lib/claire-stack-adapter.mjs` (new) — `createClaireStackAdapter({ ledger, deps })` returns `{ chat({ messages, opts }) → { text, usage, meta } }`. Composition:
  1. Call qwen-7b base via sf-client to get raw draft
  2. `runAllDetectors(...)` from `@pa/pa-orchestrator/voice/detectors/index.js` — apply F1/F2 strip
  3. `injectImperfection(...)` from `@pa/pa-orchestrator/voice/imperfection-injector/index.js` — turn-onset only, arm from `PA_IMPERFECTION_ARM` env (default "control" for benchmark — no injection)
  4. `runFsm(...)` from `@pa/pa-orchestrator/voice/fsm/index.js` — compute strategy directive (used as next-turn prompt; logged to meta)
  5. `runMemoryPolicy(...)` from `@pa/pa-orchestrator/voice/memory-policy/index.js` — compute repeat score; if `triggered`, request 1 re-roll
  6. Return `{ text: cleaned, usage, meta: { arm: "claire-stack", pipeline: ["draft","detector","injector","fsm","memory"] } }`
- `apps/eval/external-benchmarks/lib/results-aggregator.mjs` (new) — `writeResult(benchmark, payload)` validates schema + writes to `results/{benchmark}.json`. `aggregateAll()` reads all + emits combined report.
- `apps/eval/external-benchmarks/lib/claire-stack-adapter.test.mjs` (new) — pipeline order verification (mock module functions), graceful degrade when env keys missing, single re-roll cap.
- `apps/eval/external-benchmarks/lib/results-aggregator.test.mjs` (new) — JSON round-trip + schema validation.

**HOW MUCH:** ~3 hours.

**DONE:**
- `npm --workspace @pa/external-benchmarks run typecheck` clean
- `node --test apps/eval/external-benchmarks/lib/claire-stack-adapter.test.mjs apps/eval/external-benchmarks/lib/results-aggregator.test.mjs` — all pass
- `claire-stack-adapter.test.mjs` covers:
  - Default pipeline runs in order: detect → inject → fsm → memory (verified via mock spy ordering)
  - When detectors return `triggered: false` (none), output equals raw draft (sans injection in control arm)
  - When F1 returns `triggered: true` (mocked), strip is applied (output text differs from raw)
  - When memory `repeatScore.triggered: true`, single re-roll happens (qwen-7b base called twice); 2nd re-roll NOT attempted
  - `meta.pipeline` array recorded in order
  - `meta.arm === "claire-stack"`
  - Ledger charged for both draft + re-roll calls
- `results-aggregator.test.mjs` covers:
  - `writeResult({ benchmark: "botchat", arm: "claire-stack", score: {...}, cost_usd: 1.23 })` writes valid JSON
  - `aggregateAll()` reads N result files + emits `{ benchmarks: [...], totals: { cost_usd: ..., calls: ...} }`
  - Schema rejects missing `benchmark` or `arm` field

**DON'T:**
- DON'T touch `llm-rewriter.ts` (no-touch list)
- DON'T add Firestore deps to memory-policy invocation — pass `deps: { firestore: null }` so memory-policy uses in-memory mode (graceful degrade per Phase 38 design)
- DON'T add real benchmark logic — runners come in T3
- DON'T re-implement Phase 35-38 modules — direct imports

Commit msg: `feat(39/T2): claire-stack-adapter via direct Phase 35-38 module imports + results-aggregator (P9-C)`

---

## T3 — 5 benchmark runners (botchat / character-eval / empathetic-dialogues / esconv / role-llm) + dry-run tests

**WHERE:**
- `apps/eval/external-benchmarks/runners/botchat.mjs` (new) — bot-vs-bot chat dialogue runner. Reads `PA_BENCH_BOTCHAT_PATH` (default `./vendor/BotChat`). `runBotChat({ adapter, ledger, mode: "dry-run"|"live", subset })` returns result payload.
- `apps/eval/external-benchmarks/runners/character-eval.mjs` (new) — Python subprocess wrapper. `runCharacterEval({ adapter, ledger, mode })` — dry-run prints command spec; live runs `python -m characterval --model-endpoint=...` (Adam's env).
- `apps/eval/external-benchmarks/runners/empathetic-dialogues.mjs` (new) — JSON corpus reader (`empatheticdialogues_v1` data files); per-conv response gen + nl-judge.
- `apps/eval/external-benchmarks/runners/esconv.mjs` (new) — ESConv corpus + 8-strategy classification + response-gen runner.
- `apps/eval/external-benchmarks/runners/role-llm.mjs` (new) — RoleLLM corpus reader + role-play prompt runner + judge.
- `apps/eval/external-benchmarks/runners/botchat-dry-run.test.mjs` (new) — invoke with `--dry-run`, assert printed plan contains: benchmark name, arm, num calls, projected cost, repo path.
- `apps/eval/external-benchmarks/runners/character-eval-dry-run.test.mjs` (new) — same.
- `apps/eval/external-benchmarks/runners/empathetic-dialogues-dry-run.test.mjs` (new) — same.
- `apps/eval/external-benchmarks/runners/esconv-dry-run.test.mjs` (new) — same.
- `apps/eval/external-benchmarks/runners/role-llm-dry-run.test.mjs` (new) — same.

**HOW MUCH:** ~3 hours.

**DONE:**
- `npm --workspace @pa/external-benchmarks run typecheck` clean
- `node --test apps/eval/external-benchmarks/runners/*-dry-run.test.mjs` — all 5 pass
- Each runner's `--dry-run` mode:
  - Does NOT make any network calls
  - Does NOT require benchmark repo to be cloned (uses estimates from CONTEXT §2 spec)
  - Prints valid JSON plan with: `{ benchmark, arm, planned_calls, projected_input_tokens, projected_output_tokens, projected_cost_usd, repo_path, status: "dry-run" }`
- Each runner's `--live` mode:
  - Errors if benchmark repo path doesn't exist (`expected vendor/{benchmark}, set PA_BENCH_X_PATH to override`)
  - Errors if `SILICONFLOW_API_KEY` not set
  - Charges cost ledger on every call
  - Writes result via `results-aggregator.writeResult(...)`
- BotChat runner: uses bot-vs-bot mode (adapter chats with itself for N turns then judge), 50 dialogues × 8 turns = 400 calls
- CharacterEval: emits Python subprocess command spec (`python -m characterval --base-url ${SILICONFLOW_BASE_URL} --model Qwen/Qwen2.5-7B-Instruct --output-dir results/character-eval-{arm}`); dry-run validates command structure
- EmpatheticDialogues: subset 1000 convs from `empatheticdialogues/test.csv`
- ESConv: subset 200 convs from `ESConv.json`
- RoleLLM: subset 50 chars from `RoleBench-zh-en/...` (exact path TBD by repo schema)

**DON'T:**
- DON'T require benchmark repo for dry-run tests
- DON'T make any live network calls in tests
- DON'T attempt to actually parse/validate full benchmark corpus in dry-run (path existence + planning sufficient)
- DON'T fork the benchmark repos — runners adapt-by-config-injection only

Commit msg: `feat(39/T3): 5 benchmark runners (botchat / character-eval / empathetic-dialogues / esconv / role-llm) + dry-run tests (P9-C)`

---

## T4 — Top-level orchestrator `run-all.mjs` + COST-PROJECTION.md + dry-run output verification

**WHERE:**
- `apps/eval/external-benchmarks/run-all.mjs` (new) — orchestrator. `--dry-run` (default): invokes all 5 runners in dry-run mode, sums projected cost, prints plan + asserts ≤ $25. `--live`: confirms env keys + ledger fresh, invokes all 5 in live mode, writes aggregate report via `results-aggregator.aggregateAll()`. `--arm=qwen-7b-raw|qwen-72b-raw|claire-stack` (default `claire-stack`).
- `apps/eval/external-benchmarks/run-all.test.mjs` (new) — invokes orchestrator with `--dry-run`, asserts:
  - All 5 benchmarks listed in plan
  - Total projected cost ≤ $25 (per CONTEXT D-39-7 pricing table × CONTEXT §2 subset sizes)
  - Exit code 0 for dry-run
  - Exit code non-zero (with helpful error) for `--live` if `SILICONFLOW_API_KEY` not set
- `.planning/phases/39-external-benchmarks/COST-PROJECTION.md` (new) — Adam-readable cost breakdown:
  - Per-benchmark line items (calls × tokens × price)
  - Per-arm subtotals (qwen-7b-raw / qwen-72b-raw / claire-stack)
  - Grand total with budget headroom
  - Sources: CONTEXT §2 subset sizes + D-39-7 prices

**HOW MUCH:** ~1.5 hours.

**DONE:**
- `npm --workspace @pa/external-benchmarks run typecheck` clean
- `node --test apps/eval/external-benchmarks/run-all.test.mjs` passes
- `node apps/eval/external-benchmarks/run-all.mjs --dry-run` exits 0 + prints plan with 5 benchmarks + projected total ≤ $25
- `node apps/eval/external-benchmarks/run-all.mjs --dry-run --arm=qwen-72b-raw` works (different price table)
- `COST-PROJECTION.md` line items sum to printed dry-run output (cross-validated)
- COST-PROJECTION.md grand total ≤ $25 (gate)

**DON'T:**
- DON'T invoke `--live` in tests
- DON'T modify cost prices outside of `lib/cost-ledger.mjs PRICE_TABLE`
- DON'T overrun budget — if dry-run shows > $25, reduce subset sizes in CONTEXT §2 + update PLAN

Commit msg: `feat(39/T4): run-all.mjs orchestrator + COST-PROJECTION.md (P9-C)`

---

## T5 — SETUP.md runbook + WIRE-IN-PATCH.md + final smoke + STATE update

**WHERE:**
- `.planning/phases/39-external-benchmarks/SETUP.md` (new) — Adam runbook:
  - Required env: `SILICONFLOW_API_KEY` (required), `OPENAI_API_KEY` (optional, judge), `PA_BENCH_MAX_BUDGET_USD` (default 25)
  - Repo clone commands (5 git clones into `apps/eval/external-benchmarks/vendor/`)
  - Path env var overrides per benchmark
  - Disk space estimate (~3 GB total for all 5 repos)
  - Expected runtime per benchmark (botchat ~30 min, character-eval ~45 min, empathetic-dialogues ~40 min, esconv ~20 min, role-llm ~25 min — total ~3 hr per arm × 3 arms = ~9 hr serial OR run arms separately)
  - Step-by-step: dry-run → review COST-PROJECTION → live with chosen arm → repeat for other arms → review aggregate
  - Cost ledger location + how to inspect mid-run
  - Failure recovery (idempotent restart, partial-result handling)
- `.planning/phases/39-external-benchmarks/WIRE-IN-PATCH.md` (new) — claire-stack-adapter direct-import documentation:
  - Section 1: This phase needs NO wire-in to `llm-rewriter.ts` (uses module direct imports)
  - Section 2: Import surface used (4 modules from `@pa/pa-orchestrator`)
  - Section 3: If Adam wants the same composition wired into prod orchestrator post-benchmark, reference Phase 35-38 individual WIRE-IN-PATCH.md files (already written) + composition order matches D-39-4
  - Section 4: Composition diff if/when Adam wires individual phases
- Final smoke verification:
  - `node apps/eval/external-benchmarks/run-all.mjs --dry-run` prints clean output
  - All 5 runners' dry-runs print valid plans
  - All unit tests pass
- `STATE.md` updated: Phase 39 row → ✅ partial (BUILD complete, RUNS deferred Adam $25 OK), `completed_phases` 10 → 11

**HOW MUCH:** ~1.5 hours.

**DONE:**
- `SETUP.md` written, contains all sections above
- `WIRE-IN-PATCH.md` written, documents direct-import pattern + zero llm-rewriter touch
- `node apps/eval/external-benchmarks/run-all.mjs --dry-run` exits 0
- All `apps/eval/external-benchmarks/**/*.test.mjs` pass in one shot
- `npm --workspace @pa/external-benchmarks run typecheck` clean
- STATE.md Phase 39 row updated, completed_phases 10 → 11

**DON'T:**
- DON'T modify `llm-rewriter.ts` (no-touch list)
- DON'T attempt live runs — Adam owns post-budget approval
- DON'T commit `vendor/` (gitignored per T1)
- DON'T defer the smoke verification — run before committing

Commit msg: `feat(39/T5): SETUP.md runbook + WIRE-IN-PATCH.md + STATE update (P9-C)`

Final commit (after all green):

`chore(39): SUMMARY + STATE — Phase 39 external benchmarks BUILD complete, runs deferred Adam $25 OK`

---

## Execution discipline

- **One task = one commit.** No mixing T2 and T3 in same commit.
- **Run typecheck + tests after EVERY task.** Red task = STOP, fix, then proceed.
- **Cost projection ≤ $25 is non-negotiable.** If dry-run shows over: reduce subset sizes in CONTEXT §2 first, then re-run T4.
- **No live network in tests.** Mock fetch + path stubs only.
- **Adam-owed deliverables (P0):** approve $25 budget, clone 5 benchmark repos per SETUP.md, export keys, run `--live`.

> [🟠 阿里味] **抓手清晰**：5 task × 5 commit. T1 framework + adapters → T2 Claire stack composition → T3 runners → T4 orchestrator + cost projection → T5 runbook + ship. Adam 批 $25 后一键 `--live`。**因为信任所以简单。** 证据说话。
