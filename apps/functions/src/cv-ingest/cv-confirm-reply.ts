/**
 * Phase 54 (USER-TAG-03 / extends Phase 53 PARSE-07) — CV-confirm reply handler.
 *
 * The post-parse Claire confirm message ("看了你的简历——你做过 X, 用过 Y,
 * 最近在 Z. 对吗？") is enqueued by `enqueueCvConfirmMessage` (Phase 53)
 * onto `pa-outbound/out-cvconfirm-{resumeId}`. When the user replies, we
 * detect that this inbound is a follow-up to the confirm message and route
 * it through this handler instead of the regular orchestrator turn.
 *
 * Detection: the Sendblue webhook either (a) carries a `replyToMessageId`
 * matching `out-cvconfirm-{resumeId}` directly, or (b) we look up the most
 * recent `pa-outbound/out-cvconfirm-*` doc for the user (within 24h).
 *
 * Behavior:
 *   - Confirm-accepted (`对` / `yes`): no tag write, log telemetry.
 *   - Correction with new skills/industries/roles: project to canonical
 *     Phase 52 vocab, write via `applyPartialUserTags` (sole writer).
 *
 * Fail-open: every error path resolves to `{ accepted: false, correctionsApplied: 0 }`
 * and logs to telemetry. The webhook's main flow continues regardless.
 */

import type { Firestore } from "firebase-admin/firestore"
import {
  applyPartialUserTags,
  type PartialUserTags,
} from "@pa/pa-orchestrator"
import { parseUserCorrection } from "./cv-confirm-reply-parser.js"

const CV_CONFIRM_OUTBOUND_PREFIX = "out-cvconfirm-"
const CV_CONFIRM_REPLY_LOOKBACK_MS = 24 * 60 * 60 * 1000 // 24h

export interface HandleCvConfirmReplyArgs {
  /** Firestore — caller's persistence root. */
  db: Firestore
  /** Resolved userId for the inbound. Caller already did phone→user lookup. */
  userId: string
  /**
   * Optional: when the webhook carries `replyToMessageId` (sendblue native
   * reply), the resumeId can be extracted from it directly. When absent we
   * lookup the latest pending confirm in the lookback window.
   */
  resumeId?: string
  /** Raw inbound reply text. */
  replyText: string
  /** OpenAI API key. Caller resolves from env. */
  openaiApiKey?: string
  openaiBaseURL?: string
  /** Test seam: skip the LLM call and supply parsed output. */
  parseFn?: (replyText: string) => Promise<{
    confirmAccepted: boolean
    correctedSkills?: string[]
    correctedIndustries?: string[]
    correctedRoles?: string[]
    correctionFreeform?: string | null
  }>
  /** Test seam: skip Firestore lookup of latest confirm doc. */
  resolveResumeId?: (db: Firestore, userId: string) => Promise<string | null>
  log?: (event: string, payload?: Record<string, unknown>) => void
  nowIso?: () => string
}

export interface HandleCvConfirmReplyResult {
  /** True when the user accepted ("对" / "yes") with no corrections. */
  accepted: boolean
  /** Number of tag fields updated (0 when accepted or on error). */
  correctionsApplied: number
  /** Resolved resumeId if any. */
  resumeId?: string
  /** Error reason, if any (fail-open). */
  reason?: string
}

/**
 * Resolve the resumeId from the user's most-recent outbound confirm doc
 * (within 24h). Returns null when no pending confirm.
 */
async function defaultResolveResumeId(
  db: Firestore,
  userId: string
): Promise<string | null> {
  try {
    const cutoff = new Date(Date.now() - CV_CONFIRM_REPLY_LOOKBACK_MS).toISOString()
    const snap = await db
      .collection("pa-outbound")
      .where("userId", "==", userId)
      .where("createdBy", "==", "cv-ingest-confirm")
      .where("createdAt", ">=", cutoff)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get()
    if (snap.empty) return null
    const doc = snap.docs[0]!
    const data = doc.data() as Record<string, unknown>
    const meta = data.rawMeta as { cvConfirm?: { resumeId?: string } } | undefined
    return meta?.cvConfirm?.resumeId ?? null
  } catch {
    return null
  }
}

