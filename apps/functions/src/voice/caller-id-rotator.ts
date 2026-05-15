/**
 * S3 (v2.1) — caller-ID rotation strategies for outbound voice dispatch.
 *
 * Adam Task Prompt §3: default round-robin across
 * `TWILIO_OUTBOUND_CALLER_IDS`. Sticky-by-userId exposed as a strategy so
 * Adam can flip it on by env without code change.
 *
 * Strategy is selected via:
 *   PA_VOICE_CALLER_ID_STRATEGY = "roundrobin" (default) | "sticky_user"
 *
 * Both strategies are deterministic given the same input — that means a
 * dispatch retry against the same bookingId picks the same caller ID,
 * preserving thread continuity if a Twilio call leg is retried.
 */

import { createHash } from "node:crypto"

export interface CallerIdStrategy {
  readonly name: string
  pick(input: { bookingId: string; paUserId: string }): string
}

function hashTo(n: number, ...parts: string[]): number {
  const h = createHash("sha256")
  for (const p of parts) h.update(p)
  // Take first 6 hex chars → 24 bits → plenty for modulo of small N.
  const hex = h.digest("hex").slice(0, 6)
  const num = parseInt(hex, 16)
  return num % n
}

/**
 * Round-robin variant. Deterministic by bookingId so a retry of the same
 * booking always picks the same number (avoids "we dialed twice from two
 * different numbers" candidate confusion).
 */
export class RoundRobinCallerIdStrategy implements CallerIdStrategy {
  readonly name = "roundrobin"

  constructor(private readonly callerIds: readonly string[]) {
    if (callerIds.length === 0) {
      throw new Error("RoundRobinCallerIdStrategy requires ≥1 caller ID")
    }
  }

  pick(input: { bookingId: string; paUserId: string }): string {
    const idx = hashTo(this.callerIds.length, input.bookingId)
    return this.callerIds[idx]!
  }
}

/**
 * Sticky-by-userId variant. Same paUserId always maps to the same caller ID,
 * which gives the candidate a consistent number-of-record across their
 * lifetime — mirrors the Sendblue "sticky load balancing" pattern Adam
 * locked at V2.0 rule #10.
 *
 * Default OFF in v2.1 (round-robin is the Task Prompt default), but exposed
 * here so flipping `PA_VOICE_CALLER_ID_STRATEGY=sticky_user` is a one-env-var
 * change with no code edit.
 */
export class StickyByUserIdCallerIdStrategy implements CallerIdStrategy {
  readonly name = "sticky_user"

  constructor(private readonly callerIds: readonly string[]) {
    if (callerIds.length === 0) {
      throw new Error("StickyByUserIdCallerIdStrategy requires ≥1 caller ID")
    }
  }

  pick(input: { bookingId: string; paUserId: string }): string {
    const idx = hashTo(this.callerIds.length, input.paUserId)
    return this.callerIds[idx]!
  }
}

/**
 * Parse `TWILIO_OUTBOUND_CALLER_IDS=+14157075057,+16468594057` (comma list,
 * trimmed). Throws on empty / malformed input.
 */
export function parseCallerIdsEnv(value: string | undefined): string[] {
  if (!value) {
    throw new Error("TWILIO_OUTBOUND_CALLER_IDS is empty")
  }
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length === 0) {
    throw new Error("TWILIO_OUTBOUND_CALLER_IDS yielded zero ids after parse")
  }
  for (const id of ids) {
    if (!/^\+\d{6,16}$/.test(id)) {
      throw new Error(`Invalid caller ID format (expected E.164 +digits): ${id}`)
    }
  }
  return ids
}

/**
 * Factory — pick the strategy by env at trigger boot time.
 */
export function makeCallerIdStrategy(env: {
  TWILIO_OUTBOUND_CALLER_IDS?: string
  PA_VOICE_CALLER_ID_STRATEGY?: string
}): CallerIdStrategy {
  const callerIds = parseCallerIdsEnv(env.TWILIO_OUTBOUND_CALLER_IDS)
  const requested = (env.PA_VOICE_CALLER_ID_STRATEGY ?? "roundrobin").toLowerCase()
  if (requested === "sticky_user") {
    return new StickyByUserIdCallerIdStrategy(callerIds)
  }
  return new RoundRobinCallerIdStrategy(callerIds)
}
