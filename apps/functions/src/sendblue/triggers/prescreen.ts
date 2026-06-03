/**
 * v1.8 Phase 77 — PrescreenTrigger.
 *
 * Detects the candidate-side trigger pattern:
 *
 *   WeKruit_<jobId>_<userId>_Job
 *
 * Per PS7:
 *   - Regex: ^.*WeKruit_([A-Za-z0-9-]+)_([A-Za-z0-9_-]+)_Job.*$
 *   - jobId / userId char-class is closed (alnum + _ + -). Defends against
 *     injection of `/` `\n` `?` etc.
 *   - Idempotency: (jobId, userId, messageHandle) one trigger per 60 minutes
 *     so Sendblue retries are safe without blocking a fresh work session for
 *     the same job.
 *
 * Authorization (PS7 + PS15):
 *   - Trigger sender phone must resolve to a userId that EITHER matches the
 *     parsed userId (the candidate themselves) OR is in admin allowlist.
 *   - Anonymous / unrecognized sender → unauthorized + audit row.
 *
 * Runs `runPreScreenForUser({jobId, userId, toE164})` before the HTTP reply.
 * The reply is not a valid delivery guarantee until the session row and
 * first outbound handoff have been committed.
 */

import type { Trigger, TriggerContext, TriggerOutcome } from "./router.js"

const PRESCREEN_RE = /WeKruit_([A-Za-z0-9-]+)_([A-Za-z0-9_-]+)_Job/i

export const PRESCREEN_IDENTITY_CONFLICT_NOTICE =
  "This interview link is already tied to a different phone/account. If this is you, continue from that message thread, or reopen the job page and use the phone you want Claire to text."

/** Per-pair idempotency window. */
export const PRESCREEN_IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000 // 60 minutes

type PrescreenRunResult = { ok: boolean; reason?: string }

/** Deps the trigger needs at construct time. */
export interface PrescreenTriggerDeps {
  /** Phone → userId resolver. Returns null when unknown. */
  lookupUserByPhone(phone: string): Promise<string | null>
  /** Optional admin allowlist; pre-screen sender doesn't need to be admin. */
  isAdmin?(userId: string): Promise<boolean>
  /** Read idempotency timestamp ms (null = never fired). */
  getLastFiredMs(jobId: string, userId: string, messageHandle: string): Promise<number | null>
  /** Write idempotency timestamp. */
  setLastFiredMs(jobId: string, userId: string, messageHandle: string, ms: number): Promise<void>
  /** Remove idempotency timestamp when the durable handoff did not happen. */
  clearLastFiredMs?(jobId: string, userId: string, messageHandle: string): Promise<void>
  /** Run the actual pre-screening session bootstrap before the webhook replies. */
  runPreScreen(args: {
    jobId: string
    userId: string
    toE164: string
    /**
     * Public job page can prefill iMessage as:
     *   WeKruit_<jobId>_<userId>_Job\n\n<first prescreen answer>
     *
     * The trigger token authenticates/starts the session; this text is routed
     * as the candidate's first answer after the session is active.
     */
    initialReplyText?: string
    /**
     * v1.9 hotfix 2026-05-13 — when the trigger was authorized via a
     * public-job-page pending-invite (NOT self / NOT admin), this carries
     * the original wkr_uid for attribution. session userId is the
     * phone-resolved real userId.
     */
     sourceRequestedUserId?: string
    /**
     * MATCHED-GATE bypass (2026-05-31). The trigger sets this true ONLY for an
     * ADMIN sender (admin test-drives any user's session by design). A `self`
     * candidate copy-paste leaves it false so the bootstrap verifies the jobId
     * was actually matched/pushed to them — blocking a foreign jobId harvested
     * from a /j/:jobId URL or another candidate. `public_page` first-timers carry
     * `sourceRequestedUserId` instead (pending-invite = match evidence).
     */
    allowMatchedBypass?: boolean
  }): Promise<void | PrescreenRunResult>
  /** Queue a short candidate-safe notice when the token is valid but the sender phone cannot own it. */
  sendIdentityConflictNotice?(args: {
    targetUserId: string
    jobId: string
    toE164: string
    fromNumber?: string
    messageHandle: string
    content: string
    conflictCode: string
  }): Promise<void>
  /** Audit emitter (logged for both deny + accept). */
  audit(event: Record<string, unknown>): Promise<void>
  /** Optional clock seam for tests. */
  now?(): number

