/**
 * Phase 36 — ImperfectionInjector barrel export.
 *
 * Wire-in (Adam-owed via WIRE-IN-PATCH.md) imports from this module:
 *
 *   import {
 *     injectImperfection,
 *     resolveArm,
 *     type InjectorResult,
 *   } from "./imperfection-injector/index.js"
 *
 * Pipeline position (after Phase 35 detector pass):
 *
 *   LLM rewriter draft
 *     → diff guard
 *     → detector pass (Phase 35)
 *     → injector pass (Phase 36, THIS module)
 *     → final
 *
 * 0 net new LLM calls. Pure text. < 5ms p95 per turn.
 */

export {
  detectLang,
  injectImperfection,
} from "./injector.js"

export {
  djb2Hash,
  firingRateForArm,
  resolveArm,
} from "./arm-router.js"

export {
  injectAtTurnOnset,
  isAtTurnOnset,
  startsWithAnyMarker,
  startsWithMarker,
} from "./position-constraint.js"

export type { InjectAtTurnOnsetResult } from "./position-constraint.js"

export { POLICIES_EN } from "./policies-en.js"
export { POLICIES_ZH } from "./policies-zh.js"

export type {
  ArmBucketRatios,
  InjectionPosition,
  InjectionType,
  InjectorArm,
  InjectorContext,
  InjectorResult,
  Policy,
  ResolveArmOpts,
  RngFn,
} from "./types.js"
