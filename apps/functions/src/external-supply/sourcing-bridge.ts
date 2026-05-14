/**
 * V2 sourcing-bridge — fan out wekruit-pa external-supply batch + records to
 * the core-service `sourcing-api` so candidates land in the unified
 * `sourcing-source-records` collection alongside Juicebox / Coresignal /
 * GitHub-sourced rows.
 *
 * Wired from `paExternalSupplyCreateBatch` AFTER `runCreateBatch` persists
 * batch + records locally. Bridge failures are logged but do NOT fail the
 * callable — operator gets a normalized batch; next manual replay (or a
 * future Firestore-trigger CF) repairs.
 *
 * Idempotency: the wekruit-pa batch doc carries `sourcing.runId` after a
 * successful fan-out. Re-running for the same batchId is a no-op.
 *
 * HTTP API contract (see core-service `src/services/sourcing/functions/http/api.ts`):
 *   1. POST /api/sourcing/source-runs              → { runId }
 *   2. POST /api/sourcing/source-records:batchUpsert  (max 100 per call)
 *   3. POST /api/sourcing/source-runs/:runId/complete
 *
 * Records are chunked client-side at `BATCH_UPSERT_MAX = 100` to match the
 * server-side Zod cap.
 */
import type { Firestore } from "firebase-admin/firestore"
import type { ExternalCandidateRecord, ExternalSourcingBatch } from "@pa/core-types"
import { PA_COLLECTIONS } from "@pa/core-types"

const DEFAULT_SOURCING_API_BASE_URL =
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/sourcing-api"
const BATCH_UPSERT_MAX = 100
const SOURCING_DOMAIN = "wekruit-pa"
const SOURCING_NAME = "wekruit-pa-external-supply"

export interface SourcingBridgeDeps {
  /** ISO clock — injectable for tests. */
  now: () => string
  /** HTTP client — injectable for tests; defaults to global fetch. */
  fetcher: typeof fetch
  /** Logger. */
  log?: (...args: unknown[]) => void
  /** Resolved base URL (e.g. `https://...cloudfunctions.net/sourcing-api`). */
  baseUrl: string
}

export interface SourcingSyncOutcome {
  status: "synced" | "already_synced" | "failed"
  runId?: string
  recordCount?: number
  error?: string
}

interface BatchRecordsFetcher {
  /** Returns `{batch, records}` for the given batchId. */
  loadBatch: (
    batchId: string,
  ) => Promise<{ batch: ExternalSourcingBatch; records: ExternalCandidateRecord[] }>
  /** Writes `{runId, syncedAt}` to `pa-external-sourcing-batches/{batchId}.sourcing`. */
  markBatchSynced: (batchId: string, runId: string, syncedAt: string) => Promise<void>
}

/**
 * Run the bridge for a single batchId. Idempotent: if the batch already has
 * `sourcing.runId`, returns `already_synced` without HTTP calls.
 */
export async function runSourcingSync(
  batchId: string,
  io: BatchRecordsFetcher,
  deps: SourcingBridgeDeps,
): Promise<SourcingSyncOutcome> {
  const { batch, records } = await io.loadBatch(batchId)

  // Idempotency — batch doc carries sourcing.runId after first successful sync.
  const existingRunId = (batch as { sourcing?: { runId?: string } }).sourcing?.runId
  if (existingRunId) {
    deps.log?.("sourcing_bridge.skip_already_synced", { batchId, runId: existingRunId })
    return { status: "already_synced", runId: existingRunId, recordCount: records.length }
  }

  if (records.length === 0) {
    deps.log?.("sourcing_bridge.skip_empty_batch", { batchId })
    return { status: "synced", runId: "", recordCount: 0 }
  }

  // 1. Create source-run.
  const createBody = {
    sourceName: SOURCING_NAME,
    sourceDomain: SOURCING_DOMAIN,
    pipelineName: "external-supply",
    trigger: "api" as const,
    metadata: {
      wekruitPaBatchId: batchId,
      sourceTag: batch.source,
      companyId: batch.companyId ?? null,
      jobId: batch.jobId ?? null,
      importedBy: batch.importedBy,
      sha256: batch.rawFileRef.sha256,
      normalizerVersion: batch.normalizerVersion,
      rowCount: batch.rowCount,
    },
  }
  const runRes = await deps.fetcher(`${deps.baseUrl}/api/sourcing/source-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createBody),
  })
  if (!runRes.ok) {
    const errText = await safeReadBody(runRes)
    deps.log?.("sourcing_bridge.create_run_failed", { batchId, status: runRes.status, errText })
    return { status: "failed", error: `create_run_${runRes.status}_${errText}` }
  }
  const runJson = (await runRes.json()) as { runId?: string; id?: string; data?: { id?: string } }
  const runId = runJson.runId ?? runJson.id ?? runJson.data?.id
  if (!runId) {
    return { status: "failed", error: "create_run_no_id" }
  }

  // 2. batchUpsert records in chunks of BATCH_UPSERT_MAX.
  for (let i = 0; i < records.length; i += BATCH_UPSERT_MAX) {
    const chunk = records.slice(i, i + BATCH_UPSERT_MAX)
    const payload = {
      runId,
      records: chunk.map((r) => mapRecord(r, runId, batch)),
    }
    const upRes = await deps.fetcher(
      `${deps.baseUrl}/api/sourcing/source-records:batchUpsert`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    )
    if (!upRes.ok) {
      const errText = await safeReadBody(upRes)
      deps.log?.("sourcing_bridge.batch_upsert_failed", {
        batchId,
        runId,
        chunkStart: i,
        status: upRes.status,
        errText,
      })
      return { status: "failed", runId, error: `batch_upsert_${upRes.status}_${errText}` }
    }
  }

  // 3. Mark the source-run completed.
  const completeRes = await deps.fetcher(
    `${deps.baseUrl}/api/sourcing/source-runs/${encodeURIComponent(runId)}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    },
  )
  if (!completeRes.ok) {
    const errText = await safeReadBody(completeRes)
    deps.log?.("sourcing_bridge.complete_failed", {
      batchId,
      runId,
      status: completeRes.status,
      errText,
    })
    // Records did land — only marking-as-complete failed. Still write back the
    // runId so we don't re-upsert, but report partial failure.
    await io.markBatchSynced(batchId, runId, deps.now()).catch(() => {
      /* best-effort */
    })
    return { status: "failed", runId, error: `complete_${completeRes.status}` }
  }

  await io.markBatchSynced(batchId, runId, deps.now())

  deps.log?.("sourcing_bridge.synced", {
    batchId,
    runId,
    recordCount: records.length,
  })
  return { status: "synced", runId, recordCount: records.length }
}

