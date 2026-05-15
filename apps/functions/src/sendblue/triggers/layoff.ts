import type { Trigger, TriggerContext, TriggerOutcome } from "./router.js"
import { LAYOFF_SMS_TRIGGER_TEXT } from "../../layoff-sms-start.js"

const LAYOFF_RE = new RegExp(`(?:^|\\s)${LAYOFF_SMS_TRIGGER_TEXT}(?:\\s|$)`)

export const LAYOFF_TRIGGER_IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000

export interface LayoffTriggerDeps {
  lookupUserByPhone(phone: string): Promise<string | null>
  runLayoffStart(args: { userId: string; toE164: string }): Promise<void>
  getLastFiredMs(userId: string): Promise<number | null>
  setLastFiredMs(userId: string, ms: number): Promise<void>
  audit(event: Record<string, unknown>): Promise<void>
  now?(): number
}

export class LayoffTrigger implements Trigger {
  readonly name = "layoff"

  constructor(private readonly deps: LayoffTriggerDeps) {}

  match(text: string): boolean {
    if (typeof text !== "string") return false
    return LAYOFF_RE.test(text)
  }

  async handle(ctx: TriggerContext): Promise<TriggerOutcome> {
    if (ctx.hasMedia) {
      return { kind: "unauthorized", reason: "media_attached_layoff_text_only" }
    }

    const userId = await this.deps.lookupUserByPhone(ctx.fromNumber)
    if (!userId) {
      await this.deps.audit({
        type: "trigger_unauthorized",
        trigger: "layoff",
        reason: "phone_not_resolved",
        fromNumber: ctx.fromNumber,
        correlationId: ctx.messageHandle,
      })
      return { kind: "unauthorized", reason: "phone_not_resolved" }
    }

    const now = (this.deps.now ?? Date.now)()
    const last = await this.deps.getLastFiredMs(userId)
    if (last !== null && now - last < LAYOFF_TRIGGER_IDEMPOTENCY_WINDOW_MS) {
      await this.deps.audit({
        type: "trigger_deduped",
        trigger: "layoff",
        userId,
        sinceMs: now - last,
        correlationId: ctx.messageHandle,
      })
      return { kind: "handled", action: "layoff_deduped" }
    }

    await this.deps.setLastFiredMs(userId, now)

    void Promise.resolve()
      .then(() => this.deps.runLayoffStart({ userId, toE164: ctx.fromNumber }))
      .catch((err) => {
        ctx.log("trigger.layoff.run_threw", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        })
      })

    await this.deps.audit({
      type: "trigger_fired",
      trigger: "layoff",
      userId,
      correlationId: ctx.messageHandle,
    })
    return { kind: "handled", action: "layoff_triggered" }
  }
}
