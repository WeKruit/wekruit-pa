/**
 * Wave B import callable tests — drives `runCreateBatch` against an
 * in-memory Firestore + stub Storage. Mirrors the pattern in
 * `packages/pa-persistence/src/identity.test.ts`.
 */
import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  PA_COLLECTIONS,
  ExternalSourcingBatchSchema,
  ExternalCandidateRecordSchema,
  type ExternalSource,
  type ExternalSourcingBatch,
  type ExternalCandidateRecord,
} from "@pa/core-types"
import {
  runCreateBatch,
  NORMALIZER_VERSION,
  batchStoragePath,
  type CreateBatchDeps,
} from "./import.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "../../../..")

function loadFixture(name: string): Buffer {
  return fs.readFileSync(path.join(REPO_ROOT, "tests/fixtures/external-supply", name))
}

// ---------------------------------------------------------------------------
// In-memory deps factory
// ---------------------------------------------------------------------------

interface InMemoryStore {
  batches: Map<string, ExternalSourcingBatch>
  records: Map<string, ExternalCandidateRecord>
  blobs: Map<string, Buffer>
}

function makeStore(): InMemoryStore {
  return {
    batches: new Map(),
    records: new Map(),
    blobs: new Map(),
  }
}

interface MakeDepsOpts {
  store: InMemoryStore
  now?: () => string
  idCounter?: { value: number }
}

function makeInMemoryDeps(opts: MakeDepsOpts): CreateBatchDeps {
  const idCounter = opts.idCounter ?? { value: 0 }
  const now = opts.now ?? (() => "2026-05-13T12:00:00.000Z")
  return {
    async downloadFile(storageUri) {
      const buf = opts.store.blobs.get(storageUri)
      if (!buf) throw new Error(`storage_blob_missing:${storageUri}`)
      return buf
    },
    async findExistingBatch(source, sha256) {
      for (const [batchId, data] of opts.store.batches.entries()) {
        if (data.source === source && data.rawFileRef.sha256 === sha256) {
          return { batchId, data }
        }
      }
      return null
    },
    async writeBatchAndRecords(batch, records) {
      opts.store.batches.set(batch.batchId, batch)
      for (const rec of records) {
        opts.store.records.set(rec.recordId, rec)
      }
    },
    now,
    newId: () => `id_${++idCounter.value}`,
  }
}

function shaOfFixture(buf: Buffer, prefix: string): string {
  // crypto isn't strictly needed — we just need 32+ chars unique per fixture.
  return `${prefix}_${buf.length.toString(16).padStart(8, "0")}__sha256_64_chars_padding_${"0".repeat(20)}`
}

function stageBlob(store: InMemoryStore, source: ExternalSource, fixture: Buffer, mime: string): {
  storageUri: string
  sha256: string
  sizeBytes: number
} {
  const sha256 = shaOfFixture(fixture, source)
  const storageUri = `gs://test-bucket/${batchStoragePath(source, sha256, mime)}`
  store.blobs.set(storageUri, fixture)
  return { storageUri, sha256, sizeBytes: fixture.length }
}

// ---------------------------------------------------------------------------
// Happy path — Juicebox fixture (6 rows)
// ---------------------------------------------------------------------------

test("runCreateBatch — Juicebox fixture lands batch + records with correct stats", async () => {
  const store = makeStore()
  const fixture = loadFixture("juicebox-sample.json")
  const { storageUri, sha256, sizeBytes } = stageBlob(store, "juicebox", fixture, "application/json")
  const deps = makeInMemoryDeps({ store })

  const out = await runCreateBatch(
    {
      source: "juicebox",
      storageUri,
      sha256,
      mime: "application/json",
      sizeBytes,
      importedBy: "test-operator",
    },
    deps,
  )

  // 6 rows in fixture: 3 LinkedIn+email, 1 LinkedIn-only, 1 email-only,
  // 1 both invalid → 5 ready-to-profile, 1 failed. No duplicates.
  assert.equal(out.rowCount, 6)
  assert.equal(out.duplicateCount, 0)
  assert.equal(out.validLinkedInCount, 4)
  assert.equal(out.validEmailCount, 4)
  assert.equal(out.readyToProfileCount, 5)
  assert.equal(out.status, "normalized")

  // Batch doc lands.
  const batch = store.batches.get(out.batchId)
  assert.ok(batch, "batch doc should be written")
  assert.equal(batch!.normalizerVersion, NORMALIZER_VERSION)
  assert.equal(batch!.status, "normalized")
  assert.equal(batch!.meta!.adapterVersion, "juicebox-2026-05-A")
  // Schema round-trip — every persisted batch must pass Zod.
  ExternalSourcingBatchSchema.parse(batch)

  // Record docs land.
  const recs = Array.from(store.records.values()).filter((r) => r.batchId === out.batchId)
  assert.equal(recs.length, 6)
  for (const r of recs) {
    ExternalCandidateRecordSchema.parse(r)
    assert.equal(r.source, "juicebox")
    assert.equal(r.identityResolutionStatus, "pending")
  }
  // The 'Anonymous Candidate' row should be `failed`.
  const failed = recs.find((r) => r.normalizationStatus === "failed")
  assert.ok(failed, "row with both invalid LinkedIn + email should be `failed`")
  assert.deepEqual(failed!.normalizationErrors?.sort(), ["email_invalid", "linkedin_url_invalid"].sort())
})

