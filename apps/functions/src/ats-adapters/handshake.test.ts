/**
 * v1.9 Phase 86 — Handshake adapter tests.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { handshakeAdapter } from "./handshake.js"
import { getAdapter } from "./index.js"

describe("handshakeAdapter.parse — happy path", () => {
  it("parses full payload", () => {
    const r = handshakeAdapter.parse({
      event: "application.submitted",
      data: {
        applicant_id: "hs_app_1",
        job_id: "hs_job_1",
        candidate: {
          first_name: "Alex",
          last_name: "Lee",
          email: "ALEX@SCHOOL.EDU",
          phone: "+14155550199",
        },
        resume_url: "https://handshake.app/r/abc.pdf",
      },
      ts: "2026-05-12T10:00:00Z",
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.applicant.applicantId, "hs_app_1")
    assert.equal(r.applicant.jobIdExternal, "hs_job_1")
    assert.equal(r.applicant.email, "alex@school.edu")
    assert.equal(r.applicant.name, "Alex Lee")
    assert.equal(r.applicant.phone, "+14155550199")
    assert.equal(r.applicant.source, "handshake")
  })
  it("derives name from email when first/last missing", () => {
    const r = handshakeAdapter.parse({
      event: "application.submitted",
      data: {
        applicant_id: "x",
        job_id: "y",
        candidate: { email: "noname@x.com" },
      },
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.applicant.name, "noname")
  })
})

describe("handshakeAdapter.parse — failures", () => {
  it("rejects unsupported event", () => {
    const r = handshakeAdapter.parse({ event: "application.withdrawn", data: {} })
    assert.equal(r.ok, false)
  })
  it("rejects missing applicant_id", () => {
    const r = handshakeAdapter.parse({
      event: "application.submitted",
      data: { job_id: "j", candidate: { email: "e@x.com" } },
    })
    assert.equal(r.ok, false)
  })
  it("rejects missing email", () => {
    const r = handshakeAdapter.parse({
      event: "application.submitted",
      data: { applicant_id: "a", job_id: "j", candidate: {} },
    })
    assert.equal(r.ok, false)
  })
  it("rejects non-object", () => {
    assert.equal(handshakeAdapter.parse(null).ok, false)
    assert.equal(handshakeAdapter.parse("string").ok, false)
    assert.equal(handshakeAdapter.parse(42).ok, false)
  })
})

describe("getAdapter registry", () => {
  it("returns handshake (implemented)", () => {
    const a = getAdapter("handshake")
    assert.ok(a)
    assert.equal(a?.implemented, true)
  })
  it("returns stubs for GH/Lever/LinkedIn (not implemented)", () => {
    assert.equal(getAdapter("greenhouse")?.implemented, false)
    assert.equal(getAdapter("lever")?.implemented, false)
    assert.equal(getAdapter("linkedin")?.implemented, false)
  })
  it("returns null for unknown source", () => {
    assert.equal(getAdapter("workday"), null)
    assert.equal(getAdapter(""), null)
  })
})
