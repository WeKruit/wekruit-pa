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

// ── matchReason persistence (2026-05-30) — the grounded "why matched" pitch ──

test("recordRecommendedJobs persists the per-job matchReason on the rec ledger", async () => {
  const mfs = new MockFirestore()
  await recordRecommendedJobs(asFirestore(mfs), {
    userId: "cand-1",
    jobs: [
      {
        id: "job-1",
        matchReason:
          "Full-stack role at an early-stage SF startup — your React/TS background fits the stack.",
      },
      { id: "job-2", reason: "why: Your Tesla backend maps to this Stripe full-stack scale." },
      { id: "job-3" }, // no reason at all
    ],
    source: "runtime_job_search_reply",
    nowIso: "2026-05-30T12:00:00.000Z",
  })

  const d1 = ledgerDoc(mfs, "cand-1", "job-1")!
  const d2 = ledgerDoc(mfs, "cand-1", "job-2")!
  const d3 = ledgerDoc(mfs, "cand-1", "job-3")!

  // Explicit matchReason persisted verbatim.
  assert.equal(
    d1.matchReason,
    "Full-stack role at an early-stage SF startup — your React/TS background fits the stack.",
  )
  // V16 `reason` field used as fallback, with the legacy "why: " prefix stripped.
  assert.equal(d2.matchReason, "Your Tesla backend maps to this Stripe full-stack scale.")
  // No reason → field omitted (not written as empty / undefined).
  assert.equal("matchReason" in d3, false)

  // Bookkeeping still works.
  assert.equal(d1.recommendationCount, 1)
  assert.equal(d1.lastRecommendedSource, "runtime_job_search_reply")
})

test("recordRecommendedJobs does not overwrite a stored reason with nothing on re-record", async () => {
  const mfs = new MockFirestore()
  // First record carries the reason.
  await recordRecommendedJobs(asFirestore(mfs), {
    userId: "cand-1",
    jobs: [{ id: "job-1", matchReason: "Senior backend role in fintech — your Python + SQL fit." }],
    source: "job_rec_daily_batch",
    nowIso: "2026-05-30T08:00:00.000Z",
  })
  // Second record (e.g. a later push that lost the reason) must keep the old one.
  await recordRecommendedJobs(asFirestore(mfs), {
    userId: "cand-1",
    jobs: [{ id: "job-1" }],
    source: "job_rec_daily_batch",
    nowIso: "2026-05-31T08:00:00.000Z",
  })

  const d1 = ledgerDoc(mfs, "cand-1", "job-1")!
  assert.equal(d1.matchReason, "Senior backend role in fintech — your Python + SQL fit.")
  assert.equal(d1.recommendationCount, 2)
})

test("loadRecommendedJobStates surfaces the stored matchReason", async () => {
  const mfs = new MockFirestore()
  await recordRecommendedJobs(asFirestore(mfs), {
    userId: "cand-1",
    jobs: [
      {
        id: "job-1",
        matchReason: "Early-stage product role — your stack + the equity you want both line up.",
      },
    ],
    source: "runtime_job_search_reply",
    nowIso: "2026-05-30T12:00:00.000Z",
  })
  const states = await loadRecommendedJobStates(asFirestore(mfs), "cand-1", ["job-1"])
  assert.equal(
    states.get("job-1")?.matchReason,
    "Early-stage product role — your stack + the equity you want both line up.",
  )
})

test("recordRecommendedJobs rejects too-short / non-string reasons", async () => {
  const mfs = new MockFirestore()
  await recordRecommendedJobs(asFirestore(mfs), {
    userId: "cand-1",
    jobs: [
      { id: "job-1", matchReason: "ok" }, // < 8 chars → dropped
      { id: "job-2", matchReason: 12345 as unknown as string }, // non-string → dropped
    ],
    source: "runtime_job_search_reply",
  })
  const d1 = ledgerDoc(mfs, "cand-1", "job-1")!
  const d2 = ledgerDoc(mfs, "cand-1", "job-2")!
  assert.equal("matchReason" in d1, false)
  assert.equal("matchReason" in d2, false)
})