/**
 * Map a wekruit-pa ExternalCandidateRecord → sourcing `sourceRecordUpsert`
 * payload. We never set `storagePath` (server requires `sourcing/raw/`
 * prefix; we store files under wekruit-pa GCS paths). The full record payload
 * goes into `raw` so the sourcing service has lossless evidence.
 */
function mapRecord(
  record: ExternalCandidateRecord,
  runId: string,
  batch: ExternalSourcingBatch,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    sourceRecordId: record.recordId,
    runId,
    domain: SOURCING_DOMAIN,
    source: SOURCING_NAME,
    sourceNativeId: record.recordId,
    entityType: "person",
    raw: {
      wekruitPaBatchId: batch.batchId,
      sourceTag: record.source,
      recordId: record.recordId,
      name: record.name ?? null,
      linkedinUrl: record.canonicalLinkedInUrl ?? null,
      emails: record.emails,
      phoneHash: record.phoneHash ?? null,
      currentTitle: record.currentTitle ?? null,
      currentCompany: record.currentCompany ?? null,
      location: record.location ?? null,
      experience: record.experience,
      education: record.education,
      sourceTags: record.sourceTags,
      enrichment: record.enrichment ?? null,
      identityResolutionStatus: record.identityResolutionStatus,
      resolvedUserId: record.resolvedUserId ?? null,
      reviewReasons: record.reviewReasons ?? [],
    },
  }
  if (record.name) out.displayName = record.name
  if (record.canonicalLinkedInUrl) out.sourceUrl = record.canonicalLinkedInUrl
  if (record.currentCompany) out.institution = record.currentCompany
  return out
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    const t = await res.text()
    return t.slice(0, 500)
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------
// Firestore IO wiring
// ---------------------------------------------------------------------------

export function makeSourcingBridgeIo(db: Firestore): BatchRecordsFetcher {
  return {
    async loadBatch(batchId) {
      const batchRef = db.collection(PA_COLLECTIONS.externalSourcingBatches).doc(batchId)
      const [batchSnap, recordsSnap] = await Promise.all([
        batchRef.get(),
        db
          .collection(PA_COLLECTIONS.externalCandidateRecords)
          .where("batchId", "==", batchId)
          .get(),
      ])
      if (!batchSnap.exists) {
        throw new Error(`sourcing_bridge_batch_not_found:${batchId}`)
      }
      return {
        batch: batchSnap.data() as ExternalSourcingBatch,
        records: recordsSnap.docs.map((d) => d.data() as ExternalCandidateRecord),
      }
    },
    async markBatchSynced(batchId, runId, syncedAt) {
      await db
        .collection(PA_COLLECTIONS.externalSourcingBatches)
        .doc(batchId)
        .set({ sourcing: { runId, syncedAt } }, { merge: true })
    },
  }
}

export function resolveSourcingBaseUrl(): string {
  return process.env.SOURCING_API_BASE_URL ?? DEFAULT_SOURCING_API_BASE_URL
}
