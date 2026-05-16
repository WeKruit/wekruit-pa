/**
 * v2.1 S5 — TCPA gate public surface.
 *
 * S3 `handleDialOutbound` imports from this barrel:
 *
 *   import { runTcpaGate, applyTcpaGate, readGateMode } from "../tcpa/index.js"
 */

export { runTcpaGate, applyTcpaGate } from "./gate.js"
export type {
  RunTcpaGateDeps,
  ApplyTcpaGateDeps,
  ApplyTcpaGateResult,
  ApplyTcpaGateBookingRef,
} from "./gate.js"
export { readGateMode } from "./mode.js"
export type {
  GateMode,
  GateDecision,
  BlockReason,
  TcpaGateInput,
  TcpaAuditRow,
  DncResult,
  QuietHoursResult,
  ConsentResult,
  SubCheckResults,
} from "./types.js"
export { checkDnc } from "./dncCheck.js"
export { checkQuietHours } from "./quietHours.js"
export { checkConsent } from "./consentCheck.js"
