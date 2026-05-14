/**
 * v2.0 External Supply V2 — Wave E (F) — Monthly source-quality rollup.
 *
 * Read-only consumer of `pa-agent-ranking-results` (Wave D writer). For each
 * external source (juicebox / lessie / coresignal / manual_csv) it computes:
 *
 *   - agentRankedTotal              — total ranking rows seen this month
 *   - agentApprovedUnchangedTotal   — `status === "approved"` count
 *   - agentOverriddenTotal          — `status === "overridden"` count
 *   - agentTierAcceptanceRate       — approved / total
 *   - agentOperatorOverrideRate     — overridden / (approved + overridden)
 *   - costTableVersion              — first non-empty value from sampled rows
 *
 * The rollup merges into `pa-source-quality-metrics/{source__yyyyMm}` so the
 * existing V1 fields (replyRate / bounceRate / validRate / ...) are preserved
 * — F is purely additive (L-F2 / L-F5).
 *
 * Lead resolutions captured here:
 *   - L-F1  read-only consumer of pa-agent-ranking-results
 *   - L-F2  per-month, per-source upsert using createSourceQualityMetricId
 *   - L-F4  monthly cron `"0 8 1 * *"` UTC
 *   - L-F5  merge:true preserves V1 fields
 *   - L-F6  cross-collection join ranking → record → batch → source via
 *           batched `in`-queries (Firestore caps `in` at 10 ids per query)
 *   - L-F7  CF re-exported from the very bottom of apps/functions/src/index.ts
 *           in its own fenced block to minimize merge conflict with Wave D
 */

