/**
 * Unit tests for `paMatchingJobsAutoEnrich` helpers.
 *
 * P64 sponsorship wiring (2026-05-08): trigger now runs `inferSponsorship`
 * after `enrichJobTags`. These tests lock in the gate-decision logic so a
 * regression that swallows sponsorship (the v1.7 → v1.8 bug we're fixing)
 * surfaces as a unit failure, not as a 5% Firestore coverage drop.
 *
 * The actual `onDocumentWritten` handler is not unit-tested here (it requires
 * a Firebase emulator); we lock the gate predicates that determine whether
 * the inference runs.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  needsEnrichment,
  needsSponsorshipInference,
} from "../auto-enrich-matching-jobs.js"

describe("paMatchingJobsAutoEnrich — needsEnrichment", () => {
  it("returns false when doc is undefined", () => {
    assert.equal(needsEnrichment(undefined), false)
  })

  it("returns false when status !== 'active'", () => {
    assert.equal(
      needsEnrichment({ status: "inactive", roleTitle: "x" }),
      false,
    )
  })

  it("returns false when enricherVersion + contentHash both match current", () => {
    const out = needsEnrichment({
      status: "active",
      roleTitle: "Senior Engineer",
      enricherVersion: "v1.9.0",
      enricherContentHash: "abc",
      contentHash: "abc",
    })
    assert.equal(out, false)
  })

  it("returns true when enricherVersion is stale (v1.8.1 → v1.9.0 bump)", () => {
    const out = needsEnrichment({
      status: "active",
      roleTitle: "Senior Engineer",
      enricherVersion: "v1.8.1",
      enricherContentHash: "abc",
      contentHash: "abc",
    })
    assert.equal(out, true)
  })

  it("returns false when roleTitle is missing/empty", () => {
    assert.equal(
      needsEnrichment({ status: "active", roleTitle: "" }),
      false,
    )
    assert.equal(
      needsEnrichment({ status: "active", roleTitle: null }),
      false,
    )
  })

  it("returns true on first enrichment (no enricherVersion stamped)", () => {
    const out = needsEnrichment({
      status: "active",
      roleTitle: "Software Engineer",
      contentHash: "x",
    })
    assert.equal(out, true)
  })
})

describe("paMatchingJobsAutoEnrich — needsSponsorshipInference (P64 wiring)", () => {
  it("returns false when sponsorship=true AND backfill stamped (idempotency)", () => {
    const out = needsSponsorshipInference({
      sponsorship: true,
      sponsorshipBackfilledAt: "2026-05-08T10:00:00.000Z",
    })
    assert.equal(out, false)
  })

  it("returns false when sponsorship=false AND backfill stamped", () => {
    const out = needsSponsorshipInference({
      sponsorship: false,
      sponsorshipBackfilledAt: "2026-05-08T10:00:00.000Z",
    })
    assert.equal(out, false)
  })

  it("returns true when sponsorship is null (re-attempt allowed)", () => {
    const out = needsSponsorshipInference({
      sponsorship: null,
      sponsorshipBackfilledAt: "2026-05-08T10:00:00.000Z",
    })
    assert.equal(out, true)
  })

  it("returns true when sponsorship is undefined (never inferred)", () => {
    const out = needsSponsorshipInference({})
    assert.equal(out, true)
  })

  it("returns true when sponsorship=true but no backfill stamp (legacy data)", () => {
    // Edge case: doc has `sponsorship: true` from upstream but no
    // sponsorshipBackfilledAt — we DO re-run inference to stamp the audit
    // field; the inference will likely confirm allowlist=true, and we
    // overwrite with the timestamp. Cost: ~$0 (allowlist hit).
    const out = needsSponsorshipInference({
      sponsorship: true,
    })
    assert.equal(out, true)
  })

  it("returns false on undefined doc (defensive)", () => {
    assert.equal(needsSponsorshipInference(undefined), false)
  })
})
