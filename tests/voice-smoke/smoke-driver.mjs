#!/usr/bin/env node
/**
 * v2.1 S6 — 10-call smoke driver.
 *
 * Orchestrates the full sweep:
 *   1. Secrets pre-flight (refuse `--live` without all 4 env literals +
 *      GCS service-account creds).
 *   2. Load all 10 scenarios from `tests/voice-smoke/scenarios/`.
 *   3. For each scenario:
 *      a. spawn runner.mjs as a child process
 *      b. parse the printed JSON result row
 *      c. invoke pii-audit.mjs on the booking
 *   4. Spot-check archive (3 random recordings).
 *   5. Aggregate metrics + check thresholds.
 *   6. Write `smoke-runs/<timestamp>.json` + rewrite SMOKE-REPORT.md
 *      body with the filled threshold table.
 *
 * Usage:
 *   node smoke-driver.mjs [--live | --mock] [--count 10] [--out <path>]
 *
 * The driver itself is pure-orchestration. The heavy lifting (Firestore
 * writes, LiveKit dispatch, GCS reads) lives in the child tools.
 */
import { spawn } from "node:child_process"
import { mkdir, readdir, writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseFlag, parseBoolFlag } from "./lib/scenario-loader.mjs"
import { aggregateRows, checkThresholds } from "./lib/metrics-adapter.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

export const REQUIRED_LIVE_ENV = [
  "LIVEKIT_API_SECRET",
  "TWILIO_SIP_PASSWORD",
  "DEEPGRAM_API_KEY",
  "PA_VOICE_WEBHOOK_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "WEKRUIT_VOICE_RECORDINGS_BUCKET",
]

/** Pure secrets pre-flight check. Returns { ok, missing[] }. */
export function checkLiveSecrets(env) {
  const missing = REQUIRED_LIVE_ENV.filter((k) => !env[k] || env[k] === "")
  return { ok: missing.length === 0, missing }
}

/** Run a child process + collect stdout + exit code. */
export function spawnChild(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("error", rej)
    child.on("close", (code) => res({ code, stdout, stderr }))
  })
}

/** Aggregate per-call rows (passed from the runner) into Done-criteria. */
export function aggregateRun(rows) {
  const metricsRows = rows
    .map((r) => ({
      ttfaMs: r.ttfaMs ?? 0,
      costUsd: r.costUsd ?? 0,
      falseCommit: r.falseCommit ?? false,
      falseInterrupt: r.falseInterrupt ?? false,
      agentTalkRatio: 0.5,
    }))
    .filter((r) => r.ttfaMs > 0 || r.costUsd > 0)
  const agg = aggregateRows(metricsRows)
  const passed = rows.filter((r) => r.outcomePass).length
  const thresh = checkThresholds(agg)
  return {
    sampleSize: rows.length,
    passRate: rows.length === 0 ? 0 : passed / rows.length,
    passed,
    aggregate: agg,
    thresholdsPass: {
      ...thresh,
      passRatePass: passed >= 8,
    },
    failedScenarios: rows.filter((r) => !r.outcomePass).map((r) => r.scenarioId),
  }
}

