// @ts-nocheck - landing app tests run with node --test via tsx.
import assert from "node:assert/strict"
import test from "node:test"

import { CAREER_STAGE_ORDER, expandCareerStageRange } from "./career-stage-range.js"

// The editor's seniority range expansion MUST share ordering with the backend
// `collapseCareerStageRange` (CAREER_STAGE_VOCAB order) or a stored band is
// silently corrupted on the next save. These tests lock that order + boundary.

test("CAREER_STAGE_ORDER matches the canonical CAREER_STAGE_VOCAB order exactly", () => {
  // student BEFORE intern — the historical editor bug swapped indices 0/1.
  assert.deepEqual(CAREER_STAGE_ORDER, [
    "student",
    "intern",
    "entry_level",
    "junior",
    "mid_level",
    "senior",
    "staff",
    "principal",
    "manager",
    "director",
    "vp",
    "c_level",
    "founder",
  ])
})

test("expandCareerStageRange keeps the [intern, junior] band intact (no phantom student)", () => {
  // BUG REPRO (pre-fix): with intern/student swapped, [intern, junior] expanded
  // to [intern, student, entry_level, junior], auto-selecting student. With the
  // canonical order, intern(1)..junior(3) → exactly intern, entry_level, junior.
  const band = expandCareerStageRange(["intern", "junior"], CAREER_STAGE_ORDER)
  assert.deepEqual(band, ["intern", "entry_level", "junior"])
  assert.equal(band.includes("student"), false, "student is BELOW intern; it must not appear")
})

test("expandCareerStageRange includes intern inside a [student, senior] band", () => {
  // BUG REPRO (pre-fix): slicing in editor order omitted intern (editor idx 0)
  // for a student..senior band. Canonical order keeps it.
  const band = expandCareerStageRange(["student", "senior"], CAREER_STAGE_ORDER)
  assert.equal(band[0], "student")
  assert.equal(band.includes("intern"), true, "intern is inside student..senior and must be selected")
  assert.deepEqual(band, ["student", "intern", "entry_level", "junior", "mid_level", "senior"])
})

test("expandCareerStageRange yields a single chip for a single anchor and [] for off-vocab", () => {
  assert.deepEqual(expandCareerStageRange(["mid_level"], CAREER_STAGE_ORDER), ["mid_level"])
  assert.deepEqual(expandCareerStageRange(["not_a_real_stage"], CAREER_STAGE_ORDER), [])
})
