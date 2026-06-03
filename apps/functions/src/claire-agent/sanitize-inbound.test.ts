/**
 * sanitize-inbound.test.ts — guards the 2026-06-01 regression where the agent greeted the candidate
 * by their internal Firestore userId. Root cause: the id-bearing phone-bind handshake reached the
 * LLM verbatim, and with no displayName the model used the uid as the name. sanitizeInboundForLlm
 * must reduce the opener to the bare prefix (no id) while leaving the
 * "WeKruit_<jobId>_<userId>_Apply" job token and ordinary text untouched. Both opener phrasings are
 * covered: the current verification-code form and the legacy "Hello, WeKruit!" form (back-compat).
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import { sanitizeInboundForLlm } from "./agent.js"

const UID = "8fEwIduUrzxZsblHHsNz"
const VCODE_PREFIX = "Hi, WeKruit, my verification code is"

test("strips the candidateId from the verification-code phone-bind opener", () => {
  assert.equal(sanitizeInboundForLlm(`${VCODE_PREFIX} ${UID}`), "Hi, WeKruit!")
  // the internal id must NOT survive into the text handed to the LLM
  assert.ok(!sanitizeInboundForLlm(`${VCODE_PREFIX} ${UID}`).includes(UID))
})

test("strips the candidateId from the LEGACY Hello-WeKruit phone-bind opener (back-compat)", () => {
  assert.equal(sanitizeInboundForLlm(`Hello, WeKruit! ${UID}`), "Hello, WeKruit!")
  assert.ok(!sanitizeInboundForLlm(`Hello, WeKruit! ${UID}`).includes(UID))
})

test("tolerates leading whitespace before the opener", () => {
  assert.equal(sanitizeInboundForLlm(`   ${VCODE_PREFIX} ${UID}`), "Hi, WeKruit!")
  assert.equal(sanitizeInboundForLlm(`   Hello, WeKruit! ${UID}`), "Hello, WeKruit!")
})

test("leaves the bare opener (no id) unchanged", () => {
  assert.equal(sanitizeInboundForLlm(VCODE_PREFIX), "Hi, WeKruit!")
  assert.equal(sanitizeInboundForLlm("Hello, WeKruit!"), "Hello, WeKruit!")
})

test("passes the WeKruit_<jobId>_<userId>_Apply job token through untouched (prescreen kickoff)", () => {
  const token = `WeKruit_hs-11005382-invoko-product-designer_${UID}_Apply`
  assert.equal(sanitizeInboundForLlm(token), token)
})

test("passes ordinary candidate messages through untouched", () => {
  assert.equal(sanitizeInboundForLlm("hi"), "hi")
  assert.equal(sanitizeInboundForLlm("I want SWE roles in NYC"), "I want SWE roles in NYC")
})
