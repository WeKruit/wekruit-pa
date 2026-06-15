/**
 * prescreen-shared-answers-writer.ts — sole-writer for the GLOBAL cross-session
 * prescreen answer memory (SPEC §5b/§6).
 *
 * Store: `pa-users/{userId}.prescreenSharedAnswers` —
 *   Record<sharedKey, PrescreenSharedAnswer>
 *
 * This is a SEPARATE top-level field on the user doc, NOT part of `pa-users.tags`.
 * WHY (load-bearing): the `.tags` sole writer `writeUserTagsFull` overwrites the
 * ENTIRE `tags` blob on every CV re-ingest; a sibling store living inside `.tags`
 * would be silently clobbered. Keeping `prescreenSharedAnswers` top-level + giving
 * it its own writer means a CV re-parse never touches it.
 *
 * Writer contract (mirrors the `mergeUserTags` / `applyPartialUserTags` sole-writer
 * pattern — D8 / SPEC §5b):
 *   - Sole writer of `pa-users/{userId}.prescreenSharedAnswers`. Both prescreen
 *     runtimes (the deterministic FSM finalize seam AND the Claire agent finalize)
 *     call THIS — one writer, two callers.
 *   - Writes the SPECIFIC dotted path `prescreenSharedAnswers.${sharedKey}` via
 *     `set({...}, {merge:true})` — last-write-wins PER KEY. We do NOT write the whole
 *     map: Firestore `set(merge:true)` deep-merges nested maps (the reinit-cold
 *     gotcha), so writing the whole map would never delete a stale subfield and could
 *     clobber-merge. The dotted path replaces exactly one key, cleanly.
 *   - Idempotent: re-answering the same sharedKey overwrites it (newer wins). A guard
 *     skips the write when the incoming `updatedAt` is OLDER than what's already
 *     stored (defends against an out-of-order replay overwriting a fresher answer).
 *   - Fail-open: read/write errors are logged + swallowed; never blocks the screen.
 */

import type { Firestore } from "firebase-admin/firestore"
import { z } from "zod"

const PA_USERS_COLLECTION = "pa-users"
const FIELD = "prescreenSharedAnswers"

/**
 * One global shared-answer record. SPEC §5b.
 *
 * The carry-over RE-JUDGE (SPEC §7) reads `reply` (+ `summary`/`evidenceReplies`) and
 * re-scores it against the NEW job's rubric; `finalS`/`finalC` are the SOURCE job's
 * score, kept for provenance/audit only — they are NOT blind-carried into the new
 * session's verdict.
 */
export const PrescreenSharedAnswerSchema = z.object({
  /** The authored cross-job key, e.g. "ai_usage". */
  sharedKey: z.string().min(1).max(64),
  /** The candidate's raw answer text (latest/best). The re-judge input. */
  reply: z.string().min(1).max(8000),
  /** Per-turn aggregate summary at answer time (optional). */
  summary: z.string().max(2000).optional(),
  /** 0..1 raw match score from the SOURCE job's judge (provenance only). */
  finalS: z.number().min(0).max(1).optional(),
  /** 0..1 confidence from the SOURCE job's judge (provenance only). */
  finalC: z.number().min(0).max(1).optional(),
  /** Accumulated replies (bounded), mirror of PreScreenQuestionState.evidenceReplies. */
  evidenceReplies: z.array(z.string().max(8000)).max(20).optional(),
  /** Source session + job for provenance / carriedFrom marker. */
  sourceSessionId: z.string().min(1).max(200),
  sourceJobId: z.string().min(1).max(200),
  /** ISO answer time + last-update time. */
  answeredAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
})

export type PrescreenSharedAnswer = z.infer<typeof PrescreenSharedAnswerSchema>

/** The map shape stored on the user doc. */
export type PrescreenSharedAnswers = Record<string, PrescreenSharedAnswer>

export interface MergePrescreenSharedAnswerOpts {
  /** ISO; defaults to `new Date().toISOString()` (used only to backfill missing updatedAt). */
  nowIso?: string
  /** Logger; default no-op. Receives `pa.prescreen_shared_answers.*` events. */
  log?: (event: string, payload?: Record<string, unknown>) => void
}

