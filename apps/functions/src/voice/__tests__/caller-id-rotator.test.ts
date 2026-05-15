/**
 * S3 caller-ID rotation — tests.
 *
 * Covers acceptance:
 *   "dialOutbound rotates caller IDs across calls"
 * (the dispatch test exercises the strategy via the same module).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  parseCallerIdsEnv,
  makeCallerIdStrategy,
  RoundRobinCallerIdStrategy,
  StickyByUserIdCallerIdStrategy,
} from "../caller-id-rotator.js"

describe("caller-id-rotator parsing", () => {
  it("parses comma list of E.164", () => {
    assert.deepEqual(
      parseCallerIdsEnv("+14157075057,+16468594057"),
      ["+14157075057", "+16468594057"],
    )
  })

  it("trims whitespace", () => {
    assert.deepEqual(
      parseCallerIdsEnv(" +14157075057 , +16468594057 "),
      ["+14157075057", "+16468594057"],
    )
  })

  it("throws on undefined / empty", () => {
    assert.throws(() => parseCallerIdsEnv(undefined), /empty/)
    assert.throws(() => parseCallerIdsEnv(""), /empty/)
  })

  it("rejects non-E.164 entries", () => {
    assert.throws(() => parseCallerIdsEnv("14157075057"), /Invalid caller ID/)
    assert.throws(() => parseCallerIdsEnv("+abc"), /Invalid caller ID/)
  })
})

describe("RoundRobinCallerIdStrategy", () => {
  const callerIds = ["+14157075057", "+16468594057"]

  it("is deterministic by bookingId (same id → same number)", () => {
    const strat = new RoundRobinCallerIdStrategy(callerIds)
    const a = strat.pick({ bookingId: "booking-001", paUserId: "U1" })
    const b = strat.pick({ bookingId: "booking-001", paUserId: "U2" })
    assert.equal(a, b)
  })

  it("rotates across distinct bookingIds (both numbers seen in 20 picks)", () => {
    const strat = new RoundRobinCallerIdStrategy(callerIds)
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      seen.add(strat.pick({ bookingId: `booking-${i}`, paUserId: "U1" }))
    }
    assert.equal(seen.size, 2, `expected both caller IDs across 20 bookings; got ${[...seen].join(",")}`)
  })

  it("throws when constructed with empty list", () => {
    assert.throws(() => new RoundRobinCallerIdStrategy([]), /requires/)
  })
})

describe("StickyByUserIdCallerIdStrategy", () => {
  const callerIds = ["+14157075057", "+16468594057"]

  it("is deterministic by paUserId (same user → same number across bookings)", () => {
    const strat = new StickyByUserIdCallerIdStrategy(callerIds)
    const a = strat.pick({ bookingId: "booking-001", paUserId: "U-stable" })
    const b = strat.pick({ bookingId: "booking-002", paUserId: "U-stable" })
    assert.equal(a, b)
  })

  it("distributes across users", () => {
    const strat = new StickyByUserIdCallerIdStrategy(callerIds)
    const seen = new Set<string>()
    for (let i = 0; i < 30; i++) {
      seen.add(strat.pick({ bookingId: "b", paUserId: `U-${i}` }))
    }
    assert.equal(seen.size, 2)
  })
})

describe("makeCallerIdStrategy factory", () => {
  it("returns RoundRobin by default", () => {
    const s = makeCallerIdStrategy({
      TWILIO_OUTBOUND_CALLER_IDS: "+14157075057,+16468594057",
    })
    assert.equal(s.name, "roundrobin")
  })

  it("returns Sticky when env requests it", () => {
    const s = makeCallerIdStrategy({
      TWILIO_OUTBOUND_CALLER_IDS: "+14157075057,+16468594057",
      PA_VOICE_CALLER_ID_STRATEGY: "sticky_user",
    })
    assert.equal(s.name, "sticky_user")
  })

  it("falls back to roundrobin on unknown strategy name", () => {
    const s = makeCallerIdStrategy({
      TWILIO_OUTBOUND_CALLER_IDS: "+14157075057,+16468594057",
      PA_VOICE_CALLER_ID_STRATEGY: "garbage",
    })
    assert.equal(s.name, "roundrobin")
  })
})
