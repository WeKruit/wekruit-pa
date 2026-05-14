/**
 * v2.0 External Supply V1 — Wave B import callables.
 *
 * Two admin-only callables:
 *
 *  1. `paExternalSupplyCreateBatchUploadUrl` returns a Firebase Storage v4
 *     signed PUT URL the operator uploads the raw file to. Idempotent on
 *     `(sha256, source)`.
 *
 *  2. `paExternalSupplyCreateBatch` downloads the already-uploaded file,
 *     dispatches to the right source adapter, normalizes + dedupes, then
 *     writes the batch doc + N record docs in chunked Firestore batches
 *     (max 500 writes per commit). Idempotent on `(sha256, source)` — a
 *     second call returns the existing batch.
 *
 * Auth: admin-only via `authorizeAdminCallable` from `promote-sandbox-tag.ts`
 * (Firebase Auth custom claim `admin === true` OR `PA_ADMIN_TOKEN` fallback).
 *
 * Architecture: handler logic lives in `runCreateBatch` (deps-injected) so
 * unit tests can drive it against an in-memory Firestore + stub Storage
 * without booting firebase-admin. The CF wrappers below are thin shims.
 */
import { randomUUID } from "node:crypto"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"
import { getStorage } from "firebase-admin/storage"
import { z } from "zod"
import type { Firestore } from "firebase-admin/firestore"
import {
  ExternalSourceSchema,
  PA_COLLECTIONS,
  type ExternalSource,
  type ExternalSourcingBatch,
  type ExternalCandidateRecord,
} from "@pa/core-types"
import { dedupeWithinBatch } from "@pa/external-supply"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"
import { getAdapter } from "./adapters/registry.js"
import type { ManualCsvColumnMapping } from "./adapters/manual-csv.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

/** Bump when the normalize pipeline / adapter dispatch logic changes. */
export const NORMALIZER_VERSION = "ext-norm-2026-05-A"

/** Max writes per Firestore commit (Admin SDK limit is 500). */
const FIRESTORE_BATCH_MAX = 500

/** Signed-URL TTL — 15 minutes is plenty for the operator click flow. */
const SIGNED_URL_TTL_MS = 15 * 60_000

// ---------------------------------------------------------------------------
// Storage path helpers
// ---------------------------------------------------------------------------

const MIME_EXT: Record<string, string> = {
  "application/json": "json",
  "application/csv": "csv",
  "text/csv": "csv",
  "text/plain": "txt",
  "application/vnd.ms-excel": "xlsx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
}

function pickExtension(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? "bin"
}

export function batchStoragePath(source: ExternalSource, sha256: string, mime: string): string {
  return `external-supply/batches/${source}/${sha256}.${pickExtension(mime)}`
}

// ---------------------------------------------------------------------------
// Adapter dispatch
// ---------------------------------------------------------------------------

export interface AdapterResult {
  drafts: Array<Omit<ExternalCandidateRecord, "recordId" | "batchId" | "createdAt">>
  adapterVersion: string
  rawHeaderSample?: string
}

/**
 * Adapter dispatch — looks up the adapter descriptor by source and runs its
 * `parse()` against the raw buffer. Exported (additive) so the preview
 * callable can reuse the exact same dispatch path without re-implementing.
 * No behaviour change vs the prior private function.
 */
export function dispatchAdapter(
  source: ExternalSource,
  raw: Buffer,
  columnMapping: ManualCsvColumnMapping | undefined,
): AdapterResult {
  const descriptor = getAdapter(source)
  const drafts = descriptor.parse(raw, columnMapping)
  const rawHeaderSample = descriptor.signature.acceptedShapes.includes("csv")
    ? raw.toString("utf8").split(/\r?\n/, 1)[0]
    : undefined
  return { drafts, adapterVersion: descriptor.adapterVersion, rawHeaderSample }
}

// ---------------------------------------------------------------------------
// Pure handler — deps-injected for tests
// ---------------------------------------------------------------------------

export interface CreateBatchInput {
  source: ExternalSource
  storageUri: string
  sha256: string
  mime: string
  sizeBytes: number
  companyId?: string
  jobId?: string
  columnMapping?: ManualCsvColumnMapping
  importedBy: string
}

export interface CreateBatchResult {
  batchId: string
  rowCount: number
  validLinkedInCount: number
  validEmailCount: number
  duplicateCount: number
  needsReviewCount: number
  readyToProfileCount: number
  status: "normalized" | "already_normalized"
}

