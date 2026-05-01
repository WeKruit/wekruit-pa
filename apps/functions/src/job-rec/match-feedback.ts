/**
 * Tapback → matching-feedback writer (BUG #6 sister-feature, Stream A).
 *
 * Pipeline:
 *   1. Inbound iMessage tapback → webhook writes pa-tapback-events row
 *   2. paOnTapbackEvent CF (Firestore trigger) → invokes recordTapbackFeedback
 *   3. recordTapbackFeedback finds Claire's recent outbound message(s) for
 *      that user, extracts mentioned jobIds, writes ONE matching-feedback row
 *      per jobId.
 *
 * Why a separate file (NOT inside the webhook): the tapback semantic-attribution
 * needs the outbound corpus, which the webhook doesn't have at hand. Decoupling
 * via Firestore trigger lets the webhook stay fast (single write + 200) and
 * delegates the join-with-outbound to a CF that can take ~seconds.
 *
 * jobId extraction strategy (best-effort, defense-in-depth):
 *   1. PRIMARY — outbound rawMeta.jobIds[] (when Claire's job-rec module
 *      attaches the IDs explicitly at send time). This is the canonical path.
 *   2. FALLBACK — markdown URL extraction: /wekruit.com/jobs/{id} | /jobs/{id}.
 *      Used when rawMeta is absent (legacy outbound or external integrations).
 *
 * If neither yields jobIds, NO matching-feedback row is written — the tapback
 * still lives in pa-tapback-events for forensics, but we don't pollute the
 * matching dataset with un-attributed reactions.
 */

import type { Firestore } from "firebase-admin/firestore"

export type TapbackFeedbackInput = {
  userId: string
  kind: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question"
  quotedText: string
  jobIds: string[]
  /** Optional context — captured opportunistically from outbound rawMeta. */
  jobMeta?: Record<string, { companyName?: string; jobTitle?: string }>
}

export type RecordTapbackFeedbackResult = {
  written: number
  jobIds: string[]
}

/**
 * Write one row per jobId to `matching-feedback`.
 *
 * Idempotency note: this writer does NOT dedupe across calls. The CF wrapper
 * is the right place for that — it should look at the source tapback doc and
 * track via a `processed: true` flag. Keeping this writer pure makes it
 * trivial to test.
 */
export async function recordTapbackFeedback(
  db: Firestore,
  input: TapbackFeedbackInput,
  now: () => Date = () => new Date()
): Promise<RecordTapbackFeedbackResult> {
  if (!input.userId) throw new Error("recordTapbackFeedback: userId required")
  if (!input.kind) throw new Error("recordTapbackFeedback: kind required")
  const jobIds = (input.jobIds ?? []).filter((id) => typeof id === "string" && id.length > 0)
  if (jobIds.length === 0) return { written: 0, jobIds: [] }

  const createdAt = now().toISOString()
  const col = db.collection("matching-feedback")

  for (const jobId of jobIds) {
    const meta = input.jobMeta?.[jobId] ?? {}
    await col.add({
      userId: input.userId,
      jobId,
      reaction: input.kind,
      ...(meta.companyName ? { companyName: meta.companyName } : {}),
      ...(meta.jobTitle ? { jobTitle: meta.jobTitle } : {}),
      quotedText: input.quotedText,
      createdAt,
      source: "tapback",
    })
  }

  return { written: jobIds.length, jobIds }
}

// ---------------------------------------------------------------------------
// Outbound lookup helpers — used by the paOnTapbackEvent CF
// ---------------------------------------------------------------------------

/** Window for matching a tapback to a recent Claire outbound. */
const OUTBOUND_LOOKBACK_MS = 5 * 60 * 1000

/**
 * Extract jobIds from a Claire outbound row.
 *
 * Order of precedence:
 *   1. rawMeta.jobIds — canonical, set by Claire's job-rec module.
 *   2. URL regex — /jobs/{id} or wekruit.com/jobs/{id}.
 */
