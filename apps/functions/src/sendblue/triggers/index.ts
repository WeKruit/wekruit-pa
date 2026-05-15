/**
 * v1.8 Phase 77 — triggers/ public surface.
 *
 * Exports the TriggerRouter + every trigger class for wiring in webhook.ts
 * (Phase 77 round-2) and for testing.
 */
export {
  TriggerRouter,
  type Trigger,
  type TriggerContext,
  type TriggerOutcome,
  type TriggerRouterOpts,
  type DispatchResult,
} from "./router.js"

export {
  PrescreenTrigger,
  PRESCREEN_IDEMPOTENCY_WINDOW_MS,
  type PrescreenTriggerDeps,
} from "./prescreen.js"

export {
  LayoffTrigger,
  LAYOFF_TRIGGER_IDEMPOTENCY_WINDOW_MS,
  type LayoffTriggerDeps,
} from "./layoff.js"

export { CompactTrigger, type CompactTriggerDeps } from "./compact.js"

// v1.9 Phase 85 — Apply trigger (PASS-verified candidates skip prescreen).
export {
  ApplyTrigger,
  APPLY_IDEMPOTENCY_WINDOW_MS,
  PASS_LOOKBACK_MS,
  type ApplyTriggerDeps,
} from "./apply.js"
