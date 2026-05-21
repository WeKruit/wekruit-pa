/**
 * v2.1 — CoreSignal cdapi v2 collect batch fetch callable.
 *
 * Operator pastes a list of CoreSignal candidate IDs in the dashboard.
 * This callable fans out to the live `employee_multi_source/collect/{id}`
 * endpoint with a worker pool, then composes the fetched JSON payloads into
 * a single inline batch that flows through the SAME `runCreateBatch`
 * pipeline as Juicebox / Lessie / V1 Coresignal CSV uploads — no parallel
 * data path.
 *
 * Design choice — why reuse `runCreateBatch`:
 *  - same dedupe + sha256 idempotency
 *  - same Firestore writer + `pa-external-sourcing-batches` /
 *    `pa-external-candidate-records` shape
 *  - downstream identity-resolve worker triggers off existing collection
 *    create events without modification
 *  - keeps the `coresignal_collect_v2` adapter as the single normalization
 *    entrypoint
 *
 * Auth: admin-only via `requireExternalSupplyAdmin`.
 * Concurrency: worker pool size 4, matches scripts/coresignal-fetch-employees.mjs
 * Retry: client-level 3x on 429/5xx (see `coresignal-collect-client.ts`).
 */
import { createHash } from "node:crypto"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getFirestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import {
  CoresignalCollectError,
  fetchEmployeeCollect,
  type CoresignalCollectClientConfig,
  type CoresignalEmployeeCollectV2,
} from "@pa/external-supply"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"
import { makeFirestoreDeps, runCreateBatch, type CreateBatchResult } from "./import.js"

// Reuse existing CoreSignal secret (already defined for admin-coresignal-agentic-search).
const CORESIGNAL_API_KEY = defineSecret("CORESIGNAL_API_KEY")
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const DEFAULT_CONCURRENCY = 4
const MAX_BATCH_SIZE = 500
const MAX_IDS_PER_CALL = 500

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const CoresignalFetchBatchInputSchema = z.object({
  candidateIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_IDS_PER_CALL),
  companyId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  concurrency: z.number().int().min(1).max(16).optional(),
})
export type CoresignalFetchBatchInput = z.infer<typeof CoresignalFetchBatchInputSchema>

export interface CoresignalFetchBatchResult extends CreateBatchResult {
  fetchedCount: number
  failedCount: number
  failures: Array<{ id: number; error: string; status: number | null }>
}

// ---------------------------------------------------------------------------
// Pure handler — deps-injected for tests
// ---------------------------------------------------------------------------

export interface CoresignalFetchBatchDeps {
  fetchEmployee: (
    id: number,
    config: CoresignalCollectClientConfig,
  ) => Promise<CoresignalEmployeeCollectV2>
  runCreateBatch: typeof runCreateBatch
  now: () => string
  log?: (msg: string, fields?: Record<string, unknown>) => void
  apiKey: string
  importedBy: string
  // For runCreateBatch — these are passed through to its dep injection
  createBatchDeps: Parameters<typeof runCreateBatch>[1]
}

/**
 * Run the batch fetch end-to-end:
 *   1. Worker pool fetches employee JSON per ID (with retries handled in client).
 *   2. Successes packed into one JSON array, hashed, base64-encoded.
 *   3. Routes through existing `runCreateBatch` with source=coresignal_collect_v2.
 *   4. Returns merged stats with `fetchedCount` / `failedCount` / `failures`.
 */
export async function runCoresignalFetchBatch(
  input: CoresignalFetchBatchInput,
  deps: CoresignalFetchBatchDeps,
): Promise<CoresignalFetchBatchResult> {
  const uniqueIds = Array.from(new Set(input.candidateIds))
  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY

  const fetched: CoresignalEmployeeCollectV2[] = []
  const failures: CoresignalFetchBatchResult["failures"] = []

  // Worker pool: shift IDs off a shared queue.
  const queue = [...uniqueIds]

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const id = queue.shift()
      if (id === undefined) return
      try {
        const employee = await deps.fetchEmployee(id, { apiKey: deps.apiKey })
        fetched.push(employee)
      } catch (err) {
        const status =
          err instanceof CoresignalCollectError ? err.status : null
        failures.push({
          id,
          error: (err as Error).message ?? String(err),
          status,
        })
      }
    }
  }

  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(concurrency, uniqueIds.length); i++) {
    workers.push(worker())
  }
  await Promise.all(workers)

  if (fetched.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      `coresignal_fetch_all_failed: ${failures.length}/${uniqueIds.length} ids failed`,
    )
  }

  // Pack into JSON array, encode for runCreateBatch inline path.
  const payload = JSON.stringify(fetched)
  const buf = Buffer.from(payload, "utf8")
  const sha256 = createHash("sha256").update(buf).digest("hex")
  const inlineBase64 = buf.toString("base64")

  // Synthesized storage URI (not actually uploaded — matches inline-path
  // convention from import.ts).
  const filename = `coresignal-batch-${deps.now()}.json`
  const storageUri = `inline://coresignal_collect_v2/${sha256}/${filename}`

  const out = await deps.runCreateBatch(
    {
      source: "coresignal_collect_v2",
      storageUri,
      sha256,
      mime: "application/json",
      sizeBytes: buf.byteLength,
      companyId: input.companyId,
      jobId: input.jobId,
      importedBy: deps.importedBy,
    },
    {
      ...deps.createBatchDeps,
      downloadFile: async () => buf,
    },
  )

  deps.log?.("pa.external_supply.coresignal_fetch_batch.complete", {
    batchId: out.batchId,
    requestedCount: uniqueIds.length,
    fetchedCount: fetched.length,
    failedCount: failures.length,
  })

  return {
    ...out,
    fetchedCount: fetched.length,
    failedCount: failures.length,
    failures,
  }
}

// ---------------------------------------------------------------------------
// Callable wrapper
// ---------------------------------------------------------------------------

export const paCoresignalFetchBatch = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 540,
    secrets: [CORESIGNAL_API_KEY, PA_ADMIN_TOKEN],
  },
  async (req): Promise<CoresignalFetchBatchResult> => {
    const { uid } = requireExternalSupplyAdmin(req.auth)
    const parsed = CoresignalFetchBatchInputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }

    const apiKey = CORESIGNAL_API_KEY.value()
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "CORESIGNAL_API_KEY missing")
    }

    const db = getFirestore()
    const firestoreDeps = makeFirestoreDeps(db)

    return runCoresignalFetchBatch(parsed.data, {
      fetchEmployee: fetchEmployeeCollect,
      runCreateBatch,
      now: () => new Date().toISOString(),
      log: (msg, fields) => logger.info(msg, fields),
      apiKey,
      importedBy: uid,
      // Inject the inline-path downloadFile in runCoresignalFetchBatch
      // (above) — supply Firestore-backed find + write deps here.
      createBatchDeps: {
        ...firestoreDeps,
        newId: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
        downloadFile: async () => Buffer.alloc(0), // overridden above
      },
    })
  },
)
