/**
 * v1.8 P7-H — Tests for backfill-empty-required-skills.mjs.
 *
 * Coverage:
 *   - planJob: every skip-reason branch + every JD-signal classification
 *   - planJob: includeTitleOnly flag toggles title-only docs in/out of scope
 *   - planJob: case-insensitive on enricherVersion (exact match required)
 *   - buildReenrichUpdate: clears enricherContentHash + stamps sentinel version
 *   - buildReenrichUpdate: idempotent shape (re-running yields same shape)
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  planJob,
  buildReenrichUpdate,
} from "../backfill-empty-required-skills.mjs"

const TARGET = "v1.8.1"

// ─── planJob: skip branches ───────────────────────────────────────────────

test("planJob: empty/null doc → not eligible (empty-doc)", () => {
  assert.deepEqual(planJob(null, { targetVersion: TARGET }), { eligible: false, reason: "empty-doc", jdSignal: "none" })
  assert.deepEqual(planJob(undefined, { targetVersion: TARGET }), { eligible: false, reason: "empty-doc", jdSignal: "none" })
})

test("planJob: status != active → not-active", () => {
  const r = planJob({ status: "inactive", roleTitle: "SWE", enricherVersion: TARGET, jobDescription: "x" }, { targetVersion: TARGET })
  assert.equal(r.eligible, false)
  assert.equal(r.reason, "not-active")
})

test("planJob: status missing → not-active", () => {
  const r = planJob({ roleTitle: "SWE", enricherVersion: TARGET }, { targetVersion: TARGET })
  assert.equal(r.eligible, false)
  assert.equal(r.reason, "not-active")
})

test("planJob: requiredSkills already populated → has-skills", () => {
  const r = planJob({
    status: "active", roleTitle: "SWE", enricherVersion: TARGET,
    requiredSkills: [{ name: "python" }],
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, false)
  assert.equal(r.reason, "has-skills")
})

test("planJob: enricherVersion stale → version-mismatch (force-reenrich's job)", () => {
  const r = planJob({
    status: "active", roleTitle: "SWE", enricherVersion: "v1.7.0",
    requiredSkills: [], jobDescription: "details",
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, false)
  assert.equal(r.reason, "version-mismatch")
})

test("planJob: enricherVersion missing entirely → version-mismatch", () => {
  const r = planJob({
    status: "active", roleTitle: "SWE", requiredSkills: [], jobDescription: "x",
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, false)
  assert.equal(r.reason, "version-mismatch")
})

test("planJob: missing roleTitle (and no jobTitle/title fallback) → no-title", () => {
  const r = planJob({
    status: "active", enricherVersion: TARGET, requiredSkills: [], jobDescription: "x",
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, false)
  assert.equal(r.reason, "no-title")
})

test("planJob: empty roleTitle string → no-title", () => {
  const r = planJob({
    status: "active", roleTitle: "   ", enricherVersion: TARGET, requiredSkills: [], jobDescription: "x",
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, false)
  assert.equal(r.reason, "no-title")
})

test("planJob: roleTitle fallback to jobTitle field", () => {
  const r = planJob({
    status: "active", jobTitle: "SWE", enricherVersion: TARGET, requiredSkills: [], jobDescription: "x",
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, true)
  assert.equal(r.jdSignal, "jd")
})

test("planJob: roleTitle fallback to title field", () => {
  const r = planJob({
    status: "active", title: "SWE", enricherVersion: TARGET, requiredSkills: [], jobDescription: "x",
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, true)
})

// ─── planJob: JD signal classification ────────────────────────────────────

test("planJob: jdSignal=jd when jobDescription has content", () => {
  const r = planJob({
    status: "active", roleTitle: "SWE", enricherVersion: TARGET, requiredSkills: [],
    jobDescription: "Build cool stuff with Python.",
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, true)
  assert.equal(r.jdSignal, "jd")
})

test("planJob: jdSignal=aux when only coreResponsibilities array populated", () => {
  const r = planJob({
    status: "active", roleTitle: "SWE", enricherVersion: TARGET, requiredSkills: [],
    coreResponsibilities: ["Write code", "Review PRs"],
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, true)
  assert.equal(r.jdSignal, "aux")
})

test("planJob: jdSignal=aux when only qualifications array populated", () => {
  const r = planJob({
    status: "active", roleTitle: "SWE", enricherVersion: TARGET, requiredSkills: [],
    qualifications: ["BS in CS", "3+ yrs Python"],
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, true)
  assert.equal(r.jdSignal, "aux")
})

test("planJob: jdSignal=aux when only benefits array populated", () => {
  const r = planJob({
    status: "active", roleTitle: "SWE", enricherVersion: TARGET, requiredSkills: [],
    benefits: ["health", "401k"],
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, true)
  assert.equal(r.jdSignal, "aux")
})

test("planJob: empty arrays do not count as aux signal", () => {
  const r = planJob({
    status: "active", roleTitle: "SWE", enricherVersion: TARGET, requiredSkills: [],
    coreResponsibilities: [], qualifications: [], benefits: [],
  }, { targetVersion: TARGET })
  // Empty aux + no JD → title only
  assert.equal(r.jdSignal, "title")
  assert.equal(r.eligible, false)
  assert.equal(r.reason, "no-jd-need-stage-2b")
})

test("planJob: title-only doc (no JD/aux) blocked by default", () => {
  const r = planJob({
    status: "active", roleTitle: "Senior SWE", enricherVersion: TARGET, requiredSkills: [],
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, false)
  assert.equal(r.reason, "no-jd-need-stage-2b")
  assert.equal(r.jdSignal, "title")
})

test("planJob: title-only doc allowed when includeTitleOnly=true", () => {
  const r = planJob({
    status: "active", roleTitle: "Senior SWE", enricherVersion: TARGET, requiredSkills: [],
  }, { targetVersion: TARGET, includeTitleOnly: true })
  assert.equal(r.eligible, true)
  assert.equal(r.jdSignal, "title")
})

test("planJob: requiredSkills missing field (not just empty array) is treated like empty", () => {
  const r = planJob({
    status: "active", roleTitle: "SWE", enricherVersion: TARGET,
    jobDescription: "details",
    // requiredSkills field absent
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, true)
})

test("planJob: requiredSkills as non-array (defensive) treated like empty", () => {
  const r = planJob({
    status: "active", roleTitle: "SWE", enricherVersion: TARGET,
    requiredSkills: null, jobDescription: "x",
  }, { targetVersion: TARGET })
  assert.equal(r.eligible, true)
})

test("planJob: jobDescription whitespace-only → no JD signal, falls to title", () => {
  const r = planJob({
    status: "active", roleTitle: "SWE", enricherVersion: TARGET, requiredSkills: [],
    jobDescription: "    \n  ",
  }, { targetVersion: TARGET })
  assert.equal(r.jdSignal, "title")
  assert.equal(r.eligible, false)
})

// ─── buildReenrichUpdate ──────────────────────────────────────────────────

test("buildReenrichUpdate: clears enricherContentHash to null", () => {
  const upd = buildReenrichUpdate({ enricherVersion: "v1.8.1" }, "test-run")
  assert.equal(upd.enricherContentHash, null)
})

test("buildReenrichUpdate: stamps sentinel pending-reenrich version", () => {
  const upd = buildReenrichUpdate({ enricherVersion: "v1.8.1" }, "abc123")
  assert.equal(upd.enricherVersion, "pending-reenrich-abc123")
})

test("buildReenrichUpdate: records previous version for forensic trail", () => {
  const upd = buildReenrichUpdate({ enricherVersion: "v1.8.1" }, "x")
  assert.equal(upd._reenrichPreviousVersion, "v1.8.1")
})

test("buildReenrichUpdate: stamps reason='empty-required-skills' for forensic distinguishability vs force-reenrich", () => {
  const upd = buildReenrichUpdate({ enricherVersion: "v1.8.1" }, "x")
  assert.equal(upd._reenrichReason, "empty-required-skills")
})

test("buildReenrichUpdate: includes _reenrichRequestedAt ISO timestamp", () => {
  const upd = buildReenrichUpdate({ enricherVersion: "v1.8.1" }, "x")
  assert.match(upd._reenrichRequestedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
})

test("buildReenrichUpdate: handles missing enricherVersion (sets previousVersion=null)", () => {
  const upd = buildReenrichUpdate({}, "run")
  assert.equal(upd._reenrichPreviousVersion, null)
})

test("buildReenrichUpdate: shape is stable across re-runs", () => {
  const u1 = buildReenrichUpdate({ enricherVersion: "v1.8.1" }, "run-A")
  const u2 = buildReenrichUpdate({ enricherVersion: "v1.8.1" }, "run-A")
  // Timestamps differ but shape must match
  assert.deepEqual(Object.keys(u1).sort(), Object.keys(u2).sort())
  assert.equal(u1.enricherVersion, u2.enricherVersion)
  assert.equal(u1.enricherContentHash, u2.enricherContentHash)
  assert.equal(u1._reenrichPreviousVersion, u2._reenrichPreviousVersion)
  assert.equal(u1._reenrichReason, u2._reenrichReason)
})
