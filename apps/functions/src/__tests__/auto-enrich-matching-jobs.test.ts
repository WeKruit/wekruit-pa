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
  computeSemanticHash,
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

  it("returns false when enricherVersion + SEMANTIC hash match (already enriched, content unchanged)", () => {
    const doc = {
      status: "active",
      roleTitle: "Senior Engineer",
      companyName: "Acme",
      jobDescription: "Build things. React, TS.",
      enricherVersion: "v1.9.0",
    }
    const out = needsEnrichment({ ...doc, enricherSemanticHash: computeSemanticHash(doc) })
    assert.equal(out, false)
  })

  it("COST FIX: cosmetic title drift (emoji/case/punct) with SAME JD body → SKIP (no re-enrich)", () => {
    // The macmini re-scrape flips contentHash on cosmetic title changes; the
    // semantic gate must NOT re-enrich when the meaning is unchanged.
    const original = {
      status: "active",
      roleTitle: "Senior Engineer",
      companyName: "Acme",
      jobDescription: "Build things. React, TS.",
      enricherVersion: "v1.9.0",
    }
    const stamp = computeSemanticHash(original)
    // re-scrape rewrites title with emoji + different case/punct + new contentHash
    const reScraped = {
      ...original,
      roleTitle: "🚀 SENIOR  ENGINEER!!!",
      contentHash: "a-totally-different-churned-hash",
      enricherContentHash: "old-hash",
      enricherSemanticHash: stamp,
    }
    assert.equal(needsEnrichment(reScraped), false, "cosmetic-only drift must not re-enrich")
  })

  it("returns true when the JD BODY genuinely changes (semantic hash flips → re-enrich)", () => {
    const original = {
      status: "active",
      roleTitle: "Senior Engineer",
      companyName: "Acme",
      jobDescription: "Build things. React, TS.",
      enricherVersion: "v1.9.0",
    }
    const stamp = computeSemanticHash(original)
    const realChange = {
      ...original,
      jobDescription: "Now requires Rust, Kubernetes, and 5 years experience.",
      enricherSemanticHash: stamp,
    }
    assert.equal(needsEnrichment(realChange), true, "real JD-body change must re-enrich")
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

  it("returns true when sponsorship is null (re-attempt allowed) when no semantic stamp yet", () => {
    const out = needsSponsorshipInference({
      sponsorship: null,
      sponsorshipBackfilledAt: "2026-05-08T10:00:00.000Z",
    })
    assert.equal(out, true)
  })

  it("COST FIX: null-sponsorship cohort SKIPS when sponsorshipSemanticHash matches (no re-infer on re-scrape)", () => {
    const doc = {
      status: "active",
      roleTitle: "Senior Engineer",
      companyName: "Acme",
      jobDescription: "Build things.",
      sponsorship: null, // a prior NULL verdict — used to re-pay on every re-scrape
    }
    const out = needsSponsorshipInference({ ...doc, sponsorshipSemanticHash: computeSemanticHash(doc) })
    assert.equal(out, false, "already inferred (even null) for this content → must not re-infer")
  })

  it("re-infers when JD body changes even if a prior semantic stamp exists", () => {
    const doc = {
      status: "active",
      roleTitle: "Senior Engineer",
      companyName: "Acme",
      jobDescription: "Build things.",
      sponsorship: null,
    }
    const stamp = computeSemanticHash(doc)
    const changed = { ...doc, jobDescription: "We sponsor H1B visas.", sponsorshipSemanticHash: stamp }
    assert.equal(needsSponsorshipInference(changed), true, "new JD (sponsorship language) must re-infer")
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
