import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_SEND_CAP_BUFFER,
  effectiveSendCap,
  resolveHardSendCap,
  sendCapWindowCutoffIso,
  sendCapWindowMs,
} from "./send-cap.js"

describe("resolveHardSendCap", () => {
  it("reads dailySendCap only — NOT capacity", () => {
    assert.equal(resolveHardSendCap({ dailySendCap: 800 }), 800)
    // capacity is a different field (S6 / job-rec); never used as the send cap.
    assert.equal(resolveHardSendCap({ dailySendCap: undefined } as never), null)
  })
  it("unconfigured / invalid → null (no enforcement)", () => {
    assert.equal(resolveHardSendCap({}), null)
    assert.equal(resolveHardSendCap({ dailySendCap: 0 }), null)
    assert.equal(resolveHardSendCap({ dailySendCap: -5 }), null)
  })
})

describe("effectiveSendCap", () => {
  it("subtracts the buffer (default 50)", () => {
    assert.equal(effectiveSendCap({ dailySendCap: 800 }), 800 - DEFAULT_SEND_CAP_BUFFER)
  })
  it("honors a configured buffer", () => {
    assert.equal(effectiveSendCap({ dailySendCap: 800, sendCapBuffer: 100 }), 700)
    assert.equal(effectiveSendCap({ dailySendCap: 800, sendCapBuffer: 0 }), 800)
  })
  it("never goes below 0", () => {
    assert.equal(effectiveSendCap({ dailySendCap: 30, sendCapBuffer: 50 }), 0)
  })
  it("unconfigured → null", () => {
    assert.equal(effectiveSendCap({}), null)
  })
})

describe("sendCapWindowMs / cutoff", () => {
  it("defaults to a 24h rolling window", () => {
    assert.equal(sendCapWindowMs({}), 24 * 60 * 60 * 1000)
  })
  it("honors a configured window", () => {
    assert.equal(sendCapWindowMs({ sendCapWindowHours: 6 }), 6 * 60 * 60 * 1000)
  })
  it("cutoff is now minus the window (rolling, second-precise)", () => {
    const nowMs = Date.parse("2026-06-15T12:00:00.000Z")
    assert.equal(sendCapWindowCutoffIso({}, nowMs), "2026-06-14T12:00:00.000Z")
    assert.equal(sendCapWindowCutoffIso({ sendCapWindowHours: 1 }, nowMs), "2026-06-15T11:00:00.000Z")
  })
})
