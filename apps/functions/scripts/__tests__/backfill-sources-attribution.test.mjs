/**
 * v1.7 Phase 63 — Tests for backfill-sources-attribution.mjs.
 *
 * Coverage: planJob across all branches + migrateJob dry-run / apply paths.
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  LEGACY_SOURCE,
  planJob,
  migrateJob,
} from "../backfill-sources-attribution.mjs"

// ─── planJob ──────────────────────────────────────────────────────────────

test("planJob: missing sources field → rewrite", () => {
  const result = planJob({})
  assert.equal(result.mode, "rewrite")
  assert.deepEqual(result.to, [LEGACY_SOURCE])
})

test("planJob: sources=null → rewrite", () => {
  const result = planJob({ sources: null })
  assert.equal(result.mode, "rewrite")
  assert.deepEqual(result.to, [LEGACY_SOURCE])
})

test("planJob: sources=undefined → rewrite", () => {
  const result = planJob({ sources: undefined })
  assert.equal(result.mode, "rewrite")
  assert.deepEqual(result.to, [LEGACY_SOURCE])
})

test("planJob: sources=[] (empty array) → rewrite", () => {
  const result = planJob({ sources: [] })
  assert.equal(result.mode, "rewrite")
  assert.deepEqual(result.to, [LEGACY_SOURCE])
})

test("planJob: sources=['jobright'] already set → skip-already-set", () => {
  const result = planJob({ sources: ["jobright"] })
  assert.equal(result.mode, "skip-already-set")
  assert.deepEqual(result.existing, ["jobright"])
})

test("planJob: sources=['linkedin','wellfound'] already set → skip-already-set", () => {
  const result = planJob({ sources: ["linkedin", "wellfound"] })
  assert.equal(result.mode, "skip-already-set")
  assert.deepEqual(result.existing, ["linkedin", "wellfound"])
})

test("planJob: sources is a non-array (string) → rewrite (treats as missing)", () => {
  // Defensive: if sources somehow was set to a string, treat as missing
  // and overwrite with the legacy default.
  const result = planJob({ sources: "jobright" })
  assert.equal(result.mode, "rewrite")
  assert.deepEqual(result.to, [LEGACY_SOURCE])
})

// ─── migrateJob ───────────────────────────────────────────────────────────

function _fakeDb({ updateImpl } = {}) {
  let updateCallArgs = null
  return {
    collection: () => ({
      doc: () => ({
        update: async (data) => {
          updateCallArgs = data
          if (updateImpl) return updateImpl(data)
          return undefined
        },
      }),
    }),
    _getUpdateCallArgs: () => updateCallArgs,
  }
}

test("migrateJob: dry-run skip-already-set returns skip", async () => {
  const db = _fakeDb()
  const result = await migrateJob(
    db,
    "job-1",
    { sources: ["linkedin"] },
    { dryRun: true }
  )
  assert.equal(result.mode, "skip-already-set")
  assert.equal(result.jobId, "job-1")
  assert.equal(db._getUpdateCallArgs(), null)
})

test("migrateJob: dry-run rewrite does NOT call db.update", async () => {
  const db = _fakeDb()
  const result = await migrateJob(db, "job-2", {}, { dryRun: true })
  assert.equal(result.mode, "dry-run-rewrite")
  assert.deepEqual(result.to, [LEGACY_SOURCE])
  assert.equal(db._getUpdateCallArgs(), null)
})

test("migrateJob: apply rewrite calls db.update with sources + sourcesBackfilledAt", async () => {
  const db = _fakeDb()
  const result = await migrateJob(db, "job-3", {}, { dryRun: false })
  assert.equal(result.mode, "applied")
  assert.deepEqual(result.to, [LEGACY_SOURCE])
  const updateArgs = db._getUpdateCallArgs()
  assert.deepEqual(updateArgs.sources, [LEGACY_SOURCE])
  assert.equal(typeof updateArgs.sourcesBackfilledAt, "string")
})

test("migrateJob: apply error path returns error mode", async () => {
  const db = _fakeDb({
    updateImpl: () => {
      throw new Error("permission-denied")
    },
  })
  const result = await migrateJob(db, "job-4", {}, { dryRun: false })
  assert.equal(result.mode, "error")
  assert.equal(result.jobId, "job-4")
  assert.match(result.error, /permission-denied/)
})

test("migrateJob: apply skip-already-set does NOT call db.update", async () => {
  const db = _fakeDb()
  const result = await migrateJob(
    db,
    "job-5",
    { sources: ["jobright", "linkedin"] },
    { dryRun: false }
  )
  assert.equal(result.mode, "skip-already-set")
  assert.equal(db._getUpdateCallArgs(), null)
})
