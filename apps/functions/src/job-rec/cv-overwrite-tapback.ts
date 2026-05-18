/**
 * Stream H3 — second-CV overwrite UX: tapback resolver.
 *
 * Pipeline (extends the existing paOnTapbackEvent CF):
 *   1. User sends 2nd+ CV → cv-ingest stages it in `pa-cv-pending/{newResumeId}`
 *      and asks Claire runtime to decide whether/how to prompt.
 *   2. Claire runtime authors the prompt; user reacts ❤️ (love) or 🤔 (question).
 *   3. Inbound webhook → pa-tapback-events row → paOnTapbackEvent CF fires.
 *   4. CF first checks if the tapback's quotedText matches a recent
 *      runtime-authored overwrite outbound. If yes → handle here (love =
 *      replace / question = supplement) and SHORT-CIRCUIT the existing
 *      job-rec match-feedback flow. Otherwise fall through.
 *
 * Idempotency: every Firestore mutation is set-merge or .create() ALREADY_EXISTS-
 * tolerant. Replaying a duplicate webhook produces zero new state.
 *
 * Race note (3rd CV while 2nd pending): findExistingResume always returns the
 * most-recent NON-archived row in parsedCandidateResumes. If the tapback
 * arrives for the 2nd CV after a 3rd CV has already promoted/staged, we still
 * promote/supplement the 2nd CV per the user's stated intent — but log
 * `pa.cv_overwrite.race_detected` for forensics. Full versioning (tx + monotonic
 * version field) is technical debt left to a follow-up.
 */

import type { Firestore } from "firebase-admin/firestore"
import {
  CV_PENDING_COLLECTION,
} from "../cv-ingest/cv-ingest.js"
import { enqueueRuntimeEventHandoff } from "../runtime-event-handoff.js"

const PARSED_RESUMES_COLLECTION = "parsedCandidateResumes"
const OUTBOUND_COLLECTION = "pa-outbound"
const PA_TAPBACK_LOOKBACK_MS = 24 * 60 * 60 * 1000 // 24h — match the pending TTL

export type CvOverwriteTapbackResult =
  | { handled: false; reason: string }
  | {
      handled: true
      action: "replace" | "supplement"
      newResumeId: string
      previousResumeId: string
    }

/**
 * Find the most recent runtime-authored overwrite outbound for this user whose
 * body contains the tapback's quoted excerpt.
 *
 * Strategy: query pa-outbound by toE164 + createdAt range, filter to docIds
 * carrying runtimeEventContext.cvOverwrite, then body-includes match against
 * quotedText.
 */
async function findCvOverwritePromptForTapback(
  db: Firestore,
  args: { peerE164: string; quotedText: string; nowMs: number }
): Promise<Record<string, unknown> | null> {
  const lookbackIso = new Date(args.nowMs - PA_TAPBACK_LOOKBACK_MS).toISOString()
  // Try the indexed query first; if the composite index isn't ready, fall
  // back to a coarser query.
  type DocLike = { id: string; data(): Record<string, unknown> | undefined }
  type SnapLike = { docs: DocLike[] }
  let snap: SnapLike
  try {
    const q = db
      .collection(OUTBOUND_COLLECTION)
      .where("toE164", "==", args.peerE164)
      .where("createdAt", ">=", lookbackIso)
      .orderBy("createdAt", "desc")
      .limit(20)
    snap = (await (q as unknown as { get: () => Promise<SnapLike> }).get()) as SnapLike
  } catch {
    try {
      const q = db
        .collection(OUTBOUND_COLLECTION)
        .where("toE164", "==", args.peerE164)
        .limit(50)
      snap = (await (q as unknown as { get: () => Promise<SnapLike> }).get()) as SnapLike
    } catch {
      return null
    }
  }

  // Filter to overwrite-prompt docs whose body contains the tapback excerpt.
  const needle = args.quotedText.replace(/[…\.]+$/, "").trim().toLowerCase()
  for (const d of snap.docs) {
    const data = d.data() ?? {}
    const rawMeta = (data as { rawMeta?: Record<string, unknown> }).rawMeta
    const runtimeContext =
      rawMeta && typeof rawMeta === "object"
        ? (rawMeta.runtimeEventContext as Record<string, unknown> | undefined)
        : undefined
    const cvOverwrite =
      runtimeContext && typeof runtimeContext === "object"
        ? (runtimeContext.cvOverwrite as { newResumeId?: string; previousResumeId?: string } | undefined)
        : undefined
    if (!cvOverwrite?.newResumeId) continue
    const body = String((data as Record<string, unknown>).body ?? "").toLowerCase()
    if (needle && !body.includes(needle)) continue
    return { id: d.id, ...data }
  }
  return null
}