export interface CreateBatchDeps {
  /** Stream the raw file bytes from Storage. */
  downloadFile: (storageUri: string) => Promise<Buffer>
  /**
   * Find any existing batch with the same `(sha256, source)` so we can
   * short-circuit. Returns `null` if absent.
   */
  findExistingBatch: (
    source: ExternalSource,
    sha256: string,
  ) => Promise<{ batchId: string; data: ExternalSourcingBatch } | null>
  /** Atomically write `batch` doc + N `record` docs (chunked to 500). */
  writeBatchAndRecords: (
    batch: ExternalSourcingBatch,
    records: ExternalCandidateRecord[],
  ) => Promise<void>
  /** ISO timestamp factory (injectable for tests). */
  now: () => string
  /** UUID factory (injectable for tests). */
  newId: () => string
  log?: (...args: unknown[]) => void
}

export async function runCreateBatch(
  input: CreateBatchInput,
  deps: CreateBatchDeps,
): Promise<CreateBatchResult> {
  // Idempotency — if a batch with the same `(sha256, source)` exists,
  // return its existing stats. Operators occasionally re-click; we don't
  // want to double-write.
  const existing = await deps.findExistingBatch(input.source, input.sha256)
  if (existing) {
    deps.log?.("pa.external_supply.create_batch.idempotent_hit", {
      batchId: existing.batchId,
      source: input.source,
    })
    const e = existing.data
    return {
      batchId: existing.batchId,
      rowCount: e.rowCount,
      validLinkedInCount: e.validLinkedInCount,
      validEmailCount: e.validEmailCount,
      duplicateCount: e.duplicateCount,
      needsReviewCount: e.needsReviewCount,
      readyToProfileCount: e.readyToProfileCount,
      status: "already_normalized",
    }
  }

  // Download + adapter dispatch.
  const raw = await deps.downloadFile(input.storageUri)
  const { drafts, adapterVersion, rawHeaderSample } = dispatchAdapter(
    input.source,
    raw,
    input.columnMapping,
  )

  // Dedupe within batch.
  const dedupe = dedupeWithinBatch(drafts)

  // Compute stats off the kept rows.
  const validLinkedInCount = dedupe.kept.filter((r) => Boolean(r.canonicalLinkedInUrl)).length
  const validEmailCount = dedupe.kept.filter((r) => r.emails.length > 0).length
  const readyToProfileCount = dedupe.kept.filter(
    (r) => Boolean(r.canonicalLinkedInUrl) || r.emails.length > 0,
  ).length

  const batchId = deps.newId()
  const createdAt = deps.now()

  // Materialize record docs.
  const records: ExternalCandidateRecord[] = dedupe.kept.map((draft) => ({
    recordId: deps.newId(),
    batchId,
    createdAt,
    ...draft,
  }))

  const batch: ExternalSourcingBatch = {
    batchId,
    source: input.source,
    status: "normalized",
    rowCount: drafts.length,
    validLinkedInCount,
    validEmailCount,
    duplicateCount: dedupe.duplicateCount,
    needsReviewCount: 0, // C populates after identity resolution.
    readyToProfileCount,
    rawFileRef: {
      storageUri: input.storageUri,
      mime: input.mime,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
    },
    normalizerVersion: NORMALIZER_VERSION,
    importedBy: input.importedBy,
    meta: {
      adapterVersion,
      columnMapping: input.columnMapping ?? null,
      rawHeaderSample: rawHeaderSample ?? null,
      duplicateIndexes: dedupe.duplicateIndexes,
    },
    createdAt,
  }
  if (input.companyId) batch.companyId = input.companyId
  if (input.jobId) batch.jobId = input.jobId

  await deps.writeBatchAndRecords(batch, records)

  deps.log?.("pa.external_supply.create_batch.normalized", {
    batchId,
    source: input.source,
    rowCount: batch.rowCount,
    duplicateCount: batch.duplicateCount,
  })

  return {
    batchId,
    rowCount: batch.rowCount,
    validLinkedInCount,
    validEmailCount,
    duplicateCount: dedupe.duplicateCount,
    needsReviewCount: 0,
    readyToProfileCount,
    status: "normalized",
  }
}

// ---------------------------------------------------------------------------
// Firestore deps wiring
// ---------------------------------------------------------------------------

export function makeFirestoreDeps(db: Firestore): Pick<
  CreateBatchDeps,
  "findExistingBatch" | "writeBatchAndRecords"
