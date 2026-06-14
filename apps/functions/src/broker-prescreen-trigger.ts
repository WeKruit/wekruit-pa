// Prescreen token, BOTH forms (2026-06-13):
//   - JOB-ONLY (NEW): `WeKruit_<jobId>_Job` — no uid. Identity is phone-is-auth;
//     the resolved inbound user owns the start (no token uid to compare).
//   - JOB+UID (LEGACY, back-compat for in-flight tokens): `WeKruit_<jobId>_<uid>_Job`.
// jobId is `[a-z0-9-]+` (normalizeCompanyName collapses every non-alnum to `-`,
// NO underscores), so the optional uid segment is unambiguous: the jobId capture
// can never swallow a `_`. (Anchored jobId charset = hyphen-only — the legacy
// pattern's `[A-Za-z0-9_-]+` jobId class was over-broad and is tightened here so
// the two-vs-one segment disambiguation is provably correct.)
import { isBindCode } from "@pa/pa-orchestrator"

const BROKER_PRESCREEN_TRIGGER_RE = /WeKruit_([A-Za-z0-9-]+)(?:_([A-Za-z0-9_-]+))?_Job/

export type BrokerPrescreenTriggerDecision =
  | { kind: "not_trigger" }
  | { kind: "authorized"; jobId: string; userId: string }
  | { kind: "unauthorized"; jobId: string; targetUserId: string; reason: "not_self" }

export function decideBrokerPrescreenTrigger(
  text: string,
  resolvedUserId: string,
): BrokerPrescreenTriggerDecision {
  const match = text.match(BROKER_PRESCREEN_TRIGGER_RE)
  if (!match) return { kind: "not_trigger" }
  const [, jobId, rawSegment] = match
  // A BIND-CODE segment (2026-06-14 website-first identity bridge) is resolved+
  // consumed by lookupUserByPhone UPSTREAM (it binds the texted phone to the web
  // candidate), so by the time we get `resolvedUserId` the phone is already the
  // right account. Treat a bind-code segment like the JOB-ONLY form → phone-is-
  // auth start, no token-uid self-compare. Legacy raw uid keeps the gate.
  const targetUserId = rawSegment && isBindCode(rawSegment) ? undefined : rawSegment
  // JOB-ONLY form (no uid) → phone-is-auth: start for the resolved inbound user.
  // There is no token uid to compare, so there is no impersonation surface.
  if (!targetUserId) {
    return { kind: "authorized", jobId, userId: resolvedUserId }
  }
  // LEGACY job+uid form → keep the self-identity gate (start only AS yourself).
  if (targetUserId !== resolvedUserId) {
    return { kind: "unauthorized", jobId, targetUserId, reason: "not_self" }
  }
  return { kind: "authorized", jobId, userId: resolvedUserId }
}
