/**
 * sourcing-bridge unit tests (node:test). Drives `runSourcingSync` against a
 * mocked fetcher + in-memory IO so we can assert the HTTP fan-out contract
 * without booting firebase-admin or hitting the real sourcing-api.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import type {
  ExternalCandidateRecord,
  ExternalSourcingBatch,
} from "@pa/core-types"
import { runSourcingSync, type SourcingBridgeDeps } from "./sourcing-bridge.js"

const FIXED_NOW = "2026-05-14T18:00:00.000Z"
const BASE = "https://sourcing-api.test"

function fakeBatch(overrides: Partial<ExternalSourcingBatch> = {}): ExternalSourcingBatch {
  return {
    batchId: "batch-1",
    source: "manual_csv",
    status: "normalized",
    rowCount: 2,
    validLinkedInCount: 2,
    validEmailCount: 0,
    duplicateCount: 0,
    needsReviewCount: 0,
    readyToProfileCount: 2,
    rawFileRef: {
      storageUri: "inline://manual_csv/abc/upload.csv",
      mime: "text/csv",
      sha256: "abcdef0123456789abcdef0123456789",
      sizeBytes: 100,
    },
    normalizerVersion: "ext-norm-test",
    importedBy: "uid-test",
    meta: {},
    createdAt: FIXED_NOW,
    ...overrides,
  } as ExternalSourcingBatch
}

function fakeRecord(i: number, overrides: Partial<ExternalCandidateRecord> = {}): ExternalCandidateRecord {
  return {
    recordId: `rec-${i}`,
    batchId: "batch-1",
    source: "manual_csv",
    rawPayload: {},
    canonicalLinkedInUrl: `https://www.linkedin.com/in/test-${i}`,
    emails: [],
    name: `Test ${i}`,
    currentTitle: "Engineer",
    currentCompany: "AcmeCo",
    experience: [],
    education: [],
    location: "NYC",
    sourceTags: [],
    normalizationStatus: "ok",
    identityResolutionStatus: "pending",
    evidence: [],
    createdAt: FIXED_NOW,
    ...overrides,
  } as ExternalCandidateRecord
}

interface MockCall {
  url: string
  method: string
  body: unknown
}

function mockFetcher(plan: Array<{ status: number; body: unknown }>): {
  fetcher: typeof fetch
  calls: MockCall[]
} {
  const calls: MockCall[] = []
  let i = 0
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString()
    const body = init?.body ? JSON.parse(init.body as string) : null
    calls.push({ url, method: init?.method ?? "GET", body })
    const step = plan[i++] ?? { status: 500, body: { error: "no_plan" } }
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.body,
      text: async () => JSON.stringify(step.body),
    } as unknown as Response
  }
  return { fetcher, calls }
}

function makeIo(batch: ExternalSourcingBatch, records: ExternalCandidateRecord[]) {
  const synced: Array<{ batchId: string; runId: string; syncedAt: string }> = []
  return {
    io: {
      loadBatch: async () => ({ batch, records }),
      markBatchSynced: async (batchId: string, runId: string, syncedAt: string) => {
        synced.push({ batchId, runId, syncedAt })
      },
    },
    synced,
  }
}

function baseDeps(fetcher: typeof fetch): SourcingBridgeDeps {
  return {
    now: () => FIXED_NOW,
    fetcher,
    baseUrl: BASE,
    log: () => {
      /* silent */
    },
  }
}

test("runSourcingSync — happy path: creates run, batch-upserts, completes, marks batch", async () => {
  const batch = fakeBatch()
  const records = [fakeRecord(1), fakeRecord(2)]
  const { io, synced } = makeIo(batch, records)
  const { fetcher, calls } = mockFetcher([
    { status: 200, body: { runId: "run-XYZ" } },
    { status: 200, body: { upserted: 2 } },
    { status: 200, body: { ok: true } },
  ])

  const out = await runSourcingSync("batch-1", io, baseDeps(fetcher))

  assert.equal(out.status, "synced")
  assert.equal(out.runId, "run-XYZ")
  assert.equal(out.recordCount, 2)
  assert.deepEqual(synced, [
    { batchId: "batch-1", runId: "run-XYZ", syncedAt: FIXED_NOW },
  ])

  assert.equal(calls.length, 3)
  assert.equal(calls[0]!.url, `${BASE}/api/sourcing/source-runs`)
  assert.equal(calls[0]!.method, "POST")
  const createBody = calls[0]!.body as { sourceName: string; metadata: Record<string, unknown> }
  assert.equal(createBody.sourceName, "wekruit-pa-external-supply")
  assert.equal(createBody.metadata.wekruitPaBatchId, "batch-1")

  assert.equal(calls[1]!.url, `${BASE}/api/sourcing/source-records:batchUpsert`)
  const upsertBody = calls[1]!.body as { runId: string; records: Array<Record<string, unknown>> }
  assert.equal(upsertBody.runId, "run-XYZ")
  assert.equal(upsertBody.records.length, 2)
  assert.equal(upsertBody.records[0]!.sourceRecordId, "rec-1")
  assert.equal(upsertBody.records[0]!.entityType, "person")
  assert.equal(upsertBody.records[0]!.sourceUrl, "https://www.linkedin.com/in/test-1")
  assert.equal(upsertBody.records[0]!.displayName, "Test 1")
  assert.equal(upsertBody.records[0]!.institution, "AcmeCo")

  assert.equal(calls[2]!.url, `${BASE}/api/sourcing/source-runs/run-XYZ/complete`)
})

