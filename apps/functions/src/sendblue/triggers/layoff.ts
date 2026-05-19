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
    await this.deps.audit({
      type: "trigger_unauthorized",
      trigger: "layoff",
      reason: "manual_layoff_trigger_disabled",
      fromNumber: ctx.fromNumber,
      correlationId: ctx.messageHandle,
    })
    return { kind: "unauthorized", reason: "manual_layoff_trigger_disabled" }
  }
}
