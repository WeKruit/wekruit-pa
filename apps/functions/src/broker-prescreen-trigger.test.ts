/**
 * broker-prescreen-trigger.test.ts — start-token routing decision.
 *
 * Pins the brand-corruption-tolerant matcher (2026-06-16 live incident
 * +16263623119 / Tim Deng): iMessage autocorrect mangled the literal "WeKruit"
 * brand word in a start token whose bind code was VALID + unused, so the exact
 * matcher missed → cold opener → duplicate empty account + dead silence.
 *
 *   1. Correctly-spelled JOB-ONLY token → phone-is-auth authorized start.
 *   2. Correctly-spelled JOB+UID token → self-identity gate (authorized/unauthorized).
 *   3. Correctly-spelled JOB+BIND-CODE token → phone-is-auth authorized start.
 *   4. BRAND-CORRUPTED token + VALID bind code → phone-is-auth authorized start.
 *   5. BRAND-CORRUPTED token + non-bind-code segment → garbled_token (typo-ask), NOT a start.
 *   6. Plain chat → not_trigger.
 *
 * Run: node --import tsx --test apps/functions/src/broker-prescreen-trigger.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  decideBrokerPrescreenTrigger,
  BROKER_PRESCREEN_GARBLED_TOKEN_NOTICE,
} from "./broker-prescreen-trigger.js"

const RESOLVED = "user-resolved-via-phone"

test("correctly-spelled JOB-ONLY token → phone-is-auth authorized start", () => {
  const d = decideBrokerPrescreenTrigger("WeKruit_photon-macos-devops_Job", RESOLVED)
  assert.deepEqual(d, { kind: "authorized", jobId: "photon-macos-devops", userId: RESOLVED })
})

test("correctly-spelled JOB+UID token → self-identity gate", () => {
  // Self → authorized.
  assert.deepEqual(
    decideBrokerPrescreenTrigger(`WeKruit_photon-macos-devops_${RESOLVED}_Job`, RESOLVED),
    { kind: "authorized", jobId: "photon-macos-devops", userId: RESOLVED },
  )
  // Someone else's uid → unauthorized (no impersonation).
  assert.deepEqual(
    decideBrokerPrescreenTrigger("WeKruit_photon-macos-devops_other-user_Job", RESOLVED),
    { kind: "unauthorized", jobId: "photon-macos-devops", targetUserId: "other-user", reason: "not_self" },
  )
})

test("correctly-spelled JOB+BIND-CODE token → phone-is-auth authorized start (bind already attributed upstream)", () => {
  const d = decideBrokerPrescreenTrigger(
    "WeKruit_hs-10996795-invoko-product-manager_ABCDEF23_Job",
    RESOLVED,
  )
  assert.deepEqual(d, {
    kind: "authorized",
    jobId: "hs-10996795-invoko-product-manager",
    userId: RESOLVED,
  })
})

test("BRAND-CORRUPTED token + VALID bind code → authorized start, exactly like the correct token (incident fix)", () => {
  // Live incident shape: "WeKeuit_<job>_Z8SRWFQZ_Job".
  const d = decideBrokerPrescreenTrigger(
    "WeKeuit_wekruit-software-engineer-new-grad_Z8SRWFQZ_Job",
    RESOLVED,
  )
  assert.deepEqual(d, {
    kind: "authorized",
    jobId: "wekruit-software-engineer-new-grad",
    userId: RESOLVED,
  })
  // Other autocorrect corruptions of the brand word, gated by a valid code.
  assert.deepEqual(
    decideBrokerPrescreenTrigger("WeCruit_photon-macos-devops_ABCDEF23_Job", RESOLVED),
    { kind: "authorized", jobId: "photon-macos-devops", userId: RESOLVED },
  )
})

test("BRAND-CORRUPTED token + non-bind-code segment → garbled_token (typo-ask), never a start", () => {
  // A 20-char raw push-id uid on a corrupted brand must NOT bind via the tolerant
  // path — it is token-ish but unresolvable → ask about a typo.
  assert.deepEqual(
    decideBrokerPrescreenTrigger("WeKeuit_photon-macos-devops_aBcD1eFgH2iJkLmNoPqR_Job", RESOLVED),
    { kind: "garbled_token" },
  )
  // A segment with an EXCLUDED glyph (O) is not a valid bind code.
  assert.deepEqual(
    decideBrokerPrescreenTrigger("WeKeuit_photon-macos-devops_ABCD234O_Job", RESOLVED),
    { kind: "garbled_token" },
  )
  // Codeless corrupted token is also token-ish but unresolvable.
  assert.deepEqual(
    decideBrokerPrescreenTrigger("WeKeuit_photon-macos-devops_Job", RESOLVED),
    { kind: "garbled_token" },
  )
})

test("plain chat → not_trigger", () => {
  assert.deepEqual(
    decideBrokerPrescreenTrigger("hi claire, i'm looking for a job", RESOLVED),
    { kind: "not_trigger" },
  )
  assert.deepEqual(decideBrokerPrescreenTrigger("hey!", RESOLVED), { kind: "not_trigger" })
})

test("the garbled-token typo-ask notice is warm, deterministic, and asks for the exact link", () => {
  assert.match(BROKER_PRESCREEN_GARBLED_TOKEN_NOTICE, /didn't go through/i)
  assert.match(BROKER_PRESCREEN_GARBLED_TOKEN_NOTICE, /resend the exact link/i)
})
