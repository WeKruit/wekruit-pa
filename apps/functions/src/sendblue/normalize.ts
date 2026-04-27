/**
 * Sendblue webhook payload normalizer (D-02, D-04).
 *
 * Decouples downstream handlers from Sendblue field names. Idempotency key
 * format: `sendblue-${message_handle}` per D-02 (replaces legacy
 * `imessage-in-${rowId}`).
 *
 * `chatId` is synthesized to match the worker's `getImessageSessionExternalId`
 * pattern (`iMessage;-;${peer}`) so transcript continuity holds across
 * channel migration.
 */

import type {
  SendblueInboundPayload,
  NormalizedInbound,
} from "./types.js"

/**
 * Shape-based discriminator for the primary "receive" event path.
 * Returns false for outbound mirror events, malformed payloads, and other
 * webhook subscription types (typing_indicator, line_blocked, etc.).
 */
export function isInboundReceiveEvent(
  payload: unknown
): payload is SendblueInboundPayload {
  if (!payload || typeof payload !== "object") return false
  const p = payload as Record<string, unknown>
  if (p.is_outbound === true) return false
  if (typeof p.from_number !== "string" || !p.from_number) return false
  if (typeof p.message_handle !== "string" || !p.message_handle) return false
  // content can be empty (we'll handle in normalize); to_number/service are
  // best-effort — Sendblue payloads are forward-extensible.
  return true
}

/**
 * Convert a Sendblue inbound payload to the canonical shape used by the
 * webhook handler.
 *
 * Returns:
 *   - NormalizedInbound when payload is a valid receive event with non-empty content
 *   - null when payload is an outbound mirror event OR has empty content
 *     (caller logs as audit + 200 OK; matches macOS worker `[dm] empty; skip`)
 *
 * Throws:
 *   - When message_handle is missing (cannot enqueue without idempotency key —
 *     this should never happen in practice; defensive guard)
 */
export function normalizeSendblueInbound(
  payload: SendblueInboundPayload
): NormalizedInbound | null {
  if (!payload || typeof payload !== "object") return null
  // is_outbound is typed as `false` on inbound but Sendblue could send other
  // values at runtime; coerce-check.
  if ((payload as Record<string, unknown>).is_outbound === true) return null

  const messageHandle =
    typeof payload.message_handle === "string" ? payload.message_handle.trim() : ""
  if (!messageHandle) {
    throw new Error("normalizeSendblueInbound: message_handle missing — cannot derive idempotency key")
  }

  const text = typeof payload.content === "string" ? payload.content.trim() : ""
  if (!text) return null

  const fromNumber = typeof payload.from_number === "string" ? payload.from_number : ""
  const toNumber = typeof payload.to_number === "string" ? payload.to_number : ""
  const groupIdRaw = typeof payload.group_id === "string" ? payload.group_id.trim() : ""
  const isGroup = groupIdRaw.length > 0

  // 1:1 chatId convention matches `getImessageSessionExternalId` from the macOS
  // worker — uses iMessage protocol prefix + peer. Group chats have group_id
  // in the chatId, but the webhook rejects groups (Q-03 lock) before this is
  // ever consumed downstream.
  const chatId = isGroup
    ? `iMessage;+;${groupIdRaw}`
    : `iMessage;-;${fromNumber}`

  const service = payload.service === "SMS" ? "SMS" : "iMessage"

  return {
    idempotencyKey: `sendblue-${messageHandle}`,
    fromNumber,
    toNumber,
    text,
    chatId,
    messageHandle,
    isGroup,
    service,
  }
}