  /**
   * v1.9 hotfix 2026-05-13 — pending-invite binding.
   *
   * Public job page generates a random `wkr_uid` localStorage UUID and
   * stamps `pa-prescreen-pending-invites/{wkr_uid} = {jobId, createdAt}`
   * BEFORE the candidate opens iMessage. The candidate's SMS body then
   * contains that wkr_uid.
   *
   * When the trigger fires:
   *   1. Body userId = wkr_uid (NOT the real pa-users doc id)
   *   2. Sender phone resolves to the real pa-users userId (different from wkr_uid)
   *
   * Without this hook the trigger would either reject "not_self_or_admin"
   * OR (for admin sender) create a session keyed by the random wkr_uid, and
   * the Q1-reply webhook — which looks up active session BY phone-resolved
   * real userId — would miss the session and fall through to Claire.
   *
   * Optional for back-compat with v1.8 tests; production should always
   * inject both.
   */
  getPendingInvite?(requestedUserId: string): Promise<{ jobId?: string; createdAt?: string } | null>
  consumePendingInvite?(requestedUserId: string): Promise<void>
  /** 24h pending-invite TTL, ms. Override for tests; default 24h. */
  pendingInviteTtlMs?: number
}

export function extractInitialPrescreenReply(text: string, triggerText: string, triggerIndex: number): string | null {
  const after = text
    .slice(triggerIndex + triggerText.length)
    .replace(/^[\s:：,.;|/\\\-–—]+/, "")
    .trim()
  if (!after) return null
  return after.slice(0, 4_000)
}

function identityConflictCode(err: unknown): string | null {
  if (!(err instanceof Error)) return null
  if (!err.message.startsWith("identity_conflict:")) return null
  return err.message.split(":")[1]?.trim() || "unknown"
}

export class PrescreenTrigger implements Trigger {
  readonly name = "prescreen"

  constructor(private readonly deps: PrescreenTriggerDeps) {}

  match(text: string): boolean {
    if (typeof text !== "string") return false
    return PRESCREEN_RE.test(text)
  }

