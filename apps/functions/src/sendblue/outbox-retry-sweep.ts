/**
 * Stream H9 TD2 — paSendblueOutboxRetrySweep.
 *
 * Background: paSendblueOutbox uses `onDocumentCreated` only. If the trigger
 * crashes, OOMs, or the row is created but not picked up (e.g. a CF cold-
 * start failure), the row sits in `status: "pending"` indefinitely. The
 * existing top-of-tick `sweepStaleOutbound` only fires when SOMETHING ELSE
 * creates a new outbound row — so a fully idle queue stays stuck.
 *
 * Fix: a scheduled sweep that runs every 5 min and re-invokes the same
 * `paSendblueOutboxHandler` for orphans (status=pending, createdAt < now-60s).
 *
 * Idempotency: the handler's claim transaction (status=pending → sending) is
 * the single source of truth. If the onDocumentCreated trigger AND this
 * sweep both pick up the same row, only one wins the claim — the other
 * exits the handler in the `if (!claimed) return` branch.
 *
 * Concurrency cap: 5 in-flight rows per tick. Sendblue REST is rate-limited
 * (~10 req/s on the basic tier); 5 chunked is well under that and avoids
 * thundering-herd if the queue is deep.
 */

import type { Firestore } from "firebase-admin/firestore"

import { paSendblueOutboxHandler, type OutboxDeps } from "./outbox.js"

const ORPHAN_MIN_AGE_MS = 60 * 1000 // 60s — give onDocumentCreated trigger first dibs
const SWEEP_LIMIT = 50 // upper bound per tick; well under typical CF memory
const CONCURRENCY = 5 // max parallel Sendblue REST POSTs

export type RetrySweepResult = {
  scanned: number
  reprocessed: number
}

/**
 * Pure handler — accepts injected deps for testability. The CF wrapper in
 * apps/functions/src/index.ts binds the live Firestore + Sendblue client.
 */
export async function paSendblueOutboxRetrySweepHandler(
  deps: OutboxDeps & { sweepLimit?: number; concurrency?: number }
): Promise<RetrySweepResult> {
  const log = deps.log ?? console.log
  const now = deps.now ?? (() => new Date())
  const limit = deps.sweepLimit ?? SWEEP_LIMIT
  const concurrency = deps.concurrency ?? CONCURRENCY

  const cutoffMs = now().getTime() - ORPHAN_MIN_AGE_MS

  // Query candidates: status=pending. Filter age client-side to avoid
  // requiring a (status, createdAt) composite index — the existing index
  // (status, createdAt) IS deployed (see config/firebase/firestore.indexes.json
  // line 5-9), but we keep the query single-field for safety in case the
  // index is dropped.
  let candidates: Array<{ id: string; data: Record<string, unknown> }>
  try {
    const snap = await deps.db
      .collection("pa-outbound")
      .where("status", "==", "pending")
      .limit(limit)
      .get()
    candidates = (snap.docs as Array<{ id: string; data: () => Record<string, unknown> }>).map((d) => ({
      id: d.id,
      data: d.data() ?? {},
    }))
  } catch (err) {
    log("[sendblue][retry-sweep] query error", err instanceof Error ? err.message : String(err))
    return { scanned: 0, reprocessed: 0 }
  }

  // Filter to orphans only — createdAt older than cutoff (60s).
  const orphans = candidates.filter((c) => {
    const createdAt = String((c.data as { createdAt?: unknown }).createdAt ?? "")
    const t = Date.parse(createdAt)
    if (Number.isNaN(t)) return false
    return t < cutoffMs
  })

  if (orphans.length === 0) {
    return { scanned: candidates.length, reprocessed: 0 }
  }

  // Oldest first. The query has no orderBy, so Firestore returns by doc key —
  // effectively random. That could put a multi-bubble burst's seq=5 in an
  // EARLIER chunk than its seq=0, and the handler's order gate would then sit
  // out its full 20s escape hatch waiting for a predecessor this very sweep has
  // not reached yet. ISO `createdAt` sorts lexicographically = chronologically.
  orphans.sort((a, b) =>
    String((a.data as { createdAt?: unknown }).createdAt ?? "").localeCompare(
      String((b.data as { createdAt?: unknown }).createdAt ?? "")
    )
  )

  log("[sendblue][retry-sweep] found orphans", {
    scanned: candidates.length,
    orphans: orphans.length,
  })

  // Process in fixed-concurrency chunks. Each call goes through the existing
  // handler, which transactionally claims status=pending → sending and is
  // therefore safe to call concurrently with the onDocumentCreated trigger.
  let reprocessed = 0
  for (let i = 0; i < orphans.length; i += concurrency) {
    const chunk = orphans.slice(i, i + concurrency)
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(
      chunk.map(async (orphan) => {
        try {
          await paSendblueOutboxHandler(
            {
              params: { docId: orphan.id },
              data: { data: () => orphan.data, id: orphan.id },
            },
            deps
          )
          reprocessed++
        } catch (err) {
          log("[sendblue][retry-sweep] orphan handler threw (non-fatal)", {
            docId: orphan.id,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      })
    )
  }

  return { scanned: candidates.length, reprocessed }
}

/** Test helper — exported for unit tests so they can pin the cutoff window. */
export const _ORPHAN_MIN_AGE_MS = ORPHAN_MIN_AGE_MS
export const _SWEEP_LIMIT = SWEEP_LIMIT
export const _CONCURRENCY = CONCURRENCY

// re-export Firestore type for the CF wrapper
export type { Firestore }
