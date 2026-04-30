/**
 * Phase 39 — CharacterEval runner (morecry/CharacterEval, ZH).
 *
 * 77 Chinese characters × 12 metrics. Subset (CONTEXT §2): 77 chars × 5 prompts.
 * Python repo wrapper — runner emits invocation spec for `python -m characterval`;
 * full Python venv setup is Adam's environment (SETUP.md).
 *
 * Spec: https://github.com/morecry/CharacterEval
 *
 * @typedef {Object} CharacterEvalRunOpts
 * @property {{ chat: Function, arm?: string }} adapter
 * @property {ReturnType<import("../lib/cost-ledger.mjs").createLedger>} ledger
 * @property {"dry-run"|"live"} mode
 * @property {number} [subset]
 * @property {string} [arm]
 */

import {
  buildDryRunPlan,
  parseRunnerArgs,
  preflightLive,
  resolveRepoPath,
} from "../lib/runner-helpers.mjs"
import { writeResult } from "../lib/results-aggregator.mjs"

export const BENCHMARK_NAME = "character-eval"
export const ENV_PATH_VAR = "PA_BENCH_CHARACTER_EVAL_PATH"
export const DEFAULT_SUBSET = 77 // chars
export const PROMPTS_PER_CHAR = 5
export const INPUT_TOKENS_PER_CALL = 1200
export const OUTPUT_TOKENS_PER_CALL = 300

/**
 * @param {CharacterEvalRunOpts} opts
 */
export async function runCharacterEval(opts) {
  const subset = opts.subset || DEFAULT_SUBSET
  const calls = subset * PROMPTS_PER_CHAR
  const arm = opts.arm || (opts.adapter && opts.adapter.arm) || "claire-stack"
  const repoPath = resolveRepoPath(BENCHMARK_NAME, ENV_PATH_VAR)

  const armToModel = {
    "qwen-7b-raw": "Qwen/Qwen2.5-7B-Instruct",
    "qwen-72b-raw": "Qwen/Qwen2.5-72B-Instruct",
    "claire-stack": "Qwen/Qwen2.5-7B-Instruct",
  }
  const model = armToModel[arm] || armToModel["claire-stack"]
  const subprocessCmd = [
    "python",
    "-m",
    "characterval",
    `--base-url=${process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1"}`,
    `--model=${model}`,
    `--output-dir=results/character-eval-${arm}`,
    `--num-chars=${subset}`,
    `--prompts-per-char=${PROMPTS_PER_CHAR}`,
  ]

  if (opts.mode === "dry-run") {
    return buildDryRunPlan({
      benchmark: BENCHMARK_NAME,
      arm,
      calls,
      inputTokensPerCall: INPUT_TOKENS_PER_CALL,
      outputTokensPerCall: OUTPUT_TOKENS_PER_CALL,
      repoPath,
      subset,
      notes: [
        `CharacterEval = ${subset} chars × ${PROMPTS_PER_CHAR} prompts (ZH role-play)`,
        "12 metrics evaluated by repo's built-in judge (or gpt-5.4-nano if OPENAI_API_KEY)",
        "Repo: github.com/morecry/CharacterEval (Python — Adam runs subprocess)",
        `Subprocess: ${subprocessCmd.join(" ")}`,
      ],
    })
  }

  // LIVE mode — Python subprocess invocation lives in Adam's env.
  // We provide command spec + minimal in-process verification of adapter chat
  // (1 sample call per char to validate chat surface + drive ledger).
  preflightLive({
    benchmark: BENCHMARK_NAME,
    repoPath,
    requireEnv: ["SILICONFLOW_API_KEY"],
  })

  /** @type {string[]} */
  const errors = []
  const start = Date.now()
  let answered = 0

  for (let c = 0; c < subset; c++) {
    try {
      const r = await opts.adapter.chat({
        messages: [
          { role: "system", content: "You are a Chinese fictional character. Reply in Chinese." },
          { role: "user", content: `角色 #${c + 1}：请自我介绍一下。` },
        ],
        opts: {
          benchmark: BENCHMARK_NAME,
          userId: `chareval-c${c}`,
          turnNumber: 1,
        },
      })
      if (r && typeof r.text === "string" && r.text.length > 0) answered += 1
    } catch (err) {
      errors.push(`c${c}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** @type {import("../lib/results-aggregator.mjs").BenchmarkResultPayload} */
  const payload = {
    benchmark: BENCHMARK_NAME,
    arm,
    score: {
      sample_calls_answered: answered,
      sample_call_rate: answered / Math.max(1, subset),
      // 12-metric scores filled by Adam's Python subprocess output
      metrics_pending_subprocess: 1,
    },
    cost_usd: Number(ledgerSlice(opts.ledger, BENCHMARK_NAME).toFixed(4)),
    calls: subset,
    duration_ms: Date.now() - start,
    errors,
    config: {
      subset,
      promptsPerChar: PROMPTS_PER_CHAR,
      repoPath,
      subprocessCmd,
      note: "Full 12-metric scores require running subprocessCmd in Adam's Python env",
    },
  }
  writeResult(payload)
  return payload
}

/**
 * @param {ReturnType<import("../lib/cost-ledger.mjs").createLedger>} ledger
 * @param {string} benchmark
 */
function ledgerSlice(ledger, benchmark) {
  const snap = ledger.snapshot()
  return snap.byBenchmark[benchmark]?.costUsd || 0
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseRunnerArgs(argv)
  if (args.mode === "dry-run") {
    const plan = await runCharacterEval({
      adapter: /** @type {any} */ (null),
      ledger: /** @type {any} */ (null),
      mode: "dry-run",
      subset: args.subset || undefined,
      arm: args.arm,
    })
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n")
    return plan
  }
  throw new Error("character-eval.mjs --live requires invocation via run-all.mjs (adapter + ledger plumbing)")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(String(e?.message || e) + "\n")
    process.exit(1)
  })
}
