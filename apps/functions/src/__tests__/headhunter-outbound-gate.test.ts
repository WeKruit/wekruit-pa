/**
 * headhunterSendGateDecision(): the pure, first-line dev-phone gate for agent
 * outbound. Dev phones always allowed; everyone else blocked until the ramp flag
 * — the LOCKED "Claude sends DEV PHONES ONLY" rule, made unit-testable.
 */
import test from "node:test"
import assert from "node:assert/strict"

import { headhunterSendGateDecision } from "../headhunter-mcp/outbound.js"

test("dev phone (Adam) is allowed even without ramp", () => {
  const d = headhunterSendGateDecision({ phone: "+14243201960", rampAll: false })
  assert.equal(d.allowed, true)
  assert.equal(d.reason, "dev_phone")
})

test("dev phone (Noah) is allowed", () => {
  assert.equal(headhunterSendGateDecision({ phone: "+12154034668", rampAll: false }).allowed, true)
})

test("non-dev phone is BLOCKED when ramp is off", () => {
  const d = headhunterSendGateDecision({ phone: "+15551234567", rampAll: false })
  assert.equal(d.allowed, false)
  assert.equal(d.reason, "blocked_non_dev_phone")
})

test("non-dev phone is allowed ONLY when ramp is on", () => {
  assert.equal(headhunterSendGateDecision({ phone: "+15551234567", rampAll: true }).allowed, true)
})

test("missing phone is blocked regardless of ramp", () => {
  assert.equal(headhunterSendGateDecision({ phone: undefined, rampAll: true }).reason, "no_phone")
  assert.equal(headhunterSendGateDecision({ phone: "", rampAll: true }).allowed, false)
})

test("dev phone with surrounding whitespace/format still normalizes + allows", () => {
  assert.equal(headhunterSendGateDecision({ phone: " +1 (424) 320-1960 ", rampAll: false }).allowed, true)
})
