/**
 * Unit tests for matching-jobs-ttl-delete CF.
 *
 * Coverage:
 *   - toMillis: ISO / Timestamp-like / null / NaN
 *   - resolveAnchorMs: priority order per kind (inactive vs dead)
 *   - classifyPage:
 *       * cutoff classification with TWO thresholds (90d inactive, 365d dead)
 *       * Option D: dead doc 100d old NOT deleted (within 365d)
 *       * Option D: dead doc 400d old IS deleted
 *       * Option D: inactive doc 100d old IS deleted
 *       * defensive active-guard
 *       * skip on missing timestamps
 *       * dead+inactive doc → classified as dead (longer threshold)
 *   - runTtlDelete:
 *       * end-to-end with in-memory store, two streams, dedup
 *       * dry-run mode does NOT call batchDelete
 *       * batches sized at batchSize, throttle invoked between batches
 *       * maxDocsPerRun cap stops streaming
 *       * batch-failure isolated, errors counter bumps, run continues
 *       * default thresholds when not specified (90d inactive, 365d dead)
 *       * audit row written with dryRun flag
 *
 * Architecture: mocks `TtlStore` with an in-memory map. No firebase-admin boot.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  classifyPage,
  emptyCounters,
  resolveAnchorMs,
  runTtlDelete,
  toMillis,
  INACTIVE_TTL_DAYS_DEFAULT,
  DEAD_TTL_DAYS_DEFAULT,
  type TtlDeleteCounters,
  type TtlDeps,
  type TtlJobDoc,
  type TtlStore,
} from "../matching-jobs-ttl-delete.js"

const NOW = Date.parse("2026-05-08T00:00:00Z")
const MS_PER_DAY = 24 * 3600 * 1000
const dayAgoIso = (n: number) => new Date(NOW - n * MS_PER_DAY).toISOString()
const dayAgoTs = (n: number) => ({ toMillis: () => NOW - n * MS_PER_DAY })

// ---------------------------------------------------------------------------
// toMillis
// ---------------------------------------------------------------------------

describe("toMillis", () => {
  it("returns null for null/undefined", () => {
    assert.equal(toMillis(null), null)
    assert.equal(toMillis(undefined), null)
  })

  it("parses ISO string", () => {
    const iso = "2026-01-01T00:00:00Z"
    assert.equal(toMillis(iso), Date.parse(iso))
  })

  it("returns null for unparseable string", () => {
    assert.equal(toMillis("not-a-date"), null)
  })

  it("calls toMillis() on Timestamp-like object", () => {
    const ts = { toMillis: () => 1234567890123 }
    assert.equal(toMillis(ts), 1234567890123)
  })

  it("returns null when toMillis() throws", () => {
    const ts = {
      toMillis: () => {
        throw new Error("boom")
      },
    }
    assert.equal(toMillis(ts), null)
  })
})

// ---------------------------------------------------------------------------
// resolveAnchorMs
// ---------------------------------------------------------------------------

describe("resolveAnchorMs", () => {
  it("inactive: prefers lastSeenAt over firstSeenAt", () => {
    const job: TtlJobDoc = {
      id: "j1",
      lastSeenAt: dayAgoIso(10),
      firstSeenAt: dayAgoIso(100),
    }
    assert.equal(resolveAnchorMs(job, "inactive"), Date.parse(dayAgoIso(10)))
  })

  it("inactive: falls back to firstSeenAt when lastSeenAt missing", () => {
    const job: TtlJobDoc = { id: "j1", firstSeenAt: dayAgoIso(50) }
    assert.equal(resolveAnchorMs(job, "inactive"), Date.parse(dayAgoIso(50)))
  })

  it("inactive: returns null when both missing", () => {
    const job: TtlJobDoc = { id: "j1" }
    assert.equal(resolveAnchorMs(job, "inactive"), null)
  })

  it("dead: prefers deadCheckedAt over lastSeenAt", () => {
    const job: TtlJobDoc = {
      id: "j1",
      deadCheckedAt: dayAgoIso(20),
      lastSeenAt: dayAgoIso(40),
    }
    assert.equal(resolveAnchorMs(job, "dead"), Date.parse(dayAgoIso(20)))
  })

  it("dead: falls back to lastSeenAt when deadCheckedAt missing", () => {
    const job: TtlJobDoc = { id: "j1", lastSeenAt: dayAgoIso(40) }
    assert.equal(resolveAnchorMs(job, "dead"), Date.parse(dayAgoIso(40)))
  })

  it("dead: does NOT fall back to firstSeenAt (firstSeenAt is ingestion, not liveness)", () => {
    const job: TtlJobDoc = { id: "j1", firstSeenAt: dayAgoIso(40) }
    assert.equal(resolveAnchorMs(job, "dead"), null)
  })

  it("dead: returns null when no usable timestamp", () => {
    const job: TtlJobDoc = { id: "j1" }
    assert.equal(resolveAnchorMs(job, "dead"), null)
  })

  it("accepts Timestamp-like with toMillis()", () => {
    const job: TtlJobDoc = {
      id: "j1",
      lastSeenAt: dayAgoTs(10),
    }
    assert.equal(resolveAnchorMs(job, "inactive"), NOW - 10 * MS_PER_DAY)
  })
})

// ---------------------------------------------------------------------------
// classifyPage — Option D thresholds (90d inactive, 365d dead)
// ---------------------------------------------------------------------------

describe("classifyPage — Option D thresholds", () => {
  const inactiveCutoff = NOW - INACTIVE_TTL_DAYS_DEFAULT * MS_PER_DAY // 90d
  const deadCutoff = NOW - DEAD_TTL_DAYS_DEFAULT * MS_PER_DAY // 365d

  it("inactive 100d old: DELETE (>90d)", () => {
    const counters = emptyCounters()
    const page: TtlJobDoc[] = [
      { id: "j1", status: "inactive", lastSeenAt: dayAgoIso(100) },
    ]
    const plan = classifyPage(page, inactiveCutoff, deadCutoff, "inactive", counters)
    assert.deepEqual(plan.ids, [{ id: "j1", kind: "inactive" }])
  })

  it("inactive 80d old: KEEP (<90d)", () => {
    const counters = emptyCounters()
    const page: TtlJobDoc[] = [
      { id: "j1", status: "inactive", lastSeenAt: dayAgoIso(80) },
    ]
    const plan = classifyPage(page, inactiveCutoff, deadCutoff, "inactive", counters)
    assert.deepEqual(plan.ids, [])
  })

  it("OPTION D KEY: dead 100d old: KEEP (<365d, NOT 90d threshold)", () => {
    // This is THE option-D check — confirms we're not using 90/90.
    const counters = emptyCounters()
    const page: TtlJobDoc[] = [
      {
        id: "j1",
        status: "inactive",
        dead: true,
        deadCheckedAt: dayAgoIso(100),
      },
    ]
    const plan = classifyPage(page, inactiveCutoff, deadCutoff, "dead", counters)
    assert.deepEqual(
      plan.ids,
      [],
      "100d-old dead doc must NOT be deleted under Option D (365d threshold)",
    )
  })

  it("OPTION D KEY: dead 400d old: DELETE (>365d)", () => {
    const counters = emptyCounters()
    const page: TtlJobDoc[] = [
      {
        id: "j1",
        status: "inactive",
        dead: true,
        deadCheckedAt: dayAgoIso(400),
      },
    ]
    const plan = classifyPage(page, inactiveCutoff, deadCutoff, "dead", counters)
    assert.deepEqual(plan.ids, [{ id: "j1", kind: "dead" }])
  })

  it("OPTION D KEY: dead 360d old: KEEP (just inside 365d window)", () => {
    const counters = emptyCounters()
    const page: TtlJobDoc[] = [
      {
        id: "j1",
        status: "inactive",
        dead: true,
        deadCheckedAt: dayAgoIso(360),
      },
    ]
    const plan = classifyPage(page, inactiveCutoff, deadCutoff, "dead", counters)
    assert.deepEqual(plan.ids, [])
  })

  it("dead+inactive doc: classified as DEAD (longer threshold = more conservative)", () => {
    // 100d old, dead=true, status=inactive. Inactive threshold (90d) would
    // delete it, but dead threshold (365d) protects it. We classify under
    // dead → keep.
    const counters = emptyCounters()
    const page: TtlJobDoc[] = [
      {
        id: "j1",
        status: "inactive",
        dead: true,
        deadCheckedAt: dayAgoIso(100),
        lastSeenAt: dayAgoIso(100),
      },
    ]
    const plan = classifyPage(page, inactiveCutoff, deadCutoff, "inactive", counters)
    assert.deepEqual(
      plan.ids,
      [],
      "doc that is BOTH dead and inactive must use the dead (365d) threshold",
    )
  })

  it("defensive: refuses to delete status=active && dead!==true", () => {
    const counters = emptyCounters()
    const page: TtlJobDoc[] = [
      {
        id: "j1",
        status: "active",
        dead: false,
        lastSeenAt: dayAgoIso(500),
      },
    ]
    const plan = classifyPage(page, inactiveCutoff, deadCutoff, "inactive", counters)
    assert.deepEqual(plan.ids, [])
    assert.equal(counters.skipped_active_guard, 1)
  })

  it("inactive doc with no timestamps: skip with skipped_no_timestamp counter", () => {
    const counters = emptyCounters()
    const page: TtlJobDoc[] = [{ id: "j1", status: "inactive" }]
    const plan = classifyPage(page, inactiveCutoff, deadCutoff, "inactive", counters)
    assert.deepEqual(plan.ids, [])
    assert.equal(counters.skipped_no_timestamp, 1)
  })

  it("dead doc with no timestamps: skip", () => {
    const counters = emptyCounters()
    const page: TtlJobDoc[] = [{ id: "j1", status: "inactive", dead: true }]
    const plan = classifyPage(page, inactiveCutoff, deadCutoff, "dead", counters)
    assert.deepEqual(plan.ids, [])
    assert.equal(counters.skipped_no_timestamp, 1)
  })

  it("scanned counter increments for every doc regardless of outcome", () => {
    const counters = emptyCounters()
    const page: TtlJobDoc[] = [
      { id: "j1", status: "inactive", lastSeenAt: dayAgoIso(100) }, // delete
      { id: "j2", status: "inactive", lastSeenAt: dayAgoIso(50) }, // keep
      { id: "j3", status: "active", dead: false }, // active guard
      { id: "j4", status: "inactive" }, // no timestamp
    ]
    classifyPage(page, inactiveCutoff, deadCutoff, "inactive", counters)
    assert.equal(counters.scanned, 4)
  })
})

// ---------------------------------------------------------------------------
// In-memory TtlStore for runTtlDelete tests
// ---------------------------------------------------------------------------

type StoreFixture = {
  store: TtlStore
  inactiveDocs: TtlJobDoc[]
  deadDocs: TtlJobDoc[]
  deletes: string[][]
  audits: Array<{
    counters: TtlDeleteCounters
    runAt: string
    dryRun: boolean
  }>
}

function inMemoryStore(opts: {
  inactive: TtlJobDoc[]
  dead: TtlJobDoc[]
  failBatchN?: number
}): StoreFixture {
  const deletes: string[][] = []
  const audits: Array<{
    counters: TtlDeleteCounters
    runAt: string
    dryRun: boolean
  }> = []

  const paginate = (
    docs: TtlJobDoc[],
    pageSize: number,
    onPage: (docs: TtlJobDoc[]) => Promise<{ stop: boolean }>,
  ) =>
    (async () => {
      let i = 0
      while (i < docs.length) {
        const page = docs.slice(i, i + pageSize)
        const r = await onPage(page)
        if (r.stop) return
        i += pageSize
      }
    })()

  let batchCount = 0

  const store: TtlStore = {
    streamInactive: (pageSize, onPage) => paginate(opts.inactive, pageSize, onPage),
    streamDead: (pageSize, onPage) => paginate(opts.dead, pageSize, onPage),
    batchDelete: async (ids) => {
      batchCount++
      if (opts.failBatchN === batchCount) {
        throw new Error(`simulated batch ${batchCount} failure`)
      }
      deletes.push([...ids])
    },
    writeAudit: async (counters, runAt, dryRun) => {
      audits.push({ counters: { ...counters }, runAt, dryRun })
    },
  }

  return {
    store,
    inactiveDocs: opts.inactive,
    deadDocs: opts.dead,
    deletes,
    audits,
  }
}

const noSleep = async () => undefined

const baseDeps = (
  store: TtlStore,
  overrides: Partial<TtlDeps> = {},
): TtlDeps => ({
  store,
  now: () => NOW,
  sleep: noSleep,
  ...overrides,
})

// ---------------------------------------------------------------------------
// runTtlDelete — end-to-end
// ---------------------------------------------------------------------------

describe("runTtlDelete — end-to-end", () => {
  it("deletes only docs older than their kind-specific TTL", async () => {
    const fixture = inMemoryStore({
      inactive: [
        { id: "i_old", status: "inactive", lastSeenAt: dayAgoIso(100) }, // DELETE
        { id: "i_fresh", status: "inactive", lastSeenAt: dayAgoIso(80) }, // KEEP
        { id: "i_no_ts", status: "inactive" }, // SKIP
      ],
      dead: [
        {
          id: "d_old",
          status: "inactive",
          dead: true,
          deadCheckedAt: dayAgoIso(400),
        }, // DELETE
        {
          id: "d_fresh",
          status: "inactive",
          dead: true,
          deadCheckedAt: dayAgoIso(100),
        }, // KEEP (Option D 365d)
      ],
    })

    const counters = await runTtlDelete(baseDeps(fixture.store))
    assert.equal(counters.deleted_inactive, 1)
    assert.equal(counters.deleted_dead, 1)
    assert.equal(counters.skipped_no_timestamp, 1)
    assert.equal(counters.batches, 2)

    const allDeleted = fixture.deletes.flat().sort()
    assert.deepEqual(allDeleted, ["d_old", "i_old"])
  })

  it("dry-run mode: counts deletions but does NOT call batchDelete", async () => {
    const fixture = inMemoryStore({
      inactive: [
        { id: "i1", status: "inactive", lastSeenAt: dayAgoIso(100) },
        { id: "i2", status: "inactive", lastSeenAt: dayAgoIso(100) },
      ],
      dead: [
        {
          id: "d1",
          status: "inactive",
          dead: true,
          deadCheckedAt: dayAgoIso(400),
        },
      ],
    })

    const counters = await runTtlDelete(
      baseDeps(fixture.store, { dryRun: true }),
    )
    assert.equal(counters.deleted_inactive, 2, "counters tally as-if (dry-run)")
    assert.equal(counters.deleted_dead, 1)
    assert.equal(counters.batches, 2)
    assert.equal(fixture.deletes.length, 0, "no real batchDelete in dry-run")
    assert.equal(fixture.audits[0]?.dryRun, true)
  })

  it("dedupes docs that appear in both streams", async () => {
    // Same doc returned by both streams (shouldn't happen in prod since
    // streamDead is `where dead==true` — but the test guards behavior).
    const sharedDoc: TtlJobDoc = {
      id: "both",
      status: "inactive",
      dead: true,
      deadCheckedAt: dayAgoIso(400),
      lastSeenAt: dayAgoIso(400),
    }
    const fixture = inMemoryStore({
      inactive: [sharedDoc],
      dead: [sharedDoc],
    })

    const counters = await runTtlDelete(baseDeps(fixture.store))
    // Doc is dead → classified as dead (longer threshold = more conservative).
    // Inactive stream queues it under "dead". Dead stream skips (already queued).
    assert.equal(counters.deleted_inactive, 0)
    assert.equal(counters.deleted_dead, 1)
    assert.deepEqual(fixture.deletes.flat(), ["both"])
  })

  it("batches delete at batchSize=500", async () => {
    const inactive: TtlJobDoc[] = []
    for (let i = 0; i < 1100; i++) {
      inactive.push({
        id: `i${i}`,
        status: "inactive",
        lastSeenAt: dayAgoIso(100),
      })
    }
    const fixture = inMemoryStore({ inactive, dead: [] })

    const counters = await runTtlDelete(baseDeps(fixture.store))
    assert.equal(counters.deleted_inactive, 1100)
    // 1100 / 500 = 3 batches (500, 500, 100)
    assert.equal(counters.batches, 3)
    assert.equal(fixture.deletes[0]!.length, 500)
    assert.equal(fixture.deletes[1]!.length, 500)
    assert.equal(fixture.deletes[2]!.length, 100)
  })

  it("throttle invoked between batches (≤10 batches/sec target)", async () => {
    const inactive: TtlJobDoc[] = []
    for (let i = 0; i < 600; i++) {
      inactive.push({
        id: `i${i}`,
        status: "inactive",
        lastSeenAt: dayAgoIso(100),
      })
    }
    const sleepCalls: number[] = []
    const fixture = inMemoryStore({ inactive, dead: [] })

    await runTtlDelete(
      baseDeps(fixture.store, {
        sleep: async (ms) => {
          sleepCalls.push(ms)
        },
      }),
    )
    assert.ok(sleepCalls.length >= 2, "sleep called between batches")
    assert.ok(
      sleepCalls.every((ms) => ms === 100),
      "throttle is 100ms (10 batches/sec target)",
    )
  })

  it("respects maxDocsPerRun cap and stops streaming", async () => {
    const inactive: TtlJobDoc[] = []
    for (let i = 0; i < 1000; i++) {
      inactive.push({
        id: `i${i}`,
        status: "inactive",
        lastSeenAt: dayAgoIso(100),
      })
    }
    const fixture = inMemoryStore({ inactive, dead: [] })

    const counters = await runTtlDelete(
      baseDeps(fixture.store, { maxDocsPerRun: 300, pageSize: 100 }),
    )
    // The cap is checked AFTER each page, so we can overshoot by up to one
    // page worth (here pageSize=100). Allow 300..400 inclusive.
    assert.ok(
      counters.deleted_inactive >= 300 && counters.deleted_inactive <= 400,
      `expected 300..400 deletions, got ${counters.deleted_inactive}`,
    )
  })

  it("batch failure isolated: errors counter bumps, run continues", async () => {
    const inactive: TtlJobDoc[] = []
    for (let i = 0; i < 1100; i++) {
      inactive.push({
        id: `i${i}`,
        status: "inactive",
        lastSeenAt: dayAgoIso(100),
      })
    }
    const fixture = inMemoryStore({ inactive, dead: [], failBatchN: 2 })

    const counters = await runTtlDelete(baseDeps(fixture.store))
    assert.equal(counters.errors, 1)
    // Batch 1 + Batch 3 succeed (500 + 100 = 600 deletions). Batch 2 failed.
    assert.equal(counters.deleted_inactive, 600)
    // batches counter only bumps for SUCCESSFUL batches.
    assert.equal(counters.batches, 2)
  })

  it("uses default thresholds 90d/365d when not specified", async () => {
    const fixture = inMemoryStore({
      inactive: [
        // 89d → keep, 91d → delete
        { id: "i_keep", status: "inactive", lastSeenAt: dayAgoIso(89) },
        { id: "i_kill", status: "inactive", lastSeenAt: dayAgoIso(91) },
      ],
      dead: [
        // 364d → keep, 366d → delete
        {
          id: "d_keep",
          status: "inactive",
          dead: true,
          deadCheckedAt: dayAgoIso(364),
        },
        {
          id: "d_kill",
          status: "inactive",
          dead: true,
          deadCheckedAt: dayAgoIso(366),
        },
      ],
    })

    const counters = await runTtlDelete(baseDeps(fixture.store))
    const all = fixture.deletes.flat().sort()
    assert.deepEqual(all, ["d_kill", "i_kill"])
    assert.equal(counters.deleted_inactive, 1)
    assert.equal(counters.deleted_dead, 1)
  })

  it("custom thresholds override defaults", async () => {
    const fixture = inMemoryStore({
      inactive: [
        // With inactiveTtlDays=30, anything >30d → delete
        { id: "i", status: "inactive", lastSeenAt: dayAgoIso(40) },
      ],
      dead: [],
    })

    const counters = await runTtlDelete(
      baseDeps(fixture.store, { inactiveTtlDays: 30 }),
    )
    assert.equal(counters.deleted_inactive, 1)
  })

  it("audit row written with dryRun flag and counters", async () => {
    const fixture = inMemoryStore({
      inactive: [
        { id: "i1", status: "inactive", lastSeenAt: dayAgoIso(100) },
      ],
      dead: [],
    })

    await runTtlDelete(baseDeps(fixture.store, { dryRun: true }))
    assert.equal(fixture.audits.length, 1)
    assert.equal(fixture.audits[0]!.dryRun, true)
    assert.equal(fixture.audits[0]!.counters.deleted_inactive, 1)
  })

  it("constants: defaults match Option D (90d inactive, 365d dead)", () => {
    assert.equal(
      INACTIVE_TTL_DAYS_DEFAULT,
      90,
      "Option D inactive threshold MUST be 90d",
    )
    assert.equal(
      DEAD_TTL_DAYS_DEFAULT,
      365,
      "Option D dead threshold MUST be 365d (NOT 90d)",
    )
  })

  it("empty collections: zero deletes, zero errors", async () => {
    const fixture = inMemoryStore({ inactive: [], dead: [] })
    const counters = await runTtlDelete(baseDeps(fixture.store))
    assert.equal(counters.deleted_inactive, 0)
    assert.equal(counters.deleted_dead, 0)
    assert.equal(counters.errors, 0)
    assert.equal(counters.batches, 0)
  })

  it("structured log key 'pa.matching_jobs.ttl_delete' format", async () => {
    const fixture = inMemoryStore({
      inactive: [
        { id: "i", status: "inactive", lastSeenAt: dayAgoIso(100) },
      ],
      dead: [],
    })
    const messages: Array<{ msg: string; ctx: Record<string, unknown> }> = []
    await runTtlDelete(
      baseDeps(fixture.store, {
        log: (msg, ctx) => messages.push({ msg, ctx: ctx ?? {} }),
      }),
    )
    const start = messages.find((m) => m.msg === "ttl_delete_start")
    assert.ok(start, "start log emitted")
    assert.equal(start!.ctx.inactiveTtlDays, 90)
    assert.equal(start!.ctx.deadTtlDays, 365)
    const complete = messages.find((m) => m.msg === "ttl_delete_complete")
    assert.ok(complete, "complete log includes duration_seconds")
    assert.ok(typeof complete!.ctx.duration_seconds === "number")
  })
})
