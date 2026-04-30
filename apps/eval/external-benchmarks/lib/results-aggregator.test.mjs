import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  aggregateAll,
  defaultResultsDir,
  readResult,
  validateResultPayload,
  writeAggregateReport,
  writeResult,
} from "./results-aggregator.mjs"

/** @returns {import("./results-aggregator.mjs").BenchmarkResultPayload} */
function makePayload(over = {}) {
  return {
    benchmark: "botchat",
    arm: "claire-stack",
    score: { humanlikeness: 0.7 },
    cost_usd: 1.23,
    calls: 100,
    duration_ms: 5000,
    errors: [],
    config: { subset: 50 },
    ...over,
  }
}

test("validateResultPayload: throws on missing benchmark", () => {
  assert.throws(
    () => validateResultPayload(/** @type {any} */ ({ arm: "x", score: {}, cost_usd: 0, calls: 0 })),
    /benchmark required/i
  )
})

test("validateResultPayload: throws on missing arm", () => {
  assert.throws(
    () => validateResultPayload(/** @type {any} */ ({ benchmark: "x", score: {}, cost_usd: 0, calls: 0 })),
    /arm required/i
  )
})

test("validateResultPayload: throws on missing score", () => {
  assert.throws(
    () => validateResultPayload(/** @type {any} */ ({ benchmark: "x", arm: "y", cost_usd: 0, calls: 0 })),
    /score required/i
  )
})

test("validateResultPayload: passes valid payload", () => {
  assert.doesNotThrow(() => validateResultPayload(makePayload()))
})

test("writeResult + readResult round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "results-"))
  try {
    const path = writeResult(makePayload(), { resultsDir: dir })
    assert.ok(existsSync(path))
    const loaded = readResult(path)
    assert.ok(loaded)
    assert.equal(loaded.benchmark, "botchat")
    assert.equal(loaded.arm, "claire-stack")
    assert.equal(loaded.score.humanlikeness, 0.7)
    assert.ok(loaded.ts, "ts auto-added")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("writeResult: file name = {benchmark}-{arm}.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "results-"))
  try {
    const path = writeResult(makePayload({ benchmark: "esconv", arm: "qwen-7b-raw" }), { resultsDir: dir })
    assert.match(path, /esconv-qwen-7b-raw\.json$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("aggregateAll: empty dir → empty report", () => {
  const dir = mkdtempSync(join(tmpdir(), "results-"))
  try {
    const report = aggregateAll({ resultsDir: dir })
    assert.equal(report.benchmarks.length, 0)
    assert.equal(report.totals.cost_usd, 0)
    assert.equal(report.totals.benchmarkCount, 0)
    assert.equal(report.totals.armCount, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("aggregateAll: combines multiple benchmark/arm files", () => {
  const dir = mkdtempSync(join(tmpdir(), "results-"))
  try {
    writeResult(makePayload({ benchmark: "botchat", arm: "qwen-7b-raw", cost_usd: 1.0, calls: 50 }), { resultsDir: dir })
    writeResult(makePayload({ benchmark: "botchat", arm: "claire-stack", cost_usd: 1.5, calls: 75 }), { resultsDir: dir })
    writeResult(makePayload({ benchmark: "esconv", arm: "claire-stack", cost_usd: 2.0, calls: 100 }), { resultsDir: dir })
    const report = aggregateAll({ resultsDir: dir })
    assert.equal(report.benchmarks.length, 3)
    assert.ok(Math.abs(report.totals.cost_usd - 4.5) < 1e-9)
    assert.equal(report.totals.calls, 225)
    assert.equal(report.totals.benchmarkCount, 2)
    assert.equal(report.totals.armCount, 2)
    assert.ok(report.byBenchmark.botchat["qwen-7b-raw"])
    assert.ok(report.byBenchmark.botchat["claire-stack"])
    assert.ok(report.byBenchmark.esconv["claire-stack"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("aggregateAll: skips cost-ledger.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "results-"))
  try {
    writeFileSync(join(dir, "cost-ledger.json"), JSON.stringify({ totalUsd: 5 }))
    writeResult(makePayload(), { resultsDir: dir })
    const report = aggregateAll({ resultsDir: dir })
    assert.equal(report.benchmarks.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("aggregateAll: ignores malformed JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "results-"))
  try {
    writeFileSync(join(dir, "broken.json"), "{not valid")
    writeResult(makePayload(), { resultsDir: dir })
    const report = aggregateAll({ resultsDir: dir })
    assert.equal(report.benchmarks.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("aggregateAll: counts errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "results-"))
  try {
    writeResult(makePayload({ errors: ["e1", "e2"] }), { resultsDir: dir })
    writeResult(makePayload({ benchmark: "esconv", errors: ["e3"] }), { resultsDir: dir })
    const report = aggregateAll({ resultsDir: dir })
    assert.equal(report.totals.errors, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("writeAggregateReport: writes valid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "results-"))
  try {
    writeResult(makePayload(), { resultsDir: dir })
    const path = writeAggregateReport({ resultsDir: dir })
    assert.ok(existsSync(path))
    const loaded = JSON.parse(readFileSync(path, "utf-8"))
    assert.ok(loaded.totals)
    assert.equal(loaded.benchmarks.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readResult: returns null for missing file", () => {
  assert.equal(readResult("/no/such/path.json"), null)
})

test("defaultResultsDir: resolves under apps/eval/external-benchmarks/results", () => {
  const d = defaultResultsDir()
  assert.match(d, /apps\/eval\/external-benchmarks\/results$/)
})
