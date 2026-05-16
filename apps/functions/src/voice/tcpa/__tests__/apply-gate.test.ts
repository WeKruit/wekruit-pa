/**
 * v2.1 S5 — applyTcpaGate booking-row mutation tests.
 *
 * Three contracts:
 *   - allow              → no booking write, no short-circuit
 *   - block_observed     → no booking write, no short-circuit (caller still logs)
 *   - block_enforced     → writes voiceState=failed + voiceOutcome=failed:tcpa_gate:<reason>,
 *                          returns shouldShortCircuit=true
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { applyTcpaGate } from "../gate.js"
import type { GateDecision } from "../types.js"

class FakeBookingRef {
  writes: Array<{ data: Record<string, unknown>; opts?: { merge?: boolean } }> = []
  async set(
    data: Record<string, unknown>,
    opts?: { merge?: boolean },
  ): Promise<void> {
    this.writes.push({ data, opts })
  }
}

const NOW = new Date("2026-05-15T19:00:00Z")
const FIXED_NOW = () => NOW

const ALLOW: GateDecision = {
  decision: "allow",
  mode: "blocking",
  reason: undefined,
  details: {
    dnc: { blocked: false, phoneE164: "+14155551234" },
    quietHours: { blocked: false, state: "CA", localHour: 12, tz: "America/Los_Angeles" },
    consent: { blocked: false, consentedAt: "2026-05-14T10:00:00Z" },
  },
}

const BLOCK_OBSERVED: GateDecision = {
  decision: "block_observed",
  mode: "observed",
  reason: "dnc_listed",
  details: ALLOW.details,
}

const BLOCK_ENFORCED_DNC: GateDecision = {
  decision: "block_enforced",
  mode: "blocking",
  reason: "dnc_listed",
  details: ALLOW.details,
}

const BLOCK_ENFORCED_CONSENT: GateDecision = {
  decision: "block_enforced",
  mode: "blocking",
  reason: "consent_missing",
  details: ALLOW.details,
}

describe("applyTcpaGate", () => {
  it("allow → no write, no short-circuit", async () => {
    const ref = new FakeBookingRef()
    const res = await applyTcpaGate(ALLOW, ref, { now: FIXED_NOW })
    assert.equal(res.shouldShortCircuit, false)
    assert.equal(res.bookingWrite, undefined)
    assert.equal(ref.writes.length, 0)
  })

  it("block_observed → no write, no short-circuit", async () => {
    const ref = new FakeBookingRef()
    const res = await applyTcpaGate(BLOCK_OBSERVED, ref, { now: FIXED_NOW })
    assert.equal(res.shouldShortCircuit, false)
    assert.equal(res.bookingWrite, undefined)
    assert.equal(ref.writes.length, 0)
  })

  it("block_enforced (dnc_listed) → writes failure + short-circuit", async () => {
    const ref = new FakeBookingRef()
    const res = await applyTcpaGate(BLOCK_ENFORCED_DNC, ref, { now: FIXED_NOW })
    assert.equal(res.shouldShortCircuit, true)
    assert.deepEqual(res.bookingWrite, {
      voiceState: "failed",
      voiceOutcome: "failed:tcpa_gate:dnc_listed",
      voiceLastError: "tcpa_gate:dnc_listed",
      voiceEndedAt: NOW.toISOString(),
    })
    assert.equal(ref.writes.length, 1)
    assert.deepEqual(ref.writes[0]!.opts, { merge: true })
    assert.deepEqual(ref.writes[0]!.data, res.bookingWrite)
  })

  it("block_enforced (consent_missing) → reason flows into outcome string", async () => {
    const ref = new FakeBookingRef()
    const res = await applyTcpaGate(BLOCK_ENFORCED_CONSENT, ref, { now: FIXED_NOW })
    assert.equal(res.shouldShortCircuit, true)
    assert.equal(res.bookingWrite!.voiceOutcome, "failed:tcpa_gate:consent_missing")
    assert.equal(res.bookingWrite!.voiceLastError, "tcpa_gate:consent_missing")
  })
})
