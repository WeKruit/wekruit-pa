/**
 * synthetic-recipient.ts — single source of truth for the reserved synthetic /
 * e2e test recipient range, applied at EVERY Sendblue POST seam.
 *
 * 2026-06-19 incident, hardened 2026-06-21:
 * The scenario harness (`tests/scenarios/runner.mjs`) mints synthetic users in
 * the reserved `+1999999xxxx` range. When run against the PROD project those
 * synthetic inbound rows can satisfy the prior-inbound consent gate and the
 * orchestrator enqueues real candidate-facing sends.
 *
 * The original block lived ONLY in the pa-outbound outbox handler
 * (`outbox.ts isSyntheticOutboundRecipient`), which gates the durable
 * `sendText` path. But the Claire transport ALSO posts to Sendblue directly,
 * BYPASSING the outbox:
 *   - sendStatus  → sendImessage            (transient "one sec" bubble)
 *   - typing/markRead → sendTypingIndicator / sendReadReceipt
 *   - tapback     → sendReaction
 * Plus any future direct caller of those functions. Forensics on 2026-06-20
 * found 53 synthetic-range `pa-outbound` rows that POSTed and got
 * `sendblue 400: INBOUND_ONLY_PLAN` — i.e. they reached Sendblue's API.
 *
 * This module factors the phone-range check so it can be enforced at the
 * LOWEST level — inside every `send*` function that owns a Sendblue `fetch`.
 * Those functions only have the recipient number (not row metadata), so the
 * low-level guard is purely number-range based. The outbox keeps its richer
 * marker-aware gate (e2eTest / harness) for observability + a labeled status
 * row; this is the universal hard backstop.
 *
 * Synthetic numbers are never deliverable by construction — there is NO
 * exemption (not dev phones, not runtime-approved).
 */

/** Reserved synthetic / e2e test phone range: +1999999XXXX. */
export const RESERVED_SYNTHETIC_PHONE_RE = /^\+1999999\d{4}$/

/**
 * True when `to` is a reserved synthetic / e2e test recipient number that must
 * never reach Sendblue. Tolerant of surrounding whitespace; everything else is
 * an exact range match.
 */
export function isSyntheticRecipientNumber(to: unknown): boolean {
  if (typeof to !== "string") return false
  return RESERVED_SYNTHETIC_PHONE_RE.test(to.trim())
}
