/**
 * v1.8 Phase 77 — TriggerRouter (table-driven).
 *
 * Replaces the 3 inline trigger branches in webhook.ts (`__PA_FIND_MATCH__`,
 * `__PA_RESET__`, and the new `WeKruit_<jobId>_<userId>_Job` pre-screen
 * trigger) with a single regex-table registry. Adding a new trigger is one
 * registration call, not surgery on the 720-line webhook.
 *
 * Migration plan (Phase 77 round-2): webhook.ts replaces its 3 inline
 * branches with `await router.dispatch(...)`. Until then, this router runs
 * standalone and is exercised by unit tests + Phase 80 runner.
 *
 * Locked design (PS7 + PS8):
 *   - HTTP/HMAC stays in webhook.ts
 *   - This module owns trigger detection + authorization + dispatch + audit
 *     emission
 *   - Each trigger is a separate file under triggers/ implementing the
 *     `Trigger` interface
 *   - Priority + short-circuit: first matching trigger wins; no fall-through
 */

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** Common shape passed from webhook to router for every inbound message. */
export interface TriggerContext {
  /** Normalized text body (already mediaUrl-stripped at HTTP layer). */
  text: string
  /** Phone number that sent the message. */
  fromNumber: string
  /** Sendblue message handle (correlation id). */
  messageHandle: string
  /** ISO timestamp the message was received. */
  receivedAtIso: string
  /** Function-scoped logger. */
  log: (event: string, payload: Record<string, unknown>) => void
  /** Whether mediaUrl was attached (some triggers refuse media). */
  hasMedia: boolean
}

/** What a trigger returns when its regex matches. */
export type TriggerOutcome =
  | { kind: "handled"; action: string; ack?: string }
  | { kind: "unauthorized"; reason: string }
  | { kind: "error"; reason: string }

/**
 * Trigger contract. Implementations live in this directory (prescreen.ts,
 * compact.ts, find-match.ts, reset.ts).
 *
 * `match()` is a synchronous predicate over the normalized text. `handle()`
 * runs bounded trigger work and returns an outcome so the router can route an
 * HTTP reply + audit event.
 *
 * Returning `kind:"unauthorized"` on `handle()` is the ONLY way a trigger
 * can refuse to run — it must NOT throw. Authorization MUST happen in
 * `handle()`, not `match()`, so audit logs capture deny events.
 */
export interface Trigger {
  /** Stable telemetry id (e.g. "prescreen", "compact", "find-match"). */
  readonly name: string
  /**
   * Predicate over normalized text. Pure + fast. Regex-only — no async,
   * no auth check, no Firestore read.
   */
  match(text: string): boolean
  /**
   * Fire the action. The returned promise SHOULD resolve quickly enough for
   * the HTTP reply (~1-2s); heavy runtime work must be handed off to durable
   * infrastructure such as `pa-inbound-events`, not run inside the webhook.
   */
  handle(ctx: TriggerContext): Promise<TriggerOutcome>
}

// ────────────────────────────────────────────────────────────────────────────
// Router
// ────────────────────────────────────────────────────────────────────────────

export interface TriggerRouterOpts {
  /** Triggers in priority order — first match wins. */
  triggers: Trigger[]
  /** Optional global logger. */
  log?: (event: string, payload: Record<string, unknown>) => void
}

export interface DispatchResult {
  /** True when at least one trigger matched + handled. Caller short-circuits
   *  webhook fallthrough. False = no trigger matched, webhook continues. */
  handled: boolean
  /** Which trigger handled (if any). */
  triggerName?: string
  /** Outcome from the matched trigger. */
  outcome?: TriggerOutcome
}

/**
 * Table-driven trigger router. Webhook.ts wires it up once at module load:
 *
 *   const router = new TriggerRouter({ triggers: [
 *     new PrescreenTrigger(...),
 *     new CompactTrigger(...),
 *     new FindMatchTrigger(...),
 *     new ResetTrigger(...),
 *   ]})
 *
 * Then per-request:
 *
 *   const r = await router.dispatch(ctx)
 *   if (r.handled) { reply(200, ...); return }
 *
 * Adding a new trigger = one registration line.
 */
export class TriggerRouter {
  constructor(private readonly opts: TriggerRouterOpts) {}

  async dispatch(ctx: TriggerContext): Promise<DispatchResult> {
    for (const trigger of this.opts.triggers) {
      let matched = false
      try {
        matched = trigger.match(ctx.text)
      } catch (err) {
        ctx.log("trigger.match_error", {
          name: trigger.name,
          error: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      if (!matched) continue

      let outcome: TriggerOutcome
      try {
        outcome = await trigger.handle(ctx)
      } catch (err) {
        ctx.log("trigger.handle_threw", {
          name: trigger.name,
          error: err instanceof Error ? err.message : String(err),
        })
        outcome = {
          kind: "error",
          reason: err instanceof Error ? err.message : String(err),
        }
      }

      this.opts.log?.("trigger.dispatched", {
        name: trigger.name,
        outcomeKind: outcome.kind,
        action: outcome.kind === "handled" ? outcome.action : undefined,
      })

      return { handled: true, triggerName: trigger.name, outcome }
    }
    return { handled: false }
  }
}
