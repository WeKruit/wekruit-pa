/**
 * gmail-nudge.ts — WS-3(b) deterministic "ask them to connect Gmail on wekruit.com" gate.
 *
 * Adam 2026-06-03: sometimes ask the candidate to connect Gmail on wekruit.com (a conversational
 * nudge + the link). Low-friction, OCCASIONAL — not every turn. WeKruit's identity north star is email
 * magic-link (Gmail OAuth is one L1 entry), so a phone-first candidate with no email handle on file
 * benefits from connecting Gmail (durable identity + cross-device profile).
 *
 * This is a STRUCTURED-FIELD reducer (NOT a regex over free text — no-regex-in-tagging rule). It reads
 * the already-fetched pa-users doc + a durable lastGmailNudgeAt cooldown stamp and decides whether THIS
 * turn may carry the one-turn nudge directive. The agent DECIDES whether to actually surface it (the
 * directive says "you MAY"), and the stamp is written when the gate passes so we don't nudge again
 * inside the cooldown window.
 *
 * Gate (ALL must hold):
 *   - canary user (new product behavior, dev phones only)
 *   - no verified email handle on file yet (emailOnFile false)
 *   - not opted out of outreach
 *   - cooldown elapsed since the last nudge (GMAIL_NUDGE_COOLDOWN_MS)
 *   - onboarding NOT actively mid-question (don't interrupt the wall)
 */

/** Don't nudge Gmail more than once per ~7 days (occasional, not spammy). */
export const GMAIL_NUDGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000

export interface ShouldNudgeGmailArgs {
  /** the already-fetched pa-users doc (zero extra read). */
  user: Record<string, unknown>
  /** true when this uid is a canary user. */
  isCanary: boolean
  /** true when an onboarding question is actively awaiting an answer (don't interrupt). */
  onboardingAwaitingAnswer?: boolean
  now?: number
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/** True when the candidate already has an email on file (handle/profile email present). */
function emailOnFile(user: Record<string, unknown>): boolean {
  if (str(user.email)) return true
  if (str(user.normalizedEmail)) return true
  // pa-candidate-auth claim writes emailHandleId onto the user when the email handle is linked;
  // but the durable signal we trust here is a top-level email/normalizedEmail field.
  return false
}

/** True when the candidate has opted out of outreach (never nudge). */
function optedOut(user: Record<string, unknown>): boolean {
  const state = str(user.candidateState) || str(user.lifecycleState)
  if (state === "opted_out" || state === "deleted") return true
  if (user.outreachOptedOut === true) return true
  return false
}

/**
 * Deterministic decision: may this turn carry the Gmail-connect nudge directive?
 * Pure (no IO). The caller stamps lastGmailNudgeAt durably when this returns true.
 */
export function shouldNudgeGmail(args: ShouldNudgeGmailArgs): boolean {
  if (!args.isCanary) return false
  if (args.onboardingAwaitingAnswer === true) return false
  const user = args.user
  if (emailOnFile(user)) return false
  if (optedOut(user)) return false
  const now = args.now ?? Date.now()
  const lastRaw = str(user.lastGmailNudgeAt)
  if (lastRaw) {
    const last = Date.parse(lastRaw)
    if (Number.isFinite(last) && now - last < GMAIL_NUDGE_COOLDOWN_MS) return false
  }
  return true
}
