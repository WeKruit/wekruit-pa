/**
 * v1.6 Phase 57 — Liveness sweep unit tests.
 *
 * Coverage:
 *   - headCheck: 200/404/503/timeout/network classifications
 *   - runLivenessSweep: alive job no-op, alive→dead mark, dead→alive recover,
 *     dead >30d hard-delete, dead <7d skip, missing-url skip, errors counter
 *   - v1.7 Phase 65: missing atsApplyUrl is skipped (no inline backfill;
 *     paBackfillAtsUrlsBatch handles it on hourly cadence)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  headCheck,
  runLivenessSweep,
  processOneJob,
  emptyCounters,
  makeLimiter,
  type FetchFn,
  type SweepStore,
  type SweepJobDoc,
  type SweepUpdates,
  type SweepCounters,
  type LivenessVerdict,
} from "../liveness-sweep.js"

// ---------------------------------------------------------------------------
// headCheck
// ---------------------------------------------------------------------------

describe("headCheck", () => {
  it("returns alive for HTTP 200", async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(null, { status: 200 })
    const verdict = await headCheck("https://example.com/job/1", { fetchImpl })
    assert.deepEqual(verdict, { alive: true })
  })

  it("returns alive for HTTP 301 (redirect followed)", async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(null, { status: 301 })
    const verdict = await headCheck("https://example.com/job/1", { fetchImpl })
    assert.deepEqual(verdict, { alive: true })
  })

  it("returns alive for HTTP 405 (method-not-allowed but URL exists)", async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(null, { status: 405 })
    const verdict = await headCheck("https://example.com/job/1", { fetchImpl })
    assert.deepEqual(verdict, { alive: true })
  })

  it("returns dead with reason http_404 for HTTP 404", async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(null, { status: 404 })
    const verdict = await headCheck("https://example.com/job/1", { fetchImpl })
    assert.equal(verdict.alive, false)
    if (!verdict.alive) assert.equal(verdict.reason, "http_404")
  })

  it("returns dead with reason http_503 for HTTP 503", async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(null, { status: 503 })
    const verdict = await headCheck("https://example.com/job/1", { fetchImpl })
    assert.equal(verdict.alive, false)
    if (!verdict.alive) assert.equal(verdict.reason, "http_503")
  })

  it("returns dead with reason timeout when fetch is aborted", async () => {
    const fetchImpl: FetchFn = (_url, init) =>
      new Promise<Response>((_res, reject) => {
        const signal = (init as RequestInit)?.signal as AbortSignal | undefined
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("operation aborted")
            ;(err as Error & { name: string }).name = "AbortError"
            reject(err)
          })
        }
      })
    const verdict = await headCheck("https://example.com/job/1", {
      fetchImpl,
      timeoutMs: 10,
    })
    assert.equal(verdict.alive, false)
    if (!verdict.alive) assert.equal(verdict.reason, "timeout")
  })

  it("returns dead with network_error reason for fetch throw", async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error("ENOTFOUND example.com")
    }
    const verdict = await headCheck("https://example.com/job/1", { fetchImpl })
    assert.equal(verdict.alive, false)
    if (!verdict.alive) assert.match(verdict.reason, /^network_error:/)
  })

  it("truncates very long network error messages to 80 chars", async () => {
    const longMsg = "x".repeat(500)
    const fetchImpl: FetchFn = async () => {
      throw new Error(longMsg)
    }
    const verdict = await headCheck("https://example.com/job/1", { fetchImpl })
    if (!verdict.alive) {
      assert.ok(verdict.reason.length <= "network_error: ".length + 80)
    }
  })
})

// ---------------------------------------------------------------------------
// makeLimiter
// ---------------------------------------------------------------------------

describe("makeLimiter", () => {
  it("runs tasks concurrently up to the limit", async () => {
    const limiter = makeLimiter(2)
    let active = 0
    let peak = 0
    const sleep = (ms: number) =>
      new Promise<void>((r) => setTimeout(r, ms))

    const run = (i: number) =>
      limiter(async () => {
        active++
        peak = Math.max(peak, active)
        await sleep(10)
        active--
        return i
      })

    const results = await Promise.all([run(0), run(1), run(2), run(3), run(4)])
    assert.deepEqual(results, [0, 1, 2, 3, 4])
    assert.equal(peak, 2, "peak concurrency must equal the limit")
  })
})

// ---------------------------------------------------------------------------
// In-memory store helper for runLivenessSweep tests
// ---------------------------------------------------------------------------

function inMemoryStore(initial: SweepJobDoc[]) {
  const docs = new Map<string, SweepJobDoc>()
  for (const d of initial) docs.set(d.id, { ...d })
  const updates: Array<{ id: string; updates: SweepUpdates }> = []
  const deletes: string[] = []
  const audits: Array<{ counters: SweepCounters; runAt: string }> = []

  const store: SweepStore = {
    fetchActiveJobs: async () => Array.from(docs.values()).map((d) => ({ ...d })),
    updateJob: async (id, u) => {
      updates.push({ id, updates: { ...u } })
      const cur = docs.get(id)
      if (cur) docs.set(id, { ...cur, ...u } as SweepJobDoc)
    },
    deleteJob: async (id) => {
      deletes.push(id)
      docs.delete(id)
    },
    writeAudit: async (counters, runAt) => {
      audits.push({ counters: { ...counters }, runAt })
    },
  }
  return { store, docs, updates, deletes, audits }
}

// ---------------------------------------------------------------------------
// processOneJob — single-doc behaviour
// ---------------------------------------------------------------------------

describe("processOneJob", () => {
  const NOW = Date.parse("2026-05-06T00:00:00Z")
  const dayAgo = (n: number) => new Date(NOW - n * 24 * 3600 * 1000).toISOString()

  const aliveHead = async (): Promise<LivenessVerdict> => ({ alive: true })
  const deadHead = async (): Promise<LivenessVerdict> => ({
    alive: false,
    reason: "http_404",
  })

  const baseDeps = (overrides: Partial<{
    head: () => Promise<LivenessVerdict>
    serperUrl: string | null
    allowBackfill: boolean
    now: number
  }>) => ({
    store: inMemoryStore([]).store,
    headCheck: overrides.head ?? aliveHead,
    serper: async () => overrides.serperUrl ?? null,
    now: () => overrides.now ?? NOW,
    allowBackfill: overrides.allowBackfill ?? true,
  })

  it("alive job with atsApplyUrl + not dead → noop", async () => {
    const counters = emptyCounters()
    const job: SweepJobDoc = {
      id: "j1",
      atsApplyUrl: "https://boards.greenhouse.io/x/jobs/1",
    }
    const plan = await processOneJob(job, counters, baseDeps({ head: aliveHead }))
    assert.equal(plan.kind, "noop")
    assert.equal(counters.head_alive, 1)
    assert.equal(counters.dead_marked, 0)
  })

  it("normalizes YC Work at a Startup /jobs URLs before checking liveness", async () => {
    const counters = emptyCounters()
    let checkedUrl = ""
    const job: SweepJobDoc = {
      id: "j1",
      atsApplyUrl: "https://www.workatastartup.com/companies/deepgram/jobs",
      primaryUrl: "https://www.workatastartup.com/companies/deepgram/jobs",
    }
    const deps = {
      ...baseDeps({}),
      headCheck: async (url: string): Promise<LivenessVerdict> => {
        checkedUrl = url
        return { alive: true }
      },
    }
    const plan = await processOneJob(job, counters, deps)
    assert.equal(checkedUrl, "https://www.workatastartup.com/companies/deepgram")
    assert.equal(plan.kind, "update")
    if (plan.kind === "update") {
      assert.equal(plan.updates.atsApplyUrl, "https://www.workatastartup.com/companies/deepgram")
      assert.equal(plan.updates.primaryUrl, "https://www.workatastartup.com/companies/deepgram")
      assert.equal(plan.updates.dead, undefined)
    }
  })

  it("alive→dead: marks dead with reason and deadCheckedAt", async () => {
    const counters = emptyCounters()
    const job: SweepJobDoc = {
      id: "j1",
      atsApplyUrl: "https://boards.greenhouse.io/x/jobs/1",
    }
    const plan = await processOneJob(job, counters, baseDeps({ head: deadHead }))
    assert.equal(plan.kind, "update")
    if (plan.kind === "update") {
      assert.equal(plan.updates.dead, true)
      assert.equal(plan.updates.deadReason, "http_404")
      assert.ok(plan.updates.deadCheckedAt)
    }
    assert.equal(counters.dead_marked, 1)
    assert.equal(counters.head_dead, 1)
  })

  it("dead→alive (recovery): clears dead flag", async () => {
    const counters = emptyCounters()
    const job: SweepJobDoc = {
      id: "j1",
      atsApplyUrl: "https://boards.greenhouse.io/x/jobs/1",
      dead: true,
      // 8 days ago — outside 7d re-check window
      deadCheckedAt: dayAgo(8),
    }
    const plan = await processOneJob(job, counters, baseDeps({ head: aliveHead }))
    assert.equal(plan.kind, "update")
    if (plan.kind === "update") {
      assert.equal(plan.updates.dead, false)
      assert.equal(plan.updates.deadReason, null)
    }
    assert.equal(counters.dead_recovered, 1)
  })

  it("dead but inside 7d re-check window → noop (skipped)", async () => {
    const counters = emptyCounters()
    const job: SweepJobDoc = {
      id: "j1",
      atsApplyUrl: "https://boards.greenhouse.io/x/jobs/1",
      dead: true,
      deadCheckedAt: dayAgo(3), // inside 7d window
    }
    const plan = await processOneJob(job, counters, baseDeps({ head: deadHead }))
    assert.equal(plan.kind, "noop")
    assert.equal(counters.skipped_recheck_window, 1)
    // HEAD must NOT have run.
    assert.equal(counters.head_dead, 0)
    assert.equal(counters.head_alive, 0)
  })

  it("dead >30d → hard delete", async () => {
    const counters = emptyCounters()
    const job: SweepJobDoc = {
      id: "j1",
      atsApplyUrl: "https://boards.greenhouse.io/x/jobs/1",
      dead: true,
      deadCheckedAt: dayAgo(31),
    }
    const plan = await processOneJob(job, counters, baseDeps({}))
    assert.equal(plan.kind, "delete")
    assert.equal(counters.hard_deleted, 1)
  })

  it("missing atsApplyUrl + missing primaryUrl → skip + skipped_no_url counter", async () => {
    const counters = emptyCounters()
    const job: SweepJobDoc = { id: "j1" }
    const plan = await processOneJob(job, counters, baseDeps({}))
    assert.equal(plan.kind, "noop")
    assert.equal(counters.skipped_no_url, 1)
  })

  it("v1.7 Phase 65: missing atsApplyUrl is now skipped (no inline backfill, batch CF handles)", async () => {
    // Even with primaryUrl pointing at a known ATS host, liveness-sweep no
    // longer copies it across — that's the batch CF's job.
    const counters = emptyCounters()
    const job: SweepJobDoc = {
      id: "j1",
      primaryUrl: "https://boards.greenhouse.io/openai/jobs/123",
      companyName: "OpenAI",
      jobTitle: "Engineer",
    }
    const plan = await processOneJob(job, counters, baseDeps({ head: aliveHead }))
    assert.equal(plan.kind, "noop")
    assert.equal(counters.skipped_no_url, 1)
    // No backfill counters bumped — feature removed.
    assert.equal(counters.backfill_resolved, 0)
    assert.equal(counters.backfill_attempted, 0)
    // No HEAD ran — atsApplyUrl was missing.
    assert.equal(counters.head_alive, 0)
  })

  it("v1.7 Phase 65: missing atsApplyUrl skipped regardless of allowBackfill flag", async () => {
    // allowBackfill is now ignored — kept on signature for back-compat.
    const counters = emptyCounters()
    const job: SweepJobDoc = {
      id: "j1",
      primaryUrl: "https://boards.greenhouse.io/openai/jobs/123",
      companyName: "OpenAI",
      jobTitle: "Engineer",
    }
    const plan = await processOneJob(job, counters, baseDeps({ allowBackfill: false }))
    assert.equal(plan.kind, "noop")
    assert.equal(counters.skipped_no_url, 1)
    assert.equal(counters.backfill_attempted, 0)
  })

  it("HEAD throw → errors counter increments, no update", async () => {
    const counters = emptyCounters()
    const job: SweepJobDoc = {
      id: "j1",
      atsApplyUrl: "https://boards.greenhouse.io/x/jobs/1",
    }
    const plan = await processOneJob(job, counters, {
      ...baseDeps({}),
      headCheck: async () => {
        throw new Error("kaboom")
      },
    })
    assert.equal(plan.kind, "noop")
    assert.equal(counters.errors, 1)
  })

  it("dead and still dead after re-check (>7d, HEAD still 404) → bumps deadCheckedAt + reason but does NOT re-mark", async () => {
    const counters = emptyCounters()
    const job: SweepJobDoc = {
      id: "j1",
      atsApplyUrl: "https://boards.greenhouse.io/x/jobs/1",
      dead: true,
      deadCheckedAt: dayAgo(8),
    }
    const plan = await processOneJob(job, counters, baseDeps({ head: deadHead }))
    assert.equal(plan.kind, "update")
    if (plan.kind === "update") {
      // Was already dead — dead_marked should NOT increment.
      assert.equal(plan.updates.dead, undefined, "should not re-set dead=true")
      assert.ok(plan.updates.deadCheckedAt)
      assert.equal(plan.updates.deadReason, "http_404")
    }
    assert.equal(counters.dead_marked, 0)
    assert.equal(counters.head_dead, 1)
  })
})

// ---------------------------------------------------------------------------
// runLivenessSweep — end-to-end with in-memory store
// ---------------------------------------------------------------------------

describe("runLivenessSweep", () => {
  const NOW = Date.parse("2026-05-06T00:00:00Z")

  it("processes mixed corpus: alive, alive→dead, dead→alive, hard-delete, no-url", async () => {
    const docs: SweepJobDoc[] = [
      // 1. Alive, atsApplyUrl present, not dead → no update
      { id: "alive-no-op", atsApplyUrl: "https://greenhouse.io/x/1" },
      // 2. Alive but currently flagged dead, outside re-check window → recover
      {
        id: "recovered",
        atsApplyUrl: "https://lever.co/x/2",
        dead: true,
        deadCheckedAt: new Date(NOW - 8 * 24 * 3600 * 1000).toISOString(),
      },
      // 3. Dead now, currently alive in flag → mark dead
      { id: "newly-dead", atsApplyUrl: "https://ashbyhq.com/x/3" },
      // 4. Dead >30d → hard delete
      {
        id: "expired-dead",
        atsApplyUrl: "https://greenhouse.io/x/4",
        dead: true,
        deadCheckedAt: new Date(NOW - 31 * 24 * 3600 * 1000).toISOString(),
      },
      // 5. Dead inside 7d window → skipped, no head check
      {
        id: "fresh-dead",
        atsApplyUrl: "https://greenhouse.io/x/5",
        dead: true,
        deadCheckedAt: new Date(NOW - 3 * 24 * 3600 * 1000).toISOString(),
      },
      // 6. Missing atsApplyUrl + primaryUrl → skip
      { id: "no-url" },
    ]

    const { store, updates, deletes, audits } = inMemoryStore(docs)

    // HEAD impl: id 3 is dead (404); ids 1, 2, 4, 5 alive (but 4/5 don't get HEAD'd).
    const headByUrl: Record<string, LivenessVerdict> = {
      "https://greenhouse.io/x/1": { alive: true },
      "https://lever.co/x/2": { alive: true },
      "https://ashbyhq.com/x/3": { alive: false, reason: "http_404" },
      "https://greenhouse.io/x/4": { alive: true }, // never reached
      "https://greenhouse.io/x/5": { alive: true }, // never reached (skipped)
    }

    const counters = await runLivenessSweep({
      store,
      headCheck: async (url) => headByUrl[url] ?? { alive: false, reason: "unknown" },
      serper: async () => null,
      now: () => NOW,
      concurrency: 4,
      batchSize: 100,
      throttleMs: 0,
    })

    assert.equal(counters.processed, 6)
    assert.equal(counters.dead_marked, 1, "newly-dead → dead_marked")
    assert.equal(counters.dead_recovered, 1, "recovered → dead_recovered")
    assert.equal(counters.hard_deleted, 1, "expired-dead → hard_deleted")
    assert.equal(counters.skipped_recheck_window, 1, "fresh-dead → skipped_recheck_window")
    assert.equal(counters.skipped_no_url, 1, "no-url → skipped_no_url")
    assert.equal(counters.head_alive, 2)
    assert.equal(counters.head_dead, 1)

    // Verify side effects.
    assert.equal(deletes.length, 1)
    assert.equal(deletes[0], "expired-dead")

    // Two updates: recovered + newly-dead.
    assert.equal(updates.length, 2)
    const updById = new Map(updates.map((u) => [u.id, u.updates]))
    assert.equal(updById.get("recovered")?.dead, false)
    assert.equal(updById.get("newly-dead")?.dead, true)

    // Audit was written.
    assert.equal(audits.length, 1)
    assert.equal(audits[0].counters.processed, 6)
  })

  it("v1.7 Phase 65: jobs missing atsApplyUrl are all skipped (delegated to paBackfillAtsUrlsBatch)", async () => {
    // Pre-Phase-65 this test verified the inline backfill cap. Now that the
    // inline path is gone, every doc missing atsApplyUrl should be skipped —
    // regardless of whether primaryUrl is a known ATS host.
    const docs: SweepJobDoc[] = []
    for (let i = 0; i < 5; i++) {
      docs.push({
        id: `j${i}`,
        primaryUrl: `https://boards.greenhouse.io/x/${i}`,
        companyName: "X",
        jobTitle: "Engineer",
      })
    }
    const { store, updates } = inMemoryStore(docs)

    const counters = await runLivenessSweep({
      store,
      headCheck: async () => ({ alive: true }),
      serper: async () => null,
      now: () => NOW,
      concurrency: 1,
      batchSize: 100,
      throttleMs: 0,
    })

    assert.equal(counters.processed, 5)
    // No backfill counters bump — Phase 65 removed inline backfill.
    assert.equal(counters.backfill_resolved, 0)
    assert.equal(counters.backfill_attempted, 0)
    // All 5 docs miss atsApplyUrl → all 5 skipped.
    assert.equal(counters.skipped_no_url, 5)
    // No writes performed.
    assert.equal(updates.length, 0)
  })

  it("error in one job does not abort the sweep; counters.errors increments", async () => {
    const docs: SweepJobDoc[] = [
      { id: "j1", atsApplyUrl: "https://greenhouse.io/x/1" },
      { id: "j2", atsApplyUrl: "https://greenhouse.io/x/2" },
    ]
    const { store } = inMemoryStore(docs)
    let calls = 0
    const counters = await runLivenessSweep({
      store,
      headCheck: async () => {
        calls++
        if (calls === 1) throw new Error("transient")
        return { alive: true }
      },
      serper: async () => null,
      now: () => NOW,
      concurrency: 1,
      batchSize: 100,
      throttleMs: 0,
    })

    assert.equal(counters.processed, 2)
    assert.equal(counters.errors, 1)
    assert.equal(counters.head_alive, 1)
  })

  it("respects deadCheckedAt as Firestore-Timestamp-like object (toMillis)", async () => {
    const eightDaysAgoMs = NOW - 8 * 24 * 3600 * 1000
    const docs: SweepJobDoc[] = [
      {
        id: "j1",
        atsApplyUrl: "https://greenhouse.io/x/1",
        dead: true,
        deadCheckedAt: { toMillis: () => eightDaysAgoMs },
      },
    ]
    const { store, updates } = inMemoryStore(docs)
    const counters = await runLivenessSweep({
      store,
      headCheck: async () => ({ alive: true }),
      serper: async () => null,
      now: () => NOW,
      concurrency: 1,
      batchSize: 100,
      throttleMs: 0,
    })

    assert.equal(counters.dead_recovered, 1)
    assert.equal(updates.length, 1)
    assert.equal(updates[0].updates.dead, false)
  })
})