import { onSchedule } from "firebase-functions/v2/scheduler"
import { logger } from "firebase-functions/v2"
import {
  getFirestore,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore"

import {
  createSourceQualityMetricId,
  PA_COLLECTIONS,
  type AgentRankingResult,
  type ExternalSource,
} from "@pa/core-types"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Closed list of sources we emit rollup rows for (mirrors ExternalSourceSchema). */
export const ROLLUP_SOURCES: readonly ExternalSource[] = [
  "juicebox",
  "lessie",
  "coresignal",
  "manual_csv",
] as const

/** Firestore caps `where in` at 10 entries — used for the batched record + batch lookups. */
export const FIRESTORE_IN_CHUNK = 10

/** Max ranking rows scanned per monthly rollup. Keeps the CF predictable. */
export const ROLLUP_RANKING_QUERY_CAP = 5_000

// ---------------------------------------------------------------------------
// Pure rollup math
// ---------------------------------------------------------------------------

export interface MonthlyRollupRow {
  source: ExternalSource
  yyyyMm: string
  agentRankedTotal: number
  agentApprovedUnchangedTotal: number
  agentOverriddenTotal: number
  agentTierAcceptanceRate: number
  agentOperatorOverrideRate: number
  costTableVersion?: string
}

export type MonthlyRollupBySource = Record<
  ExternalSource,
  MonthlyRollupRow | null
>

/**
 * Pure aggregate — bucket ranking rows by source via the
 * `candidateRecordId -> batchId -> source` join the caller pre-computed.
 *
 * A source row is emitted only when `agentRankedTotal > 0`; otherwise the
 * key holds `null` so callers can skip the upsert (L-F2: idempotent overwrite
 * but don't pollute Firestore with empty docs).
 */
export function computeMonthlyRollup(args: {
  agentRankingRows: ReadonlyArray<AgentRankingResult>
  batchIdToSource: ReadonlyMap<string, ExternalSource>
  candidateRecordIdToBatchId: ReadonlyMap<string, string>
  yyyyMm: string
}): MonthlyRollupBySource {
  const buckets = new Map<ExternalSource, AgentRankingResult[]>()
  for (const src of ROLLUP_SOURCES) buckets.set(src, [])

  for (const row of args.agentRankingRows) {
    const batchId = args.candidateRecordIdToBatchId.get(row.candidateRecordId)
    if (!batchId) continue
    const source = args.batchIdToSource.get(batchId)
    if (!source) continue
    buckets.get(source)!.push(row)
  }

  const out = {} as Record<ExternalSource, MonthlyRollupRow | null>
  for (const src of ROLLUP_SOURCES) {
    const bucket = buckets.get(src)!
    if (bucket.length === 0) {
      out[src] = null
      continue
    }
    const approved = bucket.filter((r) => r.status === "approved").length
    const overridden = bucket.filter((r) => r.status === "overridden").length
    const total = bucket.length
    const acceptanceDenom = total
    const overrideDenom = Math.max(1, approved + overridden)
    // costTableVersion: first row that has one stamped (D writes this per L-F7).
    let costTableVersion: string | undefined
    for (const row of bucket) {
      const v = (row as unknown as { costTableVersion?: unknown }).costTableVersion
      if (typeof v === "string" && v.length > 0) {
        costTableVersion = v
        break
      }
    }
    const rollup: MonthlyRollupRow = {
      source: src,
      yyyyMm: args.yyyyMm,
      agentRankedTotal: total,
      agentApprovedUnchangedTotal: approved,
      agentOverriddenTotal: overridden,
      agentTierAcceptanceRate: acceptanceDenom > 0 ? approved / acceptanceDenom : 0,
      agentOperatorOverrideRate: overridden / overrideDenom,
    }
    if (costTableVersion) {
      rollup.costTableVersion = costTableVersion
    }
    out[src] = rollup
  }
  return out
}

// ---------------------------------------------------------------------------
// Firestore writer
// ---------------------------------------------------------------------------

/**
 * Upserts rollup rows into `pa-source-quality-metrics`. Skips `null` entries
 * (no ranking rows for that source this month). `merge:true` preserves V1
 * fields written by other paths (replyRate / bounceRate / validRate / ...).
 */
export async function writeMonthlyRollup(
  db: Firestore,
  yyyyMm: string,
  rollup: MonthlyRollupBySource,
  opts: {
    log?: (event: string, ctx?: Record<string, unknown>) => void
    now?: () => string
  } = {}
): Promise<{ written: number; skipped: number }> {
  const nowIso = opts.now?.() ?? new Date().toISOString()
  const log = opts.log ?? (() => {})
  let written = 0
  let skipped = 0
  for (const source of ROLLUP_SOURCES) {
    const row = rollup[source]
    if (!row) {
      skipped++
      continue
    }
    const docId = createSourceQualityMetricId(source, yyyyMm)
    const body: Record<string, unknown> = {
      source,
      agentRankedTotal: row.agentRankedTotal,
      agentApprovedUnchangedTotal: row.agentApprovedUnchangedTotal,
      agentOverriddenTotal: row.agentOverriddenTotal,
      agentTierAcceptanceRate: row.agentTierAcceptanceRate,
      agentOperatorOverrideRate: row.agentOperatorOverrideRate,
      updatedAt: nowIso,
    }
    if (row.costTableVersion) body.costTableVersion = row.costTableVersion
    await db
      .collection(PA_COLLECTIONS.sourceQualityMetrics)
      .doc(docId)
      .set(body, { merge: true })
    written++
    log("source_quality_rollup.row_written", {
      source,
      yyyyMm,
      docId,
      agentRankedTotal: row.agentRankedTotal,
      agentTierAcceptanceRate: row.agentTierAcceptanceRate,
      agentOperatorOverrideRate: row.agentOperatorOverrideRate,
    })
  }
  return { written, skipped }
}

// ---------------------------------------------------------------------------
// Firestore join helpers — record → batch → source
// ---------------------------------------------------------------------------

/** Chunk an array into pieces of at most `size` entries. */
function chunk<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size))
  }
  return out
}

/**
 * Resolve every `candidateRecordId` -> `batchId` via batched `in`-queries
 * (Firestore caps `in` at 10). Missing record ids are dropped (L-F6: warn,
 * don't throw).
 */