// ---------------------------------------------------------------------------
// Idempotency — second call returns existing batch without re-writing
// ---------------------------------------------------------------------------

test("runCreateBatch — idempotent on (sha256, source)", async () => {
  const store = makeStore()
  const fixture = loadFixture("juicebox-sample.json")
  const { storageUri, sha256, sizeBytes } = stageBlob(store, "juicebox", fixture, "application/json")

  const deps1 = makeInMemoryDeps({ store, idCounter: { value: 0 } })
  const first = await runCreateBatch(
    { source: "juicebox", storageUri, sha256, mime: "application/json", sizeBytes, importedBy: "op" },
    deps1,
  )
  assert.equal(first.status, "normalized")

  const recordCountAfterFirst = store.records.size
  const batchCountAfterFirst = store.batches.size

  // Second call with same sha256/source → returns existing, no new writes.
  const deps2 = makeInMemoryDeps({ store, idCounter: { value: 100 } })
  const second = await runCreateBatch(
    { source: "juicebox", storageUri, sha256, mime: "application/json", sizeBytes, importedBy: "op" },
    deps2,
  )

  assert.equal(second.status, "already_normalized")
  assert.equal(second.batchId, first.batchId)
  assert.equal(store.records.size, recordCountAfterFirst, "no new record writes")
  assert.equal(store.batches.size, batchCountAfterFirst, "no new batch writes")
  // Stats round-trip from the existing batch.
  assert.equal(second.rowCount, first.rowCount)
  assert.equal(second.readyToProfileCount, first.readyToProfileCount)
})

// ---------------------------------------------------------------------------
// Adapter dispatch — Lessie CSV
// ---------------------------------------------------------------------------

test("runCreateBatch — Lessie CSV fixture", async () => {
  const store = makeStore()
  const fixture = loadFixture("lessie-sample.csv")
  const { storageUri, sha256, sizeBytes } = stageBlob(store, "lessie", fixture, "text/csv")
  const deps = makeInMemoryDeps({ store })

  const out = await runCreateBatch(
    { source: "lessie", storageUri, sha256, mime: "text/csv", sizeBytes, importedBy: "op" },
    deps,
  )

  // 6 rows: 3 LinkedIn+email, 1 email-only, 1 LinkedIn-only, 1 both invalid.
  assert.equal(out.rowCount, 6)
  // Valid LinkedIn count = rows with canonicalLinkedInUrl set.
  assert.equal(out.validLinkedInCount, 4)
  // Valid email = rows with at least one normalized email.
  assert.equal(out.validEmailCount, 4)
  assert.equal(out.readyToProfileCount, 5)

  const batch = store.batches.get(out.batchId)
  assert.ok(batch)
  assert.equal(batch!.meta!.adapterVersion, "lessie-2026-05-A")
  assert.ok(batch!.meta!.rawHeaderSample, "lessie batch records header sample for audit")
})

// ---------------------------------------------------------------------------
// Adapter dispatch — Coresignal JSON
// ---------------------------------------------------------------------------

test("runCreateBatch — Coresignal JSON fixture", async () => {
  const store = makeStore()
  const fixture = loadFixture("coresignal-sample.json")
  const { storageUri, sha256, sizeBytes } = stageBlob(store, "coresignal", fixture, "application/json")
  const deps = makeInMemoryDeps({ store })

  const out = await runCreateBatch(
    { source: "coresignal", storageUri, sha256, mime: "application/json", sizeBytes, importedBy: "op" },
    deps,
  )

  // 6 rows: 3 LinkedIn+email, 1 LinkedIn-only, 1 email-only, 1 both broken.
  assert.equal(out.rowCount, 6)
  assert.equal(out.validLinkedInCount, 4)
  assert.equal(out.validEmailCount, 4)
  // readyToProfile = 5 (the both-broken row drops out).
  assert.equal(out.readyToProfileCount, 5)

  const batch = store.batches.get(out.batchId)
  assert.equal(batch!.meta!.adapterVersion, "coresignal-2026-05-A")

  // Coresignal carries phone for some rows — verify phoneHash flows through.
  const recs = Array.from(store.records.values()).filter((r) => r.batchId === out.batchId)
  const withPhone = recs.filter((r) => r.phoneHash)
  assert.ok(withPhone.length >= 1, "coresignal fixture has rows with phone numbers")
})