> {
  return {
    async findExistingBatch(source, sha256) {
      const q = await db
        .collection(PA_COLLECTIONS.externalSourcingBatches)
        .where("rawFileRef.sha256", "==", sha256)
        .where("source", "==", source)
        .limit(1)
        .get()
      if (q.empty) return null
      const doc = q.docs[0]!
      return {
        batchId: doc.id,
        data: doc.data() as ExternalSourcingBatch,
      }
    },
    async writeBatchAndRecords(batch, records) {
      // 1 batch doc + N record docs, max 500 per commit. We always commit
      // the batch doc in the *first* commit so subsequent record commits
      // can reference it.
      const batchesCol = db.collection(PA_COLLECTIONS.externalSourcingBatches)
      const recordsCol = db.collection(PA_COLLECTIONS.externalCandidateRecords)

      const commits: Array<Promise<unknown>> = []

      let pending = db.batch()
      let pendingCount = 0
      pending.set(batchesCol.doc(batch.batchId), batch)
      pendingCount += 1

      for (const rec of records) {
        if (pendingCount >= FIRESTORE_BATCH_MAX) {
          commits.push(pending.commit())
          pending = db.batch()
          pendingCount = 0
        }
        pending.set(recordsCol.doc(rec.recordId), rec)
        pendingCount += 1
      }
      if (pendingCount > 0) {
        commits.push(pending.commit())
      }
      await Promise.all(commits)
    },
  }
}

// ---------------------------------------------------------------------------
// Callable: paExternalSupplyCreateBatchUploadUrl
// ---------------------------------------------------------------------------

const CreateUploadUrlInputSchema = z.object({
  sha256: z.string().min(32),
  mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  source: ExternalSourceSchema,
  adminToken: z.string().optional(),
})

/**
 * Returns a Firebase Storage signed-PUT URL for the operator to upload the
 * raw export file. Storage path is keyed on `(source, sha256)` so duplicate
 * uploads land at the same blob.
 *
 * Idempotent — calling this twice with the same `(sha256, source)` returns
 * a fresh signed URL pointing at the same blob.
 */
export const paExternalSupplyCreateBatchUploadUrl = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req) => {
    // 2026-05-14 hotfix: switched from `authorizeAdminCallable` (custom claim
    // + PA_ADMIN_TOKEN) to `requireExternalSupplyAdmin` (@wekruit.com email
    // check) so the auth is consistent with every other external-supply CF.
    requireExternalSupplyAdmin(req.auth)
    const parsed = CreateUploadUrlInputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }
    const { sha256, mime, source } = parsed.data

    const path = batchStoragePath(source, sha256, mime)
    const bucket = getStorage().bucket()
    const file = bucket.file(path)
    const [signedUrl] = await file.getSignedUrl({
      action: "write",
      version: "v4",
      expires: Date.now() + SIGNED_URL_TTL_MS,
      contentType: mime,
    })

    const storageUri = `gs://${bucket.name}/${path}`
    logger.info("[external-supply.upload_url]", { storageUri, source })
    return { storageUri, signedUrl }
  },
)

// ---------------------------------------------------------------------------
// Callable: paExternalSupplyCreateBatch
// ---------------------------------------------------------------------------

const CreateBatchInputSchema = z.object({
  source: ExternalSourceSchema,
  storageUri: z.string().min(1),
  sha256: z.string().min(32),
  mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  companyId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  columnMapping: z
    .object({
      linkedinUrl: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      name: z.string().optional(),
      currentTitle: z.string().optional(),
      currentCompany: z.string().optional(),
      location: z.string().optional(),
      skills: z.string().optional(),
    })
    .optional(),
  adminToken: z.string().optional(),
})

/**
 * Downloads the uploaded file from Storage, dispatches to the right adapter,
 * normalizes + dedupes, persists batch + records.
 */
export const paExternalSupplyCreateBatch = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 300,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req): Promise<CreateBatchResult> => {
    // 2026-05-14 hotfix: same auth alignment as createBatchUploadUrl above.
    const { uid } = requireExternalSupplyAdmin(req.auth)
    const parsed = CreateBatchInputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }

    const db = getFirestore()
    const firestoreDeps = makeFirestoreDeps(db)

    const out = await runCreateBatch(
      {
        source: parsed.data.source,
        storageUri: parsed.data.storageUri,
        sha256: parsed.data.sha256,
        mime: parsed.data.mime,
        sizeBytes: parsed.data.sizeBytes,
        companyId: parsed.data.companyId,
        jobId: parsed.data.jobId,
        columnMapping: parsed.data.columnMapping,
        importedBy: uid,
      },
      {
        ...firestoreDeps,
        downloadFile: async (storageUri) => {
          // gs://<bucket>/<path>
          const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(storageUri)
          if (!m) throw new HttpsError("invalid-argument", "storage_uri_invalid")
          const [, bucketName, objectPath] = m
          const file = getStorage().bucket(bucketName!).file(objectPath!)
          const [buf] = await file.download()
          return buf
        },
        now: () => new Date().toISOString(),
        newId: () => randomUUID(),
        log: (...args) => logger.info("[external-supply]", ...args),
      },
    )

    return out
  },
)
