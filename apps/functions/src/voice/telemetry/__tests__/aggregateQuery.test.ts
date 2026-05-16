/**
 * S4 — aggregateQuery unit tests (S6 smoke-gate consumer shape).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { FakeFirestore, asFirestore } from "./fake-firestore.js"
import { createTelemetryHookBundle } from "../metricsWriter.js"
import { createCostCeilingWatchdog } from "../costCeiling.js"
import { runVoiceTelemetryAggregate } from "../aggregateQuery.js"
import { authorizeAdminCallable } from "../../../promote-sandbox-tag.js"
import { VOICE_CALL_METRICS_COLLECTION, type VoiceCallLifecycle } from "../types.js"

async function simulateCall(args: {
  fs: FakeFirestore
  sid: string
  startedAt: number
  ttfaMsList: number[]
  falseCommitIdxs?: number[]
  falseInterruptIdxs?: number[]
  finalCostUsd: number
  ceilingHit?: boolean
  userMsPerTurn?: number
  agentResponseMsPerTurn?: number
}) {
  const bundle = createTelemetryHookBundle({ db: asFirestore(args.fs) })
  const watchdog = createCostCeilingWatchdog({
    db: asFirestore(args.fs),
    inner: bundle.hook,
    state: bundle.state,
  })
  watchdog.registerCloseCallback(args.sid, () => undefined)
  await watchdog.hook.onSessionStart({
    voiceCallSid: args.sid,
    paUserId: "u_x",
    paJobId: "j_y",
    startedAt: args.startedAt,
  })

  for (let i = 0; i < args.ttfaMsList.length; i += 1) {
    const base = args.startedAt + 1_000 + i * 1_500
    const userMs = args.userMsPerTurn ?? 400
    const turnStart = base
    const commitAt = turnStart + userMs
    const agentFirstAudioAt = commitAt + args.ttfaMsList[i]!
    const agentEndAt = agentFirstAudioAt + (args.agentResponseMsPerTurn ?? 700)

    watchdog.hook.onUserSpeechCommitted({
      voiceCallSid: args.sid,
      at: commitAt,
      transcript: "u",
    })
    if (args.falseInterruptIdxs?.includes(i) || args.falseCommitIdxs?.includes(i)) {
      watchdog.hook.onFalseInterruption({ voiceCallSid: args.sid, at: commitAt + 10 })
    }
    watchdog.hook.onAgentFirstAudio({ voiceCallSid: args.sid, at: agentFirstAudioAt })
    await watchdog.hook.onAgentTurnEnded({
      voiceCallSid: args.sid,
      at: agentEndAt,
      transcript: "a",
      sttSeconds: 0.3,
      ttsSeconds: 0.7,
      llmTokensIn: 100,
      llmTokensOut: 40,
    })
  }

  // Drive cost via a single usage update at end.
  await watchdog.hook.onSessionUsageUpdated({
    voiceCallSid: args.sid,
    at: args.startedAt + 60_000,
    runningCostUsd: args.finalCostUsd,
    runningLlmTokensIn: 1000,
    runningLlmTokensOut: 400,
    runningSttSeconds: 10,
    runningTtsSeconds: 12,
  })

  await watchdog.hook.onSessionClose({
    voiceCallSid: args.sid,
    at: args.startedAt + 61_000,
    reason: args.ceilingHit ? "failed:cost_ceiling" : "completed",
  })

  // For ceilingHit-only-by-status calls (cost not actually crossing $1),
  // ensure the lifecycle reflects the requested status.
  if (args.ceilingHit) {
    const coll = args.fs._getColl(VOICE_CALL_METRICS_COLLECTION)
    const row = coll.get(args.sid) as unknown as VoiceCallLifecycle | undefined
    if (row) row.status = "failed:cost_ceiling"
  }
}

describe("aggregateQuery returns Done-criteria thresholds", () => {
  it("computes false-commit %, false-interrupt %, p50/p95 TTFA, avg cost, ceiling hits", async () => {
    const fs = new FakeFirestore()

    // Call A: 4 turns, TTFAs [100, 200, 300, 5000], 1 falseCommit, 1 falseInterrupt.
    await simulateCall({
      fs,
      sid: "callA",
      startedAt: 100_000,
      ttfaMsList: [100, 200, 300, 5_000],
      falseCommitIdxs: [3],
      finalCostUsd: 0.5,
    })

    // Call B: 4 turns, TTFAs all 800, no false-commits.
    await simulateCall({
      fs,
      sid: "callB",
      startedAt: 150_000,
      ttfaMsList: [800, 800, 800, 800],
      finalCostUsd: 1.05,
      ceilingHit: true,
    })

    const result = await runVoiceTelemetryAggregate(
      { windowMinutes: 60, maxCalls: 100 },
      { db: asFirestore(fs), now: () => 200_000 },
    )

    assert.equal(result.callsConsidered, 2)
    assert.equal(result.turnsConsidered, 8)
    // 1 falseCommit out of 8 → 12.5%
    assert.equal(result.falseCommitPct, 12.5)
    // Same 1 false interruption (falseCommitIdxs triggers false_interruption) → 12.5%
    assert.equal(result.falseInterruptPct, 12.5)
    // TTFAs sorted: [100, 200, 300, 800, 800, 800, 800, 5000]
    // floor(0.5*7)=3 → 800; floor(0.95*7)=6 → 800
    assert.equal(result.ttfaP50Ms, 800)
    assert.equal(result.ttfaP95Ms, 800)
    // avgCost = (0.5 + 1.05) / 2 = 0.775
    assert.ok(result.avgCostUsd !== null)
    assert.ok(Math.abs(result.avgCostUsd! - 0.775) < 1e-9)
    assert.equal(result.costCeilingHits, 1)
    assert.ok(result.agentTalkRatio !== null && result.agentTalkRatio > 0)
  })
})

describe("aggregateQuery handles empty window", () => {
  it("returns zero counts and null thresholds when no calls in window", async () => {
    const fs = new FakeFirestore()
    const result = await runVoiceTelemetryAggregate(
      { windowMinutes: 60, maxCalls: 100 },
      { db: asFirestore(fs), now: () => 1_000_000 },
    )
    assert.equal(result.callsConsidered, 0)
    assert.equal(result.turnsConsidered, 0)
    assert.equal(result.falseCommitPct, null)
    assert.equal(result.falseInterruptPct, null)
    assert.equal(result.ttfaP50Ms, null)
    assert.equal(result.ttfaP95Ms, null)
    assert.equal(result.avgCostUsd, null)
    assert.equal(result.costCeilingHits, 0)
    assert.equal(result.agentTalkRatio, null)
  })
})

describe("aggregateQuery rejects non-admin caller", () => {
  it("authorizeAdminCallable rejects when no claim and no token", () => {
    assert.throws(
      () =>
        authorizeAdminCallable({
          auth: { token: {} },
          data: {},
        }),
      /admin only/,
    )
  })

  it("authorizeAdminCallable accepts boolean admin claim", () => {
    const got = authorizeAdminCallable({
      auth: { token: { admin: true } },
      data: {},
    })
    assert.equal(typeof got.uid, "string")
  })
})
