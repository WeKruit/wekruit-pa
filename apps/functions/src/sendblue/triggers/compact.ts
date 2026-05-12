/**
 * v1.8 Phase 77 — CompactTrigger.
 *
 * Detects the admin trigger pattern `__PA_COMPACT__`, fires memory
 * compaction for the sender's userId (or an explicit target embedded in
 * the message).
 *
 * Admin-only (sender userId must be in PA_ADMIN_USER_IDS allowlist).
 * Refuses media. No idempotency window (admin reruns are intentional).
 *
 * Detail format:
 *   "__PA_COMPACT__"                    → compact sender's own memory
 *   "__PA_COMPACT__ target=<userId>"    → compact target user's memory
 */

import type { Trigger, TriggerContext, TriggerOutcome } from "./router.js"

const COMPACT_TOKEN = "__PA_COMPACT__"
const TARGET_RE = /target=([A-Za-z0-9_-]+)/

export interface CompactTriggerDeps {
  lookupUserByPhone(phone: string): Promise<string | null>
  /** PA_ADMIN_USER_IDS allowlist check. */
  isAdmin(userId: string): Promise<boolean>
  /** Fire-and-forget compaction. */
  runCompaction(args: { userId: string; reason: "admin_trigger" }): Promise<void>
  audit(event: Record<string, unknown>): Promise<void>
}

export class CompactTrigger implements Trigger {
  readonly name = "compact"

  constructor(private readonly deps: CompactTriggerDeps) {}

  match(text: string): boolean {
    if (typeof text !== "string") return false
    return text.includes(COMPACT_TOKEN)
  }

  async handle(ctx: TriggerContext): Promise<TriggerOutcome> {
    if (ctx.hasMedia) {
      return { kind: "unauthorized", reason: "media_attached_compact_text_only" }
    }
    const senderUserId = await this.deps.lookupUserByPhone(ctx.fromNumber)
    if (!senderUserId) {
      await this.deps.audit({
        type: "trigger_unauthorized",
        trigger: "compact",
        reason: "phone_not_resolved",
        fromNumber: ctx.fromNumber,
        correlationId: ctx.messageHandle,
      })
      return { kind: "unauthorized", reason: "phone_not_resolved" }
    }
    if (!(await this.deps.isAdmin(senderUserId))) {
      await this.deps.audit({
        type: "trigger_unauthorized",
        trigger: "compact",
        reason: "not_admin",
        senderUserId,
        correlationId: ctx.messageHandle,
      })
      return { kind: "unauthorized", reason: "not_admin" }
    }

    const targetMatch = ctx.text.match(TARGET_RE)
    const targetUserId = targetMatch ? targetMatch[1] : senderUserId

    void Promise.resolve()
      .then(() => this.deps.runCompaction({ userId: targetUserId, reason: "admin_trigger" }))
      .catch((err) => {
        ctx.log("trigger.compact.run_threw", {
          targetUserId,
          error: err instanceof Error ? err.message : String(err),
        })
      })

    await this.deps.audit({
      type: "trigger_fired",
      trigger: "compact",
      senderUserId,
      targetUserId,
      mode: senderUserId === targetUserId ? "self" : "admin_target",
      correlationId: ctx.messageHandle,
    })
    return { kind: "handled", action: "compact_triggered" }
  }
}