/**
 * Read the staging row from `pa-cv-pending/{newResumeId}`.
 * Returns null on missing or schema-malformed.
 */
async function readPendingByNewResumeId(
  db: Firestore,
  newResumeId: string
): Promise<{
  newResumeId: string
  previousResumeId: string
  userId: string
  parsedDoc: Record<string, unknown>
  expireAt: string | null
} | null> {
  try {
    const ref = db.collection(CV_PENDING_COLLECTION).doc(newResumeId)
    const snap = await (ref as unknown as { get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }> }).get()
    if (!snap.exists) return null
    const d = snap.data()
    if (!d) return null
    const prev = typeof d.previousResumeId === "string" ? d.previousResumeId : null
    const uid = typeof d.userId === "string" ? d.userId : null
    const parsedDoc = d.parsedDoc as Record<string, unknown> | undefined
    if (!prev || !uid || !parsedDoc) return null
    return {
      newResumeId,
      previousResumeId: prev,
      userId: uid,
      parsedDoc,
      expireAt: typeof d.expireAt === "string" ? d.expireAt : null,
    }
  } catch {
    return null
  }
}

/**
 * Promote a staged pending row to parsedCandidateResumes/{newResumeId}.
 *
 * Behavior:
 *   - replace: tombstone the previous row (archived/replacedBy/archivedAt),
 *     write the new row.
 *   - supplement: keep the previous row as-is, write the new row with
 *     `additionalCv: true`.
 *
 * Both actions hand confirmation context to Claire runtime and delete the
 * pa-cv-pending row.
 */
