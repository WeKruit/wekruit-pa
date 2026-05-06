/**
 * v1.7 Phase 65 — pa-cost-ledger writer + weekly summary helpers.
 *
 * Single source of truth for `pa-cost-ledger` document writes from CFs that
 * spend on third-party APIs (Serper, OpenAI, SiliconFlow, etc.). Each entry is
 * an append-only row keyed by run + timestamp so daily/weekly aggregations
 * remain trivially auditable.
 *
 * Doc shape:
 *   {
 *     api: "serper" | "openai" | "siliconflow" | "anthropic" | string,
 *     cost_usd: number,
 *     jobId?: string,
 *     userId?: string,
 *     success: boolean,
 *     ts: string (ISO 8601),
 *     runId?: string,
 *     model?: string,
 *     extra?: Record<string, unknown>,
 *   }
 *
 * NOTE: Phase 42's `match-explainer.ts` writes a daily-aggregated doc shape
 * (`pa-cost-ledger/match-explainer__YYYYMMDD` with `totalUsd` + `callCount`).
 * We intentionally use append-only rows here for finer-grained auditing of
 * Serper backfill runs. Both shapes coexist in the same collection — the
 * weekly summary aggregator (`summarizeCostLedger`) reads BOTH:
 *   - rows with `cost_usd` (this module)
 *   - rows with `totalUsd` (match-explainer rollups)
 */

import type { Firestore, Timestamp } from "firebase-admin/firestore"

export const COST_LEDGER_COLLECTION = "pa-cost-ledger"

// Per-call USD reference (kept in one place so callers don't drift). Update
// whenever provider pricing changes — also update CLAUDE.md if material.
export const SERPER_USD_PER_CALL = 0.001

export type CostLedgerEntry = {
  api: string
  cost_usd: number
  /** Optional — populated when call is per-job (e.g. Serper for a matching-job). */
  jobId?: string
  /** Optional — populated when call is per-user. */
  userId?: string
  success: boolean
  ts: string
  runId?: string
  model?: string
  extra?: Record<string, unknown>
}

/** Async writer interface (Firestore + tests via in-memory). */
export type CostLedgerWriter = {
  write: (entry: CostLedgerEntry) => Promise<void>
}

/** Build a writer over a Firestore instance. Best-effort: never throws. */
export function makeFirestoreCostLedgerWriter(db: Firestore): CostLedgerWriter {
  return {
    write: async (entry) => {
      try {
        const sanitized: Record<string, unknown> = {
          api: entry.api,
          cost_usd: entry.cost_usd,
          success: entry.success,
          ts: entry.ts,
        }
        if (entry.jobId !== undefined) sanitized.jobId = entry.jobId
        if (entry.userId !== undefined) sanitized.userId = entry.userId
        if (entry.runId !== undefined) sanitized.runId = entry.runId
        if (entry.model !== undefined) sanitized.model = entry.model
        if (entry.extra !== undefined && Object.keys(entry.extra).length > 0) {
          sanitized.extra = entry.extra
        }
        await db.collection(COST_LEDGER_COLLECTION).add(sanitized)
      } catch {
        // swallow — never let cost-ledger failure abort a backfill turn
      }
    },
  }
}

/** No-op writer for tests / dry-runs. */
export function makeNoopCostLedgerWriter(): CostLedgerWriter {
  return { write: async () => {} }
}

// ---------------------------------------------------------------------------
// Weekly summary
// ---------------------------------------------------------------------------

export type CostLedgerSummary = {
  windowStart: string
  windowEnd: string
  totalUsd: number
  byApi: Record<string, { totalUsd: number; callCount: number }>
  callCount: number
}

/**
 * Coerce a Firestore Timestamp / ISO string / number into ms-since-epoch.
 * Returns 0 on noise — callers filter on `> 0`.
 */
export function timestampToMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : 0
  }
  if (v && typeof v === "object") {
    const obj = v as { toDate?: () => Date; seconds?: number }
    if (typeof obj.toDate === "function") {
      try {
        const d = obj.toDate()
        if (d instanceof Date) return d.getTime()
      } catch {
        return 0
      }
    }
    if (typeof obj.seconds === "number") return obj.seconds * 1000
  }
  return 0
}

/**
 * Aggregate ledger rows in [windowStartMs, windowEndMs). Reads BOTH the
 * append-only `cost_usd` rows and the legacy `totalUsd` rollup rows so the
 * weekly email is comprehensive.
 *
 * Pure-ish: caller injects an iterator over docs to keep this testable.
 */
export type LedgerDocLike = {
  data: () => Record<string, unknown>
}

export function summarizeCostLedger(
  docs: ReadonlyArray<LedgerDocLike>,
  windowStartMs: number,
  windowEndMs: number
): CostLedgerSummary {
  const summary: CostLedgerSummary = {
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
    totalUsd: 0,
    byApi: {},
    callCount: 0,
  }
  for (const doc of docs) {
    const d = doc.data()
    // Determine timestamp — try `ts` first (append-only), then `runAt`/`updatedAt`
    // (rollup rows from match-explainer use a YYYYMMDD doc id but no `ts`; we
    // skip those when window is narrower than a day).
    const tsMs = timestampToMs(d.ts ?? d.runAt ?? d.updatedAt)
    if (tsMs > 0 && (tsMs < windowStartMs || tsMs >= windowEndMs)) continue

    let usd = 0
    let count = 1
    if (typeof d.cost_usd === "number" && Number.isFinite(d.cost_usd)) {
      usd = d.cost_usd
    } else if (typeof d.totalUsd === "number" && Number.isFinite(d.totalUsd)) {
      usd = d.totalUsd
      count = typeof d.callCount === "number" && Number.isFinite(d.callCount) ? d.callCount : 1
    } else {
      // Doc shape doesn't match either schema — skip.
      continue
    }
    const api =
      typeof d.api === "string"
        ? d.api
        : typeof d.kind === "string"
          ? d.kind
          : "unknown"

    summary.totalUsd += usd
    summary.callCount += count
    if (!summary.byApi[api]) {
      summary.byApi[api] = { totalUsd: 0, callCount: 0 }
    }
    summary.byApi[api]!.totalUsd += usd
    summary.byApi[api]!.callCount += count
  }
  // Round to 4 decimals for display stability.
  summary.totalUsd = Math.round(summary.totalUsd * 10_000) / 10_000
  for (const k of Object.keys(summary.byApi)) {
    summary.byApi[k]!.totalUsd = Math.round(summary.byApi[k]!.totalUsd * 10_000) / 10_000
  }
  return summary
}

/** Format a summary as a plain-text body for the weekly email. */
export function formatSummaryEmail(summary: CostLedgerSummary): string {
  const lines: string[] = []
  lines.push(`pa-cost-ledger weekly summary`)
  lines.push(`Window: ${summary.windowStart} → ${summary.windowEnd}`)
  lines.push(`Total: $${summary.totalUsd.toFixed(4)} across ${summary.callCount} calls`)
  lines.push("")
  lines.push("Breakdown by API:")
  const sorted = Object.entries(summary.byApi).sort((a, b) => b[1].totalUsd - a[1].totalUsd)
  for (const [api, stats] of sorted) {
    lines.push(`  ${api}: $${stats.totalUsd.toFixed(4)} (${stats.callCount} calls)`)
  }
  return lines.join("\n")
}

// Re-export Timestamp type for convenience to consumers that don't already
// pull it in.
export type { Timestamp }
