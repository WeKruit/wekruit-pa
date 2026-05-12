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
  runPreScreen(args: { jobId: string; userId: string; toE164: string }): Promise<void>
  /** Audit emitter (logged for both deny + accept). */
  audit(event: Record<string, unknown>): Promise<void>
  /** Optional clock seam for tests. */
  now?(): number
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
    if (!isSelf && !isAdmin) {
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

    // Stamp idempotency BEFORE dispatching so a concurrent retry from
    // Sendblue (HMAC may double-deliver) doesn't double-fire.
    await this.deps.setLastFiredMs(jobId, userId, now)

    // Fire-and-forget. Errors here would otherwise reject the HTTP reply.
    void Promise.resolve()
      .then(() =>
        this.deps.runPreScreen({
          jobId,
          userId,
          toE164: ctx.fromNumber,
        })
      )
      .catch((err) => {
        ctx.log("trigger.prescreen.run_threw", {
          jobId,
          userId,
          error: err instanceof Error ? err.message : String(err),
        })
      })

    await this.deps.audit({
      type: "trigger_fired",
      trigger: "prescreen",
      jobId,
      userId,
      senderUserId: resolvedUserId,
      role: isSelf ? "self" : "admin",
      correlationId: ctx.messageHandle,
    })
    return { kind: "handled", action: "prescreen_triggered" }
  }
}
