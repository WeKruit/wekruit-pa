/**
 * v2.1 S5 — Quiet-hours unit tests.
 *
 * Strategy: pick UTC instants whose corresponding local time in the target
 * tz is unambiguous (well away from DST transitions). Dates chosen are
 * 2026-05-15 — May is post-DST-spring-forward, pre-DST-fall-back, stable.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { checkQuietHours } from "../quietHours.js"

describe("checkQuietHours — CA (PT)", () => {
  it("blocks at 23:00 PT (= 06:00 UTC next day)", () => {
    // 2026-05-16T06:00:00Z = 2026-05-15T23:00 America/Los_Angeles (PDT, UTC-7)
    const now = new Date("2026-05-16T06:00:00Z")
    const res = checkQuietHours("+14155551234", { now: () => now })
    assert.equal(res.blocked, true)
    assert.equal(res.reason, "quiet_hours")
    assert.equal(res.state, "CA")
    assert.equal(res.localHour, 23)
    assert.equal(res.tz, "America/Los_Angeles")
  })

  it("blocks at 00:00 PT (midnight wrap)", () => {
    // 2026-05-16T07:00:00Z = 2026-05-16T00:00 PDT
    const now = new Date("2026-05-16T07:00:00Z")
    const res = checkQuietHours("+14155551234", { now: () => now })
    assert.equal(res.blocked, true)
    assert.equal(res.localHour, 0)
  })

  it("blocks at 07:59 PT (just before quiet ends)", () => {
    // 2026-05-15T14:59:00Z = 07:59 PDT
    const now = new Date("2026-05-15T14:59:00Z")
    const res = checkQuietHours("+14155551234", { now: () => now })
    assert.equal(res.blocked, true)
    assert.equal(res.localHour, 7)
  })

  it("allows at 08:00 PT (quiet ends)", () => {
    // 2026-05-15T15:00:00Z = 08:00 PDT
    const now = new Date("2026-05-15T15:00:00Z")
    const res = checkQuietHours("+14155551234", { now: () => now })
    assert.equal(res.blocked, false)
    assert.equal(res.localHour, 8)
    assert.equal(res.state, "CA")
  })

  it("allows at 15:00 PT (mid-afternoon)", () => {
    const now = new Date("2026-05-15T22:00:00Z")
    const res = checkQuietHours("+14155551234", { now: () => now })
    assert.equal(res.blocked, false)
    assert.equal(res.localHour, 15)
  })

  it("blocks at 21:00 PT (quiet starts)", () => {
    // 2026-05-16T04:00:00Z = 21:00 PDT (May 15)
    const now = new Date("2026-05-16T04:00:00Z")
    const res = checkQuietHours("+14155551234", { now: () => now })
    assert.equal(res.blocked, true)
    assert.equal(res.localHour, 21)
  })
})

describe("checkQuietHours — NY (ET)", () => {
  it("blocks at 22:00 ET", () => {
    // 2026-05-16T02:00:00Z = 22:00 EDT
    const now = new Date("2026-05-16T02:00:00Z")
    const res = checkQuietHours("+12125551234", { now: () => now })
    assert.equal(res.blocked, true)
    assert.equal(res.state, "NY")
    assert.equal(res.localHour, 22)
    assert.equal(res.tz, "America/New_York")
  })

  it("allows at 12:00 ET (noon)", () => {
    // 2026-05-15T16:00:00Z = 12:00 EDT
    const now = new Date("2026-05-15T16:00:00Z")
    const res = checkQuietHours("+12125551234", { now: () => now })
    assert.equal(res.blocked, false)
    assert.equal(res.localHour, 12)
  })
})

describe("checkQuietHours — TX (CT)", () => {
  it("blocks at 07:30 CT", () => {
    // 2026-05-15T12:30:00Z = 07:30 CDT (UTC-5)
    const now = new Date("2026-05-15T12:30:00Z")
    const res = checkQuietHours("+12145551234", { now: () => now })
    assert.equal(res.blocked, true)
    assert.equal(res.state, "TX")
    assert.equal(res.localHour, 7)
    assert.equal(res.tz, "America/Chicago")
  })

  it("allows at 10:00 CT", () => {
    const now = new Date("2026-05-15T15:00:00Z")
    const res = checkQuietHours("+12145551234", { now: () => now })
    assert.equal(res.blocked, false)
    assert.equal(res.localHour, 10)
  })
})

describe("checkQuietHours — IL (CT)", () => {
  it("blocks at 23:00 CT", () => {
    // 2026-05-16T04:00:00Z = 23:00 CDT
    const now = new Date("2026-05-16T04:00:00Z")
    const res = checkQuietHours("+13125551234", { now: () => now })
    assert.equal(res.blocked, true)
    assert.equal(res.state, "IL")
    assert.equal(res.localHour, 23)
  })
})

describe("checkQuietHours — FL (ET)", () => {
  it("blocks at 21:00 ET", () => {
    // 2026-05-16T01:00:00Z = 21:00 EDT
    const now = new Date("2026-05-16T01:00:00Z")
    const res = checkQuietHours("+13055551234", { now: () => now })
    assert.equal(res.blocked, true)
    assert.equal(res.state, "FL")
    assert.equal(res.localHour, 21)
  })
})

describe("checkQuietHours — unknown / non-US", () => {
  it("allows unknown US area code (state=unknown)", () => {
    const now = new Date("2026-05-16T06:00:00Z") // would be quiet hours anywhere US
    const res = checkQuietHours("+10005551234", { now: () => now })
    assert.equal(res.blocked, false)
    assert.equal(res.state, "unknown")
    assert.equal(res.localHour, -1)
    assert.equal(res.tz, "")
  })

  it("allows non-US numbers (state=non_us)", () => {
    const now = new Date("2026-05-16T06:00:00Z")
    const res = checkQuietHours("+447911123456", { now: () => now })
    assert.equal(res.blocked, false)
    assert.equal(res.state, "non_us")
    assert.equal(res.tz, "")
  })

  it("allows malformed phone (state=non_us, no +1 prefix)", () => {
    const res = checkQuietHours("4155551234", { now: () => new Date("2026-05-16T06:00:00Z") })
    assert.equal(res.blocked, false)
    assert.equal(res.state, "non_us")
  })
})
