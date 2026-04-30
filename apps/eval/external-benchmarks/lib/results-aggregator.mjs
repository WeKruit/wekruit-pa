/**
 * Phase 39 — Results aggregator.
 *
 * Single output schema for every benchmark/arm combination. Writes
 * per-benchmark JSON to `results/{benchmark}-{arm}.json` and emits an
 * aggregate report combining all results in `results/`.
 *
 * @typedef {Object} BenchmarkResultPayload
 * @property {string} benchmark           // "botchat" | "character-eval" | ...
 * @property {string} arm                 // "qwen-7b-raw" | "qwen-72b-raw" | "claire-stack"
 * @property {Record<string, number>} score
 * @property {number} cost_usd
 * @property {number} calls
 * @property {number} duration_ms
 * @property {string[]} errors
 * @property {Record<string, any>} config
 * @property {string} [ts]
 *
 * @typedef {Object} AggregateReport
 * @property {string} generatedAt
 * @property {BenchmarkResultPayload[]} benchmarks
 * @property {{
 *   cost_usd: number,
 *   calls: number,
 *   duration_ms: number,
 *   benchmarkCount: number,
 *   armCount: number,
 *   errors: number,
 * }} totals
 * @property {Record<string, Record<string, BenchmarkResultPayload>>} byBenchmark
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, join, basename } from "node:path"

/**
 * Validate payload shape — throws on missing required fields.
 * @param {BenchmarkResultPayload} payload
 */
export function validateResultPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("results-aggregator: payload must be an object")
  }
  if (typeof payload.benchmark !== "string" || payload.benchmark.length === 0) {
    throw new Error("results-aggregator: payload.benchmark required (string)")
  }
  if (typeof payload.arm !== "string" || payload.arm.length === 0) {
    throw new Error("results-aggregator: payload.arm required (string)")
  }
  if (!payload.score || typeof payload.score !== "object") {
    throw new Error("results-aggregator: payload.score required (object)")
  }
  if (typeof payload.cost_usd !== "number") {
    throw new Error("results-aggregator: payload.cost_usd required (number)")
  }
  if (typeof payload.calls !== "number") {
    throw new Error("results-aggregator: payload.calls required (number)")
  }
}

/**
 * Write a single benchmark result to disk.
 * @param {BenchmarkResultPayload} payload
 * @param {{ resultsDir?: string }} [opts]
 * @returns {string} the file path written
 */
export function writeResult(payload, opts = {}) {
  validateResultPayload(payload)
  const resultsDir = opts.resultsDir || defaultResultsDir()
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true })
  const file = join(resultsDir, `${payload.benchmark}-${payload.arm}.json`)
  const enriched = { ...payload, ts: payload.ts || new Date().toISOString() }
  writeFileSync(file, JSON.stringify(enriched, null, 2))
  return file
}

/**
 * Read a single result file (returns null on missing).
 * @param {string} filePath
 * @returns {BenchmarkResultPayload | null}
 */
export function readResult(filePath) {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"))
  } catch {
    return null
  }
}

/**
 * Aggregate all `*-{arm}.json` result files in a directory.
 * Skips `cost-ledger.json` (different schema).
 *
 * @param {{ resultsDir?: string }} [opts]
 * @returns {AggregateReport}
 */
export function aggregateAll(opts = {}) {
  const resultsDir = opts.resultsDir || defaultResultsDir()
  /** @type {BenchmarkResultPayload[]} */
  const all = []
  if (existsSync(resultsDir)) {
    for (const file of readdirSync(resultsDir)) {
      if (!file.endsWith(".json")) continue
      if (file === "cost-ledger.json") continue
      const full = join(resultsDir, file)
      const r = readResult(full)
      if (r && typeof r.benchmark === "string" && typeof r.arm === "string") {
        all.push(r)
      }
    }
  }

  /** @type {Record<string, Record<string, BenchmarkResultPayload>>} */
  const byBenchmark = {}
  let totalCost = 0
  let totalCalls = 0
  let totalDuration = 0
  let totalErrors = 0
  /** @type {Set<string>} */
  const armSet = new Set()
  /** @type {Set<string>} */
  const benchSet = new Set()
  for (const r of all) {
    if (!byBenchmark[r.benchmark]) byBenchmark[r.benchmark] = {}
    byBenchmark[r.benchmark][r.arm] = r
    totalCost += Number(r.cost_usd) || 0
    totalCalls += Number(r.calls) || 0
    totalDuration += Number(r.duration_ms) || 0
    totalErrors += Array.isArray(r.errors) ? r.errors.length : 0
    armSet.add(r.arm)
    benchSet.add(r.benchmark)
  }

  return {
    generatedAt: new Date().toISOString(),
    benchmarks: all,
    totals: {
      cost_usd: totalCost,
      calls: totalCalls,
      duration_ms: totalDuration,
      benchmarkCount: benchSet.size,
      armCount: armSet.size,
      errors: totalErrors,
    },
    byBenchmark,
  }
}

/**
 * Write an aggregate report to disk.
 * @param {{ resultsDir?: string, outFile?: string }} [opts]
 * @returns {string} the file path written
 */
export function writeAggregateReport(opts = {}) {
  const resultsDir = opts.resultsDir || defaultResultsDir()
  const outFile = opts.outFile || join(resultsDir, "aggregate-report.json")
  const report = aggregateAll({ resultsDir })
  const dir = dirname(outFile)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(outFile, JSON.stringify(report, null, 2))
  return outFile
}

/**
 * Default results directory — co-located with this module under
 * `apps/eval/external-benchmarks/results/`.
 *
 * Resolved relative to this file so tests + production agree.
 * @returns {string}
 */
export function defaultResultsDir() {
  // import.meta.url is file:///.../lib/results-aggregator.mjs
  const url = new URL("../results", import.meta.url)
  return url.pathname
}

void basename
