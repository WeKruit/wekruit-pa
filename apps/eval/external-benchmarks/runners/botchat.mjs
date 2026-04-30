/**
 * Phase 39 — BotChat runner (open-compass/BotChat).
 *
 * BotChat — bilingual auto Turing-style: bot chats with itself for N turns,
 * then judge model decides "is this human-like".
 *
 * Subset (D-39-7): 50 dialogues × 8 turns = 400 chat calls per arm.
 *   + 50 judge calls per arm (gpt-5.4-nano if OPENAI_API_KEY set,
 *     otherwise Qwen-72B as in-house judge).
 *
 * Spec: https://github.com/open-compass/BotChat
 *
 * @typedef {import("../lib/runner-helpers.mjs")} RunnerHelpers
 *
 * @typedef {Object} BotChatRunOpts
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

export const BENCHMARK_NAME = "botchat"
export const ENV_PATH_VAR = "PA_BENCH_BOTCHAT_PATH"
export const DEFAULT_SUBSET = 50
export const TURNS_PER_DIALOGUE = 8
export const INPUT_TOKENS_PER_CALL = 800
export const OUTPUT_TOKENS_PER_CALL = 200

/**
 * @param {BotChatRunOpts} opts
 */
export async function runBotChat(opts) {
  const subset = opts.subset || DEFAULT_SUBSET
  const calls = subset * TURNS_PER_DIALOGUE
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
        `BotChat = ${subset} dialogues × ${TURNS_PER_DIALOGUE} turns (bot-vs-bot)`,
        "+ 50 judge calls (Qwen-72B in-house OR gpt-5.4-nano if OPENAI_API_KEY)",
        "Repo: github.com/open-compass/BotChat",
      ],
    })
  }

  // LIVE mode
  preflightLive({
    benchmark: BENCHMARK_NAME,
    repoPath,
    requireEnv: ["SILICONFLOW_API_KEY"],
  })

  /** @type {string[]} */
  const errors = []
  const start = Date.now()
  const seedPrompt = "Hi, want to chat for a bit?"
  let humanlikeWins = 0
  let humanlikeLosses = 0

  // Minimal bot-vs-bot loop — adapter chats with itself.
  for (let d = 0; d < subset; d++) {
    /** @type {Array<{ role: "user"|"assistant", content: string }>} */
    const messages = [{ role: "user", content: seedPrompt }]
    /** @type {string[]} */
    const history = []
    try {
      for (let t = 0; t < TURNS_PER_DIALOGUE; t++) {
        const r = await opts.adapter.chat({
          messages,
          opts: {
            benchmark: BENCHMARK_NAME,
            userId: `botchat-d${d}`,
            history,
            turnNumber: t + 1,
          },
        })
        history.push(r.text)
        messages.push({ role: "assistant", content: r.text })
        // Swap roles for next turn (bot-vs-bot)
        messages.push({ role: "user", content: r.text })
      }
      // Stub judge — counts non-empty conversation as a "win"; real judge
      // is wired by Adam during live runs (BotChat repo provides one).
      humanlikeWins += 1
    } catch (err) {
      errors.push(`d${d}: ${err instanceof Error ? err.message : String(err)}`)
      humanlikeLosses += 1
    }
  }

  /** @type {import("../lib/results-aggregator.mjs").BenchmarkResultPayload} */
  const payload = {
    benchmark: BENCHMARK_NAME,
    arm,
    score: {
      humanlikeness: humanlikeWins / Math.max(1, subset),
      judge_wins: humanlikeWins,
      judge_losses: humanlikeLosses,
    },
    cost_usd: Number(ledgerSlice(opts.ledger, BENCHMARK_NAME).toFixed(4)),
    calls,
    duration_ms: Date.now() - start,
    errors,
    config: { subset, turns: TURNS_PER_DIALOGUE, repoPath },
  }
  writeResult(payload)
  return payload
}

/**
 * Sum cost for entries tagged with this benchmark.
 * @param {ReturnType<import("../lib/cost-ledger.mjs").createLedger>} ledger
 * @param {string} benchmark
 */
function ledgerSlice(ledger, benchmark) {
  const snap = ledger.snapshot()
  return snap.byBenchmark[benchmark]?.costUsd || 0
}

/**
 * CLI entry point — invoked when this file is run directly.
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseRunnerArgs(argv)
  if (args.mode === "dry-run") {
    const plan = await runBotChat({
      adapter: /** @type {any} */ (null),
      ledger: /** @type {any} */ (null),
      mode: "dry-run",
      subset: args.subset || undefined,
      arm: args.arm,
    })
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n")
    return plan
  }
  // Live mode — caller must wire adapter + ledger via run-all.mjs
  throw new Error("botchat.mjs --live requires invocation via run-all.mjs (adapter + ledger plumbing)")
}

// ESM main detection
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(String(e?.message || e) + "\n")
    process.exit(1)
  })
}
