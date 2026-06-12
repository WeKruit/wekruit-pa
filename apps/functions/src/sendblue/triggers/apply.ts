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
export const APPLY_ACCESS_ISSUE_NOTICE =
  "I can't continue this WeKruit apply step from this phone yet. Use the Claire thread that completed the interview, or reopen the job page from the phone you want Claire to text."

type PrescreenRunResult = { ok: boolean; reason?: string }

export interface ApplyTriggerDeps {
  /** Phone → userId resolver. Null = unknown sender. */
  lookupUserByPhone(phone: string): Promise<string | null>
  /** Find most recent PASS terminal for (jobId, userId). Null = none. */
  findRecentPass(args: {
    jobId: string
    userId: string
    sinceMs: number
  }): Promise<{ sessionId: string; terminalAtMs: number } | null>
  /** Run PII-confirm flow for verified-PASS candidate before acknowledging the trigger. */
  runPiiConfirm(args: {
    jobId: string
    userId: string
    toE164: string
    sourceSessionId: string
  }): Promise<void>
  /** Fall back to prescreen flow when no prior PASS found before acknowledging the trigger. */
  runPreScreen(args: { jobId: string; userId: string; toE164: string }): Promise<void | PrescreenRunResult>
  /** Idempotency read/write keyed by (jobId, userId). */
  getLastFiredMs(jobId: string, userId: string): Promise<number | null>
  setLastFiredMs(jobId: string, userId: string, ms: number): Promise<void>
  clearLastFiredMs?(jobId: string, userId: string): Promise<void>
  /** Audit emitter. */
  audit(event: Record<string, unknown>): Promise<void>
  /** Queue a candidate-safe same-thread notice when the token cannot be authorized. */
  sendAccessIssueNotice(args: {
    targetUserId: string
    jobId: string
    toE164: string
    fromNumber?: string
    messageHandle: string
    content: string
    reason: string
  }): Promise<void>
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
      try {
        await this.deps.sendAccessIssueNotice({
          targetUserId: userId,
          jobId,
          toE164: ctx.fromNumber,
          ...(ctx.toNumber ? { fromNumber: ctx.toNumber } : {}),
          messageHandle: ctx.messageHandle,
          content: APPLY_ACCESS_ISSUE_NOTICE,
          reason: "sender_userId_mismatch",
        })
      } catch (noticeErr) {
        ctx.log("trigger.apply.access_notice_failed", {
          jobId,
          targetUserId: userId,
          reason: "sender_userId_mismatch",
          error: noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
        })
      }
      return { kind: "handled", action: "apply_access_issue_notified" }
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
      try {
        await this.deps.runPiiConfirm({
          jobId,
          userId,
          toE164: ctx.fromNumber,
          sourceSessionId: recentPass.sessionId,
        })
      } catch (err) {
        ctx.log("trigger.apply.pii_threw", {
          jobId,
          userId,
          error: err instanceof Error ? err.message : String(err),
        })
        try {
          await this.deps.clearLastFiredMs?.(jobId, userId)
        } catch (clearErr) {
          ctx.log("trigger.apply.idempotency_clear_failed", {
            jobId,
            userId,
            error: clearErr instanceof Error ? clearErr.message : String(clearErr),
          })
        }
        throw err
      }
      await this.deps.audit({
        kind: "trigger.apply.verified_pass",
        jobId,
        userId,
        sessionId: recentPass.sessionId,
      })
      return { kind: "handled", action: "pii_confirm" }
    }

    // No prior PASS — fall back to prescreen flow.
    ctx.log("trigger.apply.no_pass_fallback_prescreen", { jobId, userId })
    try {
      const runResult = await this.deps.runPreScreen({ jobId, userId, toE164: ctx.fromNumber })
      if (runResult && runResult.ok === false) {
        if (runResult.reason === "config_missing") {
          await this.deps.audit({
            kind: "trigger.apply.prescreen_config_missing",
            jobId,
            userId,
          })
          return { kind: "handled", action: "prescreen_config_missing" }
        }
        // RULE 2 (2026-06-11) — a terminal session already exists for this
        // (userId, jobId): never restart it. Friendly status notice instead
        // of throwing into the error path.
        if (runResult.reason === "already_completed") {
          try {
            await this.deps.sendAccessIssueNotice({
              targetUserId: userId,
              jobId,
              toE164: ctx.fromNumber,
              ...(ctx.toNumber ? { fromNumber: ctx.toNumber } : {}),
              messageHandle: ctx.messageHandle,
              content:
                "You've already completed this screen — it's with the team for review. I'll text you as soon as there's an update.",
              reason: "already_completed",
            })
          } catch (noticeErr) {
            ctx.log("trigger.apply.already_completed_notice_failed", {
              jobId,
              userId,
              error: noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
            })
          }
          await this.deps.audit({
            kind: "trigger.apply.prescreen_already_completed",
            jobId,
            userId,
          })
          return { kind: "handled", action: "prescreen_already_completed" }
        }
        if (runResult.reason === "start_in_progress") {
          // Concurrent start owns the create — friendly no-op.
          await this.deps.audit({
            kind: "trigger.apply.prescreen_start_in_progress",
            jobId,
            userId,
          })
          return { kind: "handled", action: "prescreen_start_in_progress" }
        }
        throw new Error(`prescreen_start_${runResult.reason ?? "failed"}`)
      }
    } catch (err) {
      ctx.log("trigger.apply.prescreen_threw", {
        jobId,
        userId,
        error: err instanceof Error ? err.message : String(err),
      })
      try {
        await this.deps.clearLastFiredMs?.(jobId, userId)
      } catch (clearErr) {
        ctx.log("trigger.apply.idempotency_clear_failed", {
          jobId,
          userId,
          error: clearErr instanceof Error ? clearErr.message : String(clearErr),
        })
      }
      throw err
    }
    await this.deps.audit({
      kind: "trigger.apply.fallback_prescreen",
      jobId,
      userId,
    })
    return { kind: "handled", action: "prescreen_fallback" }
  }
}