// ---------------------------------------------------------------------------
// Adapter dispatch — manual CSV requires columnMapping
// ---------------------------------------------------------------------------

test("runCreateBatch — manual_csv routes through manual adapter with operator columnMapping", async () => {
  const store = makeStore()
  // Re-use the Lessie CSV but route it through manual_csv with operator mapping.
  const fixture = loadFixture("lessie-sample.csv")
  const { storageUri, sha256, sizeBytes } = stageBlob(store, "manual_csv", fixture, "text/csv")
  const deps = makeInMemoryDeps({ store })

  const out = await runCreateBatch(
    {
      source: "manual_csv",
      storageUri,
      sha256,
      mime: "text/csv",
      sizeBytes,
      importedBy: "op",
      columnMapping: {
        linkedinUrl: "LinkedIn URL",
        email: "Email",
        name: "Name",
        currentTitle: "Title",
        currentCompany: "Company",
        location: "Location",
      },
    },
    deps,
  )

  assert.equal(out.rowCount, 6)
  assert.equal(out.readyToProfileCount, 5)

  const batch = store.batches.get(out.batchId)
  assert.equal(batch!.meta!.adapterVersion, "manual-csv-2026-05-B")
  const persistedMapping = batch!.meta!.columnMapping as Record<string, string>
  assert.equal(persistedMapping.linkedinUrl, "LinkedIn URL")
})

// ---------------------------------------------------------------------------
// Adapter dispatch — manual_csv v2 auto-infers columnMapping from headers
// ---------------------------------------------------------------------------

test("runCreateBatch — manual_csv auto-infers mapping when caller omits it", async () => {
  // v2 (2026-05-14): the loose adapter auto-detects 6 stable Lessie headers
  // from the row, so omitting columnMapping is no longer a hard failure.
  // The fixture's `LinkedIn URL` / `Email` headers should resolve via the
  // inference path and yield a normalized batch.
  const store = makeStore()
  const fixture = loadFixture("lessie-sample.csv")
  const { storageUri, sha256, sizeBytes } = stageBlob(store, "manual_csv", fixture, "text/csv")
  const deps = makeInMemoryDeps({ store })

  const out = await runCreateBatch(
    {
      source: "manual_csv",
      storageUri,
      sha256,
      mime: "text/csv",
      sizeBytes,
      importedBy: "op",
    },
    deps,
  )
  assert.ok(out.rowCount >= 1, "auto-inferred batch should normalize at least one row")
  assert.equal(store.batches.size, 1)
})

test("runCreateBatch — manual_csv throws when neither linkedin nor email is resolvable", async () => {
  // Header set with no canonical identity column should still fail loudly.
  const store = makeStore()
  const csv = Buffer.from("a,b,c\n1,2,3")
  const { storageUri, sha256, sizeBytes } = stageBlob(store, "manual_csv", csv, "text/csv")
  const deps = makeInMemoryDeps({ store })

  await assert.rejects(
    runCreateBatch(
      {
        source: "manual_csv",
        storageUri,
        sha256,
        mime: "text/csv",
        sizeBytes,
        importedBy: "op",
      },
      deps,
    ),
    /manual_csv_requires_linkedin_or_email_mapping/,
  )
  assert.equal(store.batches.size, 0, "failed batch must not be persisted")
})

// ---------------------------------------------------------------------------
// Storage path helper
// ---------------------------------------------------------------------------

test("batchStoragePath — picks extension by mime and namespaces by source", () => {
  assert.equal(
    batchStoragePath("juicebox", "abc123", "application/json"),
    "external-supply/batches/juicebox/abc123.json",
  )
  assert.equal(
    batchStoragePath("lessie", "abc123", "text/csv"),
    "external-supply/batches/lessie/abc123.csv",
  )
  assert.equal(
    batchStoragePath("coresignal", "abc123", "application/octet-stream"),
    "external-supply/batches/coresignal/abc123.bin",
  )
})

// ---------------------------------------------------------------------------
// PA_COLLECTIONS sanity — confirms we never persist outside the locked names
// ---------------------------------------------------------------------------

test("PA_COLLECTIONS — external-supply collections present", () => {
  assert.equal(PA_COLLECTIONS.externalSourcingBatches, "pa-external-sourcing-batches")
  assert.equal(PA_COLLECTIONS.externalCandidateRecords, "pa-external-candidate-records")
})
