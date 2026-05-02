import assert from "node:assert/strict"
import test from "node:test"
import { createHmac } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { setFlag, _clearFeatureFlagCache } from "@pa/pa-persistence"
import {
  handleMatchingPipelineComplete,
  PIPELINE_RUNS_COLLECTION,
  PIPELINE_RATE_BUCKETS_COLLECTION,
  PA_EVENTS_COLLECTION,
  MATCHING_PIPELINE_FLAG_KEY,
  HARD_LIMIT_PER_DAY,
} from "../matching-pipeline-complete.js"

// -----------------------------------------------------------------------------
// In-memory Firestore double — covers the API surface this handler uses:
// collection(c).doc(id).{get, set, add}, runTransaction(get/set).
// -----------------------------------------------------------------------------

type Store = Map<string, Map<string, Record<string, unknown>>>

function makeFakeFirestore(): Firestore {
  const store: Store = new Map()
  function getCol(name: string): Map<string, Record<string, unknown>> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }

  let autoId = 0

  const docRef = (col: string, id: string) => ({
    id,
    _col: col,
    _id: id,
    async get() {
      const data = getCol(col).get(id)
      return { exists: data !== undefined, data: () => data, id }
    },
    async set(data: Record<string, unknown>) {
      getCol(col).set(id, { ...data })
    },
    async update(data: Record<string, unknown>) {
      const cur = getCol(col).get(id) ?? {}
      getCol(col).set(id, { ...cur, ...data })
    },
  })

  function makeQuery(col: string, filters: { field?: string; val?: unknown }[] = [], lim?: number) {
    return {
      where(field: string, _op: string, val: unknown) {
        return makeQuery(col, [...filters, { field, val }], lim)
      },
      orderBy() {
        return makeQuery(col, filters, lim)
      },
      limit(n: number) {
        return makeQuery(col, filters, n)
      },
      async get() {
        const all = Array.from(getCol(col).entries())
        let rows = all.filter(([, data]) =>
          filters.every((f) => f.field == null || data[f.field] === f.val)
        )
        if (lim != null) rows = rows.slice(0, lim)
        return {
          empty: rows.length === 0,
          docs: rows.map(([id, data]) => ({ id, data: () => data })),
        }
      },
    }
  }

  const colRef = (name: string) => ({
    doc(id?: string) {
      return docRef(name, id ?? `auto_${++autoId}`)
    },
    where(field: string, op: string, val: unknown) {
      return makeQuery(name).where(field, op, val)
    },
    orderBy() {
      return makeQuery(name)
    },
    limit(n: number) {
      return makeQuery(name).limit(n)
    },
    async get() {
      const rows = Array.from(getCol(name).entries())
      return { docs: rows.map(([id, data]) => ({ id, data: () => data })) }
    },
    async add(data: Record<string, unknown>) {
      const id = `auto_${++autoId}`
      getCol(name).set(id, { ...data })
      return { id }
    },
  })

  const fs = {
    collection: (name: string) => colRef(name),
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const t = {
        async get(ref: { _col: string; _id: string }) {
          const data = getCol(ref._col).get(ref._id)
          return { exists: data !== undefined, data: () => data }
        },
        set(ref: { _col: string; _id: string }, payload: Record<string, unknown>) {
          getCol(ref._col).set(ref._id, { ...payload })
        },
        update(ref: { _col: string; _id: string }, payload: Record<string, unknown>) {
          const cur = getCol(ref._col).get(ref._id) ?? {}
          getCol(ref._col).set(ref._id, { ...cur, ...payload })
        },
      }
      return await fn(t)
    },
    _store: store,
  }
  return fs as unknown as Firestore
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const SECRET = "test-matching-secret"
const ACTOR = "test@wekruit.com"
const FIXED_NOW_MS = 1_777_000_000_000 // 2026-04-25T... fixed point

function sign(body: string, secret = SECRET) {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex")
}

function happyBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runId: "run-fixture-1",
    status: "success",
    scrapeStartedAt: "2026-05-02T10:00:00Z",
    scrapeFinishedAt: "2026-05-02T11:00:00Z",
    jobsScraped: 1200,
    jobsNew: 35,
    jobsUpdated: 200,
    jobsErrored: 0,
    costUsd: 0.42,
    sourceRepos: ["SimplifyJobs"],
    ...overrides,
  })
}

type CapturedRes = {
  status(code: number): CapturedRes
  json(body: unknown): CapturedRes
  _status: number | null
  _json: unknown
}

