#!/usr/bin/env node
/**
 * Phase 39 — run-all orchestrator.
 *
 * Top-level entry that loops 5 benchmark runners and aggregates results.
 *
 *   --dry-run (default)  prints plan for each benchmark + total projected cost.
 *                        Exits 0 if total ≤ $25, non-zero otherwise.
 *   --live               actually executes runners (requires SILICONFLOW_API_KEY).
 *                        Cost ledger aborts mid-run if total ≥ $25.
 *   --arm=<arm>          claire-stack (default) | qwen-7b-raw | qwen-72b-raw
 *   --subset=<n>         per-runner subset override (rare; for quick sanity)
 *   --only=<csv>         comma-separated runner names to include (default all 5)
 *
 * Adam: SETUP.md is the runbook. COST-PROJECTION.md is the budget table.
 */

import { runBotChat } from "./runners/botchat.mjs"
import { runCharacterEval } from "./runners/character-eval.mjs"
import { runEmpatheticDialogues } from "./runners/empathetic-dialogues.mjs"
import { runESConv } from "./runners/esconv.mjs"
import { runRoleLLM } from "./runners/role-llm.mjs"

import { createLedger, BudgetExceededError } from "./lib/cost-ledger.mjs"
import { writeAggregateReport } from "./lib/results-aggregator.mjs"
import { createQwen7bAdapter } from "./lib/qwen-7b-adapter.mjs"
import { createQwen72bAdapter } from "./lib/qwen-72b-adapter.mjs"
import { createClaireStackAdapter } from "./lib/claire-stack-adapter.mjs"

export const RUNNERS = Object.freeze([
  { name: "botchat", fn: runBotChat },
  { name: "character-eval", fn: runCharacterEval },
  { name: "empathetic-dialogues", fn: runEmpatheticDialogues },
  { name: "esconv", fn: runESConv },
  { name: "role-llm", fn: runRoleLLM },
])

export const DEFAULT_MAX_BUDGET_USD = 25

/**
 * Parse CLI args.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = {
    mode: /** @type {"dry-run" | "live"} */ ("dry-run"),
    arm: /** @type {"qwen-7b-raw"|"qwen-72b-raw"|"claire-stack"} */ ("claire-stack"),
    subset: /** @type {number|null} */ (null),
    only: /** @type {string[]|null} */ (null),
    maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
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
    } else if (a.startsWith("--only=")) {
      out.only = a.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean)
    } else if (a.startsWith("--max-budget-usd=")) {
      const n = Number(a.slice("--max-budget-usd=".length))
      if (Number.isFinite(n) && n > 0) out.maxBudgetUsd = n
    }
  }
  return out
}

/**
 * Resolve runner subset based on --only filter.
 * @param {string[]|null} only
 */
function selectedRunners(only) {
  if (!only || only.length === 0) return RUNNERS
  const set = new Set(only)
  return RUNNERS.filter((r) => set.has(r.name))
}

/**
 * Build adapter for chosen arm.
 * @param {string} arm
 * @param {ReturnType<import("./lib/cost-ledger.mjs").createLedger>} ledger
 */
function buildAdapter(arm, ledger) {
  if (arm === "qwen-7b-raw") return createQwen7bAdapter({ ledger })
  if (arm === "qwen-72b-raw") return createQwen72bAdapter({ ledger })
  return createClaireStackAdapter({ ledger })
}

/**
 * Run dry-run mode — print plan + total projected cost.
 * @param {ReturnType<typeof parseArgs>} args
 */
export async function runDryRun(args) {
  const runners = selectedRunners(args.only)
  /** @type {any[]} */
  const plans = []
  let totalProjectedCost = 0

  for (const r of runners) {
    const plan = await r.fn({
      adapter: /** @type {any} */ (null),
      ledger: /** @type {any} */ (null),
      mode: "dry-run",
      subset: args.subset || undefined,
      arm: args.arm,
    })
    plans.push(plan)
    totalProjectedCost += /** @type {any} */ (plan).projected_cost_usd || 0
  }

  const report = {
    mode: "dry-run",
    arm: args.arm,
    runner_count: runners.length,
    plans,
    total_projected_cost_usd: Number(totalProjectedCost.toFixed(4)),
    max_budget_usd: args.maxBudgetUsd,
    budget_ok: totalProjectedCost <= args.maxBudgetUsd,
    budget_headroom_usd: Number((args.maxBudgetUsd - totalProjectedCost).toFixed(4)),
  }
  return report
}

/**
 * Run live mode — execute all runners with cost-ledger gating.
 * @param {ReturnType<typeof parseArgs>} args
 */
export async function runLive(args) {
  if (!process.env.SILICONFLOW_API_KEY && !process.env.PA_OPENAI_AGENT_API_KEY && !process.env.PA_SILICONFLOW_API_KEY) {
    throw new Error("run-all --live: SILICONFLOW_API_KEY (or PA_OPENAI_AGENT_API_KEY / PA_SILICONFLOW_API_KEY) required")
  }
  const ledger = createLedger({ maxBudgetUsd: args.maxBudgetUsd })
  const adapter = buildAdapter(args.arm, ledger)
  const runners = selectedRunners(args.only)

  /** @type {any[]} */
  const results = []
  /** @type {string[]} */
  const errors = []
  let aborted = false

  for (const r of runners) {
    try {
      const result = await r.fn({
        adapter,
        ledger,
        mode: "live",
        subset: args.subset || undefined,
        arm: args.arm,
      })
      results.push(result)
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        aborted = true
        errors.push(`${r.name}: budget exceeded (total ${ledger.totalUsd.toFixed(4)} ≥ ${args.maxBudgetUsd})`)
        break
      }
      errors.push(`${r.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Always write aggregate (partial OK).
  const aggregateFile = writeAggregateReport({})

  return {
    mode: "live",
    arm: args.arm,
    runner_count: runners.length,
    results,
    errors,
    aborted,
    total_cost_usd: ledger.totalUsd,
    aggregate_file: aggregateFile,
  }
}

/**
 * CLI entry.
 * @param {string[]} [argv]
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.mode === "live") {
    process.stderr.write(`run-all: LIVE mode — arm=${args.arm} max_budget=$${args.maxBudgetUsd}; starting in 5s...\n`)
    await new Promise((r) => setTimeout(r, 5000))
    const out = await runLive(args)
    process.stdout.write(JSON.stringify(out, null, 2) + "\n")
    if (out.aborted || out.errors.length > 0) process.exit(2)
    return out
  }
  const out = await runDryRun(args)
  process.stdout.write(JSON.stringify(out, null, 2) + "\n")
  if (!out.budget_ok) {
    process.stderr.write(
      `run-all: projected cost $${out.total_projected_cost_usd} > max $${out.max_budget_usd}\n`
    )
    process.exit(3)
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(String(e?.message || e) + "\n")
    process.exit(1)
  })
}