/** Strip undefined keys so they don't poison the Firestore write. */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * Sole writer for `pa-users/{userId}.prescreenSharedAnswers[sharedKey]`.
 *
 * Last-write-wins per `sharedKey`, with an `updatedAt` recency guard. Validates the
 * record against `PrescreenSharedAnswerSchema` (a malformed record never reaches the
 * store). Fail-open: returns `{ ok: false, error }` rather than throwing.
 */
export async function mergeUserPrescreenSharedAnswers(
  db: Firestore,
  userId: string,
  answer: PrescreenSharedAnswer,
  opts: MergePrescreenSharedAnswerOpts = {},
): Promise<{ ok: boolean; error?: string; sharedKey?: string }> {
  const log = opts.log ?? (() => {})
  if (!userId) {
    log("pa.prescreen_shared_answers.skip", { reason: "no_user_id" })
    return { ok: false, error: "no_user_id" }
  }
  const nowIso = opts.nowIso ?? new Date().toISOString()

  // Backfill timestamps before validation so a caller may omit them.
  const candidate: Record<string, unknown> = stripUndefined({
    ...answer,
    answeredAt: answer.answeredAt || nowIso,
    updatedAt: answer.updatedAt || nowIso,
  })

  const parsed = PrescreenSharedAnswerSchema.safeParse(candidate)
  if (!parsed.success) {
    log("pa.prescreen_shared_answers.invalid", {
      userId,
      sharedKey: answer?.sharedKey,
      error: parsed.error.issues.map((i) => i.message).join("; "),
    })
    return { ok: false, error: "invalid_answer" }
  }
  const record = parsed.data
  const sharedKey = record.sharedKey

  // Recency guard — never let an older answer overwrite a fresher stored one.
  try {
    const snap = await db.collection(PA_USERS_COLLECTION).doc(userId).get()
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown> | undefined
      const map = data?.[FIELD]
      const existing =
        map && typeof map === "object" && !Array.isArray(map)
          ? ((map as Record<string, unknown>)[sharedKey] as Record<string, unknown> | undefined)
          : undefined
      const existingUpdatedAt =
        existing && typeof existing.updatedAt === "string" ? existing.updatedAt : null
      if (existingUpdatedAt && existingUpdatedAt > record.updatedAt) {
        log("pa.prescreen_shared_answers.skip_stale", {
          userId,
          sharedKey,
          existingUpdatedAt,
          incomingUpdatedAt: record.updatedAt,
        })
        return { ok: true, sharedKey }
      }
    }
  } catch (err) {
    // Read failure is non-fatal — proceed to write (last-write-wins is the contract).
    log("pa.prescreen_shared_answers.read_error", {
      userId,
      sharedKey,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // Dotted-path write of the SPECIFIC key (clean last-write-wins; no deep-merge of
  // the whole map). `{merge:true}` preserves OTHER sharedKeys on the doc.
  try {
    await db
      .collection(PA_USERS_COLLECTION)
      .doc(userId)
      .set({ [`${FIELD}.${sharedKey}`]: record }, { merge: true })
    log("pa.prescreen_shared_answers.write_ok", {
      userId,
      sharedKey,
      sourceJobId: record.sourceJobId,
      sourceSessionId: record.sourceSessionId,
    })
    return { ok: true, sharedKey }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log("pa.prescreen_shared_answers.write_error", { userId, sharedKey, error: msg })
    return { ok: false, error: msg }
  }
}

/**
 * Read the global shared-answer map for a user (fail-soft → {}). Used by the
 * carry-over read path at session start (both runtimes).
 */
export async function readUserPrescreenSharedAnswers(
  db: Firestore,
  userId: string,
  opts: { log?: (event: string, payload?: Record<string, unknown>) => void } = {},
): Promise<PrescreenSharedAnswers> {
  const log = opts.log ?? (() => {})
  if (!userId) return {}
  try {
    const snap = await db.collection(PA_USERS_COLLECTION).doc(userId).get()
    if (!snap.exists) return {}
    const data = snap.data() as Record<string, unknown> | undefined
    const map = data?.[FIELD]
    if (!map || typeof map !== "object" || Array.isArray(map)) return {}
    const out: PrescreenSharedAnswers = {}
    for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
      const parsed = PrescreenSharedAnswerSchema.safeParse(v)
      if (parsed.success) out[k] = parsed.data
    }
    return out
  } catch (err) {
    log("pa.prescreen_shared_answers.read_error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
}
