import type { Trigger, TriggerContext, TriggerOutcome } from "./router.js"

// Suppress every legacy source-token variant before it reaches the broker or
// LLM. The visible candidate opener is now generic ("Hello, WeKruit!"); source
// provenance lives on pa-users.source via website/callable context, never as
// candidate-typed text. Case-insensitive matches all variants the bridge
// historically leaked through (WeKruit_LAID_OFF / WeKruit_Laid_Off /
// wekruit_laid_off / WeKruit_CANDIDATE_HI / ...).
export const LEGACY_SOURCE_TOKEN_RE = /wekruit_(?:laid_off|candidate_hi)/i

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
    return LEGACY_SOURCE_TOKEN_RE.test(text)
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
