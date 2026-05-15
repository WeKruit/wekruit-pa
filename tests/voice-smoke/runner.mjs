#!/usr/bin/env node
/**
 * v2.1 S6 — Voice smoke single-scenario runner.
 *
 * Drives ONE scenario end-to-end:
 *   1. Load + validate the scenario YAML.
 *   2. Generate a deterministic bookingId.
 *   3. Create the `outbound-bookings/{bookingId}` doc — S3 picks it up
 *      and dials. (Mock mode skips dial.)
 *   4. Poll until terminal state OR timeout.
 *   5. Read per-call metrics (`voice-call-metrics/{callSid}`).
 *   6. Compute pass/fail vs the scenario's thresholds.
 *   7. Print a JSON result row to stdout (consumed by smoke-driver.mjs).
 *
 * Usage:
 *   node runner.mjs --scenario <file.yaml> [--mock] [--timeout 300]
 *
 * Mock mode bypasses Firestore + LiveKit + Twilio; the runner injects
 * mock terminal state + canned metrics from the scenario itself
 * (`scenario.mock.metrics`).
 */
import { randomBytes } from "node:crypto"
import { loadScenarioFile, parseFlag, parseBoolFlag } from "./lib/scenario-loader.mjs"
import {
  createMockFirestoreAdapter,
  createLiveFirestoreAdapter,
  waitForTerminal,
  TERMINAL_STATES,
} from "./lib/firestore-adapter.mjs"
import {
  createMockMetricsAdapter,
  createLiveMetricsAdapter,
} from "./lib/metrics-adapter.mjs"

/** Deterministic-ish bookingId. Includes scenario.id + 8-char hex. */
export function makeBookingId(scenarioId, rand = () => randomBytes(4).toString("hex")) {
  return `smoke-${scenarioId}-${rand()}`
}

/** Build the booking doc payload from a scenario. */
export function buildBookingDoc(scenario, callSid) {
  return {
    paUserId: scenario.context.paUserId,
    paJobId: scenario.context.paJobId,
    voiceCallSid: callSid,
    voiceState: "queued",
    voiceStartedAt: null,
    voiceEndedAt: null,
    voiceOutcome: null,
    toNumber: scenario.voice.toNumber ?? null,
    fromCallerId: scenario.voice.fromCallerId ?? null,
    smokeScenarioId: scenario.id,
    seed: scenario.seed ?? null,
    createdAt: new Date().toISOString(),
  }
}

/** Score a single scenario run: produce a result row. */
export function composeResult({ scenario, booking, metrics, thresholds }) {
  const expected = scenario.voice.expectedOutcome
  const actual = booking?.voiceOutcome ?? "TIMEOUT"
  const outcomePass = actual === expected
  const ttfaPass = (metrics?.ttfaMs ?? Number.POSITIVE_INFINITY) < (thresholds?.ttfaMaxMs ?? 1500)
  const costPass = (metrics?.costUsd ?? Number.POSITIVE_INFINITY) < (thresholds?.costMaxUsd ?? 1.0)
  return {
    scenarioId: scenario.id,
    description: scenario.description,
    expectedOutcome: expected,
    actualOutcome: actual,
    outcomePass,
    callSid: booking?.voiceCallSid ?? null,
    bookingId: booking?.__bookingId ?? null,
    ttfaMs: metrics?.ttfaMs ?? null,
    costUsd: metrics?.costUsd ?? null,
    falseCommit: metrics?.falseCommit ?? null,
    falseInterrupt: metrics?.falseInterrupt ?? null,
    ttfaPass,
    costPass,
    passOverall: outcomePass && ttfaPass && costPass,
    completedAt: new Date().toISOString(),
  }
}

/** Single-scenario runner — testable via injected adapters. */
export async function runScenario({ scenario, firestore, metrics, sleep, rand }) {
  const callSid = `CA-${(rand ?? (() => randomBytes(8).toString("hex")))()}`
  const bookingId = makeBookingId(scenario.id, rand)
  const doc = buildBookingDoc(scenario, callSid)
  await firestore.createBooking(bookingId, doc)

  // Mock mode: pre-seed terminal state + metric row from scenario.mock.
  if (firestore.kind === "mock" && scenario.mock?.outcome) {
    firestore.__advanceTerminal(bookingId, scenario.mock.outcome)
    if (scenario.mock.metrics) {
      // Re-create metrics adapter contents by routing through the
      // metrics adapter. The mock metrics adapter is per-callSid, so we
      // re-init if it supports writeMetrics; otherwise the rows come
      // from scenario.mock.metrics through the runner's own composition.
      if (typeof metrics.__seed === "function") {
        metrics.__seed(callSid, scenario.mock.metrics)
      }
    }
  }

  const terminal = await waitForTerminal(firestore, bookingId, {
    timeoutMs: scenario.timeoutMs ?? 300_000,
    intervalMs: scenario.pollIntervalMs ?? 50, // fast for tests
    sleep,
  })
  terminal.__bookingId = bookingId
  const row = await metrics.readCallMetrics(callSid)
  return composeResult({
    scenario,
    booking: terminal,
    metrics: row,
    thresholds: scenario.thresholds,
  })
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────
async function main(argv) {
  const scenarioPath = parseFlag(argv, "scenario")
  if (!scenarioPath) {
    console.error("usage: runner.mjs --scenario <file.yaml> [--mock] [--timeout 300]")
    process.exit(2)
  }
  const mockMode = parseBoolFlag(argv, "mock")
  const timeoutSec = Number.parseInt(parseFlag(argv, "timeout") ?? "300", 10)

  const scenario = await loadScenarioFile(scenarioPath, process.env, {
    strict: !mockMode,
  })
  scenario.timeoutMs = timeoutSec * 1000

  let firestore, metrics
  if (mockMode) {
    firestore = createMockFirestoreAdapter()
    const mockRows = {}
    metrics = createMockMetricsAdapter(mockRows)
    metrics.__seed = (sid, row) => {
      mockRows[sid] = row
    }
  } else {
    firestore = await createLiveFirestoreAdapter()
    metrics = await createLiveMetricsAdapter()
  }

  const result = await runScenario({ scenario, firestore, metrics })
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  process.exit(result.passOverall ? 0 : 1)
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`runner.mjs failed: ${err.message}`)
    process.exit(2)
  })
}

export { TERMINAL_STATES }