export async function fetchRecordIdToBatchId(
  db: Firestore,
  recordIds: ReadonlyArray<string>,
  log: (event: string, ctx?: Record<string, unknown>) => void
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const ids of chunk([...new Set(recordIds)], FIRESTORE_IN_CHUNK)) {
    if (ids.length === 0) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snap = await (db as any)
        .collection(PA_COLLECTIONS.externalCandidateRecords)
        .where("recordId", "in", ids)
        .get()
      for (const doc of snap.docs as QueryDocumentSnapshot[]) {
        const data = doc.data() as DocumentData
        const recordId =
          typeof data.recordId === "string" ? data.recordId : doc.id
        const batchId = typeof data.batchId === "string" ? data.batchId : undefined
        if (batchId) out.set(recordId, batchId)
      }
    } catch (err) {
      log("source_quality_rollup.record_lookup_failed", {
        err: String(err).slice(0, 200),
        chunkSize: ids.length,
      })
    }
  }
  const missing = recordIds.filter((id) => !out.has(id))
  if (missing.length > 0) {
    log("source_quality_rollup.records_missing", { count: missing.length })
  }
  return out
}

/**
 * Resolve every `batchId` -> `source` via batched `in`-queries. Missing batch
 * ids are dropped with a warning (L-F6).
 */
