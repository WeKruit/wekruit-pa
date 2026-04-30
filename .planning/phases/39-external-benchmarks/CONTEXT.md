# Phase 39 — External Auto Benchmarks (5 benchmarks) — CONTEXT

> [🟠 阿里味] **底层逻辑**：5 benchmark = Claire stack 上公共榜的入场券。BUILD-only — actual run 等 Adam 批 $25。证据说话。**抓手清晰**：harness scripts + 2 model adapters + cost ledger + 5 runners + 1 orchestrator + runbook. 闭环到底。

**Owner:** P9-C (v1.4 humanize-runtime stream)
**Estimate:** ~1 dev-day BUILD-only
**Upstream gate:** Phase 38 Memory Policy ✅ PARTIAL (modules built; wire-in Adam-owed) — not blocking, harness uses direct module imports
**Downstream:** Phase 40 (Bible v7.5 + Crisis + Ship — final phase) reads benchmark report once Adam runs `--live`

---

## 1. Phase boundary

### In scope (BENCH-01..07, BUILD-only)

Harness package under `apps/eval/external-benchmarks/` — ESM Node, **0 production-path LLM calls** (this is offline benchmarking; runs deferred to Adam after $25 budget approval).

Files to ship:

| File | Role |
|------|------|
| `package.json` | New ESM Node package `@pa/external-benchmarks`. Workspace member (already covered by `apps/*` glob in root `package.json` workspaces). Scripts: `typecheck`, `test`, `bench:dry-run`, `bench:live`. |
| `tsconfig.json` | Used only for `tsc --noEmit` typecheck on `.mjs` (via `allowJs + checkJs`) — keeps parity with sibling apps style. |
| `lib/cost-ledger.mjs` | Tracks per-benchmark $ spend using SiliconFlow Qwen-7B / Qwen-72B / BGE-M3 prices. Hard-aborts when `total >= MAX_BUDGET_USD` (default 25). Persists to `.planning/phases/39-external-benchmarks/results/cost-ledger.json`. |
| `lib/qwen-7b-adapter.mjs` | Adapter that points each benchmark's "model under test" hook at our SiliconFlow `Qwen/Qwen2.5-7B-Instruct` endpoint. Single `chat({ messages, opts }) → { text, usage }` interface. Reuses `SILICONFLOW_API_KEY` env var. |
| `lib/qwen-72b-adapter.mjs` | Same shape, points at `Qwen/Qwen2.5-72B-Instruct` for the "Qwen-72B raw" comparison arm (per Phase 39 success criterion: Claire stack ≥ Qwen-72B raw on ≥ 1 of 5). |
| `lib/claire-stack-adapter.mjs` | Adapter wrapping our orchestrator stack via direct imports of Phase 35-38 modules. Wraps Qwen-7B base + runs detector pass + injector pass + FSM pass + memory-policy pass IN-PROCESS. **Same `chat()` interface** as qwen-7b-adapter so benchmarks see identical surface. |
| `lib/results-aggregator.mjs` | Collects raw output + writes `.planning/phases/39-external-benchmarks/results/{benchmark}.json` with score + cost + traces. |
| `lib/sf-client.mjs` | Thin SiliconFlow OpenAI-compat wrapper (chat completions + embeddings). Env-driven. Used by all 3 adapters. |
| `runners/botchat.mjs` | BotChat (open-compass) runner. Bilingual auto Turing-style. Dry-run mode prints command + projected cost without executing. Live mode invokes adapter pair (chat-with-self) + judge. |
| `runners/character-eval.mjs` | CharacterEval (morecry, ZH 77-char × 12-metric) runner. Python repo wrapper — dry-run prints invocation; live mode requires Adam to have cloned repo + `python -m characterval` available. |
| `runners/empathetic-dialogues.mjs` | EmpatheticDialogues (facebookresearch, EN 25k convs) runner. Subset 1000 per BENCH-03. |
| `runners/esconv.mjs` | ESConv (thu-coai, EN 8 strategies) runner. Subset 200 per BENCH-04. |
| `runners/role-llm.mjs` | RoleLLM (InteractiveNLP-Team, EN 100 chars) runner. Subset 50 per BENCH-05. |
| `run-all.mjs` | Top-level orchestrator. `--dry-run` prints plan + projected total cost (must be ≤ $25). `--live` executes all 5 + writes aggregate report. |
| `lib/cost-ledger.test.mjs` | Unit tests — accumulation, abort threshold, persistence round-trip. |
| `lib/qwen-7b-adapter.test.mjs` | Unit tests — env var resolution, request shape, mock fetch. |
| `lib/claire-stack-adapter.test.mjs` | Unit tests — pipeline invocation order (detect → inject → fsm → memory), graceful degrade when modules missing. |
| `lib/results-aggregator.test.mjs` | Unit tests — JSON round-trip, schema validation. |
| `runners/*-dry-run.test.mjs` | One per runner — verifies `--dry-run` prints valid plan + budget projection (no network). |