/**
 * Project the LLM-parsed correction into canonical Phase 52 PartialUserTags.
 *
 * - correctedSkills → `tags.skills` (full list, lowercased)
 * - correctedIndustries → `tags.industrySector` (canonical hints; downstream
 *   admin promotes if not in vocab)
 * - correctedRoles → `tags.targetRoleFunction` (subset of ROLE_FUNCTION_VOCAB
 *   when recognizable; else `proposedTags`)
 *
 * NB: we trust the LLM tokens to be sufficiently canonical. Cross-validating
 * against vocab is deferred to Phase 56's hard-filter consumer.
 */
function projectCorrectionToTags(parsed: {
  confirmAccepted: boolean
  correctedSkills?: string[]
  correctedIndustries?: string[]
  correctedRoles?: string[]
}): PartialUserTags {
  const out: PartialUserTags = {}
  if (Array.isArray(parsed.correctedSkills) && parsed.correctedSkills.length > 0) {
    // Append-only semantics on chat side: store as a flat array of
    // lowercased tokens. Phase 53 cv-ingest may already have a canonical
    // bag at `tags.skills`; this becomes the chat-supplemented bag. Phase
    // 56 consumers union both sources.
    out.skills = parsed.correctedSkills
  }
  if (
    Array.isArray(parsed.correctedIndustries) &&
    parsed.correctedIndustries.length > 0
  ) {
    out.industrySector = parsed.correctedIndustries
  }
  if (Array.isArray(parsed.correctedRoles) && parsed.correctedRoles.length > 0) {
    // Phase 52 role-function tokens (jobright 17). LLM is instructed to
    // produce snake_case canonical hints; we cast through the schema field.
    ;(out as Record<string, unknown>).targetRoleFunction = parsed.correctedRoles
  }
  return out
}

/**
 * Public entrypoint. NEVER throws.
 */
