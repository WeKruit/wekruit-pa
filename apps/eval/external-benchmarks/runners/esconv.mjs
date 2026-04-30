/**
 * Phase 39 — ESConv runner (thu-coai/Emotional-Support-Conversation, EN).
 *
 * Emotional Support Conversation, 8 strategies. Subset (CONTEXT §2 / BENCH-04): 200 convs.
 * Each conv: classify support strategy + generate next-turn response.
 *
 * Spec: https://github.com/thu-coai/Emotional-Support-Conversation
 *
 * @typedef {Object} ESConvRunOpts
 * @property {{ chat: Function, arm?: string }} adapter
 * @property {ReturnType<import("../lib/cost-ledger.mjs").createLedger>} ledger
 * @property {"dry-run"|"live"} mode
 * @property {number} [subset]
 * @property {string} [arm]
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  buildDryRunPlan,
  parseRunnerArgs,
  preflightLive,
  resolveRepoPath,
} from "../lib/runner-helpers.mjs"
import { writeResult } from "../lib/results-aggregator.mjs"

export const BENCHMARK_NAME = "esconv"
export const ENV_PATH_VAR = "PA_BENCH_ESCONV_PATH"
export const DEFAULT_SUBSET = 200
export const INPUT_TOKENS_PER_CALL = 800
export const OUTPUT_TOKENS_PER_CALL = 250
export const STRATEGIES = Object.freeze([
  "Question",
  "Restatement or Paraphrasing",
  "Reflection of feelings",
  "Self-disclosure",
  "Affirmation and Reassurance",
  "Providing Suggestions",
  "Information",
  "Others",
])

/**
 * @param {ESConvRunOpts} opts
 */
export async function runESConv(opts) {
  const subset = opts.subset || DEFAULT_SUBSET
  // Per conv: 1 strategy classify + 1 response gen ≈ 2 calls/conv (in-process).
  // For cost projection use 2× subset.
  const calls = subset * 2
  const arm = opts.arm || (opts.adapter && opts.adapter.arm) || "claire-stack"
  const repoPath = resolveRepoPath(BENCHMARK_NAME, ENV_PATH_VAR)

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
        `ESConv = ${subset} convs × 2 calls (strategy classify + response gen)`,
        `8 ESConv strategies: ${STRATEGIES.join(", ")}`,
        "Repo: github.com/thu-coai/Emotional-Support-Conversation",
        "Expected file: ESConv.json",
      ],
    })
  }

  preflightLive({
    benchmark: BENCHMARK_NAME,
    repoPath,
    requireEnv: ["SILICONFLOW_API_KEY"],
  })

  const dataPath = join(repoPath, "ESConv.json")
  if (!existsSync(dataPath)) {
    throw new Error(
      `${BENCHMARK_NAME}: expected ${dataPath}; clone repo per SETUP.md or set ${ENV_PATH_VAR}`
    )
  }

  /** @type {any[]} */
  let convs
  try {
    convs = JSON.parse(readFileSync(dataPath, "utf-8"))
  } catch (err) {
    throw new Error(`${BENCHMARK_NAME}: failed to parse ${dataPath}: ${err instanceof Error ? err.message : err}`)
  }
  convs = convs.slice(0, subset)

  /** @type {string[]} */
  const errors = []
  const start = Date.now()
  let strategyHits = 0
  let responsesGenerated = 0

  for (let i = 0; i < convs.length; i++) {
    const conv = convs[i]
    const dialog = Array.isArray(conv?.dialog) ? conv.dialog : []
    const seekerTurns = dialog.filter((d) => d.speaker === "seeker").slice(0, 3)
    const supporterTurns = dialog.filter((d) => d.speaker === "supporter").slice(0, 1)
    const goldStrategy = supporterTurns[0]?.strategy || "Others"
    const seekerContext = seekerTurns.map((t) => t.content).join("\n") || "I'm feeling stressed."

    try {
      // Strategy classify
      const cls = await opts.adapter.chat({
        messages: [
          {
            role: "system",
            content: `Classify the best emotional support strategy for the following message. Reply with one of: ${STRATEGIES.join(", ")}.`,
          },
          { role: "user", content: seekerContext },
        ],
        opts: {
          benchmark: BENCHMARK_NAME,
          userId: `esconv-${i}-classify`,
          turnNumber: 1,
        },
      })
      if (cls && typeof cls.text === "string" && cls.text.includes(goldStrategy.split(" ")[0])) {
        strategyHits += 1
      }

      // Response gen
      const resp = await opts.adapter.chat({
        messages: [
          {
            role: "system",
            content: `You are an emotional support listener. Use the "${goldStrategy}" strategy.`,
          },
          { role: "user", content: seekerContext },
        ],
        opts: {
          benchmark: BENCHMARK_NAME,
          userId: `esconv-${i}-respond`,
          turnNumber: 2,
        },
      })
      if (resp && typeof resp.text === "string" && resp.text.length > 0) responsesGenerated += 1
    } catch (err) {
      errors.push(`${i}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** @type {import("../lib/results-aggregator.mjs").BenchmarkResultPayload} */
  const payload = {
    benchmark: BENCHMARK_NAME,
    arm,
    score: {
      strategy_accuracy: strategyHits / Math.max(1, convs.length),
      response_rate: responsesGenerated / Math.max(1, convs.length),
      strategies_evaluated: convs.length,
    },
    cost_usd: Number(ledgerSlice(opts.ledger, BENCHMARK_NAME).toFixed(4)),
    calls: convs.length * 2,
    duration_ms: Date.now() - start,
    errors,
    config: { subset, repoPath, dataPath, strategies: Array.from(STRATEGIES) },
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
    const plan = await runESConv({
      adapter: /** @type {any} */ (null),
      ledger: /** @type {any} */ (null),
      mode: "dry-run",
      subset: args.subset || undefined,
      arm: args.arm,
    })
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n")
    return plan
  }
  throw new Error("esconv.mjs --live requires invocation via run-all.mjs (adapter + ledger plumbing)")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(String(e?.message || e) + "\n")
    process.exit(1)
  })
}
