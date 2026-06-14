// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import test from "node:test"
import {
  buildClaireContinuationBody,
  buildClaireContinuationHref,
} from "./claire-continuation.js"

test("bound phone → plain sticky-thread deeplink (Hi Claire)", () => {
  const href = buildClaireContinuationHref({
    senderNumber: "+17174919939",
    candidateId: "cand-1",
    phoneVerified: true,
  })
  assert.equal(href, `sms:+17174919939?&body=${encodeURIComponent("Hi Claire")}`)
})

test("no bound phone → verification-code binding opener (same pa-users uid, never a stranger)", () => {
  const body = buildClaireContinuationBody({
    senderNumber: "+17174919939",
    candidateId: "cand-1",
    phoneVerified: false,
  })
  assert.equal(body, "Hi, WeKruit, my verification code is cand-1")
})

test("job context + bound phone + bindCode → token CARRIES the bind code (Adam-locked 2026-06-14: never mint job-only)", () => {
  const bound = buildClaireContinuationBody({
    senderNumber: "+17174919939",
    candidateId: "cand-1",
    bindCode: "ABCDEF23",
    phoneVerified: true,
    jobId: "hs-123-job",
  })
  assert.equal(bound, "WeKruit_hs-123-job_ABCDEF23_Job")
})

test("job context + bound phone, NO bindCode → degraded job-only fallback (phone-is-auth resolves inbound)", () => {
  const bound = buildClaireContinuationBody({
    senderNumber: "+17174919939",
    candidateId: "cand-1",
    phoneVerified: true,
    jobId: "hs-123-job",
  })
  // Only the degraded fallback (no code available) emits the bare job-only token.
  assert.equal(bound, "WeKruit_hs-123-job_Job")
})

test("job context + UNbound phone → binding opener (phone-is-auth needs a bound phone first; bind, then start)", () => {
  const unbound = buildClaireContinuationBody({
    senderNumber: "+17174919939",
    candidateId: "cand-1",
    phoneVerified: false,
    jobId: "hs-123-job",
  })
  assert.equal(unbound, "Hi, WeKruit, my verification code is cand-1")
})

test("no candidateId falls back to Hi Claire (cannot mint a binding token)", () => {
  assert.equal(
    buildClaireContinuationBody({ senderNumber: "+17174919939", phoneVerified: false }),
    "Hi Claire",
  )
})

test("invalid/missing sender number → null (caller surfaces a binding path)", () => {
  assert.equal(buildClaireContinuationHref({ phoneVerified: true, candidateId: "c" }), null)
  assert.equal(
    buildClaireContinuationHref({ senderNumber: "12", phoneVerified: true, candidateId: "c" }),
    null,
  )
})
