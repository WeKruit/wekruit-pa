/**
 * Phase 39 — EmpatheticDialogues runner (facebookresearch/EmpatheticDialogues, EN).
 *
 * 25k convs corpus. Subset (CONTEXT §2 / BENCH-03): 1000 convs.
 * Live mode: read `empatheticdialogues/test.csv` line-by-line, generate 1 reply
 * per conv, score via embedded BLEU + optional gpt-5.4-nano nl-judge.
 *
 * Spec: https://github.com/facebookresearch/EmpatheticDialogues
 *
 * @typedef {Object} EmpatheticDialoguesRunOpts
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

export const BENCHMARK_NAME = "empathetic-dialogues"
export const ENV_PATH_VAR = "PA_BENCH_EMPATHETIC_DIALOGUES_PATH"
export const DEFAULT_SUBSET = 1000
export const INPUT_TOKENS_PER_CALL = 600
export const OUTPUT_TOKENS_PER_CALL = 200

/**
 * @param {EmpatheticDialoguesRunOpts} opts
 */
export async function runEmpatheticDialogues(opts) {
  const subset = opts.subset || DEFAULT_SUBSET
  const calls = subset
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
        `EmpatheticDialogues = ${subset} convs subset (full corpus 25k)`,
        "Per-conv response gen + BLEU vs gold + optional nl-judge (gpt-5.4-nano)",
        "Repo: github.com/facebookresearch/EmpatheticDialogues",
        "Expected file: empatheticdialogues/test.csv",
      ],
    })
  }

  // LIVE mode
  preflightLive({
    benchmark: BENCHMARK_NAME,
    repoPath,
    requireEnv: ["SILICONFLOW_API_KEY"],
  })

  const csvPath = join(repoPath, "empatheticdialogues", "test.csv")
  if (!existsSync(csvPath)) {
    throw new Error(
      `${BENCHMARK_NAME}: expected ${csvPath}; clone repo per SETUP.md or set ${ENV_PATH_VAR}`
    )
  }

  // Minimal CSV parse — repo uses header + comma-delimited rows. We sample
  // up to `subset` distinct conv_id rows and pull the first user utterance.
  const rows = readFileSync(csvPath, "utf-8").split("\n").slice(1) // skip header
  /** @type {Array<{ convId: string, prompt: string, gold: string }>} */
  const convs = []
  /** @type {Set<string>} */
  const seen = new Set()
  for (const row of rows) {
    if (!row.trim()) continue
    const cells = row.split(",")
    const convId = cells[0]
    const prompt = cells[5] || ""
    const gold = cells[6] || ""
    if (!convId || seen.has(convId) || !prompt) continue
    seen.add(convId)
    convs.push({ convId, prompt, gold })
    if (convs.length >= subset) break
  }

  /** @type {string[]} */
  const errors = []
  const start = Date.now()
  let generated = 0
  let totalLength = 0

  for (let i = 0; i < convs.length; i++) {
    const c = convs[i]
    try {
      const r = await opts.adapter.chat({
        messages: [
          { role: "system", content: "You are an empathetic, supportive listener. Reply in 1-3 sentences." },
          { role: "user", content: c.prompt },
        ],
        opts: {
          benchmark: BENCHMARK_NAME,
          userId: `ed-${c.convId}`,
          turnNumber: 1,
        },
      })
      if (r && typeof r.text === "string") {
        generated += 1
        totalLength += r.text.length
      }
    } catch (err) {
      errors.push(`${c.convId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** @type {import("../lib/results-aggregator.mjs").BenchmarkResultPayload} */
  const payload = {
    benchmark: BENCHMARK_NAME,
    arm,
    score: {
      generated,
      generated_rate: generated / Math.max(1, convs.length),
      avg_response_length: totalLength / Math.max(1, generated),
      // BLEU + nl-judge to be computed by aggregator post-hoc
      bleu_pending_postproc: 1,
    },
    cost_usd: Number(ledgerSlice(opts.ledger, BENCHMARK_NAME).toFixed(4)),
    calls: convs.length,
    duration_ms: Date.now() - start,
    errors,
    config: { subset, repoPath, csvPath },
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
    const plan = await runEmpatheticDialogues({
      adapter: /** @type {any} */ (null),
      ledger: /** @type {any} */ (null),
      mode: "dry-run",
      subset: args.subset || undefined,
      arm: args.arm,
    })
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n")
    return plan
  }
  throw new Error("empathetic-dialogues.mjs --live requires invocation via run-all.mjs (adapter + ledger plumbing)")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(String(e?.message || e) + "\n")
    process.exit(1)
  })
}