  async handle(ctx: TriggerContext): Promise<TriggerOutcome> {
    // Pre-screen REQUIRES text (not media-only).
    if (ctx.hasMedia) {
      return { kind: "unauthorized", reason: "media_attached_pre_screen_text_only" }
    }

    const m = ctx.text.match(PRESCREEN_RE)
    if (!m) return { kind: "unauthorized", reason: "regex_no_match" }
    const [, jobId, userId] = m
    const initialReplyText = extractInitialPrescreenReply(ctx.text, m[0], m.index ?? 0)

    const now = (this.deps.now ?? Date.now)()

    // Authorization
    let resolvedUserId: string | null
    try {
      resolvedUserId = await this.deps.lookupUserByPhone(ctx.fromNumber)
    } catch (err) {
      const conflictCode = identityConflictCode(err)
      if (!conflictCode) throw err
      await this.deps.audit({
        type: "trigger_unauthorized",
        trigger: "prescreen",
        reason: "identity_conflict",
        fromNumber: ctx.fromNumber,
        correlationId: ctx.messageHandle,
        payload: { jobId, targetUserId: userId, conflictCode },
      })
      try {
        await this.deps.sendIdentityConflictNotice?.({
          targetUserId: userId,
          jobId,
          toE164: ctx.fromNumber,
          ...(ctx.toNumber ? { fromNumber: ctx.toNumber } : {}),
          messageHandle: ctx.messageHandle,
          content: PRESCREEN_IDENTITY_CONFLICT_NOTICE,
          conflictCode,
        })
      } catch (noticeErr) {
        ctx.log("trigger.prescreen.identity_conflict_notice_failed", {
          jobId,
          targetUserId: userId,
          conflictCode,
          error: noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
        })
      }
      return { kind: "handled", action: "prescreen_identity_conflict_notified" }
    }
    if (!resolvedUserId) {
      await this.deps.audit({
        type: "trigger_unauthorized",
        trigger: "prescreen",
        reason: "phone_not_resolved",
        fromNumber: ctx.fromNumber,
        correlationId: ctx.messageHandle,
      })
      return { kind: "unauthorized", reason: "phone_not_resolved" }
    }
    const isSelf = resolvedUserId === userId
    const isAdmin = this.deps.isAdmin ? await this.deps.isAdmin(resolvedUserId) : false

    // v1.9 hotfix 2026-05-13 — pending-invite binding.
    // Public job page generates random wkr_uid and stamps a pending-invite
    // doc keyed by it. When the trigger body's userId matches that wkr_uid
    // AND the doc was created < TTL ago AND the jobId matches, this is a
    // PUBLIC-PAGE-CANDIDATE flow. Bind session to the phone-resolved real
    // userId (not the random wkr_uid). Without this, the session is keyed
    // by wkr_uid and the Q1-reply lookup (which uses phone-resolved real
    // userId) misses → falls through to Claire.
    const ttlMs = this.deps.pendingInviteTtlMs ?? 24 * 60 * 60 * 1000
    let pendingMatch = false
    if (!isSelf && this.deps.getPendingInvite) {
      try {
        const pending = await this.deps.getPendingInvite(userId)
        if (
          pending &&
          typeof pending.jobId === "string" &&
          pending.jobId === jobId &&
          typeof pending.createdAt === "string"
        ) {
          const createdMs = new Date(pending.createdAt).getTime()
          if (Number.isFinite(createdMs) && now - createdMs < ttlMs) {
            pendingMatch = true
          }
        }
      } catch (err) {
        ctx.log("trigger.prescreen.pending_invite_lookup_failed", {
          parsedUserId: userId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (!isSelf && !isAdmin && !pendingMatch) {
      await this.deps.audit({
        type: "trigger_unauthorized",
        trigger: "prescreen",
        reason: "not_self_or_admin",
        senderUserId: resolvedUserId,
        targetUserId: userId,
        correlationId: ctx.messageHandle,
      })
      return { kind: "unauthorized", reason: "not_self_or_admin" }
    }

    // Session userId selection:
    //   - self: body userId === resolved userId → use it (no-op)
    //   - pendingMatch: body userId = wkr_uid; rebind session to resolvedUserId
    //   - admin (without pendingMatch): admin testing on behalf of another
    //     user — keep body userId so admin can drive that user's session
    const sessionUserId = pendingMatch ? resolvedUserId : userId
    const role: "self" | "admin" | "public_page" = pendingMatch
      ? "public_page"
      : isSelf
        ? "self"
        : "admin"

    // Idempotency guards only webhook retries of the SAME Sendblue message.
    // A candidate sending a fresh trigger for the same job is a new work
    // session; `runPreScreenForUser` will supersede any still-active session.
    const messageHandle = ctx.messageHandle.trim() || "missing_message_handle"
    const last = await this.deps.getLastFiredMs(jobId, sessionUserId, messageHandle)
    if (last !== null && now - last < PRESCREEN_IDEMPOTENCY_WINDOW_MS) {
      ctx.log("trigger.prescreen.deduped", {
        jobId,
        userId: sessionUserId,
        messageHandle,
        sinceMs: now - last,
        windowMs: PRESCREEN_IDEMPOTENCY_WINDOW_MS,
      })
      await this.deps.audit({
        type: "trigger_deduped",
        trigger: "prescreen",
        jobId,
        userId: sessionUserId,
        messageHandle,
        sinceMs: now - last,
        correlationId: ctx.messageHandle,
      })
      return { kind: "handled", action: "prescreen_deduped" }
    }

    // Stamp idempotency BEFORE dispatching so a concurrent retry from
    // Sendblue (HMAC may double-deliver) doesn't double-fire. Idempotency
    // is keyed by the SESSION userId + message handle so a public-page
    // candidate doesn't get throttled by a stale wkr_uid stamp or older
    // same-job work session.
    await this.deps.setLastFiredMs(jobId, sessionUserId, messageHandle, now)

    try {
      const runResult = await this.deps.runPreScreen({
        jobId,
        userId: sessionUserId,
        toE164: ctx.fromNumber,
        ...(initialReplyText ? { initialReplyText } : {}),
        ...(pendingMatch ? { sourceRequestedUserId: userId } : {}),
        // STRING-TOKEN START bypasses the matched-gate for EVERY authorized sender (Adam 2026-06-03:
        // "the invited[gate] is for guarding the CONVERSATIONAL start; but for string → start it's
        // everyone"). Reaching here means the sender transmitted the EXACT WeKruit_<jobId>_<userId>_Job
        // string AND passed the self-identity check above (isSelf || admin || pending-invite) — token
        // possession + self-identity IS the authorization. The matched-gate (was this job ever
        // recommended to them) only guards the AGENT/conversational start (begin_collab_prescreen,
        // which resolves the candidate's matched roles first); it must NOT block an explicit self
        // copy-paste. This was the live 2026-06-03 ghost — +14108695008 pasted a product-designer
        // token never recommended to them → not_matched → SILENT no-reply. Now: every authorized
        // sender starts. The self-identity gate still blocks starting a screen AS someone else.
        allowMatchedBypass: true,
      })
      if (runResult && runResult.ok === false) {
        if (runResult.reason === "config_missing") {
          await this.deps.audit({
            type: "trigger_notice",
            trigger: "prescreen",
            reason: "config_missing",
            jobId,
            userId: sessionUserId,
            correlationId: ctx.messageHandle,
          })
          return { kind: "handled", action: "prescreen_config_missing" }
        }
        if (runResult.reason === "not_matched") {
          // MATCHED-GATE refusal (2026-05-31): the candidate sent a valid token for a
          // jobId never matched/pushed to them (foreign jobId from a /j/ URL or another
          // candidate). No session was created and no active screen superseded. This is a
          // controlled refusal, NOT an error — audit + clear the idempotency stamp so a
          // later legit start (after the job IS matched to them) isn't deduped away.
          await this.deps.audit({
            type: "trigger_unauthorized",
            trigger: "prescreen",
            reason: "job_not_matched_to_user",
            senderUserId: resolvedUserId,
            targetUserId: sessionUserId,
            jobId,
            correlationId: ctx.messageHandle,
          })
          if (this.deps.clearLastFiredMs) {
            try {
              await this.deps.clearLastFiredMs(jobId, sessionUserId, messageHandle)
            } catch {
              /* best-effort */
            }
          }
          return { kind: "handled", action: "prescreen_not_matched" }
        }
        throw new Error(`prescreen_start_${runResult.reason ?? "failed"}`)
      }
    } catch (err) {
      ctx.log("trigger.prescreen.run_threw", {
        jobId,
        userId: sessionUserId,
        error: err instanceof Error ? err.message : String(err),
      })
      try {
        await this.deps.clearLastFiredMs?.(jobId, sessionUserId, messageHandle)
      } catch (clearErr) {
        ctx.log("trigger.prescreen.idempotency_clear_failed", {
          jobId,
          userId: sessionUserId,
          messageHandle,
          error: clearErr instanceof Error ? clearErr.message : String(clearErr),
        })
      }
      throw err
    }

    // Consume pending-invite AFTER successful dispatch so a retry can re-
    // bind. Fail-open — delete failure does not roll back the trigger.
    if (pendingMatch && this.deps.consumePendingInvite) {
      try {
        await this.deps.consumePendingInvite(userId)
      } catch (err) {
        ctx.log("trigger.prescreen.pending_invite_consume_failed", {
          parsedUserId: userId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    await this.deps.audit({
      type: "trigger_fired",
      trigger: "prescreen",
      jobId,
      userId: sessionUserId,
      senderUserId: resolvedUserId,
      role,
      initialReplyCaptured: Boolean(initialReplyText),
      ...(pendingMatch ? { sourceRequestedUserId: userId } : {}),
      correlationId: ctx.messageHandle,
    })
    return { kind: "handled", action: "prescreen_triggered" }
  }
}
