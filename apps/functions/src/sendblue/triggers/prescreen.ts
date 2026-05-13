/**
 * v1.8 Phase 77 — PrescreenTrigger.
 *
 * Detects the candidate-side trigger pattern:
 *
 *   WeKruit_<jobId>_<userId>_Job
 *
 * Per PS7:
 *   - Regex: ^.*WeKruit_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]+)_Job.*$
 *   - jobId / userId char-class is closed (alnum + _ + -). Defends against
 *     injection of `/` `\n` `?` etc.
 *   - Idempotency: (jobId, userId) one trigger per 60 minutes — wait helper
 *     reads an idempotency store the caller supplies.
 *
 * Authorization (PS7 + PS15):
 *   - Trigger sender phone must resolve to a userId that EITHER matches the
 *     parsed userId (the candidate themselves) OR is in admin allowlist.
 *   - Anonymous / unrecognized sender → unauthorized + audit row.
 *
 * Fires `runPreScreenForUser({jobId, userId, toE164})` fire-and-forget so
 * the HTTP reply stays fast. Heavy work (session creation + first Q
 * emission) happens in the background.
 */

import type { Trigger, TriggerContext, TriggerOutcome } from "./router.js"

const PRESCREEN_RE = /WeKruit_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]+)_Job/

/** Per-pair idempotency window. */
export const PRESCREEN_IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000 // 60 minutes

/** Deps the trigger needs at construct time. */
export interface PrescreenTriggerDeps {
  /** Phone → userId resolver. Returns null when unknown. */
  lookupUserByPhone(phone: string): Promise<string | null>
  /** Optional admin allowlist; pre-screen sender doesn't need to be admin. */
  isAdmin?(userId: string): Promise<boolean>
  /** Read idempotency timestamp ms (null = never fired). */
  getLastFiredMs(jobId: string, userId: string): Promise<number | null>
  /** Write idempotency timestamp. */
  setLastFiredMs(jobId: string, userId: string, ms: number): Promise<void>
  /** Fire the actual pre-screening session bootstrap. Fire-and-forget. */
  runPreScreen(args: {
    jobId: string
    userId: string
    toE164: string
    /**
     * v1.9 hotfix 2026-05-13 — when the trigger was authorized via a
     * public-job-page pending-invite (NOT self / NOT admin), this carries
     * the original wkr_uid for attribution. session userId is the
     * phone-resolved real userId.
     */
     sourceRequestedUserId?: string
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

    // Idempotency guard
    const now = (this.deps.now ?? Date.now)()
    const last = await this.deps.getLastFiredMs(jobId, userId)
    if (last !== null && now - last < PRESCREEN_IDEMPOTENCY_WINDOW_MS) {
      ctx.log("trigger.prescreen.deduped", {
        jobId,
        userId,
        sinceMs: now - last,
        windowMs: PRESCREEN_IDEMPOTENCY_WINDOW_MS,
      })
      await this.deps.audit({
        type: "trigger_deduped",
        trigger: "prescreen",
        jobId,
        userId,
        sinceMs: now - last,
        correlationId: ctx.messageHandle,
      })
      return { kind: "handled", action: "prescreen_deduped" }
    }

    // Authorization
    const resolvedUserId = await this.deps.lookupUserByPhone(ctx.fromNumber)
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

    // Stamp idempotency BEFORE dispatching so a concurrent retry from
    // Sendblue (HMAC may double-deliver) doesn't double-fire. Idempotency
    // is keyed by the SESSION userId so a public-page candidate doesn't
    // get throttled by a stale wkr_uid stamp.
    await this.deps.setLastFiredMs(jobId, sessionUserId, now)

    // Fire-and-forget. Errors here would otherwise reject the HTTP reply.
    void Promise.resolve()
      .then(() =>
        this.deps.runPreScreen({
          jobId,
          userId: sessionUserId,
          toE164: ctx.fromNumber,
          ...(pendingMatch ? { sourceRequestedUserId: userId } : {}),
        })
      )
      .catch((err) => {
        ctx.log("trigger.prescreen.run_threw", {
          jobId,
          userId: sessionUserId,
          error: err instanceof Error ? err.message : String(err),
        })
      })

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
      ...(pendingMatch ? { sourceRequestedUserId: userId } : {}),
      correlationId: ctx.messageHandle,
    })
    return { kind: "handled", action: "prescreen_triggered" }
  }
}
