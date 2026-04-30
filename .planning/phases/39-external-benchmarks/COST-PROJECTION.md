# Phase 39 — Cost Projection

**Source:** `node apps/eval/external-benchmarks/run-all.mjs --dry-run --arm=<arm>` cross-validated against this table.
**Pricing (D-39-7, SiliconFlow public 2026-04-29):**

| Model | Input $/M tok | Output $/M tok |
|-------|--------------:|---------------:|
| Qwen/Qwen2.5-7B-Instruct  | 0.07 | 0.14 |
| Qwen/Qwen2.5-72B-Instruct | 0.50 | 1.50 |
| BAAI/bge-m3 (embeddings)  | 0.00 | 0.00 |
| gpt-5.4-nano (optional judge) | 0.10 | 0.40 |

**Hard cap:** $25 total (D15 / D-39-2). Override via `PA_BENCH_MAX_BUDGET_USD`.

---

## Per-arm projection (subset sizes locked in CONTEXT §2)

### Arm 1: Qwen-7B raw (model-under-test baseline)

| Benchmark | Calls | In tok | Out tok | Cost USD |
|-----------|------:|-------:|--------:|---------:|
| botchat              |   400 |   320,000 |   80,000 | $0.0336 |
| character-eval       |   385 |   462,000 |  115,500 | $0.0485 |
| empathetic-dialogues | 1,000 |   600,000 |  200,000 | $0.0700 |
| esconv               |   400 |   320,000 |  100,000 | $0.0364 |
| role-llm             |   200 |   200,000 |   60,000 | $0.0224 |
| **Subtotal**         | **2,385** | **1,902,000** | **555,500** | **$0.2109** |

### Arm 2: Qwen-72B raw (comparison; success criterion ≥1/5)

| Benchmark | Calls | In tok | Out tok | Cost USD |
|-----------|------:|-------:|--------:|---------:|
| botchat              |   400 |   320,000 |   80,000 | $0.2800 |
| character-eval       |   385 |   462,000 |  115,500 | $0.4042 |
| empathetic-dialogues | 1,000 |   600,000 |  200,000 | $0.6000 |
| esconv               |   400 |   320,000 |  100,000 | $0.3100 |
| role-llm             |   200 |   200,000 |   60,000 | $0.1900 |
| **Subtotal**         | **2,385** | **1,902,000** | **555,500** | **$1.7842** |

### Arm 3: Claire stack (Qwen-7B + 4 detector/inject/fsm/memory passes; ~10% re-roll overhead)

| Benchmark | Calls | In tok | Out tok | Cost USD |
|-----------|------:|-------:|--------:|---------:|
| botchat              |   400 |   352,000 |   88,000 | $0.0370 |
| character-eval       |   385 |   508,200 |  127,050 | $0.0534 |
| empathetic-dialogues | 1,000 |   660,000 |  220,000 | $0.0770 |
| esconv               |   400 |   352,000 |  110,000 | $0.0400 |
| role-llm             |   200 |   220,000 |   66,000 | $0.0246 |
| **Subtotal**         | **2,385** | **2,092,200** | **611,050** | **$0.2320** |

---

## Optional judge cost (gpt-5.4-nano)

If `OPENAI_API_KEY` set, judge replaces Qwen-72B in-house judge for botchat / role-llm (~250 judge calls per arm × 800 in / 400 out tok):

| Benchmark | Judge calls | In tok | Out tok | Cost USD per arm |
|-----------|------------:|-------:|--------:|-----------------:|
| botchat (judge)   |  50 |   40,000 |  20,000 | $0.0120 |
| role-llm (judge)  | 200 |  160,000 |  80,000 | $0.0480 |
| **Subtotal/arm**  | 250 |  200,000 | 100,000 | **$0.0600** |

3 arms × $0.06 = **$0.18** judge total (optional).

---

## Grand total (all 3 arms × 5 benchmarks + optional judge)

| Component                       |   Cost USD |
|---------------------------------|-----------:|
| Qwen-7B raw arm                 |   $0.2109 |
| Qwen-72B raw arm                |   $1.7842 |
| Claire stack arm                |   $0.2320 |
| Optional gpt-5.4-nano judge × 3 |   $0.1800 |
| **Total**                       | **$2.4071** |
| Headroom vs $25 cap             | **$22.59** |

Even running all 3 arms with optional judges, projected spend is well under the $25 ceiling. Cost-ledger enforces hard abort at runtime if any single charge would push the running total ≥ $25 (defense-in-depth — verified in `run-all.test.mjs`).

---

## How to verify (Adam, before approving budget)

```bash
node apps/eval/external-benchmarks/run-all.mjs --dry-run --arm=qwen-7b-raw
node apps/eval/external-benchmarks/run-all.mjs --dry-run --arm=qwen-72b-raw
node apps/eval/external-benchmarks/run-all.mjs --dry-run --arm=claire-stack
```

Each command prints a JSON plan with `total_projected_cost_usd` + `budget_ok: true`. Numbers must equal the per-arm subtotals in this file.

---

## Notes

- 10% overhead on claire-stack arm = re-roll budget for F1/F2 strip + memory-policy `triggered` re-roll path (single re-roll cap per CONTEXT D-39-4).
- Per-call token estimates from CONTEXT §2 Benchmark spec table (locked).
- Subset sizes locked in CONTEXT §2; reducing them further is a knob if Adam wants tighter budget.
- Real spend will likely be lower (input-token estimates are upper-bound; many calls truncate prompts).
- `--max-budget-usd=N` flag overrides default 25.