function makeRes(): CapturedRes {
  const r: CapturedRes = {
    _status: null,
    _json: null,
    status(code) {
      this._status = code
      return this
    },
    json(body) {
      this._json = body
      return this
    },
  }
  return r
}

async function enableFlag(db: Firestore) {
  _clearFeatureFlagCache()
  await setFlag(
    db,
    MATCHING_PIPELINE_FLAG_KEY,
    { value: true, type: "bool", scope: "global" },
    { actor: ACTOR, reason: "test setup" }
  )
}

function baseDeps(db: Firestore, overrides: Partial<Parameters<typeof handleMatchingPipelineComplete>[2]> = {}) {
  return {
    db,
    secret: SECRET,
    nowMs: () => FIXED_NOW_MS,
    nowIso: () => new Date(FIXED_NOW_MS).toISOString(),
    newId: () => "new-id-1",
    ...overrides,
  }
}

function headers(body: string, tsOverride?: number): Record<string, string> {
  return {
    "x-pa-signature": sign(body),
    "x-pa-timestamp": String(tsOverride ?? FIXED_NOW_MS),
  }
}

// -----------------------------------------------------------------------------
// Tests (6 required + 1 happy-path overlap)
// -----------------------------------------------------------------------------

test("HMAC valid → 200 + writes pa-matching-pipeline-runs doc", async () => {
  const db = makeFakeFirestore()
  await enableFlag(db)
  const body = happyBody()
  const res = makeRes()
  await handleMatchingPipelineComplete(
    { rawBody: body, headers: headers(body) },
    res,
    baseDeps(db)
  )
  assert.equal(res._status, 200)
  const payload = res._json as { ok: boolean; runId: string }
  assert.equal(payload.ok, true)
  assert.equal(payload.runId, "run-fixture-1")

  const fs = db as unknown as { _store: Store }
  const run = fs._store.get(PIPELINE_RUNS_COLLECTION)?.get("run-fixture-1") as Record<string, unknown> | undefined
  assert.ok(run, "run doc missing")
  assert.equal(run!.status, "success")
  assert.equal(run!.jobsNew, 35)
  assert.deepEqual(run!.sourceRepos, ["SimplifyJobs"])
})

test("HMAC invalid → 401 invalid_signature", async () => {
  const db = makeFakeFirestore()
  const body = happyBody()
  const res = makeRes()
  await handleMatchingPipelineComplete(
    {
      rawBody: body,
      headers: { "x-pa-signature": "deadbeef", "x-pa-timestamp": String(FIXED_NOW_MS) },
    },
    res,
    baseDeps(db)
  )
  assert.equal(res._status, 401)
  assert.deepEqual(res._json, { ok: false, error: "invalid_signature" })
})

test("Stale timestamp (>5min) → 401 stale_timestamp", async () => {
  const db = makeFakeFirestore()
  await enableFlag(db)
  const body = happyBody()
  const staleTs = FIXED_NOW_MS - 6 * 60 * 1000 // 6min ago
  const res = makeRes()
  await handleMatchingPipelineComplete(
    {
      rawBody: body,
      headers: { "x-pa-signature": sign(body), "x-pa-timestamp": String(staleTs) },
    },
    res,
    baseDeps(db)
  )
  assert.equal(res._status, 401)
  assert.deepEqual(res._json, { ok: false, error: "stale_timestamp" })
})

test("Missing required fields → 400", async () => {
  const db = makeFakeFirestore()
  await enableFlag(db)
  // status missing
  const body = JSON.stringify({
    runId: "x",
    scrapeStartedAt: "2026-05-02T10:00:00Z",
    scrapeFinishedAt: "2026-05-02T11:00:00Z",
    jobsNew: 1,
  })
  const res = makeRes()
  await handleMatchingPipelineComplete(
    { rawBody: body, headers: headers(body) },
    res,
    baseDeps(db)
  )
  assert.equal(res._status, 400)
  assert.deepEqual(res._json, { ok: false, error: "missing_or_invalid_status" })

  // missing scrapeStartedAt
  const body2 = JSON.stringify({ status: "success", scrapeFinishedAt: "2026-05-02T11:00:00Z" })
  const res2 = makeRes()
  await handleMatchingPipelineComplete(
    { rawBody: body2, headers: headers(body2) },
    res2,
    baseDeps(db)
  )
  assert.equal(res2._status, 400)
  assert.deepEqual(res2._json, { ok: false, error: "missing_or_invalid_timestamps" })
})

