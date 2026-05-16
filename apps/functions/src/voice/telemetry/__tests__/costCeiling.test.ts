/**
 * S4 — costCeiling watchdog unit tests (Lock L11).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { FakeFirestore, asFirestore } from "./fake-firestore.js"
import { createTelemetryHookBundle } from "../metricsWriter.js"
import { createCostCeilingWatchdog } from "../costCeiling.js"
import {
  VOICE_CALL_METRICS_COLLECTION,
  type CostCeilingCallback,
  type VoiceCallLifecycle,
} from "../types.js"

const SID = "vc_test_cost"

function build() {
  const fs = new FakeFirestore()
  const bundle = createTelemetryHookBundle({ db: asFirestore(fs) })
  const watchdog = createCostCeilingWatchdog({
    db: asFirestore(fs),
    inner: bundle.hook,
    state: bundle.state,
  })
  return { fs, watchdog }
}

async function start(watchdog: ReturnType<typeof createCostCeilingWatchdog>) {
  await watchdog.hook.onSessionStart({
    voiceCallSid: SID,
    paUserId: null,
    paJobId: null,
    startedAt: 1_000,
  })
}

describe("costCeiling warns at $0.90", () => {
  it("sets costWarningAt exactly once when running cost crosses 0.9", async () => {
    const { fs, watchdog } = build()
    await start(watchdog)

    await watchdog.hook.onSessionUsageUpdated({
      voiceCallSid: SID,
      at: 2_000,
      runningCostUsd: 0.85,
      runningLlmTokensIn: 0,
      runningLlmTokensOut: 0,
      runningSttSeconds: 0,
      runningTtsSeconds: 0,
    })
    let lifecycle = fs._getColl(VOICE_CALL_METRICS_COLLECTION).get(SID) as unknown as VoiceCallLifecycle
    assert.equal(lifecycle.costWarningAt, null, "no warning yet under 0.9")

    await watchdog.hook.onSessionUsageUpdated({
      voiceCallSid: SID,
      at: 3_000,
      runningCostUsd: 0.92,
      runningLlmTokensIn: 0,
      runningLlmTokensOut: 0,
      runningSttSeconds: 0,
      runningTtsSeconds: 0,
    })
    lifecycle = fs._getColl(VOICE_CALL_METRICS_COLLECTION).get(SID) as unknown as VoiceCallLifecycle
    assert.equal(lifecycle.costWarningAt, 3_000)

    // A second event past 0.90 should NOT overwrite (only one warning per call).
    await watchdog.hook.onSessionUsageUpdated({
      voiceCallSid: SID,
      at: 4_000,
      runningCostUsd: 0.95,
      runningLlmTokensIn: 0,
      runningLlmTokensOut: 0,
      runningSttSeconds: 0,
      runningTtsSeconds: 0,
    })
    lifecycle = fs._getColl(VOICE_CALL_METRICS_COLLECTION).get(SID) as unknown as VoiceCallLifecycle
    assert.equal(lifecycle.costWarningAt, 3_000, "warning timestamp is sticky")
  })
})

describe("costCeiling triggers close-callback at $1.00", () => {
  it("invokes registered callback exactly once and marks lifecycle failed:cost_ceiling", async () => {
    const { fs, watchdog } = build()
    await start(watchdog)

    let callbackCalls = 0
    let receivedFinalCost = -1
    const cb: CostCeilingCallback = (a) => {
      callbackCalls += 1
      receivedFinalCost = a.finalCostUsd
      assert.equal(a.reason, "cost_ceiling_exceeded")
      assert.equal(a.voiceCallSid, SID)
    }
    watchdog.registerCloseCallback(SID, cb)

    await watchdog.hook.onSessionUsageUpdated({
      voiceCallSid: SID,
      at: 5_000,
      runningCostUsd: 1.02,
      runningLlmTokensIn: 0,
      runningLlmTokensOut: 0,
      runningSttSeconds: 0,
      runningTtsSeconds: 0,
    })

    assert.equal(callbackCalls, 1, "callback fired exactly once")
    assert.equal(receivedFinalCost, 1.02)

    const lifecycle = fs._getColl(VOICE_CALL_METRICS_COLLECTION).get(SID) as unknown as VoiceCallLifecycle
    assert.equal(lifecycle.status, "failed:cost_ceiling")
    assert.equal(lifecycle.costExceededAt, 5_000)
    // Warning also fired because 1.02 >= 0.9.
    assert.equal(lifecycle.costWarningAt, 5_000)
  })
})

describe("costCeiling idempotent on duplicate session_usage_updated", () => {
  it("does not double-fire the close-callback on repeat events past $1.00", async () => {
    const { watchdog } = build()
    await start(watchdog)

    let callbackCalls = 0
    watchdog.registerCloseCallback(SID, () => {
      callbackCalls += 1
    })

    for (let i = 0; i < 5; i += 1) {
      await watchdog.hook.onSessionUsageUpdated({
        voiceCallSid: SID,
        at: 6_000 + i,
        runningCostUsd: 1.5 + i * 0.01,
        runningLlmTokensIn: 0,
        runningLlmTokensOut: 0,
        runningSttSeconds: 0,
        runningTtsSeconds: 0,
      })
    }
    assert.equal(callbackCalls, 1, "callback idempotent across duplicates")
  })

  it("logs but does not throw when no close-callback is registered", async () => {
    const { fs, watchdog } = build()
    await start(watchdog)
    await watchdog.hook.onSessionUsageUpdated({
      voiceCallSid: SID,
      at: 7_000,
      runningCostUsd: 1.05,
      runningLlmTokensIn: 0,
      runningLlmTokensOut: 0,
      runningSttSeconds: 0,
      runningTtsSeconds: 0,
    })
    const lifecycle = fs._getColl(VOICE_CALL_METRICS_COLLECTION).get(SID) as unknown as VoiceCallLifecycle
    assert.equal(lifecycle.status, "failed:cost_ceiling")
    assert.equal(lifecycle.costExceededAt, 7_000)
  })
})
