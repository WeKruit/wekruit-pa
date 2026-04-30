/**
 * Phase 39 — RoleLLM runner (InteractiveNLP-Team/RoleLLM-public, EN).
 *
 * 100 chars × 4 prompts. Subset (CONTEXT §2 / BENCH-05): 50 chars × 4 prompts.
 * Role-play prompt runner + judge.
 *
 * Spec: https://github.com/InteractiveNLP-Team/RoleLLM-public
 *
 * @typedef {Object} RoleLLMRunOpts
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

export const BENCHMARK_NAME = "role-llm"
export const ENV_PATH_VAR = "PA_BENCH_ROLE_LLM_PATH"
export const DEFAULT_SUBSET = 50 // chars
export const PROMPTS_PER_CHAR = 4
export const INPUT_TOKENS_PER_CALL = 1000
export const OUTPUT_TOKENS_PER_CALL = 300

/**
 * @param {RoleLLMRunOpts} opts
 */
export async function runRoleLLM(opts) {
  const subset = opts.subset || DEFAULT_SUBSET
  const calls = subset * PROMPTS_PER_CHAR
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
        `RoleLLM = ${subset} chars × ${PROMPTS_PER_CHAR} prompts (EN role-play)`,
        "Per-prompt judge call (Qwen-72B in-house OR gpt-5.4-nano if OPENAI_API_KEY)",
        "Repo: github.com/InteractiveNLP-Team/RoleLLM-public",
        "Expected dir: RoleBench-zh-en/ or rolebench-en/",
      ],
    })
  }

  preflightLive({
    benchmark: BENCHMARK_NAME,
    repoPath,
    requireEnv: ["SILICONFLOW_API_KEY"],
  })

  // Best-effort path resolution — repo schema slightly varies.
  const candidates = [
    join(repoPath, "RoleBench-zh-en", "rolebench-en", "general", "role.jsonl"),
    join(repoPath, "rolebench-en", "general", "role.jsonl"),
    join(repoPath, "data", "rolebench-en", "general", "role.jsonl"),
  ]
  const dataPath = candidates.find((p) => existsSync(p))
  if (!dataPath) {
    throw new Error(
      `${BENCHMARK_NAME}: rolebench-en data file not found in any of: ${candidates.join(" | ")}; check repo layout or set ${ENV_PATH_VAR}`
    )
  }

  /** @type {Array<{ role: string, prompt: string }>} */
  const items = []
  for (const line of readFileSync(dataPath, "utf-8").split("\n")) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      const role = obj.role || obj.character || obj.name
      const prompt = obj.question || obj.prompt || obj.input
      if (role && prompt) items.push({ role, prompt })
    } catch {
      // skip malformed lines
    }
    if (items.length >= subset * PROMPTS_PER_CHAR) break
  }

  /** @type {string[]} */
  const errors = []
  const start = Date.now()
  let generated = 0
  let totalLen = 0

  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    try {
      const r = await opts.adapter.chat({
        messages: [
          { role: "system", content: `You are role-playing as ${it.role}. Stay in character.` },
          { role: "user", content: it.prompt },
        ],
        opts: {
          benchmark: BENCHMARK_NAME,
          userId: `role-llm-${i}`,
          turnNumber: 1,
        },
      })
      if (r && typeof r.text === "string" && r.text.length > 0) {
        generated += 1
        totalLen += r.text.length
      }
    } catch (err) {
      errors.push(`${i}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** @type {import("../lib/results-aggregator.mjs").BenchmarkResultPayload} */
  const payload = {
    benchmark: BENCHMARK_NAME,
    arm,
    score: {
      generated,
      generated_rate: generated / Math.max(1, items.length),
      avg_response_length: totalLen / Math.max(1, generated),
      // judge_score filled by post-process aggregator
      judge_pending_postproc: 1,
    },
    cost_usd: Number(ledgerSlice(opts.ledger, BENCHMARK_NAME).toFixed(4)),
    calls: items.length,
    duration_ms: Date.now() - start,
    errors,
    config: { subset, promptsPerChar: PROMPTS_PER_CHAR, repoPath, dataPath },
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
    const plan = await runRoleLLM({
      adapter: /** @type {any} */ (null),
      ledger: /** @type {any} */ (null),
      mode: "dry-run",
      subset: args.subset || undefined,
      arm: args.arm,
    })
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n")
    return plan
  }
  throw new Error("role-llm.mjs --live requires invocation via run-all.mjs (adapter + ledger plumbing)")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(String(e?.message || e) + "\n")
    process.exit(1)
  })
}