export async function handleCvConfirmReply(
  args: HandleCvConfirmReplyArgs
): Promise<HandleCvConfirmReplyResult> {
  const log = args.log ?? (() => {})
  const nowIso = args.nowIso ? args.nowIso() : new Date().toISOString()

  if (!args.userId) {
    return { accepted: false, correctionsApplied: 0, reason: "no_user_id" }
  }
  if (!args.replyText || !args.replyText.trim()) {
    return { accepted: false, correctionsApplied: 0, reason: "empty_reply" }
  }

  // Resolve resumeId if not provided.
  let resumeId = args.resumeId ?? null
  if (!resumeId) {
    const resolveFn = args.resolveResumeId ?? defaultResolveResumeId
    try {
      resumeId = await resolveFn(args.db, args.userId)
    } catch (err) {
      log("pa.cv_confirm_reply.resolve_error", {
        userId: args.userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Parse the reply via LLM (or test seam).
  let parsed: {
    confirmAccepted: boolean
    correctedSkills?: string[]
    correctedIndustries?: string[]
    correctedRoles?: string[]
    correctionFreeform?: string | null
  }
  try {
    if (args.parseFn) {
      parsed = await args.parseFn(args.replyText)
    } else {
      const apiKey = args.openaiApiKey ?? ""
      parsed = await parseUserCorrection({
        replyText: args.replyText,
        apiKey,
        baseURL: args.openaiBaseURL,
        log,
      })
    }
  } catch (err) {
    log("pa.cv_confirm_reply.parse_throw", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      accepted: false,
      correctionsApplied: 0,
      reason: "parse_error",
      ...(resumeId ? { resumeId } : {}),
    }
  }

  // Confirm-accepted path: telemetry + early return.
  const hasCorrections =
    (parsed.correctedSkills?.length ?? 0) > 0 ||
    (parsed.correctedIndustries?.length ?? 0) > 0 ||
    (parsed.correctedRoles?.length ?? 0) > 0
  if (parsed.confirmAccepted && !hasCorrections) {
    log("cv_confirm.accepted", {
      userId: args.userId,
      resumeId: resumeId ?? null,
    })
    return {
      accepted: true,
      correctionsApplied: 0,
      ...(resumeId ? { resumeId } : {}),
    }
  }

  // Correction path: project + write.
  const projected = projectCorrectionToTags(parsed)
  const fieldCount = Object.keys(projected).length
  if (fieldCount === 0) {
    // Reply was a non-confirm AND had no extractable tags (vent / question /
    // off-topic). Telemetry only.
    log("cv_confirm.no_corrections", {
      userId: args.userId,
      resumeId: resumeId ?? null,
      replyLen: args.replyText.length,
    })
    return {
      accepted: false,
      correctionsApplied: 0,
      ...(resumeId ? { resumeId } : {}),
    }
  }

  try {
    const res = await applyPartialUserTags(args.db, args.userId, projected, {
      source: "chat",
      nowIso,
      log,
    })
    if (!res.ok) {
      log("cv_confirm.write_failed", {
        userId: args.userId,
        resumeId: resumeId ?? null,
        error: res.error,
      })
      return {
        accepted: false,
        correctionsApplied: 0,
        reason: "write_failed",
        ...(resumeId ? { resumeId } : {}),
      }
    }
    log("cv_confirm.corrected", {
      userId: args.userId,
      resumeId: resumeId ?? null,
      fieldCount,
      mergedKeys: res.mergedKeys ?? [],
    })
    return {
      accepted: false,
      correctionsApplied: fieldCount,
      ...(resumeId ? { resumeId } : {}),
    }
  } catch (err) {
    log("cv_confirm.write_throw", {
      userId: args.userId,
      resumeId: resumeId ?? null,
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      accepted: false,
      correctionsApplied: 0,
      reason: "write_throw",
      ...(resumeId ? { resumeId } : {}),
    }
  }
}

/**
 * Detect whether an inbound reply matches the cv-confirm pattern.
 *
 * Heuristic (no LLM): user has a recent `out-cvconfirm-*` outbound (last
 * 24h) AND the inbound text doesn't look like an unrelated topic
 * (resume re-upload, "stop", crisis keyword, etc — those are gated upstream).
 *
 * The webhook integration uses this to short-circuit the inbound through
 * `handleCvConfirmReply` BEFORE the orchestrator's general turn handler
 * sees it.
 */
export async function detectCvConfirmReply(
  db: Firestore,
  userId: string,
  opts: { nowMs?: number; log?: (e: string, p?: Record<string, unknown>) => void } = {}
): Promise<{ matches: boolean; resumeId: string | null }> {
  const log = opts.log ?? (() => {})
  if (!userId) return { matches: false, resumeId: null }
  const nowMs = opts.nowMs ?? Date.now()
  const cutoff = new Date(nowMs - CV_CONFIRM_REPLY_LOOKBACK_MS).toISOString()
  try {
    const snap = await db
      .collection("pa-outbound")
      .where("userId", "==", userId)
      .where("createdBy", "==", "cv-ingest-confirm")
      .where("createdAt", ">=", cutoff)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get()
    if (snap.empty) return { matches: false, resumeId: null }
    const doc = snap.docs[0]!
    const data = doc.data() as Record<string, unknown>
    const meta = data.rawMeta as { cvConfirm?: { resumeId?: string } } | undefined
    const resumeId = meta?.cvConfirm?.resumeId ?? null
    // Optional: skip if doc has `replyHandledAt` already (idempotency).
    if (typeof data.replyHandledAt === "string") {
      return { matches: false, resumeId }
    }
    return { matches: true, resumeId }
  } catch (err) {
    log("pa.cv_confirm_reply.detect_error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { matches: false, resumeId: null }
  }
}

export { CV_CONFIRM_OUTBOUND_PREFIX }