test("runSourcingSync — chunks records at 100 per upsert call", async () => {
  const batch = fakeBatch({ rowCount: 250 })
  const records = Array.from({ length: 250 }, (_, i) => fakeRecord(i))
  const { io } = makeIo(batch, records)
  const { fetcher, calls } = mockFetcher([
    { status: 200, body: { runId: "r" } },
    { status: 200, body: {} },
    { status: 200, body: {} },
    { status: 200, body: {} },
    { status: 200, body: { ok: true } },
  ])

  const out = await runSourcingSync("batch-1", io, baseDeps(fetcher))
  assert.equal(out.status, "synced")

  // Expect: 1 create-run + 3 batchUpsert (100+100+50) + 1 complete = 5 calls.
  assert.equal(calls.length, 5)
  const upsertChunkSizes = calls
    .slice(1, 4)
    .map((c) => (c.body as { records: unknown[] }).records.length)
  assert.deepEqual(upsertChunkSizes, [100, 100, 50])
})

test("runSourcingSync — idempotent when batch already has sourcing.runId", async () => {
  const batch = fakeBatch()
  ;(batch as unknown as { sourcing: { runId: string } }).sourcing = { runId: "prior-run" }
  const records = [fakeRecord(1)]
  const { io, synced } = makeIo(batch, records)
  const { fetcher, calls } = mockFetcher([])

  const out = await runSourcingSync("batch-1", io, baseDeps(fetcher))
  assert.equal(out.status, "already_synced")
  assert.equal(out.runId, "prior-run")
  assert.equal(calls.length, 0)
  assert.deepEqual(synced, [])
})

test("runSourcingSync — failed create-run returns failed without writing back", async () => {
  const batch = fakeBatch()
  const records = [fakeRecord(1)]
  const { io, synced } = makeIo(batch, records)
  const { fetcher, calls } = mockFetcher([{ status: 500, body: { error: "boom" } }])

  const out = await runSourcingSync("batch-1", io, baseDeps(fetcher))
  assert.equal(out.status, "failed")
  assert.match(out.error ?? "", /create_run_500/)
  assert.equal(calls.length, 1)
  assert.deepEqual(synced, [])
})

test("runSourcingSync — batchUpsert failure on chunk 2 returns failed mid-way", async () => {
  const batch = fakeBatch({ rowCount: 150 })
  const records = Array.from({ length: 150 }, (_, i) => fakeRecord(i))
  const { io, synced } = makeIo(batch, records)
  const { fetcher, calls } = mockFetcher([
    { status: 200, body: { runId: "r" } },
    { status: 200, body: {} }, // chunk 1 ok
    { status: 503, body: { error: "throttled" } }, // chunk 2 fail
  ])

  const out = await runSourcingSync("batch-1", io, baseDeps(fetcher))
  assert.equal(out.status, "failed")
  assert.equal(out.runId, "r")
  assert.match(out.error ?? "", /batch_upsert_503/)
  // 3 calls made (run-create, chunk1, chunk2); no complete, no mark synced.
  assert.equal(calls.length, 3)
  assert.deepEqual(synced, [])
})

test("runSourcingSync — empty batch is a no-op success", async () => {
  const batch = fakeBatch({ rowCount: 0 })
  const { io, synced } = makeIo(batch, [])
  const { fetcher, calls } = mockFetcher([])

  const out = await runSourcingSync("batch-1", io, baseDeps(fetcher))
  assert.equal(out.status, "synced")
  assert.equal(out.recordCount, 0)
  assert.equal(calls.length, 0)
  assert.deepEqual(synced, [])
})
