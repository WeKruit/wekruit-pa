import assert from "node:assert/strict"
import test from "node:test"
import {
  __resetSendblueBreakerForTests,
  getSendblueBreakerState,
  recordSendblueFailure,
  recordSendblueSuccess,
} from "../circuit-breaker.js"

test("breaker starts CLOSED", () => {
  __resetSendblueBreakerForTests()
  assert.equal(getSendblueBreakerState(), "CLOSED")
})

test("4 failures stay CLOSED, 5th opens", () => {
  __resetSendblueBreakerForTests()
  for (let i = 0; i < 4; i++) recordSendblueFailure()
  assert.equal(getSendblueBreakerState(), "CLOSED")
  recordSendblueFailure()
  assert.equal(getSendblueBreakerState(), "OPEN")
})

test("success resets failure count", () => {
  __resetSendblueBreakerForTests()
  for (let i = 0; i < 4; i++) recordSendblueFailure()
  recordSendblueSuccess()
  for (let i = 0; i < 4; i++) recordSendblueFailure()
  assert.equal(getSendblueBreakerState(), "CLOSED")
})

test("OPEN transitions to HALF_OPEN after 60s", () => {
  __resetSendblueBreakerForTests()
  const opened = 1_000_000
  for (let i = 0; i < 5; i++) recordSendblueFailure("sendblue", opened)
  assert.equal(getSendblueBreakerState("sendblue", opened + 30_000), "OPEN")
  assert.equal(getSendblueBreakerState("sendblue", opened + 59_999), "OPEN")
  assert.equal(getSendblueBreakerState("sendblue", opened + 60_000), "HALF_OPEN")
})

test("recordSuccess in HALF_OPEN closes breaker", () => {
  __resetSendblueBreakerForTests()
  for (let i = 0; i < 5; i++) recordSendblueFailure()
  recordSendblueSuccess()
  assert.equal(getSendblueBreakerState(), "CLOSED")
})

test("named keys are independent", () => {
  __resetSendblueBreakerForTests()
  for (let i = 0; i < 5; i++) recordSendblueFailure("sendblue-typing")
  assert.equal(getSendblueBreakerState("sendblue-typing"), "OPEN")
  assert.equal(getSendblueBreakerState("sendblue"), "CLOSED")
})