Plus deliverables (Adam-readable):

| File | Role |
|------|------|
| `.planning/phases/39-external-benchmarks/SETUP.md` | Runbook for Adam — env vars, clone instructions for 5 benchmark repos (vendor/ + .gitignore approach), expected runtime, expected total spend. |
| `.planning/phases/39-external-benchmarks/COST-PROJECTION.md` | Per-benchmark token estimate × SiliconFlow Qwen-7B price + Qwen-72B comparison cost + BGE-M3 free + judge cost (optional OpenAI gpt-5.4-nano). Total ≤ $25. |
| `.planning/phases/39-external-benchmarks/WIRE-IN-PATCH.md` | Spec — claire-stack-adapter uses **direct module imports** (no orchestrator wire-in needed because we bypass `llm-rewriter.ts` and call modules directly). Documents the import surface + Adam follow-up if integration into prod orchestrator desired post-benchmark. |

### Out of scope (deferred)

| Item | Defer to | Why |
|------|----------|-----|
| **Actual benchmark runs** (BENCH-01..07 numeric results) | Adam after $25 budget approval | Adam ownership: clone repos + export keys + run `--live`. Harness BUILDS-only this phase. |
| **Aggregate report `benchmark-v1.4.md`** (BENCH-06) | Adam after live runs | Requires actual scores. Phase 39 scaffolds the writer; Adam invokes after `--live`. |
| **CharacterEval Python pipeline integration** (full subprocess wiring) | Adam runbook | Python repo — wrapper script invokes via subprocess; full Python venv setup is Adam's environment. Runner provides command spec + dry-run validation only. |
| **Cloning benchmark repos into our tree** | `vendor/` + `.gitignore` (Adam clones manually) | Per P10 brief: "DO NOT clone benchmark repos into our tree as committed code." Runbook documents `git clone` commands. |
| **Live wire-in into `llm-rewriter.ts`** | Adam wire-in (post Phase 35-38 wire-ins land) | Claire-stack-adapter calls Phase 35-38 modules directly via TS-compiled imports — production wire-in is Adam's separate workflow. |
| **Cost-attribution per-turn telemetry** | Phase 40 ship dashboard | Cost ledger is benchmark-level only. Per-turn telemetry lives in production `pa_turns.usage`. |

---

## 2. Methodology — adapter-pattern + cost ledger + dry-run-first

**Decision (locked):** Each benchmark gets one runner that talks to our shared `chat()` interface (3 adapters: Qwen-7B raw / Qwen-72B raw / Claire stack). Runner does NOT know which adapter — it just calls `adapter.chat({ messages })`. This means swapping arms = swapping the adapter param, no per-runner change.

