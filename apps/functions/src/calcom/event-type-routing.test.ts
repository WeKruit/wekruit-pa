import assert from "node:assert/strict"
import test from "node:test"

import { DEFAULT_EVENT_TYPE_ID, ROLE_FUNCTION_EVENT_TYPE, resolveEventTypeId } from "./event-type-routing.js"

test("job override beats everything", () => {
  const r = resolveEventTypeId({
    jobOverrideEventTypeId: 12345,
    roleFunctions: ["software_engineering"],
  })
  assert.deepEqual(r, { eventTypeId: 12345, source: "job_override" })
})

test("invalid override (0 / negative / non-int) falls through to roleFunction", () => {
  assert.equal(resolveEventTypeId({ jobOverrideEventTypeId: 0, roleFunctions: ["software_engineering"] }).source, "role_function")
  assert.equal(resolveEventTypeId({ jobOverrideEventTypeId: -1, roleFunctions: ["software_engineering"] }).source, "role_function")
  assert.equal(resolveEventTypeId({ jobOverrideEventTypeId: 1.5, roleFunctions: ["software_engineering"] }).source, "role_function")
})

test("software_engineering maps to 5847961", () => {
  const r = resolveEventTypeId({ roleFunctions: ["software_engineering"] })
  assert.deepEqual(r, { eventTypeId: 5847961, source: "role_function" })
  assert.equal(ROLE_FUNCTION_EVENT_TYPE.software_engineering, 5847961)
})

test("creatives_and_design maps to 5604544", () => {
  const r = resolveEventTypeId({ roleFunctions: ["creatives_and_design"] })
  assert.deepEqual(r, { eventTypeId: 5604544, source: "role_function" })
})

test("sales maps to 5180826 (GTM)", () => {
  const r = resolveEventTypeId({ roleFunctions: ["sales"] })
  assert.deepEqual(r, { eventTypeId: 5180826, source: "role_function" })
})

test("first mapped token wins when multiple roleFunctions present", () => {
  // unmapped first, then a mapped one — the mapped one wins.
  const r = resolveEventTypeId({ roleFunctions: ["legal_and_compliance", "software_engineering"] })
  assert.deepEqual(r, { eventTypeId: 5847961, source: "role_function" })
})

test("roleFunction matching is case-insensitive", () => {
  const r = resolveEventTypeId({ roleFunctions: ["Software_Engineering"] })
  assert.equal(r.eventTypeId, 5847961)
})

test("unmapped roleFunctions → neutral interview default (NOT the demo type)", () => {
  const r = resolveEventTypeId({ roleFunctions: ["legal_and_compliance"] })
  assert.deepEqual(r, { eventTypeId: DEFAULT_EVENT_TYPE_ID, source: "default" })
  // Neutral interview default = 5847961 ("Software Engineer Interview"), a real
  // interview type — NOT the "WeKruit Demo" type (4508818).
  assert.equal(DEFAULT_EVENT_TYPE_ID, 5847961)
  assert.notEqual(DEFAULT_EVENT_TYPE_ID, 4508818)
})

test("empty / null roleFunctions → neutral interview default", () => {
  assert.deepEqual(resolveEventTypeId({ roleFunctions: [] }), { eventTypeId: DEFAULT_EVENT_TYPE_ID, source: "default" })
  assert.deepEqual(resolveEventTypeId({ roleFunctions: null }), { eventTypeId: DEFAULT_EVENT_TYPE_ID, source: "default" })
  assert.deepEqual(resolveEventTypeId({}), { eventTypeId: DEFAULT_EVENT_TYPE_ID, source: "default" })
})
