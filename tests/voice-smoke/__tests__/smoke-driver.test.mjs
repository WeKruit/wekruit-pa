/**
 * v2.1 S6 — Smoke driver unit tests.
 *
 * Drives `driveSweep` with stub runOne / runPii / runArchive seams so
 * we never spawn a real child or read real Firestore. Asserts the
 * driver:
 *   - refuses --live without secrets
 *   - aggregates rows correctly
 *   - composes a Markdown report
 *   - writes both the per-run JSON + SMOKE-REPORT.md
 */
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import {
  REQUIRED_LIVE_ENV,
  checkLiveSecrets,
  aggregateRun,
  composeReportBody,
  driveSweep,
} from "../smoke-driver.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCENARIO_DIR = resolve(__dirname, "..", "scenarios")

test("REQUIRED_LIVE_ENV lists all 6 Adam-managed env keys", () => {
  assert.ok(REQUIRED_LIVE_ENV.includes("LIVEKIT_API_SECRET"))
  assert.ok(REQUIRED_LIVE_ENV.includes("TWILIO_SIP_PASSWORD"))
  assert.ok(REQUIRED_LIVE_ENV.includes("DEEPGRAM_API_KEY"))
  assert.ok(REQUIRED_LIVE_ENV.includes("PA_VOICE_WEBHOOK_SECRET"))
  assert.ok(REQUIRED_LIVE_ENV.includes("GOOGLE_APPLICATION_CREDENTIALS"))
  assert.ok(REQUIRED_LIVE_ENV.includes("WEKRUIT_VOICE_RECORDINGS_BUCKET"))
})

test("checkLiveSecrets: ok when all present", () => {
  const env = Object.fromEntries(REQUIRED_LIVE_ENV.map((k) => [k, "x"]))
  const r = checkLiveSecrets(env)
  assert.equal(r.ok, true)
  assert.equal(r.missing.length, 0)
})

test("checkLiveSecrets: lists missing keys", () => {
  const env = {
    LIVEKIT_API_SECRET: "x",
    DEEPGRAM_API_KEY: "x",
  }
  const r = checkLiveSecrets(env)
  assert.equal(r.ok, false)
  assert.ok(r.missing.includes("TWILIO_SIP_PASSWORD"))
  assert.ok(r.missing.includes("PA_VOICE_WEBHOOK_SECRET"))
  assert.ok(r.missing.includes("GOOGLE_APPLICATION_CREDENTIALS"))
  assert.ok(r.missing.includes("WEKRUIT_VOICE_RECORDINGS_BUCKET"))
})

test("aggregateRun computes pass-rate + threshold flags", () => {
  const rows = [
    { scenarioId: "01", outcomePass: true, ttfaMs: 1000, costUsd: 0.5, falseCommit: false, falseInterrupt: false },
    { scenarioId: "02", outcomePass: true, ttfaMs: 1200, costUsd: 0.7, falseCommit: false, falseInterrupt: false },
    { scenarioId: "03", outcomePass: false, ttfaMs: 800, costUsd: 0.3, falseCommit: true, falseInterrupt: false },
  ]
  const s = aggregateRun(rows)
  assert.equal(s.sampleSize, 3)
  assert.equal(s.passed, 2)
  assert.ok(Math.abs(s.passRate - 2 / 3) < 1e-9)
  assert.deepEqual(s.failedScenarios, ["03"])
  assert.equal(s.thresholdsPass.passRatePass, false) // 2 < 8
})

test("composeReportBody emits threshold table + ship-gate", () => {
  const body = composeReportBody({
    runSummary: aggregateRun(
      Array.from({ length: 10 }).map((_, i) => ({
        scenarioId: `s${i}`,
        outcomePass: true,
        actualOutcome: "PASS",
        expectedOutcome: "PASS",
        ttfaMs: 1000,
        costUsd: 0.5,
        falseCommit: false,
        falseInterrupt: false,
        passOverall: true,
      })),
    ),
    rows: Array.from({ length: 10 }).map((_, i) => ({
      scenarioId: `s${i}`,
      expectedOutcome: "PASS",
      actualOutcome: "PASS",
      ttfaMs: 1000,
      costUsd: 0.5,
      passOverall: true,
    })),
    piiSummary: { perCall: [], totalLeaks: 0 },
    archiveSummary: { sampled: 3, ok: true, failures: [] },
    mode: "mock",
    timestamp: "2026-05-15T00:00:00Z",
  })
  assert.match(body, /Threshold compliance/)
  assert.match(body, /Ship gate.*GREEN/)
  assert.match(body, /Pass rate.*10\/10/)
})

