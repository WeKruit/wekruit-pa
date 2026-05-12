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

export { CompactTrigger, type CompactTriggerDeps } from "./compact.js"
