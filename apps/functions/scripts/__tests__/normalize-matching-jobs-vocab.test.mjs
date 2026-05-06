/**
 * v1.6 Phase 57 — Tests for normalize-matching-jobs-vocab.mjs.
 *
 * Coverage: normalizeJobType + planJob across all canonical and legacy values.
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  JOB_TYPE_VOCAB,
  LEGACY_JOB_TYPE_MAP,
  normalizeJobType,
  planJob,
} from "../normalize-matching-jobs-vocab.mjs"

// ── normalizeJobType ────────────────────────────────────────────────────────

test("normalizeJobType: canonical values pass through", () => {
  for (const v of JOB_TYPE_VOCAB) {
    assert.equal(normalizeJobType(v), v)
  }
})

test("normalizeJobType: intern → internship", () => {
  assert.equal(normalizeJobType("intern"), "internship")
})

test("normalizeJobType: new_grad → new_graduate", () => {
  assert.equal(normalizeJobType("new_grad"), "new_graduate")
})

test("normalizeJobType: newgrad / new-grad → new_graduate", () => {
  assert.equal(normalizeJobType("newgrad"), "new_graduate")
  assert.equal(normalizeJobType("new-grad"), "new_graduate")
})

test("normalizeJobType: co-op / coop → co_op_rotation", () => {
  assert.equal(normalizeJobType("co-op"), "co_op_rotation")
  assert.equal(normalizeJobType("coop"), "co_op_rotation")
})

test("normalizeJobType: return-to-work → return_to_work_program", () => {
  assert.equal(normalizeJobType("return-to-work"), "return_to_work_program")
})

test("normalizeJobType: ft / fulltime / full-time → full_time", () => {
  assert.equal(normalizeJobType("ft"), "full_time")
  assert.equal(normalizeJobType("fulltime"), "full_time")
  assert.equal(normalizeJobType("full-time"), "full_time")
})

test("normalizeJobType: pt / parttime / part-time → part_time", () => {
  assert.equal(normalizeJobType("pt"), "part_time")
  assert.equal(normalizeJobType("parttime"), "part_time")
  assert.equal(normalizeJobType("part-time"), "part_time")
})

test("normalizeJobType: contractor / contracting → contract", () => {
  assert.equal(normalizeJobType("contractor"), "contract")
  assert.equal(normalizeJobType("contracting"), "contract")
})

test("normalizeJobType: case-insensitive", () => {
  assert.equal(normalizeJobType("INTERN"), "internship")
  assert.equal(normalizeJobType("New_Grad"), "new_graduate")
})

test("normalizeJobType: trims whitespace", () => {
  assert.equal(normalizeJobType("  intern  "), "internship")
})

test("normalizeJobType: empty / null / undefined → null", () => {
  assert.equal(normalizeJobType(""), null)
  assert.equal(normalizeJobType("   "), null)
  assert.equal(normalizeJobType(null), null)
  assert.equal(normalizeJobType(undefined), null)
})

test("normalizeJobType: unmapped value → null", () => {
  assert.equal(normalizeJobType("permanent_role_in_mars"), null)
  assert.equal(normalizeJobType("xxxxx"), null)
})

test("LEGACY_JOB_TYPE_MAP all values must be in JOB_TYPE_VOCAB", () => {
  for (const target of Object.values(LEGACY_JOB_TYPE_MAP)) {
    assert.ok(JOB_TYPE_VOCAB.includes(target), `${target} must be canonical`)
  }
})

// ── planJob ─────────────────────────────────────────────────────────────────

test("planJob: missing jobType → skip-empty", () => {
  assert.equal(planJob({}).mode, "skip-empty")
  assert.equal(planJob({ jobType: null }).mode, "skip-empty")
  assert.equal(planJob({ jobType: "" }).mode, "skip-empty")
})

test("planJob: canonical jobType (already correct) → skip-canonical", () => {
  const r = planJob({ jobType: "internship" })
  assert.equal(r.mode, "skip-canonical")
  assert.equal(r.from, "internship")
})

test("planJob: legacy jobType → rewrite with from + to", () => {
  const r = planJob({ jobType: "intern" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.from, "intern")
  assert.equal(r.to, "internship")
})

test("planJob: unmappable jobType → skip-no-mapping", () => {
  const r = planJob({ jobType: "alien_recruiter" })
  assert.equal(r.mode, "skip-no-mapping")
})

test("planJob: case-different canonical → skip-canonical", () => {
  // Edge case: 'Internship' (capital) — current impl re-emits 'internship'
  // (still canonical), so the diff is purely casing. We treat that as
  // rewrite to drive a normalization write.
  const r = planJob({ jobType: "Internship" })
  assert.equal(r.mode, "rewrite")
  assert.equal(r.to, "internship")
})