**Why dry-run first:**
- Adam owes $25 budget approval before any live spend.
- Dry-run prints: number of API calls × per-call token estimate × adapter price → projected cost per benchmark.
- Total dry-run output must show `≤ $25` projected total OR runner refuses to enter live mode.
- Cost ledger ALSO enforces at runtime (defense-in-depth) — aborts if running total ≥ $25 mid-run.

**Why Claire-stack-adapter via direct module imports:**
- Phase 35-38 wire-ins are Adam-owed (deferred per WIRE-IN-PATCH.md per phase).
- For benchmarking, we DON'T need the prod `llm-rewriter.ts` flow — we need to apply the same logical transformations (detect → inject → fsm → memory) on Qwen-7B raw output.
- Direct imports bypass the wire-in dependency: harness imports `runAllDetectors` from `packages/pa-orchestrator/src/voice/detectors/index.ts`, `injectImperfection` from `imperfection-injector/index.ts`, `runFsm` from `fsm/index.ts`, `runMemoryPolicy` from `memory-policy/index.ts`. Composes them in-process.
- This is the same composition Adam will eventually wire into `llm-rewriter.ts` — benchmark validates the composition works end-to-end.

**Adapter contract (3 adapters, same shape):**

```js
async chat({ messages, opts }) → {
  text: string,         // assistant reply
  usage: {
    inputTokens: number,
    outputTokens: number,
    costUSD: number,    // computed from price table at call time
  },
  meta: {
    arm: "qwen-7b-raw" | "qwen-72b-raw" | "claire-stack",
    pipeline?: string[]  // claire-stack only: ["draft", "detector", "injector", "fsm", "memory"]
  }
}
```

### Reuse manifest (verified existing assets)

| Asset | Path | Use |
|-------|------|-----|
| Detectors module (Phase 35) | `packages/pa-orchestrator/src/voice/detectors/index.ts` | Direct import in claire-stack-adapter |
| ImperfectionInjector module (Phase 36) | `packages/pa-orchestrator/src/voice/imperfection-injector/index.ts` | Direct import in claire-stack-adapter |
| FSM module (Phase 37) | `packages/pa-orchestrator/src/voice/fsm/index.ts` | Direct import in claire-stack-adapter |
| Memory Policy module (Phase 38) | `packages/pa-orchestrator/src/voice/memory-policy/index.ts` | Direct import in claire-stack-adapter |
| SiliconFlow env var pattern | Phase 33 `embed-sim.mjs` | Same `SILICONFLOW_API_KEY` → `PA_OPENAI_AGENT_API_KEY` → `PA_SILICONFLOW_API_KEY` chain |
| BGE-M3 embedding wrapper | Phase 33 `embed-sim.mjs` + Phase 35 `f4-advice-repeat.ts` | sf-client wraps for parity |
| Cost-ledger pattern | `tests/scenarios/judge.mjs` cost tracking | Same per-call accumulation pattern |

### Benchmark spec (per repo)

| Benchmark | Repo | Lang | Subset size | Mode | Per-call est tokens (in/out) |
|-----------|------|------|-------------|------|------------------------------|
| BotChat | open-compass/BotChat | bilingual | 50 dialogues × 8 turns | bot-vs-bot + judge | 800/200 |
| CharacterEval | morecry/CharacterEval | ZH | 77 chars × 5 prompts (subset) | role-play + 12-metric eval | 1200/300 |
| EmpatheticDialogues | facebookresearch/EmpatheticDialogues | EN | 1000 convs (per BENCH-03) | response-gen + nl-judge | 600/200 |
| ESConv | thu-coai/Emotional-Support-Conversation | EN | 200 convs | strategy-classification + response-gen | 800/250 |
| RoleLLM | InteractiveNLP-Team/RoleLLM-public | EN | 50 chars × 4 prompts | role-play + judge | 1000/300 |

---

## 3. Decisions (P9-C calls — locked unless Adam vetos)

### D-39-1: Package = ESM `.mjs` (not `.ts`)

