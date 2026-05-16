/**
 * S3 (v2.1) — outbound-bookings voice state machine reducer.
 *
 * Lock L10 (Adam 2026-05-15): transitions are deterministic. LLM never
 * controls state. Voice agent writes via CAS only.
 *
 * Allowed transitions:
 *
 *   queued    → dialing
 *   dialing   → connected | failed
 *   connected → completed | failed
 *   completed → reconciled
 *   failed    → reconciled
 *
 * Self-transitions (e.g. dialing → dialing) are allowed as no-ops so that
 * duplicate webhook deliveries do not throw. The reducer's CAS check elsewhere
 * (sipWebhook.ts) decides whether to write — this module is the pure rules
 * table.
 */

export const VOICE_STATES = [
  "queued",
  "dialing",
  "connected",
  "completed",
  "failed",
  "reconciled",
] as const

export type VoiceState = (typeof VOICE_STATES)[number]

const ALLOWED: Record<VoiceState, ReadonlySet<VoiceState>> = {
  queued: new Set<VoiceState>(["queued", "dialing", "failed"]),
  // ^ queued → failed allowed when identity short-circuit happens
  dialing: new Set<VoiceState>(["dialing", "connected", "failed"]),
  connected: new Set<VoiceState>(["connected", "completed", "failed"]),
  completed: new Set<VoiceState>(["completed", "reconciled"]),
  failed: new Set<VoiceState>(["failed", "reconciled"]),
  reconciled: new Set<VoiceState>(["reconciled"]),
}

export class InvalidVoiceTransitionError extends Error {
  constructor(
    public readonly from: VoiceState,
    public readonly to: VoiceState,
  ) {
    super(`Invalid voice state transition: ${from} -> ${to}`)
    this.name = "InvalidVoiceTransitionError"
  }
}

/**
 * Returns true if `from -> to` is a permitted transition (including
 * self-transitions for idempotency safety).
 */
export function canTransition(from: VoiceState, to: VoiceState): boolean {
  const allowed = ALLOWED[from]
  if (!allowed) return false
  return allowed.has(to)
}

/**
 * Returns true only if the transition is a meaningful forward step (excludes
 * self-transitions). Useful when deciding whether to perform a Firestore
 * write at all — replay-safe webhook handlers check this to skip no-ops.
 */
export function isForwardTransition(from: VoiceState, to: VoiceState): boolean {
  return from !== to && canTransition(from, to)
}

/**
 * Asserting variant. Throws InvalidVoiceTransitionError for disallowed
 * transitions.
 */
export function assertTransition(from: VoiceState, to: VoiceState): void {
  if (!canTransition(from, to)) {
    throw new InvalidVoiceTransitionError(from, to)
  }
}

/**
 * Terminal-state check (no further progression possible besides reconciled).
 */
export function isTerminal(s: VoiceState): boolean {
  return s === "completed" || s === "failed" || s === "reconciled"
}
