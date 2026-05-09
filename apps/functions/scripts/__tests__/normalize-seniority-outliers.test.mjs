/**
 * v1.8 P7-H — Tests for normalize-seniority-outliers.mjs.
 *
 * Coverage:
 *   - planDoc: every mode branch (skip-canonical / skip-empty / skip-no-mapping / rewrite)
 *   - planDoc: "New Grad, Entry Level" → entry_level (the live outlier)
 *   - planDoc: "Entry Level" → entry_level (the other live outlier)
 *   - planDoc: title-infer fallback when canonical map can't resolve
 *   - planDoc: case-mismatched canonical (e.g. "Senior") goes via canonical-map source
 *   - buildUpdate: rejects non-rewrite modes (defensive)
 *   - buildUpdate: writes seniorityLevel + audit trail (from + source + timestamp)
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  planDoc,
  buildUpdate,
} from "../normalize-seniority-outliers.mjs"

// ─── planDoc: skip-empty / skip-canonical ─────────────────────────────────

test("planDoc: missing seniorityLevel → skip-empty (out of scope)", () => {
  const r = planDoc({ roleTitle: "SWE" })
  assert.equal(r.mode, "skip-empty")
})

test("planDoc: empty string seniorityLevel → skip-empty", () => {
  const r = planDoc({ seniorityLevel: "" })
  assert.equal(r.mode, "skip-empty")
})

test("planDoc: whitespace-only seniorityLevel → skip-empty", () => {
  const r = planDoc({ seniorityLevel: "   " })
  assert.equal(r.mode, "skip-empty")
})

test("planDoc: already-canonical lowercase → skip-canonical", () => {
  for (const v of ["entry_level", "junior", "mid_level", "senior", "staff", "manager"]) {
    const r = planDoc({ seniorityLevel: v })
    assert.equal(r.mode, "skip-canonical", `${v} should pass through`)
    assert.equal(r.existing, v)
  }
})

// ─── planDoc: rewrite branches (the actual bugfix) ─────────────────────────

test("planDoc: 'New Grad, Entry Level' → entry_level (live outlier #1)", () => {
  const r = planDoc({ seniorityLevel: "New Grad, Entry Level", roleTitle: "Software Engineer" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.from, "New Grad, Entry Level")
  assert.equal(r.to, "entry_level")
  assert.equal(r.source, "canonical-map")
})

test("planDoc: 'Entry Level' → entry_level (live outlier #2)", () => {
  const r = planDoc({ seniorityLevel: "Entry Level", roleTitle: "Backend Engineer" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.to, "entry_level")
  assert.equal(r.source, "canonical-map")
})

test("planDoc: case mismatch 'Senior' → senior via canonical-map (lowercase)", () => {
  const r = planDoc({ seniorityLevel: "Senior", roleTitle: "Senior Engineer" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.to, "senior")
  assert.equal(r.source, "canonical-map")
})

test("planDoc: 'ENTRY_LEVEL' uppercase canonical → rewrite to lowercase", () => {
  const r = planDoc({ seniorityLevel: "ENTRY_LEVEL" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.to, "entry_level")
})

test("planDoc: comma-separated 'Senior, Lead' → senior", () => {
  const r = planDoc({ seniorityLevel: "Senior, Lead" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.to, "senior")
})

test("planDoc: bare alias 'Lead' → manager", () => {
  const r = planDoc({ seniorityLevel: "Lead" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.to, "manager")
})

test("planDoc: bare alias 'Founder' → founder (canonical)", () => {
  const r = planDoc({ seniorityLevel: "Founder" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.to, "founder")
})

// ─── planDoc: title-infer fallback ─────────────────────────────────────────

test("planDoc: unknown raw + roleTitle present → title-infer fallback", () => {
  const r = planDoc({ seniorityLevel: "Galactic Overlord", roleTitle: "VP of Engineering" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.to, "vp")
  assert.equal(r.source, "title-infer")
})

test("planDoc: unknown raw + plain title falls back to mid_level via inferSeniority", () => {
  const r = planDoc({ seniorityLevel: "weird value", roleTitle: "Software Engineer" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.to, "mid_level") // inferSeniority default
  assert.equal(r.source, "title-infer")
})

test("planDoc: title fallback uses jobTitle field", () => {
  const r = planDoc({ seniorityLevel: "junk", jobTitle: "Director of Sales" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.to, "director")
  assert.equal(r.source, "title-infer")
})

// ─── planDoc: skip-no-mapping (terminal) ───────────────────────────────────

test("planDoc: unknown raw + no title → skip-no-mapping", () => {
  const r = planDoc({ seniorityLevel: "Galactic Overlord" })
  assert.equal(r.mode, "skip-no-mapping")
  assert.equal(r.existing, "Galactic Overlord")
})

test("planDoc: unknown raw + empty title → skip-no-mapping", () => {
  const r = planDoc({ seniorityLevel: "weird", roleTitle: "" })
  assert.equal(r.mode, "skip-no-mapping")
})

// ─── buildUpdate ───────────────────────────────────────────────────────────

test("buildUpdate: rewrite plan produces seniorityLevel + audit trail", () => {
  const upd = buildUpdate({ mode: "rewrite", from: "Entry Level", to: "entry_level", source: "canonical-map" })
  assert.equal(upd.seniorityLevel, "entry_level")
  assert.equal(upd.seniorityNormalizedFrom, "Entry Level")
  assert.equal(upd.seniorityNormalizedSource, "canonical-map")
  assert.match(upd.seniorityNormalizedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
})

test("buildUpdate: throws on non-rewrite plan (defensive)", () => {
  assert.throws(() => buildUpdate({ mode: "skip-canonical" }), /non-rewrite/)
  assert.throws(() => buildUpdate({ mode: "skip-empty" }), /non-rewrite/)
  assert.throws(() => buildUpdate({ mode: "skip-no-mapping" }), /non-rewrite/)
})

// ─── Idempotency end-to-end ────────────────────────────────────────────────

test("planDoc + buildUpdate is idempotent: re-running on canonicalized doc yields skip-canonical", () => {
  const docBefore = { seniorityLevel: "New Grad, Entry Level" }
  const plan1 = planDoc(docBefore)
  assert.equal(plan1.mode, "rewrite")
  const upd = buildUpdate(plan1)
  // Simulate the doc post-write
  const docAfter = { seniorityLevel: upd.seniorityLevel }
  const plan2 = planDoc(docAfter)
  assert.equal(plan2.mode, "skip-canonical")
})