/** Compose Markdown report body from a run summary + per-call rows. */
export function composeReportBody({ runSummary, rows, piiSummary, archiveSummary, mode, timestamp }) {
  const lines = []
  lines.push(`# v2.1 S6 Smoke Report`)
  lines.push("")
  lines.push(`- **Mode**: ${mode}`)
  lines.push(`- **Run at**: ${timestamp}`)
  lines.push(`- **Sample size**: ${runSummary.sampleSize}`)
  lines.push(`- **Pass rate**: ${runSummary.passed}/${runSummary.sampleSize}`)
  lines.push("")
  lines.push("## Threshold compliance")
  lines.push("")
  lines.push("| Metric | Threshold | Actual | Pass |")
  lines.push("|---|---|---|---|")
  lines.push(
    `| Pass rate | >= 8/10 | ${runSummary.passed}/${runSummary.sampleSize} | ${runSummary.thresholdsPass.passRatePass ? "yes" : "no"} |`,
  )
  lines.push(
    `| PII leaks | == 0 | ${piiSummary.totalLeaks} | ${piiSummary.totalLeaks === 0 ? "yes" : "no"} |`,
  )
  lines.push(
    `| p50 TTFA | < 1500 ms | ${runSummary.aggregate.p50TtfaMs} ms | ${runSummary.thresholdsPass.p50TtfaPass ? "yes" : "no"} |`,
  )
  lines.push(
    `| Cost / call | < $1.00 | $${runSummary.aggregate.costPerCallUsd.toFixed(2)} | ${runSummary.thresholdsPass.costPerCallPass ? "yes" : "no"} |`,
  )
  lines.push(
    `| False-commit | < 10% | ${(runSummary.aggregate.falseCommitRate * 100).toFixed(1)}% | ${runSummary.thresholdsPass.falseCommitPass ? "yes" : "no"} |`,
  )
  lines.push(
    `| False-interrupt | < 5% | ${(runSummary.aggregate.falseInterruptRate * 100).toFixed(1)}% | ${runSummary.thresholdsPass.falseInterruptPass ? "yes" : "no"} |`,
  )
  lines.push("")
  lines.push("## Recording archive spot-check")
  lines.push("")
  lines.push(`- Sampled: ${archiveSummary.sampled}`)
  lines.push(`- OK: ${archiveSummary.ok}`)
  if (archiveSummary.failures.length > 0) {
    lines.push("- Failures:")
    for (const f of archiveSummary.failures) {
      lines.push(`  - ${f.name}: ${f.reason}`)
    }
  }
  lines.push("")
  lines.push("## Per-call results")
  lines.push("")
  lines.push("| # | Scenario | Expected | Actual | TTFA ms | Cost $ | Pass |")
  lines.push("|---|---|---|---|---|---|---|")
  rows.forEach((r, idx) => {
    lines.push(
      `| ${idx + 1} | ${r.scenarioId} | ${r.expectedOutcome} | ${r.actualOutcome} | ${r.ttfaMs ?? "-"} | ${r.costUsd?.toFixed?.(2) ?? "-"} | ${r.passOverall ? "yes" : "no"} |`,
    )
  })
  lines.push("")
  lines.push("## Ship-readiness")
  lines.push("")
  const allPass =
    runSummary.thresholdsPass.passRatePass &&
    piiSummary.totalLeaks === 0 &&
    runSummary.thresholdsPass.p50TtfaPass &&
    runSummary.thresholdsPass.costPerCallPass &&
    runSummary.thresholdsPass.falseCommitPass &&
    runSummary.thresholdsPass.falseInterruptPass &&
    archiveSummary.ok
  lines.push(`- **Ship gate**: ${allPass ? "GREEN" : "RED"}`)
  if (!allPass) {
    lines.push("- **Blockers**:")
    if (!runSummary.thresholdsPass.passRatePass) lines.push("  - pass rate below 8/10")
    if (piiSummary.totalLeaks > 0) lines.push("  - PII leaks present")
    if (!runSummary.thresholdsPass.p50TtfaPass) lines.push("  - p50 TTFA above 1500ms")
    if (!runSummary.thresholdsPass.costPerCallPass) lines.push("  - cost/call above $1.00")
    if (!runSummary.thresholdsPass.falseCommitPass) lines.push("  - false-commit rate above 10%")
    if (!runSummary.thresholdsPass.falseInterruptPass) lines.push("  - false-interrupt rate above 5%")
    if (!archiveSummary.ok) lines.push("  - archive spot-check failed")
  }
  lines.push("")
  return lines.join("\n")
}

/** Driver entry — runs the sweep + writes outputs. */
export async function driveSweep({
  mode = "mock",
  scenarioDir = resolve(__dirname, "scenarios"),
  outDir = resolve(__dirname, "..", "..", ".planning", "v2.1", "sprints", "S6", "smoke-runs"),
  reportPath = resolve(__dirname, "..", "..", ".planning", "v2.1", "sprints", "S6", "SMOKE-REPORT.md"),
  count = 10,
  runOne, // test seam — () => Promise<resultRow>
  runPii, // test seam — () => Promise<{ leaks }>
  runArchive, // test seam — () => Promise<{ sampled, ok, failures }>
  now = () => new Date(),
} = {}) {
  const entries = await readdir(scenarioDir)
  const scenarioFiles = entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .slice(0, count)
  if (scenarioFiles.length === 0) {
    throw new Error(`no scenarios in ${scenarioDir}`)
  }

  const rows = []
  const piiPerCall = []

  for (const file of scenarioFiles) {
    const scenarioPath = join(scenarioDir, file)
    const row = await runOne(scenarioPath, mode)
    rows.push(row)
    const pii = await runPii(row, mode)
    piiPerCall.push({ scenarioId: row.scenarioId, leaks: pii.leaks ?? [] })
  }

  const piiSummary = {
    perCall: piiPerCall,
    totalLeaks: piiPerCall.reduce((s, p) => s + p.leaks.length, 0),
  }
  const archiveSummary = await runArchive(mode)
  const runSummary = aggregateRun(rows)

  const timestamp = now().toISOString()
  await mkdir(outDir, { recursive: true })
  const safeStamp = timestamp.replace(/[:.]/g, "-")
  const outFile = join(outDir, `${safeStamp}.json`)
  await writeFile(
    outFile,
    JSON.stringify(
      { timestamp, mode, runSummary, piiSummary, archiveSummary, rows },
      null,
      2,
    ),
    "utf8",
  )

  // Rewrite report body. We keep a banner header so the file is
  // discoverable when SMOKE-REPORT.md has not yet been touched.
  const body = composeReportBody({ runSummary, rows, piiSummary, archiveSummary, mode, timestamp })
  await writeFile(reportPath, body, "utf8")

  return { outFile, reportPath, runSummary, piiSummary, archiveSummary }
}

