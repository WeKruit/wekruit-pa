/**
 * S4 — metricsWriter unit tests.
 *
 * Run via the apps/functions test script (see package.json `test` field —
 * this directory is added there).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { FakeFirestore, asFirestore } from "./fake-firestore.js"
import { createTelemetryHook } from "../metricsWriter.js"
import {
  VOICE_CALL_METRICS_COLLECTION,
  type VoiceCallLifecycle,
  type VoiceTurnMetric,
} from "../types.js"

const SID = "vc_test_001"

function makeHook() {
  const fs = new FakeFirestore()
  const hook = createTelemetryHook({ db: asFirestore(fs) })
  return { fs, hook }
}

async function startCall(hook: ReturnType<typeof createTelemetryHook>, startedAt = 1_000) {
  await hook.onSessionStart({
    voiceCallSid: SID,
    paUserId: "u_test_user",
    paJobId: "j_test_job",
    startedAt,
  })
}

async function simulateTurn(
  hook: ReturnType<typeof createTelemetryHook>,
  opts: {
    userCommitAt: number
    agentFirstAudioAt: number | null
    agentTurnEndAt: number
    falseInterruption?: boolean
    transcriptUser?: string
    transcriptAgent?: string
    turnCostUsd?: number
  },
) {
  hook.onUserSpeechCommitted({
    voiceCallSid: SID,
    at: opts.userCommitAt,
    transcript: opts.transcriptUser ?? "user line",
  })
  if (opts.falseInterruption) {
    hook.onFalseInterruption({ voiceCallSid: SID, at: opts.userCommitAt + 10 })
  }
  if (opts.agentFirstAudioAt !== null) {
    hook.onAgentFirstAudio({ voiceCallSid: SID, at: opts.agentFirstAudioAt })
  }
  await hook.onAgentTurnEnded({
    voiceCallSid: SID,
    at: opts.agentTurnEndAt,
    transcript: opts.transcriptAgent ?? "agent reply",
    sttSeconds: 0.5,
    ttsSeconds: 1.0,
    llmTokensIn: 200,
    llmTokensOut: 80,
    ...(opts.turnCostUsd !== undefined ? { turnCostUsd: opts.turnCostUsd } : {}),
  })
}

describe("metricsWriter persists one row per turn", () => {
  it("creates one turn doc per agent turn for a 10-turn mock", async () => {
    const { fs, hook } = makeHook()
    await startCall(hook)
    for (let i = 0; i < 10; i += 1) {
      const base = 2_000 + i * 1_000
      await simulateTurn(hook, {
        userCommitAt: base,
        agentFirstAudioAt: base + 200,
        agentTurnEndAt: base + 800,
      })
    }
    const turns = fs._getColl(`${VOICE_CALL_METRICS_COLLECTION}/${SID}/turns`)
    assert.equal(turns.size, 10, "expected 10 turn rows")
    for (let i = 0; i < 10; i += 1) {
      const row = turns.get(String(i)) as unknown as VoiceTurnMetric | undefined
      assert.ok(row, `turn ${i} should exist`)
      assert.equal(row!.turnIndex, i)
    }

    const lifecycle = fs._getColl(VOICE_CALL_METRICS_COLLECTION).get(SID) as
      unknown as VoiceCallLifecycle | undefined
    assert.ok(lifecycle, "lifecycle doc exists")
    assert.equal(lifecycle!.turnCount, 10)
    assert.equal(lifecycle!.paUserId, "u_test_user")
    assert.equal(lifecycle!.paJobId, "j_test_job")
  })
})

describe("metricsWriter computes ttfaMs", () => {
  it("derives TTFA from user_speech_committed to first agent audio", async () => {
    const { fs, hook } = makeHook()
    await startCall(hook)
    await simulateTurn(hook, {
      userCommitAt: 5_000,
      agentFirstAudioAt: 5_320,
      agentTurnEndAt: 6_500,
    })
    const row = fs._getColl(`${VOICE_CALL_METRICS_COLLECTION}/${SID}/turns`).get("0") as
      unknown as VoiceTurnMetric | undefined
    assert.ok(row)
    assert.equal(row!.ttfaMs, 320, "TTFA = 5_320 - 5_000 = 320ms")
    assert.equal(row!.agentResponseMs, 6_500 - 5_320)
    assert.equal(row!.falseCommit, false)
    assert.equal(row!.falseInterruption, false)
  })

  it("records ttfaMs=null when first agent audio never fired (silent agent)", async () => {
    const { fs, hook } = makeHook()
    await startCall(hook)
    await simulateTurn(hook, {
      userCommitAt: 5_000,
      agentFirstAudioAt: null,
      agentTurnEndAt: 6_500,
    })
    const row = fs._getColl(`${VOICE_CALL_METRICS_COLLECTION}/${SID}/turns`).get("0") as
      unknown as VoiceTurnMetric | undefined
    assert.ok(row)
    assert.equal(row!.ttfaMs, null)
    assert.equal(row!.agentResponseMs, null)
  })
})

describe("metricsWriter records false-commit when agent_false_interruption fires", () => {
  it("flags falseCommit=true when false_interruption arrives mid-turn", async () => {
    const { fs, hook } = makeHook()
    await startCall(hook)
    await simulateTurn(hook, {
      userCommitAt: 1_000,
      agentFirstAudioAt: 1_200,
      agentTurnEndAt: 2_000,
      falseInterruption: true,
    })
    const row = fs._getColl(`${VOICE_CALL_METRICS_COLLECTION}/${SID}/turns`).get("0") as
      unknown as VoiceTurnMetric | undefined
    assert.ok(row)
    assert.equal(row!.falseCommit, true)
    assert.equal(row!.falseInterruption, true)
  })
})

describe("metricsWriter lifecycle aggregation", () => {
  it("tracks cumulative cost + tokens across usage updates", async () => {
    const { fs, hook } = makeHook()
    await startCall(hook)
    await hook.onSessionUsageUpdated({
      voiceCallSid: SID,
      at: 1_500,
      runningCostUsd: 0.1,
      runningLlmTokensIn: 1000,
      runningLlmTokensOut: 400,
      runningSttSeconds: 3,
      runningTtsSeconds: 4,
    })
    await hook.onSessionUsageUpdated({
      voiceCallSid: SID,
      at: 2_500,
      runningCostUsd: 0.3,
      runningLlmTokensIn: 2500,
      runningLlmTokensOut: 1100,
      runningSttSeconds: 8,
      runningTtsSeconds: 9,
    })
    await hook.onSessionClose({ voiceCallSid: SID, at: 3_000, reason: "completed" })

    const lifecycle = fs._getColl(VOICE_CALL_METRICS_COLLECTION).get(SID) as
      unknown as VoiceCallLifecycle | undefined
    assert.ok(lifecycle)
    assert.equal(lifecycle!.totalCostUsd, 0.3)
    assert.equal(lifecycle!.runningLlmTokensIn, 2500)
    assert.equal(lifecycle!.runningLlmTokensOut, 1100)
    assert.equal(lifecycle!.status, "completed")
    assert.equal(lifecycle!.endedAt, 3_000)
  })

  it("does not regress cost when a stale usage update arrives late", async () => {
    const { fs, hook } = makeHook()
    await startCall(hook)
    await hook.onSessionUsageUpdated({
      voiceCallSid: SID,
      at: 1_500,
      runningCostUsd: 0.5,
      runningLlmTokensIn: 100,
      runningLlmTokensOut: 50,
      runningSttSeconds: 2,
      runningTtsSeconds: 3,
    })
    await hook.onSessionUsageUpdated({
      voiceCallSid: SID,
      at: 1_600,
      runningCostUsd: 0.2,
      runningLlmTokensIn: 80,
      runningLlmTokensOut: 30,
      runningSttSeconds: 1,
      runningTtsSeconds: 2,
    })
    const lifecycle = fs._getColl(VOICE_CALL_METRICS_COLLECTION).get(SID) as
      unknown as VoiceCallLifecycle | undefined
    assert.ok(lifecycle)
    assert.equal(lifecycle!.totalCostUsd, 0.5, "max-monotone clamp holds")
    assert.equal(lifecycle!.runningLlmTokensIn, 100)
  })
})