test("composeReportBody flags ship gate RED with blockers", () => {
  const rows = [
    {
      scenarioId: "s1",
      expectedOutcome: "PASS",
      actualOutcome: "NOT_PASS",
      ttfaMs: 2000,
      costUsd: 1.2,
      passOverall: false,
    },
  ]
  const body = composeReportBody({
    runSummary: aggregateRun([{ ...rows[0], outcomePass: false, falseCommit: true, falseInterrupt: false }]),
    rows,
    piiSummary: { perCall: [], totalLeaks: 3 },
    archiveSummary: { sampled: 3, ok: false, failures: [{ name: "x", reason: "zero_size" }] },
    mode: "mock",
    timestamp: "2026-05-15T00:00:00Z",
  })
  assert.match(body, /Ship gate.*RED/)
  assert.match(body, /pass rate below/)
  assert.match(body, /PII leaks present/)
  assert.match(body, /p50 TTFA above/)
  assert.match(body, /cost\/call above/)
  assert.match(body, /archive spot-check failed/)
})

test("driveSweep end-to-end with stub seams + 10 scenarios", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "smoke-out-"))
  const reportPath = join(outDir, "SMOKE-REPORT.md")

  let oneCount = 0
  const runOne = async (path) => {
    oneCount += 1
    return {
      scenarioId: `s${oneCount}`,
      description: path,
      expectedOutcome: "PASS",
      actualOutcome: "PASS",
      outcomePass: true,
      callSid: `CA-${oneCount}`,
      bookingId: `b${oneCount}`,
      ttfaMs: 1000,
      costUsd: 0.5,
      falseCommit: false,
      falseInterrupt: false,
      ttfaPass: true,
      costPass: true,
      passOverall: true,
      completedAt: "2026-05-15T00:00:00Z",
    }
  }
  const runPii = async () => ({ leaks: [] })
  const runArchive = async () => ({ sampled: 3, ok: true, failures: [] })

  const res = await driveSweep({
    mode: "mock",
    scenarioDir: SCENARIO_DIR,
    outDir,
    reportPath,
    count: 10,
    runOne,
    runPii,
    runArchive,
    now: () => new Date("2026-05-15T00:00:00Z"),
  })

  assert.equal(oneCount, 10)
  assert.equal(res.runSummary.sampleSize, 10)
  assert.equal(res.runSummary.passed, 10)
  assert.equal(res.piiSummary.totalLeaks, 0)
  const reportText = await readFile(reportPath, "utf8")
  assert.match(reportText, /Pass rate.*10\/10/)
  assert.match(reportText, /Ship gate.*GREEN/)
  const runJson = JSON.parse(await readFile(res.outFile, "utf8"))
  assert.equal(runJson.rows.length, 10)
})

test("driveSweep records pii leaks in summary + report", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "smoke-out-"))
  const reportPath = join(outDir, "SMOKE-REPORT.md")

  const runOne = async (path, mode) => ({
    scenarioId: "s1",
    description: path,
    expectedOutcome: "PASS",
    actualOutcome: "PASS",
    outcomePass: true,
    callSid: "CA-1",
    bookingId: "b1",
    ttfaMs: 1000,
    costUsd: 0.5,
    falseCommit: false,
    falseInterrupt: false,
    passOverall: true,
    completedAt: "2026-05-15T00:00:00Z",
  })
  const runPii = async () => ({
    leaks: [{ role: "agent", kind: "email", matched: "x@y.com" }],
  })
  const runArchive = async () => ({ sampled: 3, ok: true, failures: [] })

  const res = await driveSweep({
    mode: "mock",
    scenarioDir: SCENARIO_DIR,
    outDir,
    reportPath,
    count: 1,
    runOne,
    runPii,
    runArchive,
    now: () => new Date("2026-05-15T00:00:00Z"),
  })

  assert.equal(res.piiSummary.totalLeaks, 1)
  const reportText = await readFile(reportPath, "utf8")
  assert.match(reportText, /PII leaks present/)
  assert.match(reportText, /Ship gate.*RED/)
})