export async function fetchBatchIdToSource(
  db: Firestore,
  batchIds: ReadonlyArray<string>,
  log: (event: string, ctx?: Record<string, unknown>) => void
): Promise<Map<string, ExternalSource>> {
  const out = new Map<string, ExternalSource>()
  for (const ids of chunk([...new Set(batchIds)], FIRESTORE_IN_CHUNK)) {
    if (ids.length === 0) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snap = await (db as any)
        .collection(PA_COLLECTIONS.externalSourcingBatches)
        .where("batchId", "in", ids)
        .get()
      for (const doc of snap.docs as QueryDocumentSnapshot[]) {
        const data = doc.data() as DocumentData
        const batchId =
          typeof data.batchId === "string" ? data.batchId : doc.id
        const source =
          typeof data.source === "string"
            ? (data.source as ExternalSource)
            : undefined
        if (source && (ROLLUP_SOURCES as readonly string[]).includes(source)) {
          out.set(batchId, source)
        }
      }
    } catch (err) {
      log("source_quality_rollup.batch_lookup_failed", {
        err: String(err).slice(0, 200),
        chunkSize: ids.length,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Month-window helpers
// ---------------------------------------------------------------------------

/** Compute the prior month window for a given "as-of" date. */
export function priorMonthWindow(asOf: Date): {
  yyyyMm: string
  startIso: string
  endIso: string
} {
  const start = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - 1, 1))
  const end = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1))
  const yyyy = start.getUTCFullYear()
  const mm = String(start.getUTCMonth() + 1).padStart(2, "0")
  return {
    yyyyMm: `${yyyy}-${mm}`,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// End-to-end runner (injectable)
// ---------------------------------------------------------------------------

export type SourceQualityRunDeps = {
  db: Firestore
  asOf?: Date
  log?: (event: string, ctx?: Record<string, unknown>) => void
  errorLog?: (event: string, ctx?: Record<string, unknown>) => void
}

export async function runSourceQualityRollup(
  deps: SourceQualityRunDeps
): Promise<{
  yyyyMm: string
  rowsScanned: number
  written: number
  skipped: number
}> {
  const log = deps.log ?? (() => {})
  const errorLog = deps.errorLog ?? log
  const asOf = deps.asOf ?? new Date()
  const window = priorMonthWindow(asOf)
  log("source_quality_rollup.start", {
    yyyyMm: window.yyyyMm,
    startIso: window.startIso,
    endIso: window.endIso,
  })

  // 1. Pull ranking rows for the window. Use ISO timestamps for createdAt range.
  let rows: AgentRankingResult[] = []
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = deps.db
      .collection(PA_COLLECTIONS.agentRankingResults)
      .where("createdAt", ">=", window.startIso)
      .where("createdAt", "<", window.endIso)
      .orderBy("createdAt", "desc")
      .limit(ROLLUP_RANKING_QUERY_CAP)
    let snap
    try {
      snap = await q.get()
    } catch {
      // Composite-index miss — fall back to unbounded latest cap. The window
      // filter is best-effort here, so we trim in memory.
      q = deps.db
        .collection(PA_COLLECTIONS.agentRankingResults)
        .limit(ROLLUP_RANKING_QUERY_CAP)
      snap = await q.get()
    }
    for (const doc of snap.docs as QueryDocumentSnapshot[]) {
      const data = doc.data() as DocumentData
      const createdAt =
        typeof data.createdAt === "string" ? data.createdAt : ""
      if (createdAt && (createdAt < window.startIso || createdAt >= window.endIso)) {
        continue
      }
      rows.push(data as unknown as AgentRankingResult)
    }
  } catch (err) {
    errorLog("source_quality_rollup.ranking_scan_failed", {
      err: String(err).slice(0, 200),
      yyyyMm: window.yyyyMm,
    })
    rows = []
  }

  log("source_quality_rollup.rows_scanned", {
    yyyyMm: window.yyyyMm,
    count: rows.length,
  })

  if (rows.length === 0) {
    log("source_quality_rollup.empty_window", { yyyyMm: window.yyyyMm })
    return { yyyyMm: window.yyyyMm, rowsScanned: 0, written: 0, skipped: 0 }
  }

  // 2. Join: candidateRecordId -> batchId -> source.
  const recordIds = rows.map((r) => r.candidateRecordId)
  const recordToBatch = await fetchRecordIdToBatchId(deps.db, recordIds, log)
  const batchIds = [...new Set([...recordToBatch.values()])]
  const batchToSource = await fetchBatchIdToSource(deps.db, batchIds, log)

  // 3. Compute + write.
  const rollup = computeMonthlyRollup({
    agentRankingRows: rows,
    batchIdToSource: batchToSource,
    candidateRecordIdToBatchId: recordToBatch,
    yyyyMm: window.yyyyMm,
  })

  let writeResult = { written: 0, skipped: ROLLUP_SOURCES.length }
  try {
    writeResult = await writeMonthlyRollup(deps.db, window.yyyyMm, rollup, {
      log,
    })
  } catch (err) {
    errorLog("source_quality_rollup.write_failed", {
      err: String(err).slice(0, 200),
      yyyyMm: window.yyyyMm,
    })
  }

  log("source_quality_rollup.done", {
    yyyyMm: window.yyyyMm,
    rowsScanned: rows.length,
    written: writeResult.written,
    skipped: writeResult.skipped,
  })

  return {
    yyyyMm: window.yyyyMm,
    rowsScanned: rows.length,
    ...writeResult,
  }
}

// ---------------------------------------------------------------------------
// Cloud Function — Monthly @ 08:00 UTC on the 1st (L-F4)
// ---------------------------------------------------------------------------

export const paExternalSupplyRollupSourceQualityMonthly = onSchedule(
  {
    schedule: "0 8 1 * *",
    timeZone: "UTC",
    memory: "1GiB",
    timeoutSeconds: 540,
    region: "us-central1",
    retryCount: 0,
  },
  async () => {
    const db = getFirestore()
    try {
      const result = await runSourceQualityRollup({
        db,
        log: (event, ctx) =>
          logger.info(`[external-supply-source-quality] ${event}`, ctx ?? {}),
        errorLog: (event, ctx) =>
          logger.error(`[external-supply-source-quality] ${event}`, ctx ?? {}),
      })
      logger.info("[external-supply-source-quality] complete", result)
    } catch (err) {
      // Belt-and-suspenders — runSourceQualityRollup already catches its own
      // step errors, but a top-level throw is still logged here so the cron
      // health surface registers the failure.
      logger.error("[external-supply-source-quality] failed", {
        err: String(err).slice(0, 200),
      })
    }
  }
)
