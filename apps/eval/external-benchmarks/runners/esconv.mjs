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
    // ESConv schema: each dialog turn has { speaker, annotation: { strategy }, content };
    // strategy lives under .annotation.strategy, NOT directly on the turn.
    //
    // Align gold ↔ classifier input: walk the dialog, pick the FIRST supporter turn
    // that follows ≥2 substantive seeker turns. Otherwise the gold collapses to
    // ~70% "Question" (the canonical opening "what would you like to talk about?")
    // which doesn't match the strategy a classifier should pick given a 3-turn
    // seeker context. Use those preceding seeker turns as the classifier input.
    /** @type {Array<{ speaker: string, content: string, annotation?: any }>} */
    const turns = dialog
    /** @type {string[]} */
    const seekerSoFar = []
    /** @type {{ strategy: string, context: string[] } | null} */
    let pick = null
    for (const t of turns) {
      if (t.speaker === "seeker" && typeof t.content === "string" && t.content.trim().length > 10) {
        seekerSoFar.push(t.content)
        continue
      }
      if (t.speaker === "supporter" && t.annotation?.strategy && seekerSoFar.length >= 2) {
        pick = { strategy: t.annotation.strategy, context: seekerSoFar.slice() }
        break
      }
    }
    // Fallback: first supporter strategy of any kind, with whatever seeker turns came before.
    if (!pick) {
      for (let k = 0; k < turns.length; k++) {
        const t = turns[k]
        if (t.speaker === "supporter" && t.annotation?.strategy) {
          const ctx = turns.slice(0, k).filter((x) => x.speaker === "seeker").map((x) => x.content)
          pick = { strategy: t.annotation.strategy, context: ctx }
          break
        }
      }
    }
    const goldStrategy = pick?.strategy || "Others"
    const seekerContext = (pick?.context.join("\n") || "").trim() || "I'm feeling stressed."

    try {
      // Strategy classify — definitions inlined to combat base-model bias toward
      // "Reflection of feelings". Strict output format requested (label only) so
      // the comparator's substring match doesn't false-trip on stray content.
      const cls = await opts.adapter.chat({
        messages: [
          {
            role: "system",
            content: [
              "You classify the best emotional-support strategy for the seeker's message.",
              "Strategies (ESConv, Liu et al. 2021):",
              "- Question: ask for more information / clarify the situation.",
              "- Restatement or Paraphrasing: restate the seeker's words concisely.",
              "- Reflection of feelings: name the emotion the seeker is showing.",
              "- Self-disclosure: share a similar experience of your own.",
              "- Affirmation and Reassurance: affirm strengths or offer reassurance.",
              "- Providing Suggestions: suggest concrete next steps.",
              "- Information: share relevant facts or knowledge.",
              "- Others: generic support that fits none of the above.",
              "",
              "Output exactly ONE label from the list above. No prose, no punctuation, no quotes.",
            ].join("\n"),
          },
          { role: "user", content: seekerContext },
        ],
        opts: {
          benchmark: BENCHMARK_NAME,
          userId: `esconv-${i}-classify`,
          turnNumber: 1,
          // Cap at ~12 tokens — long enough for the longest label
          // ("Restatement or Paraphrasing" ≈ 6 BPE tokens) plus slack, short
          // enough to suppress base-model rambling beyond the label.
          max_tokens: 12,
          temperature: 0,
        },
      })
      // Normalized substring match on full strategy name (case-insensitive); falls back
      // to first-word match for "Others" / single-token strategies. Classifier may return
      // markdown ("**Reflection of feelings**"), trailing punctuation, or extra prose.
      if (cls && typeof cls.text === "string") {
        const norm = cls.text.toLowerCase()
        const goldFull = goldStrategy.toLowerCase()
        const goldHead = goldStrategy.split(" ")[0].toLowerCase()
        if (norm.includes(goldFull) || norm.includes(goldHead)) {
          strategyHits += 1
        }
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
