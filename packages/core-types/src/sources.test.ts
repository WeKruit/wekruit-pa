import assert from "node:assert/strict"
import test from "node:test"

import { PA_USER_SOURCES, PaUserSourceSchema, isPaUserSource } from "./sources.js"

test("PA_USER_SOURCES contains the closed referral-partner enum", () => {
  assert.equal(PA_USER_SOURCES.length, 10, "expected 10 sources including layoffhedge + qr_imessage + yc_startup_school")
  assert.ok(PA_USER_SOURCES.includes("layoffhedge"))
  assert.ok(PA_USER_SOURCES.includes("qr_imessage"))
})

test("PaUserSourceSchema accepts layoffhedge", () => {
  assert.equal(PaUserSourceSchema.parse("layoffhedge"), "layoffhedge")
})

test("PaUserSourceSchema rejects unknown values", () => {
  assert.throws(() => PaUserSourceSchema.parse("layoffheaven"))
})

test("isPaUserSource recognizes every literal in the tuple", () => {
  for (const v of PA_USER_SOURCES) {
    assert.equal(isPaUserSource(v), true, `expected ${v} to be a PaUserSource`)
  }
  assert.equal(isPaUserSource("layoffhedge"), true)
  assert.equal(isPaUserSource(""), false)
  assert.equal(isPaUserSource(undefined), false)
})
