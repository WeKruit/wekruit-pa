// Prescreen token, BOTH forms (2026-06-13):
//   - JOB-ONLY (NEW): `WeKruit_<jobId>_Job` — no uid. Identity is phone-is-auth;
//     the resolved inbound user owns the start (no token uid to compare).
//   - JOB+UID (LEGACY, back-compat for in-flight tokens): `WeKruit_<jobId>_<uid>_Job`.
// jobId is `[a-z0-9-]+` (normalizeCompanyName collapses every non-alnum to `-`,
// NO underscores), so the optional uid segment is unambiguous: the jobId capture
// can never swallow a `_`. (Anchored jobId charset = hyphen-only — the legacy
// pattern's `[A-Za-z0-9_-]+` jobId class was over-broad and is tightened here so
// the two-vs-one segment disambiguation is provably correct.)
import { isBindCode, looksLikeGarbledStartToken } from "@pa/pa-orchestrator"

/**
 * Deterministic typo-ask notice (2026-06-16). Sent when an inbound LOOKS like a
 * prescreen start token but the bind-code didn't resolve (corrupted brand +
 * bad/expired/unknown code, or codeless) — INSTEAD of the stranger cold opener.
 * Warm, honest, asks for the exact link; no LLM, no duplicate account.
 */
export const BROKER_PRESCREEN_GARBLED_TOKEN_NOTICE =
  "looks like you sent a job link, but it didn't go through on my end — the text may have gotten garbled in transit. " +
  "could you resend the exact link from your job page? then i'll get you started right away 🙌"

const BROKER_PRESCREEN_TRIGGER_RE = /WeKruit_([A-Za-z0-9-]+)(?:_([A-Za-z0-9_-]+))?_Job/
// Brand-corruption-tolerant trigger (2026-06-16). iMessage autocorrect mangles
// the literal "WeKruit" brand word ("WeKeuit", "WeCruit", "Wekruit"...), so the
// exact RE above misses → cold opener → duplicate empty account + dead silence
// (live incident: "WeKeuit_..._Z8SRWFQZ_Job", +16263623119). This tolerant RE
// accepts ANY 4-9 char leading word in the brand slot, but is INTENTIONALLY
// UNSAFE on its own — it is gated below by isBindCode(segment): it ONLY proceeds
// when the trailing segment is a structurally-valid, server-minted bind code,
// never a raw uid / codeless token. The 2nd capture group is the bind-code
// candidate; group 1 is the jobId.
const BROKER_PRESCREEN_TRIGGER_TOLERANT_RE =
  /[A-Za-z]{4,9}_([A-Za-z0-9][A-Za-z0-9-]{1,160})_([A-Za-z0-9][A-Za-z0-9_-]{7,127})_Job/

export type BrokerPrescreenTriggerDecision =
  | { kind: "not_trigger" }
  | { kind: "authorized"; jobId: string; userId: string }
  | { kind: "unauthorized"; jobId: string; targetUserId: string; reason: "not_self" }
  // Looks like a start token structurally but the bind-code did NOT resolve
  // (corrupted/expired/unknown code, or codeless). The caller emits a graceful
  // "looks like a job link but it didn't go through — resend the exact link"
  // typo notice INSTEAD of dropping the candidate into the stranger cold opener
  // (which would mint a duplicate empty account + dead silence).
  | { kind: "garbled_token" }

export function decideBrokerPrescreenTrigger(
  text: string,
  resolvedUserId: string,
): BrokerPrescreenTriggerDecision {
  const trimmed = text.trim()
  const exact = trimmed.match(BROKER_PRESCREEN_TRIGGER_RE)
  if (!exact) {
    // EXACT brand missed — try the brand-corruption-tolerant pass. Only proceed
    // when the captured segment passes isBindCode (the same gate as the bind-code
    // arm below); a corrupted brand + valid bind code starts EXACTLY like the
    // correctly-spelled token (targetUserId=undefined → phone-is-auth start). A
    // non-bind-code segment is NOT accepted here.
    const tol = trimmed.match(BROKER_PRESCREEN_TRIGGER_TOLERANT_RE)
    const tolSeg = tol?.[2]?.trim()
    if (tol && tolSeg && isBindCode(tolSeg)) {
      return { kind: "authorized", jobId: tol[1], userId: resolvedUserId }
    }
    // Structurally token-ish but unresolvable (corrupted brand + bad/expired
    // code, or codeless) → ask about a typo instead of cold-opening a stranger.
    if (looksLikeGarbledStartToken(trimmed)) return { kind: "garbled_token" }
    return { kind: "not_trigger" }
  }
  const match = exact
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