- Per P10 brief: "TypeScript / .mjs only".
- Sibling `tests/scenarios/runner.mjs` + `apps/stress` are .mjs.
- Avoids tsc setup overhead for what is essentially a bench harness, not production code.
- Typecheck via `tsc --noEmit --allowJs --checkJs` for .mjs JSDoc-typed.

### D-39-2: Cost ledger MAX_BUDGET_USD = 25 (matches D15)

- Hard limit per Phase 39 gate.
- Configurable via `PA_BENCH_MAX_BUDGET_USD` env (defaults 25).
- Aborts mid-run if `total >= 25` (raises `BenchmarkBudgetExceeded` error; runner catches + writes partial report).
- COST-PROJECTION.md must show projected total ≤ $20 to leave headroom.

### D-39-3: Dry-run is the default; `--live` opt-in

- Running `node run-all.mjs` with no flag = dry-run mode (prints plan + cost projection, no network calls).
- `--live` flag explicitly opts in to spending money. Logs warning + 5-second countdown before executing.
- Each runner has same convention.

### D-39-4: Claire-stack-adapter pipeline = detector → inject → fsm → memory (post-process)

- Order: Get Qwen-7B raw draft → run detectors → if F1/F2 trigger, apply strip → run injector (turn-onset only) → run FSM (compute strategy directive — used for next-turn prompt, not current draft) → run memory-policy (compute repeat score — used to flag draft for re-roll if `triggered`).
- Single re-roll max if F1 strip not enough OR memory repeat triggered. After re-roll, ship as-is (fail-open).
- This mirrors the WIRE-IN-PATCH.md compositions across Phases 35-38 (consistent with what Adam will eventually wire into `llm-rewriter.ts`).

### D-39-5: Repos NOT cloned into tree

- Per P10 brief.
- SETUP.md provides exact `git clone` commands for Adam, target dir = `.planning/phases/39-external-benchmarks/vendor/{benchmark}` (gitignored).
- Runners read repo path from env (`PA_BENCH_BOTCHAT_PATH` etc.) with sane defaults (`./vendor/{benchmark}`).

### D-39-6: Test coverage = unit + dry-run smoke (NO live network in tests)

- `lib/*.test.mjs` — unit tests with mocked fetch.
- `runners/*-dry-run.test.mjs` — smoke: invoke runner with `--dry-run`, assert printed plan contains expected fields.
- Live runs are Adam's responsibility post-budget approval; CI never runs `--live`.

### D-39-7: COST-PROJECTION.md uses SiliconFlow public pricing as of 2026-04-29

- Qwen2.5-7B-Instruct: $0.07/M input + $0.14/M output (2026 SiliconFlow rate)
- Qwen2.5-72B-Instruct: $0.50/M input + $1.50/M output
- BAAI/bge-m3 embeddings: free
- gpt-5.4-nano (judge, optional): $0.10/M input + $0.40/M output
- Hard-coded into `lib/cost-ledger.mjs` `PRICE_TABLE`. Adam can override via `PA_BENCH_PRICE_TABLE_JSON` env.

### D-39-8: Runner output schema = stable JSON

```json
{
  "benchmark": "botchat",
  "arm": "claire-stack",
  "score": { "humanlikeness": 0.62, "judge_wins": 31, "judge_losses": 12 },
  "cost_usd": 3.42,
  "calls": 124,
  "duration_ms": 482312,
  "errors": [],
  "config": { ... }
}
```

Stable schema enables `lib/results-aggregator.mjs` to mechanically diff arms + write the v1.4 ship report (BENCH-06).

---

## 4. Acceptance gates (Phase 39 done = all green)

