/**
 * v1.7 Phase 65 — `paBackfillAtsUrlsBatch` unit tests.
 *
 * Coverage:
 *   - processOneJob: pass1 / pass3 / linkedin / miss(no_anchors|serper_miss)
 *   - cost-ledger row written per Serper call (success + failure both logged)
 *   - linkedin extractor regex
 *   - retry-queue write on miss with attempts bump
 *   - retry-queue clear on resolve
 *   - retry-queue TTL cleanup
 *   - concurrency cap respected (peak == serperConcurrency)
 *   - audit row written
 *   - end-to-end batch: priority-queue first, then fresh, capped at batchSize
 *   - LinkedIn fallback runs only after Serper miss
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  runBackfillBatch,
  processOneJob,
  emptyCounters,
  isLinkedinJobsUrl,
  type BackfillBatchStore,
  type BackfillBatchDeps,
  type BatchJobDoc,
  type BatchUpdate,
  type RetryQueueEntry,
  type LinkedinExtractor,
  type BatchCounters,
} from "../backfill-ats-urls-batch.js"
import type { SerperFn } from "../backfill-ats-urls.js"
import type { CostLedgerEntry, CostLedgerWriter } from "../lib/cost-ledger.js"

// ---------------------------------------------------------------------------
// In-memory store helper
// ---------------------------------------------------------------------------

function inMemoryStore(opts: {
  jobs?: Map<string, BatchJobDoc>
  priority?: RetryQueueEntry[]
  candidates?: BatchJobDoc[]
}) {
  const jobs = opts.jobs ?? new Map<string, BatchJobDoc>()
  const priority = new Map<string, RetryQueueEntry>()
  for (const e of opts.priority ?? []) priority.set(e.jobId, { ...e })
  const candidates = opts.candidates ?? []

  const updates: Array<{ id: string; updates: BatchUpdate }> = []
  const upserts: Array<{ jobId: string; payload: RetryQueueEntry }> = []
  const removes: string[] = []
  const audits: Array<{ runId: string; doc: Record<string, unknown> }> = []
  const cleanups: Array<{ ttlMs: number; nowMs: number }> = []

  const store: BackfillBatchStore = {
    fetchPriorityQueue: async (limit) => {
      return Array.from(priority.values())
        .sort((a, b) => a.firstFailedAt.localeCompare(b.firstFailedAt))
        .slice(0, limit)
        .map((e) => ({ ...e }))
    },
    cleanupExpiredPriorityQueue: async (ttlMs, nowMs) => {
      cleanups.push({ ttlMs, nowMs })
      const cutoff = nowMs - ttlMs
      let count = 0
      for (const [id, e] of Array.from(priority.entries())) {
        if (Date.parse(e.firstFailedAt) < cutoff) {
          priority.delete(id)
          count++
        }
      }
      return count
    },
    fetchCandidates: async (limit) => {
      return candidates.slice(0, limit).map((c) => ({ ...c }))
    },
    fetchJobById: async (jobId) => {
      const j = jobs.get(jobId)
      return j ? { ...j } : null
    },
    updateJob: async (id, u) => {
      updates.push({ id, updates: { ...u } })
      const cur = jobs.get(id)
      if (cur) jobs.set(id, { ...cur, ...u })
    },
    upsertPriorityQueue: async (jobId, payload) => {
      upserts.push({ jobId, payload: { ...payload } })
      priority.set(jobId, { ...payload })
    },
    removePriorityQueue: async (jobId) => {
      removes.push(jobId)
      priority.delete(jobId)
    },
    writeAudit: async (runId, doc) => {
      audits.push({ runId, doc: { ...doc } })
    },
  }

  return { store, jobs, priority, candidates, updates, upserts, removes, audits, cleanups }
}

function recordingLedger(): CostLedgerWriter & { entries: CostLedgerEntry[] } {
  const entries: CostLedgerEntry[] = []
  return {
    entries,
    write: async (e) => {
      entries.push({ ...e })
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-05-06T00:00:00Z")
const noopLog = () => {}

function baseDeps(overrides: Partial<{
  serper: SerperFn
  linkedinExtractor: LinkedinExtractor
  store: BackfillBatchStore
  ledger: CostLedgerWriter
  now: number
  serperConcurrency: number
  batchSize: number
  retryTtlMs: number
}>): BackfillBatchDeps {
  const dep: BackfillBatchDeps = {
    store: overrides.store ?? inMemoryStore({}).store,
    costLedger: overrides.ledger ?? recordingLedger(),
    serper: overrides.serper ?? (async () => null),
    now: () => overrides.now ?? NOW,
    log: noopLog,
    errorLog: noopLog,
  }
  if (overrides.linkedinExtractor !== undefined) {
    dep.linkedinExtractor = overrides.linkedinExtractor
  }
  if (overrides.serperConcurrency !== undefined) {
    dep.serperConcurrency = overrides.serperConcurrency
  }
  if (overrides.batchSize !== undefined) {
    dep.batchSize = overrides.batchSize
  }
  if (overrides.retryTtlMs !== undefined) {
    dep.retryTtlMs = overrides.retryTtlMs
  }
  return dep
}

// ---------------------------------------------------------------------------
// isLinkedinJobsUrl
// ---------------------------------------------------------------------------

describe("isLinkedinJobsUrl", () => {
  it("matches valid LinkedIn jobs URLs", () => {
    assert.equal(isLinkedinJobsUrl("https://linkedin.com/jobs/view/123"), true)
    assert.equal(isLinkedinJobsUrl("https://www.linkedin.com/jobs/view/abc"), true)
  })
  it("rejects non-LinkedIn URLs", () => {
    assert.equal(isLinkedinJobsUrl("https://greenhouse.io/jobs/1"), false)
    assert.equal(isLinkedinJobsUrl(undefined), false)
    assert.equal(isLinkedinJobsUrl(""), false)
  })
})

// ---------------------------------------------------------------------------
// processOneJob
// ---------------------------------------------------------------------------

describe("processOneJob", () => {
  it("pass 1: primaryUrl is greenhouse → returns pass1, no Serper call", async () => {
    const counters = emptyCounters()
    const ledger = recordingLedger()
    const job: BatchJobDoc = {
      id: "j1",
      primaryUrl: "https://boards.greenhouse.io/x/jobs/1",
      companyName: "X",
      jobTitle: "Engineer",
    }
    const out = await processOneJob(job, "run-1", counters, baseDeps({ ledger }))
    assert.equal(out.kind, "pass1")
    if (out.kind === "pass1") assert.equal(out.url, job.primaryUrl)
    assert.equal(counters.pass1Count, 1)
    assert.equal(counters.serperCalls, 0)
    assert.equal(ledger.entries.length, 0)
  })

  it("pass 3: Serper returns ATS host → returns pass3 + cost-ledger logged success", async () => {
    const counters = emptyCounters()
    const ledger = recordingLedger()
    const job: BatchJobDoc = {
      id: "j1",
      primaryUrl: "https://jobright.ai/jobs/1", // not ATS
      companyName: "Stripe",
      jobTitle: "Engineer",
    }
    const out = await processOneJob(
      job,
      "run-1",
      counters,
      baseDeps({
        ledger,
        serper: async () => "https://boards.greenhouse.io/stripe/jobs/2",
      })
    )
    assert.equal(out.kind, "pass3")
    if (out.kind === "pass3") assert.equal(out.url, "https://boards.greenhouse.io/stripe/jobs/2")
    assert.equal(counters.pass3Count, 1)
    assert.equal(counters.serperCalls, 1)
    assert.equal(ledger.entries.length, 1)
    const [entry] = ledger.entries
    assert.equal(entry?.api, "serper")
    assert.equal(entry?.success, true)
    assert.equal(entry?.jobId, "j1")
    assert.equal(entry?.runId, "run-1")
    assert.equal(typeof entry?.cost_usd, "number")
  })

  it("miss: Serper returns nothing AND no LinkedIn extractor → miss(serper_miss) + cost-ledger failure", async () => {
    const counters = emptyCounters()
    const ledger = recordingLedger()
    const job: BatchJobDoc = {
      id: "j1",
      primaryUrl: "https://jobright.ai/jobs/1",
      companyName: "X",
      jobTitle: "Engineer",
    }
    const out = await processOneJob(
      job,
      "run-1",
      counters,
      baseDeps({ ledger, serper: async () => null })
    )
    assert.equal(out.kind, "miss")
    if (out.kind === "miss") assert.equal(out.reason, "serper_miss")
    assert.equal(counters.missCount, 1)
    assert.equal(ledger.entries.length, 1)
    assert.equal(ledger.entries[0]?.success, false)
  })

  it("miss: no companyName / jobTitle → miss(no_anchors) without Serper hit", async () => {
    const counters = emptyCounters()
    const ledger = recordingLedger()
    const job: BatchJobDoc = {
      id: "j1",
      primaryUrl: "https://jobright.ai/jobs/1",
    }
    const out = await processOneJob(
      job,
      "run-1",
      counters,
      baseDeps({ ledger, serper: async () => "https://boards.greenhouse.io/x/1" })
    )
    assert.equal(out.kind, "miss")
    if (out.kind === "miss") assert.equal(out.reason, "no_anchors")
    assert.equal(counters.serperCalls, 0)
    assert.equal(ledger.entries.length, 0)
  })

  it("linkedin fallback: Serper miss + extractor returns linkedin → returns linkedin", async () => {
    const counters = emptyCounters()
    const job: BatchJobDoc = {
      id: "j1",
      // jobright primaryUrl forces pass1 fail → Serper → linkedin fallback
      primaryUrl: "https://jobright.ai/jobs/info/listing-x",
      companyName: "X",
      jobTitle: "Engineer",
    }
    const linkedinExtractor: LinkedinExtractor = async () =>
      "https://www.linkedin.com/jobs/view/9876"
    const out = await processOneJob(
      job,
      "run-1",
      counters,
      baseDeps({ serper: async () => null, linkedinExtractor })
    )
    assert.equal(out.kind, "linkedin")
    if (out.kind === "linkedin") {
      assert.equal(out.url, "https://www.linkedin.com/jobs/view/9876")
    }
    assert.equal(counters.linkedinCount, 1)
  })

  it("linkedin fallback rejects non-linkedin URLs from extractor", async () => {
    const counters = emptyCounters()
    const job: BatchJobDoc = {
      id: "j1",
      primaryUrl: "https://jobright.ai/jobs/info/listing-y",
      companyName: "X",
      jobTitle: "Engineer",
    }
    const linkedinExtractor: LinkedinExtractor = async () =>
      "https://example.com/something" // not a linkedin URL
    const out = await processOneJob(
      job,
      "run-1",
      counters,
      baseDeps({ serper: async () => null, linkedinExtractor })
    )
    assert.equal(out.kind, "miss")
    if (out.kind === "miss") assert.equal(out.reason, "linkedin_miss")
  })
})

// ---------------------------------------------------------------------------
// runBackfillBatch — end-to-end
// ---------------------------------------------------------------------------

describe("runBackfillBatch", () => {
  it("processes priority queue first, then fresh candidates, capped at batchSize", async () => {
    // 1 priority entry (failed-before, ready to retry) + 3 fresh candidates.
    const jobs = new Map<string, BatchJobDoc>([
      [
        "p-1",
        {
          id: "p-1",
          primaryUrl: "https://boards.greenhouse.io/p1/jobs/1",
          companyName: "P1",
          jobTitle: "Engineer",
          status: "active",
        },
      ],
      [
        "f-1",
        {
          id: "f-1",
          primaryUrl: "https://boards.greenhouse.io/f1/jobs/1",
          companyName: "F1",
          jobTitle: "Engineer",
          status: "active",
        },
      ],
      [
        "f-2",
        {
          id: "f-2",
          primaryUrl: "https://boards.greenhouse.io/f2/jobs/2",
          companyName: "F2",
          jobTitle: "Engineer",
          status: "active",
        },
      ],
    ])
    const priority: RetryQueueEntry[] = [
      {
        jobId: "p-1",
        firstFailedAt: new Date(NOW - 2 * 24 * 3600 * 1000).toISOString(),
        lastAttemptAt: new Date(NOW - 2 * 24 * 3600 * 1000).toISOString(),
        attempts: 1,
        lastReason: "serper_miss",
      },
    ]
    const candidates: BatchJobDoc[] = [jobs.get("f-1")!, jobs.get("f-2")!]
    const sx = inMemoryStore({ jobs, priority, candidates })

    const result = await runBackfillBatch(
      baseDeps({
        store: sx.store,
        batchSize: 10,
        serperConcurrency: 2,
      })
    )

    // p-1 + f-1 + f-2 all resolve via Pass 1.
    assert.equal(result.counters.totalProcessed, 3)
    assert.equal(result.counters.pass1Count, 3)
    assert.equal(result.counters.serperCalls, 0)
    // p-1 should have its priority queue entry removed (resolved).
    assert.ok(sx.removes.includes("p-1"))
    // 3 updates written (one per resolved job).
    assert.equal(sx.updates.length, 3)
    // Audit row written.
    assert.equal(sx.audits.length, 1)
    assert.ok(sx.audits[0]?.doc.runId)
  })

  it("retry queue: miss bumps attempts; subsequent run finds it as priority", async () => {
    const counters = emptyCounters()
    const ledger = recordingLedger()
    const fresh: BatchJobDoc[] = [
      {
        id: "j1",
        primaryUrl: "https://jobright.ai/jobs/1", // not ATS
        companyName: "X",
        jobTitle: "Engineer",
        status: "active",
      },
    ]
    const jobs = new Map([["j1", fresh[0]!]])
    const sx = inMemoryStore({ jobs, candidates: fresh })

    // First run — Serper misses, no LinkedIn extractor → write retry queue.
    const r1 = await runBackfillBatch(
      baseDeps({ store: sx.store, ledger, serper: async () => null })
    )
    assert.equal(r1.counters.missCount, 1)
    assert.equal(r1.counters.retryQueueWrites, 1)
    assert.equal(sx.upserts.length, 1)
    assert.equal(sx.upserts[0]?.payload.attempts, 1)

    // Second run — priority queue picks it up, attempts bumps to 2.
    sx.candidates.length = 0 // no fresh candidates this time
    const r2 = await runBackfillBatch(
      baseDeps({ store: sx.store, ledger, serper: async () => null, now: NOW + 60_000 })
    )
    assert.equal(r2.counters.totalProcessed, 1)
    assert.equal(r2.counters.missCount, 1)
    // The 2nd upsert should reflect attempts=2.
    const last = sx.upserts[sx.upserts.length - 1]
    assert.equal(last?.payload.attempts, 2)
  })

  it("retry queue TTL: entries older than 7d cleaned up at run start", async () => {
    const oldEntry: RetryQueueEntry = {
      jobId: "stale-1",
      firstFailedAt: new Date(NOW - 8 * 24 * 3600 * 1000).toISOString(),
      lastAttemptAt: new Date(NOW - 8 * 24 * 3600 * 1000).toISOString(),
      attempts: 5,
    }
    const recentEntry: RetryQueueEntry = {
      jobId: "fresh-1",
      firstFailedAt: new Date(NOW - 1 * 24 * 3600 * 1000).toISOString(),
      lastAttemptAt: new Date(NOW - 1 * 24 * 3600 * 1000).toISOString(),
      attempts: 1,
    }
    // The fresh-1 entry's job needs to exist + still be missing atsApplyUrl
    // so the run picks it up but lacks anchors → re-bumps attempts and stays
    // in the queue. We give it a primaryUrl that's NOT an ATS host so Pass-1
    // misses; Serper returns null; outcome=miss → upsertPriorityQueue.
    const jobs = new Map<string, BatchJobDoc>([
      [
        "fresh-1",
        {
          id: "fresh-1",
          primaryUrl: "https://jobright.ai/jobs/x",
          companyName: "X",
          jobTitle: "Engineer",
          status: "active",
        },
      ],
    ])
    const sx = inMemoryStore({
      priority: [oldEntry, recentEntry],
      jobs,
    })

    const r = await runBackfillBatch(
      baseDeps({ store: sx.store, serper: async () => null })
    )
    // 1 expired entry removed via cleanup (the 7d-old stale-1).
    assert.equal(r.counters.expiredCleanups, 1)
    // fresh-1 was processed (miss) and re-upserted into priority — still there.
    const pq = await sx.store.fetchPriorityQueue(10)
    assert.equal(pq.length, 1)
    assert.equal(pq[0]?.jobId, "fresh-1")
    // attempts should have bumped from 1 → 2
    assert.equal(pq[0]?.attempts, 2)
  })

  it("concurrency cap: serperConcurrency=2 → peak parallel <=2", async () => {
    let active = 0
    let peak = 0
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const slowSerper: SerperFn = async () => {
      active++
      peak = Math.max(peak, active)
      await sleep(15)
      active--
      return null
    }
    const candidates: BatchJobDoc[] = []
    const jobs = new Map<string, BatchJobDoc>()
    for (let i = 0; i < 6; i++) {
      const j: BatchJobDoc = {
        id: `j${i}`,
        primaryUrl: "https://jobright.ai/jobs/x", // not ATS, forces Serper
        companyName: "X",
        jobTitle: "Engineer",
        status: "active",
      }
      candidates.push(j)
      jobs.set(j.id, j)
    }
    const sx = inMemoryStore({ jobs, candidates })

    await runBackfillBatch(
      baseDeps({
        store: sx.store,
        serper: slowSerper,
        serperConcurrency: 2,
      })
    )
    assert.equal(peak, 2, "peak concurrency should equal cap")
  })

  it("cost-ledger: every Serper call logs an entry (success + failure)", async () => {
    const ledger = recordingLedger()
    const candidates: BatchJobDoc[] = []
    const jobs = new Map<string, BatchJobDoc>()
    for (let i = 0; i < 3; i++) {
      const j: BatchJobDoc = {
        id: `j${i}`,
        primaryUrl: "https://jobright.ai/jobs/x",
        companyName: "X",
        jobTitle: "Engineer",
        status: "active",
      }
      candidates.push(j)
      jobs.set(j.id, j)
    }
    const sx = inMemoryStore({ jobs, candidates })

    let calls = 0
    const serper: SerperFn = async () => {
      calls++
      // First two miss, third hits.
      return calls === 3 ? "https://boards.greenhouse.io/x/3" : null
    }

    const r = await runBackfillBatch(
      baseDeps({ store: sx.store, ledger, serper })
    )
    assert.equal(r.counters.serperCalls, 3)
    assert.equal(ledger.entries.length, 3)
    const successCount = ledger.entries.filter((e) => e.success).length
    assert.equal(successCount, 1)
    for (const e of ledger.entries) {
      assert.equal(e.api, "serper")
      assert.ok(e.cost_usd > 0)
      assert.ok(e.runId?.startsWith("atsurl-"))
      assert.ok(e.ts)
    }
  })

  it("priority queue entry pointing at deleted job → entry cleared", async () => {
    const stale: RetryQueueEntry = {
      jobId: "deleted-1",
      firstFailedAt: new Date(NOW - 1 * 24 * 3600 * 1000).toISOString(),
      lastAttemptAt: new Date(NOW - 1 * 24 * 3600 * 1000).toISOString(),
      attempts: 2,
    }
    // jobs map empty → fetchJobById returns null
    const sx = inMemoryStore({ priority: [stale] })

    const r = await runBackfillBatch(baseDeps({ store: sx.store }))
    assert.ok(sx.removes.includes("deleted-1"))
    assert.equal(r.counters.retryQueueClears, 1)
  })

  it("audit row contains runId + counters", async () => {
    const sx = inMemoryStore({})
    const r = await runBackfillBatch(baseDeps({ store: sx.store }))
    assert.equal(sx.audits.length, 1)
    const audit = sx.audits[0]!
    assert.equal(audit.runId, r.runId)
    assert.ok(audit.doc.runId)
    assert.ok(audit.doc.counters)
  })

  // -------------------------------------------------------------------------
  // Track F (matching-quality launch blocker, 2026-05-20):
  // After UNRESOLVABLE_ATS_MISS_THRESHOLD failed Serper passes, the doc is
  // stamped `unresolvableAts: true` so the next job-pool-hygiene sweep can
  // flip it inactive. Without this, the 5k unresolved docs cycle through
  // Serper quota every hour with no exit.
  // -------------------------------------------------------------------------

  it("Track F: third consecutive miss marks unresolvableAts=true", async () => {
    const fresh: BatchJobDoc[] = [
      {
        id: "stuck-1",
        primaryUrl: "https://jobright.ai/jobs/1",
        companyName: "X",
        jobTitle: "Engineer",
        status: "active",
      },
    ]
    const jobs = new Map([["stuck-1", fresh[0]!]])
    const sx = inMemoryStore({ jobs, candidates: fresh })

    // Pass 1: attempts 0 → 1. Below threshold (3) → no marking.
    const r1 = await runBackfillBatch(
      baseDeps({ store: sx.store, serper: async () => null }),
    )
    assert.equal(r1.counters.missCount, 1)
    assert.equal(
      r1.counters.unresolvableMarkedCount,
      0,
      "1st miss: still under threshold",
    )
    const u1 = sx.updates.at(-1)!
    assert.equal(u1.updates.urlResolutionMissCount, 1)
    assert.equal(u1.updates.unresolvableAts, undefined)

    // Pass 2: attempts 1 → 2. Still below threshold.
    sx.candidates.length = 0
    const r2 = await runBackfillBatch(
      baseDeps({
        store: sx.store,
        serper: async () => null,
        now: NOW + 60_000,
      }),
    )
    assert.equal(r2.counters.unresolvableMarkedCount, 0)
    const u2 = sx.updates.at(-1)!
    assert.equal(u2.updates.urlResolutionMissCount, 2)
    assert.equal(u2.updates.unresolvableAts, undefined)

    // Pass 3: attempts 2 → 3. Crosses threshold → unresolvableAts=true,
    // unresolvableMarkedCount bumps.
    const r3 = await runBackfillBatch(
      baseDeps({
        store: sx.store,
        serper: async () => null,
        now: NOW + 120_000,
      }),
    )
    assert.equal(r3.counters.missCount, 1)
    assert.equal(
      r3.counters.unresolvableMarkedCount,
      1,
      "3rd miss must mark unresolvable",
    )
    const u3 = sx.updates.at(-1)!
    assert.equal(u3.updates.urlResolutionMissCount, 3)
    assert.equal(
      u3.updates.unresolvableAts,
      true,
      "matching-jobs doc must carry the marker so hygiene can read it",
    )
  })

  it("Track F: first-time miss never marks unresolvableAts", async () => {
    // Regression: fresh docs whose first Serper pass misses should NOT be
    // immediately stamped unresolvable — they still have retry budget.
    const fresh: BatchJobDoc[] = [
      {
        id: "fresh-1",
        primaryUrl: "https://jobright.ai/jobs/1",
        companyName: "X",
        jobTitle: "Engineer",
        status: "active",
      },
    ]
    const jobs = new Map([["fresh-1", fresh[0]!]])
    const sx = inMemoryStore({ jobs, candidates: fresh })

    const r = await runBackfillBatch(
      baseDeps({ store: sx.store, serper: async () => null }),
    )
    assert.equal(r.counters.missCount, 1)
    assert.equal(r.counters.unresolvableMarkedCount, 0)
    const u = sx.updates.at(-1)!
    assert.equal(u.updates.urlResolutionMissCount, 1)
    assert.equal(u.updates.unresolvableAts, undefined)
  })
})
