/**
 * v1.9 Phase 85 — ApplyTrigger.
 *
 * Detects:
 *
 *   WeKruit_<jobId>_<userId>_Apply
 *
 * Per APPLY-01..03:
 *   - Skips prescreen + goes directly to PiiConfirmPipeline IF the sender
 *     has a prior PASS terminal for (jobId, userId) within 30 days.
 *   - Otherwise fails safe to the standard `_Job` prescreen flow so Level 1
 *     info is never revealed to an unverified candidate.
 *
 * Regex identical char class to PrescreenTrigger (alnum + _ + -). 60-min
 * idempotency for repeated invocations of the same _Apply trigger.
 */

import type { Trigger, TriggerContext, TriggerOutcome } from "./router.js"

const APPLY_RE = /WeKruit_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]+)_Apply/

export const APPLY_IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000
export const PASS_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

export interface ApplyTriggerDeps {
  /** Phone → userId resolver. Null = unknown sender. */
  lookupUserByPhone(phone: string): Promise<string | null>
  /** Find most recent PASS terminal for (jobId, userId). Null = none. */
  findRecentPass(args: {
    jobId: string
    userId: string
    sinceMs: number
  }): Promise<{ sessionId: string; terminalAtMs: number } | null>
  /** Run PII-confirm flow for verified-PASS candidate. Fire-and-forget. */
  runPiiConfirm(args: {
    jobId: string
    userId: string
    toE164: string
    sourceSessionId: string
  }): Promise<void>
  /** Fall-back to prescreen flow when no prior PASS found. Fire-and-forget. */
  runPreScreen(args: { jobId: string; userId: string; toE164: string }): Promise<void>
  /** Idempotency read/write keyed by (jobId, userId). */
  getLastFiredMs(jobId: string, userId: string): Promise<number | null>
  setLastFiredMs(jobId: string, userId: string, ms: number): Promise<void>
  /** Audit emitter. */
  audit(event: Record<string, unknown>): Promise<void>
  /** Optional clock seam for tests. */
  now?(): number
}

export class ApplyTrigger implements Trigger {
  readonly name = "apply"

  constructor(private readonly deps: ApplyTriggerDeps) {}

  match(text: string): boolean {
    if (typeof text !== "string") return false
    return APPLY_RE.test(text)
  }

  async handle(ctx: TriggerContext): Promise<TriggerOutcome> {
    if (ctx.hasMedia) {
      return { kind: "unauthorized", reason: "media_attached_apply_text_only" }
    }
    const m = ctx.text.match(APPLY_RE)
    if (!m) return { kind: "unauthorized", reason: "regex_no_match" }
    const [, jobId, userId] = m

    // Idempotency
    const now = (this.deps.now ?? Date.now)()
    const last = await this.deps.getLastFiredMs(jobId, userId)
    if (last !== null && now - last < APPLY_IDEMPOTENCY_WINDOW_MS) {
      ctx.log("trigger.apply.deduped", { jobId, userId, sinceMs: now - last })
      await this.deps.audit({
        kind: "trigger.apply.deduped",
        jobId,
        userId,
        sinceMs: now - last,
      })
      return { kind: "handled", action: "deduped" }
    }

    // Authorize: sender phone must resolve to the parsed userId.
    const senderUserId = await this.deps.lookupUserByPhone(ctx.fromNumber)
    if (!senderUserId || senderUserId !== userId) {
      await this.deps.audit({
        kind: "trigger.apply.unauthorized",
        jobId,
        userId,
        senderUserId,
        fromNumber: ctx.fromNumber,
      })
      return { kind: "unauthorized", reason: "sender_userId_mismatch" }
    }

    // Look up prior PASS within 30d.
    const recentPass = await this.deps.findRecentPass({
      jobId,
      userId,
      sinceMs: PASS_LOOKBACK_MS,
    })

    await this.deps.setLastFiredMs(jobId, userId, now)

    if (recentPass) {
      ctx.log("trigger.apply.verified_pass", {
        jobId,
        userId,
        sessionId: recentPass.sessionId,
      })
      await this.deps.audit({
        kind: "trigger.apply.verified_pass",
        jobId,
        userId,
        sessionId: recentPass.sessionId,
      })
      void this.deps
        .runPiiConfirm({
          jobId,
          userId,
          toE164: ctx.fromNumber,
          sourceSessionId: recentPass.sessionId,
        })
        .catch((err) =>
          ctx.log("trigger.apply.pii_threw", {
            jobId,
            userId,
            error: err instanceof Error ? err.message : String(err),
          })
        )
      return { kind: "handled", action: "pii_confirm" }
    }

    // No prior PASS — fall back to prescreen flow.
    ctx.log("trigger.apply.no_pass_fallback_prescreen", { jobId, userId })
    await this.deps.audit({
      kind: "trigger.apply.fallback_prescreen",
      jobId,
      userId,
    })
    void this.deps
      .runPreScreen({ jobId, userId, toE164: ctx.fromNumber })
      .catch((err) =>
        ctx.log("trigger.apply.prescreen_threw", {
          jobId,
          userId,
          error: err instanceof Error ? err.message : String(err),
        })
      )
    return { kind: "handled", action: "prescreen_fallback" }
  }
}
