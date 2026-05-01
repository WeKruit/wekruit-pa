/**
 * Phase 39 — Shared runner helpers.
 *
 * Common scaffolding for all 5 benchmark runners — dry-run plan emission,
 * env var resolution for repo paths, projected cost calculation.
 *
 * Each runner exports `runBenchmark({ adapter, ledger, mode, subset, opts })`
 * with a stable shape; this module owns the cross-cutting plumbing.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { DEFAULT_PRICE_TABLE, computeChargeUsd } from "./cost-ledger.mjs"

export const ARM_TO_MODEL = Object.freeze({
  "qwen-7b-raw": "Qwen/Qwen2.5-7B-Instruct",
  "qwen-72b-raw": "Qwen/Qwen2.5-72B-Instruct",
  "claire-stack": "Qwen/Qwen2.5-7B-Instruct",
})

/**
 * Resolve benchmark repo path from env or default to vendor/{name}.
 *
 * @param {string} benchmark
 * @param {string} envVarName
 * @returns {string} absolute path
 */
export function resolveRepoPath(benchmark, envVarName) {
  const fromEnv = process.env[envVarName]
  if (fromEnv) return resolve(fromEnv)
  // Default: apps/eval/external-benchmarks/vendor/{benchmark}
  return resolve(new URL(`../vendor/${benchmark}`, import.meta.url).pathname)
}

/**
 * Project cost for a planned set of calls.
 *
 * For claire-stack arm we account for ~10% overhead from re-rolls on
 * F3/F4/repeat triggers (conservative estimate based on Phase 35-38
 * baseline trigger rates).
 *
 * @param {{
 *   arm: string,
 *   calls: number,
 *   inputTokensPerCall: number,
 *   outputTokensPerCall: number,
 * }} args
 * @returns {{ projectedInputTokens: number, projectedOutputTokens: number, projectedCostUsd: number }}
 */
export function projectCost(args) {
  const overhead = args.arm === "claire-stack" ? 1.1 : 1.0
  const inputTokens = Math.round(args.calls * args.inputTokensPerCall * overhead)
  const outputTokens = Math.round(args.calls * args.outputTokensPerCall * overhead)
  const model = ARM_TO_MODEL[args.arm] || "Qwen/Qwen2.5-7B-Instruct"
  const projectedCostUsd = computeChargeUsd(
    { model, inputTokens, outputTokens },
    DEFAULT_PRICE_TABLE
  )
  return {
    projectedInputTokens: inputTokens,
    projectedOutputTokens: outputTokens,
    projectedCostUsd,
  }
}

/**
 * Build a dry-run plan payload (printed by runner --dry-run).
 *
 * @param {{
 *   benchmark: string,
 *   arm: string,
 *   calls: number,
 *   inputTokensPerCall: number,
 *   outputTokensPerCall: number,
 *   repoPath: string,
 *   subset: number | string,
 *   notes?: string[],
 * }} args
 */
export function buildDryRunPlan(args) {
  const { projectedInputTokens, projectedOutputTokens, projectedCostUsd } = projectCost({
    arm: args.arm,
    calls: args.calls,
    inputTokensPerCall: args.inputTokensPerCall,
    outputTokensPerCall: args.outputTokensPerCall,
  })
  return {
    benchmark: args.benchmark,
    arm: args.arm,
    status: "dry-run",
    planned_calls: args.calls,
    projected_input_tokens: projectedInputTokens,
    projected_output_tokens: projectedOutputTokens,
    projected_cost_usd: Number(projectedCostUsd.toFixed(4)),
    repo_path: args.repoPath,
    repo_path_exists: existsSync(args.repoPath),
    subset: args.subset,
    notes: args.notes || [],
  }
}

/**
 * Standard live-mode preflight — verify env keys + repo path.
 *
 * @param {{
 *   benchmark: string,
 *   repoPath: string,
 *   requireEnv: string[],
 * }} args
 * @throws {Error} when preflight fails
 */
export function preflightLive(args) {
  if (!existsSync(args.repoPath)) {
    throw new Error(
      `${args.benchmark}: repo not found at ${args.repoPath}; clone per SETUP.md or set the appropriate PA_BENCH_*_PATH env`
    )
  }
  for (const envName of args.requireEnv) {
    if (!process.env[envName]) {
      throw new Error(
        `${args.benchmark}: required env var ${envName} not set`
      )
    }
  }
}

/**
 * Parse CLI args — supports `--dry-run` (default), `--live`, `--arm=...`,
 * `--subset=...`, `--out=...`.
 *
 * @param {string[]} argv
 */
export function parseRunnerArgs(argv) {
  const out = {
    mode: /** @type {"dry-run" | "live"} */ ("dry-run"),
    arm: /** @type {"qwen-7b-raw"|"qwen-72b-raw"|"claire-stack"} */ ("claire-stack"),
    subset: /** @type {number|null} */ (null),
    outFile: /** @type {string|null} */ (null),
  }
  for (const a of argv) {
    if (a === "--live") out.mode = "live"
    else if (a === "--dry-run") out.mode = "dry-run"
    else if (a.startsWith("--arm=")) {
      const v = a.slice("--arm=".length)
      if (v === "qwen-7b-raw" || v === "qwen-72b-raw" || v === "claire-stack") out.arm = v
    } else if (a.startsWith("--subset=")) {
      const n = Number(a.slice("--subset=".length))
      if (Number.isFinite(n) && n > 0) out.subset = n
    } else if (a.startsWith("--out=")) {
      out.outFile = a.slice("--out=".length)
    }
  }
  return out
}
