/**
 * Rec tracking (req #4, 2026-05-29) — per-(user,job) recommendation ledger.
 *
 * Covers:
 *   - recordRecommendedJobs increments recommendationCount + sets scalar fields
 *   - reason='wekruit_collab' appends a `recommendationSources` row
 *   - firstRecommendedAt only on the FIRST call (idempotent on repeats)
 *   - confidence is persisted on the row when provided
 *   - loadRecommendedJobStates round-trips the ledger
 */

import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "./mock-firestore.js"
import {
  recordRecommendedJobs,
  loadRecommendedJobStates,
  USER_JOB_RECOMMENDATIONS_COLLECTION,
} from "../recommendation-state.js"

function ledgerDoc(mfs: MockFirestore, userId: string, jobId: string): Record<string, unknown> | undefined {
  return mfs.store.get(`${USER_JOB_RECOMMENDATIONS_COLLECTION}/${userId}/jobs`)?.get(jobId)
}

test("recordRecommendedJobs: reason='wekruit_collab' appends a recommendationSources row + firstRecommendedAt on first call only", async () => {
  const mfs = new MockFirestore()
  await recordRecommendedJobs(asFirestore(mfs), {
    userId: "u1",
    jobs: [{ id: "j1" }],
    source: "runtime_job_search_reply",
    reason: "wekruit_collab",
    confidence: 0.91,
    nowIso: "2026-05-29T10:00:00.000Z",
  })
  const after1 = ledgerDoc(mfs, "u1", "j1")!
  assert.equal(after1.recommendationCount, 1)
  assert.equal(after1.firstRecommendedAt, "2026-05-29T10:00:00.000Z")
  assert.equal(after1.lastRecommendedSource, "runtime_job_search_reply")
  const sources1 = after1.recommendationSources as Array<Record<string, unknown>>
  assert.equal(sources1.length, 1)
  assert.equal(sources1[0]!.source, "wekruit_collab")
  assert.equal(sources1[0]!.timestamp, "2026-05-29T10:00:00.000Z")
  assert.equal(sources1[0]!.confidence, 0.91)

  // Second call: count increments, a SECOND source row appends, but
  // firstRecommendedAt is NOT overwritten.
  await recordRecommendedJobs(asFirestore(mfs), {
    userId: "u1",
    jobs: [{ id: "j1" }],
    source: "daily_batch",
    reason: "general_market",
    nowIso: "2026-05-30T10:00:00.000Z",
  })
  const after2 = ledgerDoc(mfs, "u1", "j1")!
  assert.equal(after2.recommendationCount, 2)
  assert.equal(after2.firstRecommendedAt, "2026-05-29T10:00:00.000Z", "firstRecommendedAt only on first call")
  const sources2 = after2.recommendationSources as Array<Record<string, unknown>>
  assert.equal(sources2.length, 2)
  assert.equal(sources2[0]!.source, "wekruit_collab")
  assert.equal(sources2[1]!.source, "general_market")
  // no confidence supplied on the 2nd call → omitted on that row.
  assert.equal(sources2[1]!.confidence, undefined)
})

test("recordRecommendedJobs: falls back to `source` as the row label when `reason` is absent", async () => {
  const mfs = new MockFirestore()
  await recordRecommendedJobs(asFirestore(mfs), {
    userId: "u2",
    jobs: [{ id: "jA" }],
    source: "claire_agent",
    nowIso: "2026-05-29T12:00:00.000Z",
  })
  const doc = ledgerDoc(mfs, "u2", "jA")!
  const sources = doc.recommendationSources as Array<Record<string, unknown>>
  assert.equal(sources.length, 1)
  assert.equal(sources[0]!.source, "claire_agent")
})

test("loadRecommendedJobStates: round-trips the source ledger", async () => {
  const mfs = new MockFirestore()
  await recordRecommendedJobs(asFirestore(mfs), {
    userId: "u3",
    jobs: [{ id: "jX" }],
    source: "runtime",
    reason: "wekruit_collab",
    confidence: 0.7,
    nowIso: "2026-05-29T08:00:00.000Z",
  })
  const states = await loadRecommendedJobStates(asFirestore(mfs), "u3", ["jX"])
  const state = states.get("jX")
  assert.ok(state)
  assert.equal(state.recommendationCount, 1)
  assert.equal(state.lastRecommendedSource, "runtime")
  assert.equal(state.recommendationSources?.length, 1)
  assert.equal(state.recommendationSources?.[0]?.source, "wekruit_collab")
  assert.equal(state.recommendationSources?.[0]?.confidence, 0.7)
})

test("recordRecommendedJobs: no-op for blank userId / empty job list", async () => {
  const mfs = new MockFirestore()
  await recordRecommendedJobs(asFirestore(mfs), { userId: "  ", jobs: [{ id: "j" }], source: "s" })
  await recordRecommendedJobs(asFirestore(mfs), { userId: "u", jobs: [], source: "s" })
  await recordRecommendedJobs(asFirestore(mfs), { userId: "u", jobs: [{ id: "" }], source: "s" })
  assert.equal(mfs.writeLog.length, 0)
})
