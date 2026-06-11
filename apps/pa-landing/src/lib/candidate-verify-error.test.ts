// @ts-nocheck - pure-module unit test; runs with node --test via tsx.
import assert from "node:assert/strict"
import test from "node:test"

import {
  CandidateVerifyError,
  shouldSignOutOnVerifyError,
} from "./candidate-verify-error.js"

// ── Auth-class failures: session itself is bad → sign out + bounce ──────────

test("signs out on email_not_verified", () => {
  assert.equal(
    shouldSignOutOnVerifyError(new CandidateVerifyError("email_not_verified", 200)),
    true,
  )
})

test("signs out on missing_verified_email", () => {
  assert.equal(
    shouldSignOutOnVerifyError(new CandidateVerifyError("missing_verified_email", 200)),
    true,
  )
})

test("signs out on not_signed_in", () => {
  assert.equal(
    shouldSignOutOnVerifyError(new CandidateVerifyError("not_signed_in", 401)),
    true,
  )
})

test("signs out on HTTP 401 regardless of reason", () => {
  assert.equal(
    shouldSignOutOnVerifyError(new CandidateVerifyError("verify_failed", 401)),
    true,
  )
})

test("signs out on HTTP 403 regardless of reason", () => {
  assert.equal(
    shouldSignOutOnVerifyError(new CandidateVerifyError("verify_failed", 403)),
    true,
  )
})

// ── Transient failures: keep the session, retry inline ──────────────────────

test("keeps session on 5xx verify_failed", () => {
  assert.equal(
    shouldSignOutOnVerifyError(new CandidateVerifyError("verify_failed", 500)),
    false,
  )
  assert.equal(
    shouldSignOutOnVerifyError(new CandidateVerifyError("verify_failed", 503)),
    false,
  )
})

test("keeps session on network failure (plain TypeError from fetch)", () => {
  assert.equal(shouldSignOutOnVerifyError(new TypeError("Failed to fetch")), false)
})

test("keeps session on generic Error and non-Error throwables", () => {
  assert.equal(shouldSignOutOnVerifyError(new Error("boom")), false)
  assert.equal(shouldSignOutOnVerifyError("boom"), false)
  assert.equal(shouldSignOutOnVerifyError(undefined), false)
})

test("keeps session on non-auth reason with a 4xx that is not 401/403", () => {
  assert.equal(
    shouldSignOutOnVerifyError(new CandidateVerifyError("verify_failed", 429)),
    false,
  )
})
