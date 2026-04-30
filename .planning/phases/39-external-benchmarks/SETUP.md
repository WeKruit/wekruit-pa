# Phase 39 — Adam Runbook (External Benchmark Live Runs)

**Status:** BUILD complete (P9-C, 5 runner harness + run-all orchestrator + cost ledger). Live runs deferred to Adam after $25 budget approval.

**Cost projection:** see `COST-PROJECTION.md` — total ≤ $2.41 across all 3 arms × 5 benchmarks (with optional judge), well under the $25 cap.

---

## 1. Clone benchmark repos (~3 GB total)

Repos NOT committed into our tree (per CONTEXT D-39-5). Default location: `apps/eval/external-benchmarks/vendor/{benchmark}/` (gitignored). Override per-benchmark via env var (Section 2).

```bash
mkdir -p apps/eval/external-benchmarks/vendor
cd apps/eval/external-benchmarks/vendor

git clone --depth 1 https://github.com/open-compass/BotChat.git botchat
git clone --depth 1 https://github.com/morecry/CharacterEval.git character-eval
git clone --depth 1 https://github.com/facebookresearch/EmpatheticDialogues.git empathetic-dialogues
git clone --depth 1 https://github.com/thu-coai/Emotional-Support-Conversation.git esconv
git clone --depth 1 https://github.com/InteractiveNLP-Team/RoleLLM-public.git role-llm

cd -
```

Sizes (approx):
| Repo | Disk | Notes |
|------|-----:|-------|
| BotChat                              | ~50 MB  | Python framework |
| CharacterEval                        | ~200 MB | ZH benchmark + 12-metric judge |
| EmpatheticDialogues                  | ~300 MB | 25k convs CSV |
| Emotional-Support-Conversation       | ~50 MB  | ESConv.json |
| RoleLLM-public                       | ~2 GB   | Largest — RoleBench-zh-en data |