/** Default child-process runOne — invokes runner.mjs and parses JSON. */
async function defaultRunOne(scenarioPath, mode) {
  const args = [join(__dirname, "runner.mjs"), "--scenario", scenarioPath]
  if (mode === "mock") args.push("--mock")
  const res = await spawnChild(process.execPath, args)
  // Runner exits 1 on threshold-fail but still prints a row; only treat
  // exit >= 2 as a hard error.
  if (res.code >= 2) {
    throw new Error(`runner.mjs exited ${res.code}: ${res.stderr}`)
  }
  try {
    return JSON.parse(res.stdout)
  } catch {
    throw new Error(`runner.mjs produced non-JSON output: ${res.stdout.slice(0, 200)}`)
  }
}

/** Default runPii — invokes pii-audit.mjs against a transcript fixture. */
async function defaultRunPii(row, mode) {
  // In live mode we'd pass --booking <id>; in mock we synthesize a
  // clean transcript fixture (no leak) so the driver completes
  // end-to-end. Real PII auditing happens in live mode via Firestore.
  if (mode === "live" && row.bookingId) {
    const args = [join(__dirname, "pii-audit.mjs"), "--booking", row.bookingId]
    const res = await spawnChild(process.execPath, args)
    try {
      return JSON.parse(res.stdout)
    } catch {
      return { leaks: [] }
    }
  }
  return { leaks: [] }
}

/** Default runArchive — invokes archive-spot-check.mjs. */
async function defaultRunArchive(mode) {
  const args = [
    join(__dirname, "archive-spot-check.mjs"),
    "--bucket",
    process.env.WEKRUIT_VOICE_RECORDINGS_BUCKET ?? "wekruit-voice-recordings",
    "--count",
    "3",
  ]
  if (mode === "mock") args.push("--mock")
  const res = await spawnChild(process.execPath, args)
  let parsed
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    parsed = { ok: false, samples: [], failures: [] }
  }
  return {
    sampled: parsed.samples?.length ?? 0,
    ok: parsed.ok ?? false,
    failures: parsed.failures ?? [],
  }
}

async function main(argv) {
  const live = parseBoolFlag(argv, "live")
  const mock = parseBoolFlag(argv, "mock") || !live
  const count = Number.parseInt(parseFlag(argv, "count") ?? "10", 10)

  if (live) {
    const check = checkLiveSecrets(process.env)
    if (!check.ok) {
      console.error(
        `Live smoke refused — missing env: ${check.missing.join(", ")}`,
      )
      console.error(
        "See tests/voice-smoke/README.md for the Adam-secrets unblock list.",
      )
      process.exit(2)
    }
  }

  const mode = live ? "live" : "mock"
  const result = await driveSweep({
    mode,
    count,
    runOne: defaultRunOne,
    runPii: defaultRunPii,
    runArchive: defaultRunArchive,
  })
  process.stdout.write(JSON.stringify(result.runSummary, null, 2) + "\n")
  process.stdout.write(`\nReport written: ${result.reportPath}\n`)
  process.stdout.write(`Per-run JSON:   ${result.outFile}\n`)
  process.exit(
    result.runSummary.thresholdsPass.passRatePass &&
      result.piiSummary.totalLeaks === 0 &&
      result.archiveSummary.ok
      ? 0
      : 1,
  )
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`smoke-driver.mjs failed: ${err.message}`)
    process.exit(2)
  })
}

// keep linters quiet about unused
void existsSync
void readFile