test("Flag off → 503 feature_disabled (no run doc written)", async () => {
  const db = makeFakeFirestore()
  _clearFeatureFlagCache()
  // intentionally no enableFlag()
  const body = happyBody()
  const res = makeRes()
  await handleMatchingPipelineComplete(
    { rawBody: body, headers: headers(body) },
    res,
    baseDeps(db)
  )
  assert.equal(res._status, 503)
  assert.deepEqual(res._json, { ok: false, error: "feature_disabled" })

  const fs = db as unknown as { _store: Store }
  const runs = fs._store.get(PIPELINE_RUNS_COLLECTION)
  assert.equal(runs?.size ?? 0, 0, "no run doc should be written when flag is off")
})

test("Rate limit hit (>24/day) → 429", async () => {
  const db = makeFakeFirestore()
  await enableFlag(db)
  // Pre-seed the day bucket counter to the hard cap.
  const fs = db as unknown as { _store: Store }
  const dayBucketId = (() => {
    const d = new Date(FIXED_NOW_MS)
    return `SimplifyJobs__day-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`
  })()
  if (!fs._store.has(PIPELINE_RATE_BUCKETS_COLLECTION)) {
    fs._store.set(PIPELINE_RATE_BUCKETS_COLLECTION, new Map())
  }
  fs._store.get(PIPELINE_RATE_BUCKETS_COLLECTION)!.set(dayBucketId, {
    count: HARD_LIMIT_PER_DAY,
    updatedAt: FIXED_NOW_MS,
  })

  const body = happyBody()
  const res = makeRes()
  await handleMatchingPipelineComplete(
    { rawBody: body, headers: headers(body) },
    res,
    baseDeps(db)
  )
  assert.equal(res._status, 429)
  const payload = res._json as { ok: boolean; error: string; hardLimitPerDay: number }
  assert.equal(payload.error, "rate_limited")
  assert.equal(payload.hardLimitPerDay, HARD_LIMIT_PER_DAY)
})

test("Success + jobsNew > 0 → emits pa-events 'matching:pipeline:completed'", async () => {
  const db = makeFakeFirestore()
  await enableFlag(db)
  const body = happyBody({ jobsNew: 7 })
  const res = makeRes()
  await handleMatchingPipelineComplete(
    { rawBody: body, headers: headers(body) },
    res,
    baseDeps(db)
  )
  assert.equal(res._status, 200)

  const fs = db as unknown as { _store: Store }
  const events = fs._store.get(PA_EVENTS_COLLECTION)
  assert.ok(events, "pa-events collection should exist")
  const rows = Array.from(events!.values())
  assert.equal(rows.length, 1, "exactly one event")
  assert.equal(rows[0].eventKind, "matching:pipeline:completed")
  assert.equal(rows[0].runId, "run-fixture-1")
  assert.equal(rows[0].jobsNew, 7)
})

test("Success but jobsNew === 0 → does NOT emit pa-events", async () => {
  const db = makeFakeFirestore()
  await enableFlag(db)
  const body = happyBody({ jobsNew: 0 })
  const res = makeRes()
  await handleMatchingPipelineComplete(
    { rawBody: body, headers: headers(body) },
    res,
    baseDeps(db)
  )
  assert.equal(res._status, 200)

  const fs = db as unknown as { _store: Store }
  const events = fs._store.get(PA_EVENTS_COLLECTION)
  assert.equal(events?.size ?? 0, 0, "no event should be emitted when jobsNew=0")
})

test("Failed status → 200 + run doc + no event emitted", async () => {
  const db = makeFakeFirestore()
  await enableFlag(db)
  const body = happyBody({ status: "failed", error: "scrape_blew_up", jobsNew: 0 })
  const res = makeRes()
  await handleMatchingPipelineComplete(
    { rawBody: body, headers: headers(body) },
    res,
    baseDeps(db)
  )
  assert.equal(res._status, 200)
  const fs = db as unknown as { _store: Store }
  const run = fs._store.get(PIPELINE_RUNS_COLLECTION)?.get("run-fixture-1") as Record<string, unknown> | undefined
  assert.ok(run)
  assert.equal(run!.status, "failed")
  assert.equal(run!.error, "scrape_blew_up")
  const events = fs._store.get(PA_EVENTS_COLLECTION)
  assert.equal(events?.size ?? 0, 0)
})