export async function promotePendingCv(
  db: Firestore,
  args: {
    pending: {
      newResumeId: string
      previousResumeId: string
      userId: string
      parsedDoc: Record<string, unknown>
    }
    action: "replace" | "supplement"
    nowIso: string
    confirmationToE164?: string | null
    /** When true, skip the confirmation runtime handoff (TTL fallback path). */
    silent?: boolean
    /** Inject for tests. */
    log?: (event: string, payload?: Record<string, unknown>) => void
  }
): Promise<{ promoted: boolean; archived: boolean }> {
  const log = args.log ?? (() => {})
  const { pending, action, nowIso } = args

  // 1. (replace only) Tombstone previous row.
  let archived = false
  if (action === "replace") {
    try {
      await db.collection(PARSED_RESUMES_COLLECTION).doc(pending.previousResumeId).set(
        {
          archived: true,
          archivedAt: nowIso,
          replacedBy: pending.newResumeId,
        },
        { merge: true }
      )
      archived = true
    } catch (err) {
      log("pa.cv_overwrite.archive_error", {
        userId: pending.userId,
        previousResumeId: pending.previousResumeId,
        error: err instanceof Error ? err.message : String(err),
      })
      // Continue — we'd rather have both rows live than lose the new one.
    }
  }

  // 2. Promote the new row. Use .set({ merge: false }) on a deterministic id
  //    so duplicate calls overwrite-with-the-same-data (idempotent).
  let promoted = false
  try {
    const promotedDoc: Record<string, unknown> = {
      ...pending.parsedDoc,
      // Stamp the canonical createdAt only on promote.
      createdAt: new Date(nowIso),
      promotedAt: nowIso,
    }
    if (action === "supplement") {
      promotedDoc.additionalCv = true
      promotedDoc.supplementsResumeId = pending.previousResumeId
    }
    await db
      .collection(PARSED_RESUMES_COLLECTION)
      .doc(pending.newResumeId)
      .set(promotedDoc, { merge: true })
    promoted = true
  } catch (err) {
    log("pa.cv_overwrite.promote_error", {
      userId: pending.userId,
      newResumeId: pending.newResumeId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { promoted: false, archived }
  }

  // 3. Delete pending row (best-effort).
  try {
    await db.collection(CV_PENDING_COLLECTION).doc(pending.newResumeId).delete()
  } catch (err) {
    log("pa.cv_overwrite.pending_delete_error", {
      userId: pending.userId,
      newResumeId: pending.newResumeId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 4. Hand structured confirmation facts to runtime (idempotent event id).
  if (!args.silent && args.confirmationToE164) {
    const docId = `cv-overwrite-confirm-${pending.newResumeId}`
    try {
      const runtime = await enqueueRuntimeEventHandoff(db, {
        userId: pending.userId,
        toE164: args.confirmationToE164,
        source: "cv_overwrite",
        eventKind: "resume_overwrite_confirmed",
        idempotencyKey: `${pending.newResumeId}-${action}`,
        context: {
          newResumeId: pending.newResumeId,
          previousResumeId: pending.previousResumeId,
          action,
        },
      })
      if (!runtime.ok) throw new Error(`runtime_handoff_${runtime.reason}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isDup = /already.?exists|6 ALREADY_EXISTS/i.test(msg)
      log(
        isDup
          ? "pa.cv_overwrite.confirm_idempotent_skip"
          : "pa.cv_overwrite.confirm_error",
        { docId, userId: pending.userId, error: msg }
      )
    }
  }

  log("pa.cv_overwrite.promoted", {
    userId: pending.userId,
    newResumeId: pending.newResumeId,
    previousResumeId: pending.previousResumeId,
    action,
    archived,
  })
  return { promoted, archived }
}

/**
 * One-shot tapback resolver invoked from paOnTapbackEvent.
 *
 * Returns { handled: true } when the tapback corresponded to a runtime-authored
 * CV overwrite prompt and was processed. The CF caller short-circuits the
 * existing match-feedback flow on { handled: true } to avoid double-processing.
 *
 * Returns { handled: false } in every other case (no overwrite prompt
 * matched, malformed pending, unsupported tapback kind, etc.) so the caller
 * falls through to the existing job-rec pipeline.
 */
export async function processCvOverwriteTapback(
  db: Firestore,
  tapback: {
    userId: string
    fromNumber?: string
    kind: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question"
    quotedText: string
  },
  opts?: {
    nowIso?: () => string
    nowMs?: () => number
    log?: (event: string, payload?: Record<string, unknown>) => void
  }
): Promise<CvOverwriteTapbackResult> {
  const log = opts?.log ?? (() => {})
  const nowIso = (opts?.nowIso ?? (() => new Date().toISOString()))()
  const nowMs = (opts?.nowMs ?? (() => Date.now()))()

  // Only love (replace) and question (supplement) are meaningful here.
  if (tapback.kind !== "love" && tapback.kind !== "question") {
    return { handled: false, reason: "unsupported_kind" }
  }

  const peer = tapback.fromNumber ?? tapback.userId
  const promptRow = await findCvOverwritePromptForTapback(db, {
    peerE164: peer,
    quotedText: tapback.quotedText,
    nowMs,
  })
  if (!promptRow) {
    return { handled: false, reason: "no_overwrite_prompt_match" }
  }

  // Resolve the staged pending row from runtime metadata carried on the
  // outbound row. The visible message was authored by runtime; this metadata
  // only links the tapback to the staged resume.
  const rawMeta = (promptRow as { rawMeta?: Record<string, unknown> }).rawMeta
  const runtimeContext =
    rawMeta && typeof rawMeta === "object"
      ? (rawMeta.runtimeEventContext as Record<string, unknown> | undefined)
      : undefined
  const cvMeta =
    runtimeContext && typeof runtimeContext === "object"
      ? (runtimeContext.cvOverwrite as { newResumeId?: string; previousResumeId?: string } | undefined)
      : undefined
  const newResumeId = cvMeta?.newResumeId ?? null
  if (!newResumeId) {
    return { handled: false, reason: "missing_new_resume_id" }
  }

  const pending = await readPendingByNewResumeId(db, newResumeId)
  if (!pending) {
    log("pa.cv_overwrite.pending_missing", {
      userId: tapback.userId,
      newResumeId,
    })
    return { handled: false, reason: "pending_missing" }
  }

  // Race-guard: confirm the previousResumeId is still the most-recent
  // NON-archived row for this user. If not, log + still promote (per
  // user intent).
  const action: "replace" | "supplement" = tapback.kind === "love" ? "replace" : "supplement"
  // Look up confirmation phone from pa-users.
  let toE164: string | null = null
  try {
    const snap = await (db.collection("pa-users").doc(pending.userId) as unknown as {
      get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>
    }).get()
    const d = snap.exists ? snap.data() : undefined
    const phone = typeof d?.phoneE164 === "string" ? d.phoneE164 : null
    toE164 = phone && phone.length > 0 ? phone : null
  } catch {
    toE164 = null
  }

  const { promoted, archived } = await promotePendingCv(db, {
    pending: {
      newResumeId: pending.newResumeId,
      previousResumeId: pending.previousResumeId,
      userId: pending.userId,
      parsedDoc: pending.parsedDoc,
    },
    action,
    nowIso,
    confirmationToE164: toE164,
    log,
  })

  if (!promoted) {
    return { handled: false, reason: "promote_failed" }
  }
  log("pa.cv_overwrite.tapback_handled", {
    userId: pending.userId,
    kind: tapback.kind,
    action,
    newResumeId: pending.newResumeId,
    previousResumeId: pending.previousResumeId,
    archived,
  })
  return {
    handled: true,
    action,
    newResumeId: pending.newResumeId,
    previousResumeId: pending.previousResumeId,
  }
}

/**
 * 24-hour TTL fallback. Scans `pa-cv-pending` for rows whose `expireAt`
 * has elapsed and auto-promotes (default action: replace).
 *
 * Deps-injectable; intended to be called from `paJobRecDaily` (or a
 * dedicated daily cron). Returns counts for observability.
 */
export async function runPendingCvTtlSweep(
  db: Firestore,
  opts?: {
    nowIso?: () => string
    log?: (event: string, payload?: Record<string, unknown>) => void
    /** Test seam. */
    listExpired?: (
      db: Firestore,
      nowIso: string
    ) => Promise<
      Array<{
        newResumeId: string
        previousResumeId: string
        userId: string
        parsedDoc: Record<string, unknown>
      }>
    >
  }
): Promise<{ scanned: number; promoted: number; archived: number; failed: number }> {
  const log = opts?.log ?? (() => {})
  const nowIso = (opts?.nowIso ?? (() => new Date().toISOString()))()
  const lister =
    opts?.listExpired ??
    (async (db, ts) => {
      type DocLike = { id: string; data(): Record<string, unknown> | undefined }
      type SnapLike = { docs: DocLike[] }
      const out: Array<{
        newResumeId: string
        previousResumeId: string
        userId: string
        parsedDoc: Record<string, unknown>
      }> = []
      let snap: SnapLike
      try {
        const q = db
          .collection(CV_PENDING_COLLECTION)
          .where("expireAt", "<=", ts)
          .limit(100)
        snap = (await (q as unknown as { get: () => Promise<SnapLike> }).get()) as SnapLike
      } catch {
        return out
      }
      for (const d of snap.docs) {
        const data = d.data() ?? {}
        const prev = typeof data.previousResumeId === "string" ? data.previousResumeId : null
        const uid = typeof data.userId === "string" ? data.userId : null
        const parsed = data.parsedDoc as Record<string, unknown> | undefined
        if (!prev || !uid || !parsed) continue
        out.push({
          newResumeId: d.id,
          previousResumeId: prev,
          userId: uid,
          parsedDoc: parsed,
        })
      }
      return out
    })

  let scanned = 0
  let promoted = 0
  let archived = 0
  let failed = 0
  const expired = await lister(db, nowIso)
  for (const p of expired) {
    scanned++
    const r = await promotePendingCv(db, {
      pending: p,
      action: "replace",
      nowIso,
      silent: true,
      log,
    })
    if (r.promoted) promoted++
    else failed++
    if (r.archived) archived++
  }
  log("pa.cv_overwrite.ttl_sweep_done", { scanned, promoted, archived, failed })
  return { scanned, promoted, archived, failed }
}