CharacterEval needs a Python venv for the 12-metric scorer (Adam's environment — separate from this Node harness).

---

## 2. Environment variables

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `SILICONFLOW_API_KEY` | YES | — | SiliconFlow OpenAI-compat key (Qwen-7B + Qwen-72B chat + bge-m3 embeddings) |
| `PA_OPENAI_AGENT_API_KEY` | alt | — | Fallback name for SiliconFlow key (existing Phase 33 convention) |
| `PA_SILICONFLOW_API_KEY` | alt | — | Second fallback name |
| `OPENAI_API_KEY` | optional | — | Enables `gpt-5.4-nano` as judge (else Qwen-72B in-house judge) |
| `PA_BENCH_MAX_BUDGET_USD` | optional | 25 | Hard abort threshold (cost ledger) |
| `PA_BENCH_PRICE_TABLE_JSON` | optional | (built-in) | Override price table (JSON string) |
| `PA_BENCH_BOTCHAT_PATH` | optional | `vendor/botchat` | Override repo path |
| `PA_BENCH_CHARACTER_EVAL_PATH` | optional | `vendor/character-eval` | Override repo path |
| `PA_BENCH_EMPATHETIC_DIALOGUES_PATH` | optional | `vendor/empathetic-dialogues` | Override repo path |
| `PA_BENCH_ESCONV_PATH` | optional | `vendor/esconv` | Override repo path |
| `PA_BENCH_ROLE_LLM_PATH` | optional | `vendor/role-llm` | Override repo path |
| `PA_IMPERFECTION_ARM` | optional | `control` | Claire-stack arm only — set to `safe` or `verbal` to enable injection |

```bash
export SILICONFLOW_API_KEY="sk-..."
export OPENAI_API_KEY="sk-..."          # optional, judge-only
export PA_BENCH_MAX_BUDGET_USD=25
```

---

## 3. Expected runtime

Per benchmark per arm (approx, depends on SiliconFlow latency):

| Benchmark | Calls | Est runtime |
|-----------|------:|------------:|
| botchat              |   400 | ~30 min |
| character-eval       |   385 | ~45 min (+ Python subprocess for 12-metric scoring) |
| empathetic-dialogues | 1,000 | ~40 min |
| esconv               |   400 | ~20 min |
| role-llm             |   200 | ~25 min |
| **Per arm total**    | **2,385** | **~3 hr** |

3 arms serial: ~9 hr.
Recommended: run arms in separate terminal sessions (state isolated by ledger persistence path).

---

## 4. Expected spend

See `COST-PROJECTION.md` for full breakdown. Headline: **$2.41 grand total** for all 3 arms × 5 benchmarks + optional judge. Hard cap $25.

---

## 5. Run procedure

### Step 1: Dry-run sanity check (zero spend)

```bash
node apps/eval/external-benchmarks/run-all.mjs --dry-run
# Expect: JSON plan + budget_ok: true + total_projected_cost_usd ≈ $0.23 (claire-stack)
```

Repeat for each arm:
```bash
node apps/eval/external-benchmarks/run-all.mjs --dry-run --arm=qwen-7b-raw
node apps/eval/external-benchmarks/run-all.mjs --dry-run --arm=qwen-72b-raw
node apps/eval/external-benchmarks/run-all.mjs --dry-run --arm=claire-stack
```

### Step 2: Execute live (one arm at a time, recommended)

```bash
# 5-second countdown banner shown before execution begins; ctrl-C aborts cleanly
node apps/eval/external-benchmarks/run-all.mjs --live --arm=qwen-7b-raw
node apps/eval/external-benchmarks/run-all.mjs --live --arm=qwen-72b-raw
node apps/eval/external-benchmarks/run-all.mjs --live --arm=claire-stack
```

Each command:
- Charges the cost ledger on every call
- Persists `cost-ledger.json` to `apps/eval/external-benchmarks/results/`
- Aborts mid-run + writes partial aggregate if total ≥ `$PA_BENCH_MAX_BUDGET_USD`
- Writes per-benchmark result JSON to `results/{benchmark}-{arm}.json`

### Step 3: Inspect results

```bash
ls apps/eval/external-benchmarks/results/
# botchat-qwen-7b-raw.json, botchat-qwen-72b-raw.json, botchat-claire-stack.json,
# character-eval-qwen-7b-raw.json, ... aggregate-report.json, cost-ledger.json
```

Each result file conforms to schema (CONTEXT D-39-8):
```json
{
  "benchmark": "botchat",
  "arm": "claire-stack",
  "score": { ... },
  "cost_usd": 0.04,
  "calls": 400,
  "duration_ms": 1820312,
  "errors": [],
  "config": { ... },
  "ts": "2026-..."
}
```

### Step 4: CharacterEval — Python subprocess (only if running CharacterEval live)

Live runner emits `subprocessCmd` in result config. Adam runs in own Python venv:
```bash
cd apps/eval/external-benchmarks/vendor/character-eval
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m characterval --base-url=https://api.siliconflow.cn/v1 \
  --model=Qwen/Qwen2.5-7B-Instruct \
  --output-dir=../../results/character-eval-claire-stack \
  --num-chars=77 --prompts-per-char=5
```
The Python subprocess fills in the 12-metric scores. Re-run aggregator afterwards (Phase 40 SHIP-04 reads aggregate).

### Step 5: Failure recovery

- Cost ledger persists between runs — restart resumes the same budget
- Per-benchmark result files are idempotent (overwrite on re-run); safe to re-execute a single benchmark via `--only=botchat`
- If `BudgetExceededError` aborts mid-run: inspect `results/cost-ledger.json` for spend by benchmark; reduce `--subset=N` or raise `PA_BENCH_MAX_BUDGET_USD` and resume

---

## 6. Inspect cost mid-run

```bash
cat apps/eval/external-benchmarks/results/cost-ledger.json | head -40
# Shows totalUsd, remainingUsd, byBenchmark + byArm aggregates
```

---

## 7. After live runs complete (Phase 40 input)

`apps/eval/external-benchmarks/results/aggregate-report.json` is the canonical input for Phase 40 SHIP-04 audit (`benchmark-v1.4.md`). Phase 40 reads:
- `byBenchmark[X][arm]` for per-arm scores
- `totals.cost_usd` for spend reconciliation
- `errors` arrays for known failure surfaces

---

## Quick reference — every command

```bash
# 1. Clone repos (one-time, ~3 GB)
mkdir -p apps/eval/external-benchmarks/vendor && cd apps/eval/external-benchmarks/vendor
git clone --depth 1 https://github.com/open-compass/BotChat.git botchat
git clone --depth 1 https://github.com/morecry/CharacterEval.git character-eval
git clone --depth 1 https://github.com/facebookresearch/EmpatheticDialogues.git empathetic-dialogues
git clone --depth 1 https://github.com/thu-coai/Emotional-Support-Conversation.git esconv
git clone --depth 1 https://github.com/InteractiveNLP-Team/RoleLLM-public.git role-llm
cd -

# 2. Set keys
export SILICONFLOW_API_KEY="..."

# 3. Dry-run
node apps/eval/external-benchmarks/run-all.mjs --dry-run

# 4. Live (one arm at a time, ~3 hr each)
node apps/eval/external-benchmarks/run-all.mjs --live --arm=qwen-7b-raw
node apps/eval/external-benchmarks/run-all.mjs --live --arm=qwen-72b-raw
node apps/eval/external-benchmarks/run-all.mjs --live --arm=claire-stack

# 5. Inspect
cat apps/eval/external-benchmarks/results/aggregate-report.json
```