- [ ] `npm --workspace @pa/external-benchmarks run typecheck` clean
- [ ] All `lib/*.test.mjs` pass via `node --test apps/eval/external-benchmarks/lib/*.test.mjs`
- [ ] All `runners/*-dry-run.test.mjs` pass — each runner prints valid plan + projected cost
- [ ] `node apps/eval/external-benchmarks/run-all.mjs --dry-run` prints plan covering 5 benchmarks + total projected cost ≤ $25
- [ ] Cost ledger refuses to add a call that would push total ≥ $25 (unit-tested)
- [ ] `SETUP.md` written — Adam-readable, no Q's; covers env vars + clone commands + runtime estimate
- [ ] `COST-PROJECTION.md` written — per-benchmark line items + total ≤ $25
- [ ] `WIRE-IN-PATCH.md` written — claire-stack-adapter direct-import pattern documented
- [ ] `STATE.md` Phase 39 row → ✅ partial (BUILD complete, RUNS deferred Adam $25 OK), `completed_phases` 10 → 11

---

## 5. Hard constraints applied (P10 lockdown)

- TypeScript / .mjs only ✅ (.mjs with JSDoc types)
- 0 net new LLM calls in production path ✅ (offline harness only)
- Total benchmark spend ≤ $25 ✅ (cost ledger enforces hard abort)
- SiliconFlow Qwen2.5-7B-Instruct = model-under-test ✅
- SiliconFlow Qwen2.5-72B-Instruct = comparison ✅
- BGE-M3 via SiliconFlow only ✅
- DO NOT clone benchmark repos as committed code ✅ (vendor/ + .gitignore + SETUP.md runbook)
- Latency irrelevant ✅ (offline batch)
- **Files NOT touched** (Adam uncommitted-work collision avoidance):
  - `apps/functions/src/admin-bootstrap.ts`
  - `packages/pa-orchestrator/src/voice/llm-rewriter.ts` + `.test.ts`
  - Any other Adam-untracked files

---

## 6. Risks + mitigations

| Risk | Mitigation |
|------|------------|
| Phase 35-38 module imports break (rootDir / module resolution) when consumed from `apps/eval/external-benchmarks/` | Use the published package entry — `apps/eval/external-benchmarks/package.json` declares dependency on `@pa/pa-orchestrator` workspace; harness imports from `@pa/pa-orchestrator/voice/...` paths the package already exposes. Verified Phase 35 detectors export from `index.ts` which is part of package exports. |
| Live cost overrun | Defense-in-depth: dry-run gate + runtime cost ledger hard abort + per-runner subset caps + COST-PROJECTION.md headroom. |
| Benchmark repo schema drift | Runners read repo data via documented file paths; if drift, runner errors loudly with file path expected. SETUP.md pins repo SHA references. |
| CharacterEval Python wrapper fragility | Runner emits subprocess command spec; full Python execution is Adam's environment. `--dry-run` validates command structure + paths only. |
| Claire-stack-adapter doesn't match eventual prod wire-in | Composition order documented in WIRE-IN-PATCH.md mirrors Phase 35-38 individual WIRE-IN-PATCH.md specs. Adam reviewing wire-ins will catch any drift. |
| Adam clones repos to wrong path | SETUP.md gives exact paths + env var override. Runner errors with `expected vendor/{benchmark}, set PA_BENCH_X_PATH to override`. |

---

## 7. Cross-stream sync

- **Phase 35-38** (detector / injector / fsm / memory-policy modules) — direct in-process import via `@pa/pa-orchestrator` workspace dep. Zero file collision (read-only consumption).
- **Phase 40** (Bible v7.5 + Ship) — consumes `results/{benchmark}.json` aggregates after Adam runs `--live`. Phase 40 SHIP-04 audit reads benchmark report.
- **No Stream A collision** — Stream A complete; nothing in `pa-eval-triggers/` namespace.

---

> [🟠 阿里味] **闭环意识**：CONTEXT 抓手清晰 — 5 个 task = package skeleton + claire-stack-adapter + 5 runners + orchestrator + runbook. **因为信任所以简单**：Phase 35-38 modules 都 export 干净，直接 import 就行。Adam 批 $25 后一键 `--live`。证据说话。