export function extractJobIdsFromOutbound(outbound: Record<string, unknown>): {
  jobIds: string[]
  jobMeta: Record<string, { companyName?: string; jobTitle?: string }>
} {
  const meta: Record<string, { companyName?: string; jobTitle?: string }> = {}

  const rawMeta = outbound.rawMeta as Record<string, unknown> | undefined
  if (rawMeta && Array.isArray(rawMeta.jobIds)) {
    const ids = rawMeta.jobIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    if (ids.length > 0) {
      const jobMeta = rawMeta.jobMeta as Record<string, { companyName?: string; jobTitle?: string }> | undefined
      if (jobMeta && typeof jobMeta === "object") {
        for (const id of ids) {
          if (jobMeta[id]) meta[id] = jobMeta[id]!
        }
      }
      return { jobIds: ids, jobMeta: meta }
    }
  }

  // URL regex fallback. Supports:
  //   https://wekruit.com/jobs/<id>
  //   https://www.wekruit.com/jobs/<id>
  //   /jobs/<id>
  const body = String(outbound.body ?? "")
  const seen = new Set<string>()
  const re = /\/jobs\/([A-Za-z0-9_-]{4,})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    if (m[1]) seen.add(m[1])
  }
  return { jobIds: [...seen], jobMeta: meta }
}

/**
 * Find Claire outbound rows for a user within the lookback window whose body
 * contains the tapback's quoted excerpt.
 *
 * Caller is responsible for the Firestore query — this helper just filters
 * the candidate set by quotedText match. Centralized here so the matching
 * heuristic is unit-testable.
 */
export function selectMatchingOutbound(
  candidates: Array<Record<string, unknown>>,
  quotedText: string,
  now: number = Date.now()
): Array<Record<string, unknown>> {
  if (!quotedText) return []
  const cutoff = now - OUTBOUND_LOOKBACK_MS
  // Strip the truncation ellipsis iMessage adds to long-message tapbacks.
  const needle = quotedText.replace(/[…\.]+$/, "").trim().toLowerCase()
  if (!needle) return []
  return candidates.filter((c) => {
    const body = String(c.body ?? "").toLowerCase()
    if (!body.includes(needle)) return false
    const created = c.createdAt
    if (typeof created === "string") {
      const t = Date.parse(created)
      if (!Number.isFinite(t)) return true // can't parse → don't drop, let body match decide
      return t >= cutoff
    }
    // No createdAt — keep (defensive; real outbound rows have createdAt).
    return true
  })
}

/**
 * One-shot orchestration for the paOnTapbackEvent CF: takes a tapback doc,
 * pulls Claire's recent outbound from `pa-outbound`, finds matches, extracts
 * jobIds, and writes matching-feedback rows.
 */
export async function processTapbackForFeedback(
  db: Firestore,
  tapback: {
    userId: string
    fromNumber?: string
    kind: TapbackFeedbackInput["kind"]
    quotedText: string
  },
  now: () => Date = () => new Date()
): Promise<RecordTapbackFeedbackResult> {
  // Outbound rows are keyed by `userId` (the WeKruit user identifier). The
  // tapback row carries the user's E.164 phone in `userId`/`fromNumber`. We
  // try the strongest match first: rows whose `toE164` matches the tapback
  // sender. Falls back to userId if upstream sets that.
  const lookback = new Date(now().getTime() - OUTBOUND_LOOKBACK_MS).toISOString()
  const peer = tapback.fromNumber ?? tapback.userId

  // Pull recent outbound for that recipient. We only consider sent/queued
  // statuses — failed rows weren't actually delivered, so the user couldn't
  // have reacted to them.
  let snap
  try {
    snap = await db
      .collection("pa-outbound")
      .where("toE164", "==", peer)
      .where("createdAt", ">=", lookback)
      .orderBy("createdAt", "desc")
      .limit(20)
      .get()
  } catch {
    // If the composite index isn't ready, fall back to a simpler query.
    snap = await db
      .collection("pa-outbound")
      .where("toE164", "==", peer)
      .limit(50)
      .get()
  }

  const candidates: Array<Record<string, unknown>> = []
  for (const d of snap.docs) {
    candidates.push({ id: d.id, ...d.data() })
  }
  const matched = selectMatchingOutbound(candidates, tapback.quotedText, now().getTime())
  if (matched.length === 0) {
    return { written: 0, jobIds: [] }
  }

  // Aggregate jobIds across all matched outbounds (rare to have >1 but cheap).
  const jobIdSet = new Set<string>()
  const jobMeta: Record<string, { companyName?: string; jobTitle?: string }> = {}
  for (const m of matched) {
    const ext = extractJobIdsFromOutbound(m)
    for (const id of ext.jobIds) jobIdSet.add(id)
    Object.assign(jobMeta, ext.jobMeta)
  }
  const jobIds = [...jobIdSet]
  if (jobIds.length === 0) return { written: 0, jobIds: [] }

  return recordTapbackFeedback(
    db,
    {
      userId: tapback.userId,
      kind: tapback.kind,
      quotedText: tapback.quotedText,
      jobIds,
      jobMeta,
    },
    now
  )
}
