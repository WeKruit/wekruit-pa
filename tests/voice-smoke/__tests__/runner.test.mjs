/**
 * v2.1 S6 — Unit tests for the voice smoke runner + adapters.
 *
 * No real Firestore, no real LiveKit. All via injected mock adapters.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  interpolate,
  interpolateTree,
  validateScenario,
  loadScenarioFile,
  parseFlag,
  parseBoolFlag,
} from "../lib/scenario-loader.mjs"
import {
  createMockFirestoreAdapter,
  waitForTerminal,
} from "../lib/firestore-adapter.mjs"
import {
  createMockMetricsAdapter,
  aggregateRows,
  checkThresholds,
} from "../lib/metrics-adapter.mjs"
import {
  makeBookingId,
  buildBookingDoc,
  composeResult,
  runScenario,
} from "../runner.mjs"

// ── scenario-loader ─────────────────────────────────────────────────────────

test("interpolate replaces ${VAR} tokens", () => {
  assert.equal(interpolate("a-${X}-b", { X: "Y" }), "a-Y-b")
})

test("interpolate empty when var missing (non-strict)", () => {
  assert.equal(interpolate("a-${MISSING}-b", {}), "a--b")
})

test("interpolate throws when strict + missing", () => {
  assert.throws(() => interpolate("${MISSING}", {}, { strict: true }), /MISSING/)
})

test("interpolateTree traverses nested objects + arrays", () => {
  const env = { N: "+1555" }
  const out = interpolateTree({ a: "${N}", b: ["${N}", { c: "${N}-x" }] }, env)
  assert.deepEqual(out, { a: "+1555", b: ["+1555", { c: "+1555-x" }] })
})

test("validateScenario rejects bad shape", () => {
  assert.throws(() => validateScenario({}, "x.yaml"), /missing id/)
  assert.throws(
    () => validateScenario({ id: "a", description: "b", voice: { expectedOutcome: "WAT" } }, "x.yaml"),
    /expectedOutcome/
  )
})

test("validateScenario accepts minimal valid scenario", () => {
  const s = {
    id: "x",
    description: "d",
    voice: { expectedOutcome: "PASS" },
    context: { paUserId: "u", paJobId: "j" },
    thresholds: { ttfaMaxMs: 1500 },
  }
  assert.equal(validateScenario(s, "x.yaml").id, "x")
})

test("loadScenarioFile parses + interpolates a YAML file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "smoke-yaml-"))
  const path = join(dir, "x.yaml")
  await writeFile(
    path,
    `id: "x"\ndescription: "d"\nvoice:\n  toNumber: "\${PA_TEAM_NUMBER_X}"\n  expectedOutcome: "PASS"\ncontext:\n  paUserId: "u"\n  paJobId: "j"\nthresholds:\n  ttfaMaxMs: 1500\n`,
    "utf8"
  )
  const s = await loadScenarioFile(path, { PA_TEAM_NUMBER_X: "+15550100" })
  assert.equal(s.voice.toNumber, "+15550100")
})

test("parseFlag + parseBoolFlag basic", () => {
  assert.equal(parseFlag(["--scenario", "x.yaml"], "scenario"), "x.yaml")
  assert.equal(parseFlag(["--scenario", "--other"], "scenario"), null)
  assert.equal(parseFlag([], "scenario"), null)
  assert.equal(parseBoolFlag(["--mock"], "mock"), true)
  assert.equal(parseBoolFlag([], "mock"), false)
})

// ── firestore-adapter mock ──────────────────────────────────────────────────

test("mock firestore: create + read", async () => {
  const fs = createMockFirestoreAdapter()
  await fs.createBooking("b1", { paUserId: "u", paJobId: "j" })
  const d = await fs.readBooking("b1")
  assert.equal(d.paUserId, "u")
  assert.equal(d.voiceState, "queued")
  assert.equal(fs.counters.creates, 1)
})

test("mock firestore: waitForTerminal returns immediately when already terminal", async () => {
  const fs = createMockFirestoreAdapter()
  await fs.createBooking("b1", { paUserId: "u", paJobId: "j" })
  fs.__advanceTerminal("b1", "PASS")
  let waits = 0
  const t = await waitForTerminal(fs, "b1", {
    intervalMs: 1,
    timeoutMs: 100,
    sleep: () => {
      waits += 1
      return Promise.resolve()
    },
  })
  assert.equal(t.voiceOutcome, "PASS")
  assert.equal(waits, 0)
})

test("mock firestore: waitForTerminal times out", async () => {
  const fs = createMockFirestoreAdapter()
  await fs.createBooking("b1", { paUserId: "u", paJobId: "j" })
  await assert.rejects(
    () =>
      waitForTerminal(fs, "b1", {
        intervalMs: 1,
        timeoutMs: 5,
        sleep: () => new Promise((r) => setTimeout(r, 1)),
      }),
    /timeout/
  )
})

// ── metrics-adapter ─────────────────────────────────────────────────────────

test("aggregateRows empty case", () => {
  const a = aggregateRows([])
  assert.equal(a.sampleSize, 0)
  assert.equal(a.p50TtfaMs, 0)
})

test("aggregateRows computes p50/p95 + means", () => {
  const rows = [
    { ttfaMs: 1000, costUsd: 0.5, falseCommit: false, falseInterrupt: false, agentTalkRatio: 0.5 },
    { ttfaMs: 1200, costUsd: 0.7, falseCommit: false, falseInterrupt: false, agentTalkRatio: 0.5 },
    { ttfaMs: 800, costUsd: 0.3, falseCommit: true, falseInterrupt: false, agentTalkRatio: 0.5 },
  ]
  const a = aggregateRows(rows)
  assert.equal(a.sampleSize, 3)
  assert.equal(a.p50TtfaMs, 1000)
  assert.ok(Math.abs(a.falseCommitRate - 1 / 3) < 1e-9)
})

test("checkThresholds flags fails", () => {
  const r = checkThresholds({
    sampleSize: 1,
    p50TtfaMs: 2000,
    p95TtfaMs: 3000,
    falseCommitRate: 0.2,
    falseInterruptRate: 0.1,
    costPerCallUsd: 1.5,
    agentTalkRatio: 0.5,
  })
  assert.equal(r.p50TtfaPass, false)
  assert.equal(r.costPerCallPass, false)
  assert.equal(r.falseCommitPass, false)
  assert.equal(r.falseInterruptPass, false)
})

test("checkThresholds all pass under happy values", () => {
  const r = checkThresholds({
    sampleSize: 10,
    p50TtfaMs: 1000,
    p95TtfaMs: 1400,
    falseCommitRate: 0.05,
    falseInterruptRate: 0.02,
    costPerCallUsd: 0.5,
    agentTalkRatio: 0.55,
  })
  assert.equal(r.p50TtfaPass, true)
  assert.equal(r.costPerCallPass, true)
  assert.equal(r.falseCommitPass, true)
  assert.equal(r.falseInterruptPass, true)
})

// ── runner: end-to-end (mocked) ─────────────────────────────────────────────

test("makeBookingId deterministic with injected rand", () => {
  assert.equal(makeBookingId("s1", () => "abcd1234"), "smoke-s1-abcd1234")
})

test("buildBookingDoc shape", () => {
  const s = {
    id: "x",
    description: "d",
    voice: { toNumber: "+1", fromCallerId: "+2", expectedOutcome: "PASS" },
    context: { paUserId: "u", paJobId: "j" },
  }
  const doc = buildBookingDoc(s, "CA-test")
  assert.equal(doc.paUserId, "u")
  assert.equal(doc.voiceCallSid, "CA-test")
  assert.equal(doc.voiceState, "queued")
  assert.equal(doc.smokeScenarioId, "x")
})

test("composeResult marks pass when outcome + ttfa + cost satisfy", () => {
  const r = composeResult({
    scenario: {
      id: "x",
      description: "d",
      voice: { expectedOutcome: "PASS" },
    },
    booking: { voiceOutcome: "PASS", voiceCallSid: "CA-1", __bookingId: "b1" },
    metrics: { ttfaMs: 1000, costUsd: 0.5, falseCommit: false, falseInterrupt: false },
    thresholds: { ttfaMaxMs: 1500, costMaxUsd: 1.0 },
  })
  assert.equal(r.passOverall, true)
  assert.equal(r.bookingId, "b1")
})

test("composeResult fails when outcome mismatch", () => {
  const r = composeResult({
    scenario: { id: "x", description: "d", voice: { expectedOutcome: "PASS" } },
    booking: { voiceOutcome: "NOT_PASS", voiceCallSid: "CA-1" },
    metrics: { ttfaMs: 500, costUsd: 0.1 },
    thresholds: { ttfaMaxMs: 1500, costMaxUsd: 1.0 },
  })
  assert.equal(r.outcomePass, false)
  assert.equal(r.passOverall, false)
})

test("composeResult fails when no metrics + no booking (timeout case)", () => {
  const r = composeResult({
    scenario: { id: "x", description: "d", voice: { expectedOutcome: "PASS" } },
    booking: null,
    metrics: null,
    thresholds: { ttfaMaxMs: 1500, costMaxUsd: 1.0 },
  })
  assert.equal(r.actualOutcome, "TIMEOUT")
  assert.equal(r.passOverall, false)
})

test("runScenario end-to-end against mocks", async () => {
  const scenario = {
    id: "e2e",
    description: "happy",
    voice: { expectedOutcome: "PASS" },
    context: { paUserId: "u", paJobId: "j" },
    thresholds: { ttfaMaxMs: 1500, costMaxUsd: 1.0 },
    timeoutMs: 200,
    pollIntervalMs: 1,
    mock: {
      outcome: "PASS",
      metrics: {
        ttfaMs: 900,
        costUsd: 0.4,
        falseCommit: false,
        falseInterrupt: false,
        agentTalkRatio: 0.5,
      },
    },
  }
  const fs = createMockFirestoreAdapter()
  const mockRows = {}
  const metrics = createMockMetricsAdapter(mockRows)
  metrics.__seed = (sid, row) => {
    mockRows[sid] = row
  }
  let randCounter = 0
  const rand = () => `r${++randCounter}`
  const sleep = () => Promise.resolve()
  const out = await runScenario({ scenario, firestore: fs, metrics, sleep, rand })
  assert.equal(out.outcomePass, true)
  assert.equal(out.actualOutcome, "PASS")
  assert.equal(out.passOverall, true)
  assert.match(out.callSid, /^CA-r/)
  assert.match(out.bookingId, /^smoke-e2e-r/)
  assert.equal(out.ttfaMs, 900)
})
