/**
 * Phase 39 — Cost ledger (per-benchmark spend + hard abort).
 *
 * Hard limit per Phase 39 gate D15: total ≤ $25 across all benchmarks/arms.
 *
 * Price table (CONTEXT D-39-7) — SiliconFlow public pricing 2026-04-29.
 * Override via env `PA_BENCH_PRICE_TABLE_JSON` (JSON string).
 *
 * @typedef {Object} PriceEntry
 * @property {number} inputPerM
 * @property {number} outputPerM
 *
 * @typedef {Object} ChargeArgs
 * @property {string} model
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {string} [benchmark]
 * @property {string} [arm]
 *
 * @typedef {Object} LedgerOpts
 * @property {number} [maxBudgetUsd]
 * @property {Record<string, PriceEntry>} [priceTable]
 * @property {string} [persistPath]
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export const DEFAULT_PRICE_TABLE = Object.freeze({
  "Qwen/Qwen2.5-7B-Instruct": { inputPerM: 0.07, outputPerM: 0.14 },
  "Qwen/Qwen2.5-72B-Instruct": { inputPerM: 0.5, outputPerM: 1.5 },
  "BAAI/bge-m3": { inputPerM: 0, outputPerM: 0 },
  "gpt-5.4-nano": { inputPerM: 0.1, outputPerM: 0.4 },
})

export class BudgetExceededError extends Error {
  constructor(message, { totalUsd, attemptedUsd, maxBudgetUsd }) {
    super(message)
    this.name = "BudgetExceededError"
    this.totalUsd = totalUsd
    this.attemptedUsd = attemptedUsd
    this.maxBudgetUsd = maxBudgetUsd
  }
}

/**
 * Resolve price table — env override > opts > default.
 * @param {Record<string, PriceEntry>} [override]
 * @returns {Record<string, PriceEntry>}
 */
export function resolvePriceTable(override) {
  if (override && typeof override === "object") return override
  const envJson = process.env.PA_BENCH_PRICE_TABLE_JSON
  if (envJson) {
    try {
      return JSON.parse(envJson)
    } catch {
      // fall through
    }
  }
  return DEFAULT_PRICE_TABLE
}

/**
 * Resolve max budget — env > opts > 25.
 * @param {number} [override]
 * @returns {number}
 */
export function resolveMaxBudgetUsd(override) {
  if (typeof override === "number" && Number.isFinite(override)) return override
  const envVal = process.env.PA_BENCH_MAX_BUDGET_USD
  if (envVal) {
    const n = Number(envVal)
    if (Number.isFinite(n)) return n
  }
  return 25
}

/**
 * Compute charge for a single call.
 * @param {ChargeArgs} args
 * @param {Record<string, PriceEntry>} priceTable
 * @returns {number}
 */
export function computeChargeUsd(args, priceTable) {
  const entry = priceTable[args.model] || { inputPerM: 0, outputPerM: 0 }
  const inputUsd = (Number(args.inputTokens) || 0) * entry.inputPerM / 1_000_000
  const outputUsd = (Number(args.outputTokens) || 0) * entry.outputPerM / 1_000_000
  return inputUsd + outputUsd
}

/**
 * Create a ledger.
 * @param {LedgerOpts} [opts]
 */
export function createLedger(opts = {}) {
  const maxBudgetUsd = resolveMaxBudgetUsd(opts.maxBudgetUsd)
  const priceTable = resolvePriceTable(opts.priceTable)
  const persistPath = opts.persistPath || null

  /** @type {Array<ChargeArgs & { costUsd: number, ts: number }>} */
  const entries = []
  let totalUsd = 0

  function snapshot() {
    return {
      maxBudgetUsd,
      totalUsd,
      remainingUsd: Math.max(0, maxBudgetUsd - totalUsd),
      callCount: entries.length,
      byModel: aggregateByKey(entries, "model"),
      byBenchmark: aggregateByKey(entries, "benchmark"),
      byArm: aggregateByKey(entries, "arm"),
      entries: entries.slice(),
    }
  }

  function persist() {
    if (!persistPath) return
    const dir = dirname(persistPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(persistPath, JSON.stringify(snapshot(), null, 2))
  }

  /**
   * Charge the ledger. Throws BudgetExceededError if total + new charge ≥ max.
   * @param {ChargeArgs} args
   * @returns {{ totalUsd: number, costUsd: number, callCount: number }}
   */
  function charge(args) {
    const costUsd = computeChargeUsd(args, priceTable)
    const projected = totalUsd + costUsd
    if (projected > maxBudgetUsd) {
      throw new BudgetExceededError(
        `Budget exceeded: total ${totalUsd.toFixed(4)} + new ${costUsd.toFixed(4)} > max ${maxBudgetUsd}`,
        { totalUsd, attemptedUsd: costUsd, maxBudgetUsd }
      )
    }
    entries.push({
      model: args.model,
      inputTokens: Number(args.inputTokens) || 0,
      outputTokens: Number(args.outputTokens) || 0,
      benchmark: args.benchmark || undefined,
      arm: args.arm || undefined,
      costUsd,
      ts: Date.now(),
    })
    totalUsd = projected
    persist()
    return { totalUsd, costUsd, callCount: entries.length }
  }

  /**
   * Project a charge without committing — used for dry-run cost projection.
   * @param {ChargeArgs} args
   * @returns {number}
   */
  function project(args) {
    return computeChargeUsd(args, priceTable)
  }

  function reset() {
    entries.length = 0
    totalUsd = 0
    persist()
  }

  return {
    charge,
    project,
    snapshot,
    reset,
    get totalUsd() {
      return totalUsd
    },
    get maxBudgetUsd() {
      return maxBudgetUsd
    },
    get callCount() {
      return entries.length
    },
  }
}

/**
 * Load a ledger snapshot from disk (read-only).
 * @param {string} path
 */
export function loadLedgerSnapshot(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

function aggregateByKey(entries, key) {
  /** @type {Record<string, { costUsd: number, calls: number, inputTokens: number, outputTokens: number }>} */
  const out = {}
  for (const e of entries) {
    const k = e[key] || "unknown"
    if (!out[k]) out[k] = { costUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0 }
    out[k].costUsd += e.costUsd
    out[k].calls += 1
    out[k].inputTokens += e.inputTokens
    out[k].outputTokens += e.outputTokens
  }
  return out
}
