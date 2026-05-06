/**
 * v1.6 Phase 57 — Tests for backfill-seniority-level.mjs.
 *
 * Coverage: inferSeniority + planJob across all canonical mappings + edge cases.
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  SENIORITY_LEVEL_VOCAB,
  SENIORITY_DEFAULT,
  inferSeniority,
  planJob,
  canonicalizeSeniorityLevel,
} from "../backfill-seniority-level.mjs"

// ── inferSeniority ──────────────────────────────────────────────────────────

test("inferSeniority: empty / null / undefined → null", () => {
  assert.equal(inferSeniority(""), null)
  assert.equal(inferSeniority("   "), null)
  assert.equal(inferSeniority(null), null)
  assert.equal(inferSeniority(undefined), null)
})

test("inferSeniority: intern / internship / co-op → intern", () => {
  assert.equal(inferSeniority("Software Engineer Intern"), "intern")
  assert.equal(inferSeniority("Summer 2026 Internship"), "intern")
  assert.equal(inferSeniority("Co-op Software Engineer"), "intern")
  assert.equal(inferSeniority("CoOp Engineer"), "intern")
})

test("inferSeniority: new grad / entry-level / early career → entry_level", () => {
  assert.equal(inferSeniority("New Grad Software Engineer"), "entry_level")
  assert.equal(inferSeniority("New Graduate Engineer 2026"), "entry_level")
  assert.equal(inferSeniority("Entry Level Backend Engineer"), "entry_level")
  assert.equal(inferSeniority("Entry-Level Data Analyst"), "entry_level")
  assert.equal(inferSeniority("Early Career Software Engineer"), "entry_level")
})

test("inferSeniority: junior / jr → junior", () => {
  assert.equal(inferSeniority("Junior Software Engineer"), "junior")
  assert.equal(inferSeniority("Jr. Engineer"), "junior")
  assert.equal(inferSeniority("Jr Developer"), "junior")
})

test("inferSeniority: senior / sr. → senior", () => {
  assert.equal(inferSeniority("Senior Software Engineer"), "senior")
  assert.equal(inferSeniority("Sr. Data Analyst"), "senior")
  assert.equal(inferSeniority("Sr Backend Engineer"), "senior")
})

test("inferSeniority: staff → staff", () => {
  assert.equal(inferSeniority("Staff Software Engineer"), "staff")
  assert.equal(inferSeniority("Staff Backend Engineer"), "staff")
})

test("inferSeniority: principal → principal", () => {
  assert.equal(inferSeniority("Principal Engineer"), "principal")
  assert.equal(inferSeniority("Principal Architect"), "principal")
})

test("inferSeniority: vp / vice president → vp", () => {
  assert.equal(inferSeniority("VP of Engineering"), "vp")
  assert.equal(inferSeniority("Vice President, Sales"), "vp")
})

test("inferSeniority: cto / ceo / cfo → c_level", () => {
  assert.equal(inferSeniority("CTO"), "c_level")
  assert.equal(inferSeniority("CEO"), "c_level")
  assert.equal(inferSeniority("CFO"), "c_level")
})

test("inferSeniority: chief X officer → c_level", () => {
  assert.equal(inferSeniority("Chief Technology Officer"), "c_level")
  assert.equal(inferSeniority("Chief People Officer"), "c_level")
})

test("inferSeniority: director / head of → director", () => {
  assert.equal(inferSeniority("Director of Engineering"), "director")
  assert.equal(inferSeniority("Head of Product"), "director")
})

test("inferSeniority: manager / lead → manager", () => {
  assert.equal(inferSeniority("Engineering Manager"), "manager")
  assert.equal(inferSeniority("Tech Lead"), "manager")
  assert.equal(inferSeniority("Engineering Lead"), "manager")
})

test("inferSeniority: bare 'Software Engineer' → mid_level (default)", () => {
  assert.equal(inferSeniority("Software Engineer"), SENIORITY_DEFAULT)
  assert.equal(inferSeniority("Backend Developer"), SENIORITY_DEFAULT)
  assert.equal(inferSeniority("Data Analyst"), SENIORITY_DEFAULT)
})

test("inferSeniority: priority — Senior Software Engineer Intern → intern (intern wins because higher priority)", () => {
  // Adam's spec: intern catch-all is checked AFTER staff/principal but
  // BEFORE senior/junior — so 'Intern' label wins even when prefix says 'Senior'.
  // (Internship student called 'senior' is unusual; we treat the role as intern.)
  assert.equal(inferSeniority("Senior Software Engineer Intern"), "intern")
})

test("inferSeniority: returns canonical TAG-06 token", () => {
  for (const sample of [
    "Senior Engineer",
    "Director of Sales",
    "Software Engineer",
    "VP Engineering",
  ]) {
    const out = inferSeniority(sample)
    assert.ok(SENIORITY_LEVEL_VOCAB.includes(out), `${out} must be canonical`)
  }
})

test("inferSeniority: case-insensitive", () => {
  assert.equal(inferSeniority("SENIOR ENGINEER"), "senior")
  assert.equal(inferSeniority("intern"), "intern")
})

// ── planJob ────────────────────────────────────────────────────────────────

test("planJob: missing roleTitle → skip-no-title", () => {
  assert.equal(planJob({}).mode, "skip-no-title")
  assert.equal(planJob({ roleTitle: "" }).mode, "skip-no-title")
})

test("planJob: existing seniorityLevel non-empty → skip-already-set", () => {
  const r = planJob({ seniorityLevel: "senior", roleTitle: "Senior Engineer" })
  assert.equal(r.mode, "skip-already-set")
  assert.equal(r.existing, "senior")
})

test("planJob: missing seniorityLevel + roleTitle present → rewrite", () => {
  const r = planJob({ roleTitle: "Senior Backend Engineer" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.from, null)
  assert.equal(r.to, "senior")
})

test("planJob: falls back to jobTitle / title fields", () => {
  const r1 = planJob({ jobTitle: "Director of Sales" })
  assert.equal(r1.mode, "rewrite")
  assert.equal(r1.to, "director")

  const r2 = planJob({ title: "VP Engineering" })
  assert.equal(r2.mode, "rewrite")
  assert.equal(r2.to, "vp")
})

test("planJob: untaggable plain title → defaults mid_level", () => {
  const r = planJob({ roleTitle: "Software Engineer" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.to, "mid_level")
})

// ── canonicalizeSeniorityLevel (Phase 68 / HYGIENE-02) ─────────────────────

test("canonicalizeSeniorityLevel: null/empty input → null", () => {
  assert.equal(canonicalizeSeniorityLevel(null), null)
  assert.equal(canonicalizeSeniorityLevel(undefined), null)
  assert.equal(canonicalizeSeniorityLevel(""), null)
  assert.equal(canonicalizeSeniorityLevel("   "), null)
})

test("canonicalizeSeniorityLevel: already-canonical lowercase passes through", () => {
  for (const v of SENIORITY_LEVEL_VOCAB) {
    assert.equal(canonicalizeSeniorityLevel(v), v)
  }
})

test("canonicalizeSeniorityLevel: case-insensitive canonical match", () => {
  assert.equal(canonicalizeSeniorityLevel("ENTRY_LEVEL"), "entry_level")
  assert.equal(canonicalizeSeniorityLevel("Senior"), "senior")
  assert.equal(canonicalizeSeniorityLevel("MID_LEVEL"), "mid_level")
})

test("canonicalizeSeniorityLevel: raw multi-word forms → canonical", () => {
  assert.equal(canonicalizeSeniorityLevel("Entry Level"), "entry_level")
  assert.equal(canonicalizeSeniorityLevel("Entry-Level"), "entry_level")
  assert.equal(canonicalizeSeniorityLevel("Mid Level"), "mid_level")
  assert.equal(canonicalizeSeniorityLevel("Mid-Level"), "mid_level")
  assert.equal(canonicalizeSeniorityLevel("New Grad"), "entry_level")
  assert.equal(canonicalizeSeniorityLevel("New Graduate"), "entry_level")
  assert.equal(canonicalizeSeniorityLevel("Early Career"), "entry_level")
  assert.equal(canonicalizeSeniorityLevel("Vice President"), "vp")
})

test("canonicalizeSeniorityLevel: comma-separated multi-tier degrades to lower tier", () => {
  // Phase 68 — broader window: prefer the more inclusive (lower) bucket so
  // candidates see more matches.
  assert.equal(canonicalizeSeniorityLevel("New Grad, Entry Level"), "entry_level")
  assert.equal(canonicalizeSeniorityLevel("Entry Level, New Grad"), "entry_level")
  assert.equal(canonicalizeSeniorityLevel("Entry, Mid Level"), "entry_level")
  assert.equal(canonicalizeSeniorityLevel("Entry Level, Mid Level"), "entry_level")
  assert.equal(canonicalizeSeniorityLevel("Mid Level, Senior"), "mid_level")
  assert.equal(canonicalizeSeniorityLevel("Senior, Mid Level"), "mid_level")
  assert.equal(canonicalizeSeniorityLevel("Senior, Lead"), "senior")
  assert.equal(canonicalizeSeniorityLevel("Senior, Staff"), "senior")
  assert.equal(canonicalizeSeniorityLevel("Manager, Lead"), "manager")
  assert.equal(canonicalizeSeniorityLevel("Director, Manager"), "manager")
  assert.equal(canonicalizeSeniorityLevel("Director, VP"), "director")
})

test("canonicalizeSeniorityLevel: bare aliases map to canonical buckets", () => {
  assert.equal(canonicalizeSeniorityLevel("Lead"), "manager")
  assert.equal(canonicalizeSeniorityLevel("Chief"), "c_level")
  assert.equal(canonicalizeSeniorityLevel("Founder"), "founder")
  assert.equal(canonicalizeSeniorityLevel("Associate"), "junior")
  assert.equal(canonicalizeSeniorityLevel("Internship"), "intern")
})

test("canonicalizeSeniorityLevel: unknown raw values → null (caller leaves alone)", () => {
  assert.equal(canonicalizeSeniorityLevel("Galactic Overlord"), null)
  assert.equal(canonicalizeSeniorityLevel("???"), null)
  assert.equal(canonicalizeSeniorityLevel("level 5"), null)
})

// ── planJob — Phase 68 canonicalization branch ─────────────────────────────

test("planJob: existing canonical lowercase → skip-already-set", () => {
  const r = planJob({ seniorityLevel: "senior", roleTitle: "Senior Engineer" })
  assert.equal(r.mode, "skip-already-set")
  assert.equal(r.existing, "senior")
})

test("planJob: existing canonical with case mismatch → rewrite-canonical (lowercase)", () => {
  const r = planJob({ seniorityLevel: "Senior", roleTitle: "Senior Engineer" })
  assert.equal(r.mode, "rewrite-canonical")
  assert.equal(r.from, "Senior")
  assert.equal(r.to, "senior")
})

test("planJob: existing raw 'Entry Level' → rewrite-canonical to entry_level", () => {
  const r = planJob({ seniorityLevel: "Entry Level", roleTitle: "New Grad SWE" })
  assert.equal(r.mode, "rewrite-canonical")
  assert.equal(r.from, "Entry Level")
  assert.equal(r.to, "entry_level")
})

test("planJob: existing raw 'New Grad, Entry Level' → entry_level", () => {
  const r = planJob({ seniorityLevel: "New Grad, Entry Level", roleTitle: "Engineer" })
  assert.equal(r.mode, "rewrite-canonical")
  assert.equal(r.to, "entry_level")
})

test("planJob: existing raw 'Senior, Lead' → senior", () => {
  const r = planJob({ seniorityLevel: "Senior, Lead", roleTitle: "Tech Lead" })
  assert.equal(r.mode, "rewrite-canonical")
  assert.equal(r.to, "senior")
})

test("planJob: existing raw unknown + roleTitle present → rewrites via inferSeniority fallback", () => {
  const r = planJob({ seniorityLevel: "Galactic Overlord", roleTitle: "Senior Engineer" })
  assert.equal(r.mode, "rewrite-canonical")
  assert.equal(r.to, "senior")
})

test("planJob: existing raw unknown + no useful title → skip-no-mapping", () => {
  const r = planJob({ seniorityLevel: "weird value xyz", roleTitle: "" })
  assert.equal(r.mode, "skip-no-mapping")
  assert.equal(r.existing, "weird value xyz")
})
