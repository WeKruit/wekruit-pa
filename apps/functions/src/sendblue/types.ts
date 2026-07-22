/**
 * Sendblue webhook + REST contract types.
 *
 * Sourced from:
 *   - Sendblue triple-verified assessment (~/.claude/.../sendblue_assessment.md)
 *   - Live API probe 2026-04-27 (.planning/phases/21-sendblue-channel-migration/21-CONTRACT-NOTES.md)
 *
 * Discriminator strategy: shape-based (NOT a single `event_type` field). Inbound
 * `receive` events have `is_outbound` falsy + required fields. Outbound mirror
 * events have `is_outbound: true`. Typing/line/call events are differentiated
 * by absent `content` + presence of type-specific fields. The webhook handler
 * routes via `isInboundReceiveEvent(payload)`; everything else → audit-log only.
 */

export type SendblueService = "iMessage" | "SMS"

/**
 * Inbound `receive` event payload — primary path.
 * `message_handle` is stable across Sendblue retry attempts and is the
 * idempotency key source: `sendblue-${message_handle}` (D-02).
 */
export type SendblueInboundPayload = {
  content: string
  from_number: string
  to_number: string
  message_handle: string
  date_sent: string
  status: string
  service: SendblueService
  participants?: string[]
  group_id?: string
  group_display_name?: string
  media_url?: string
  is_outbound?: false
  // Allow arbitrary forward-compat fields (Sendblue may extend payload).
  [key: string]: unknown
}

/**
 * Outbound mirror event — Sendblue sends this AFTER a REST POST,
 * confirming delivery state. We log + ignore (Q-02 deferred).
 */
export type SendblueOutboundPayload = {
  content: string
  from_number: string
  number: string
  message_handle?: string
  uuid?: string
  date_sent?: string
  status: string
  service: SendblueService
  is_outbound: true
  [key: string]: unknown
}

/**
 * Inbound typing-indicator webhook payload.
 *
 * Sendblue docs (verified 2026-05-03 via docs.sendblue.com/api-v2/typing-indicators):
 *   { number, is_typing, from_number, timestamp }
 *   - `number`: E.164 of the contact who is typing (the user).
 *   - `is_typing`: true when typing started, false when stopped.
 *   - `from_number`: Sendblue line that received the indicator (Claire's number).
 *   - `timestamp`: ISO-8601 of the device-side event.
 *
 * Older deliveries may arrive with only `{ type: "typing_indicator", number }`;
 * downstream code MUST handle the missing `is_typing` case (treat as
 * "typing started" — the conservative buffer-extending interpretation).
 *
 * NOTE: number/from_number direction is REVERSED relative to inbound `receive`
 * events (where `from_number` = sender). Be careful when reusing payload keys.
 */
export type SendblueTypingIndicatorPayload = {
  number: string
  is_typing?: boolean
  from_number?: string
  timestamp?: string
  type?: "typing_indicator"
  status?: string
  [key: string]: unknown
}

export type SendblueLineBlockedPayload = {
  type?: "line_blocked"
  from_number?: string
  to_number?: string
  status?: string
  reason?: string
  [key: string]: unknown
}

export type SendblueWebhookEvent =
  | SendblueInboundPayload
  | SendblueOutboundPayload
  | SendblueTypingIndicatorPayload
  | SendblueLineBlockedPayload
  | Record<string, unknown>

/**
 * REST send request — `POST https://api.sendblue.co/api/send-message`.
 * On `free_api` (sandbox) plans, `from_number` is REQUIRED (probe-verified
 * 2026-04-27). On paid dedicated lines it auto-populates.
 */
export type SendblueSendRequest = {
  number: string
  content: string
  from_number?: string
  status_callback?: string
  send_style?: string
  media_url?: string
  /** SMS fallback for non-iMessage (Android/green-bubble) recipients (Adam
   *  2026-07-21 fleet-wide). Probe 2026-04-27 shows the account echoing
   *  `allowSMS:true`; we now REQUEST it on every send. Webhooks report the
   *  downgrade via `service:"SMS"` / `was_downgraded`. */
  allowSMS?: boolean
}

/**
 * REST send response. Confirmed shape from probe error envelope:
 * Sendblue uses `uuid` as the message identifier on REST responses;
 * the parallel `message_handle` field is what shows up on webhook
 * payloads. Both are recorded onto `pa-outbound` for delivery audit.
 */
export type SendblueSendResponse = {
  type?: "message"
  uuid?: string
  message_handle?: string
  status: string
  from_number: string | null
  number: string
  content: string
  service: SendblueService | null
  is_outbound: true
  date?: string
  error_message?: string
  callbackURL?: string
  accountEmail?: string
  metadata?: { plan?: string; [key: string]: unknown }
  /**
   * Echo of the accepted media attachment URL. Present when Sendblue accepted
   * the `media_url`; NULL/absent when the attachment was dropped (signed URL or
   * non-extension-terminated). Used by the outbox for dropped-attachment audit.
   */
  media_url?: string | null
  [key: string]: unknown
}

/**
 * Normalized inbound shape consumed by the webhook handler after
 * `normalizeSendblueInbound` runs. Decouples downstream code from
 * Sendblue field names.
 */
export type NormalizedInbound = {
  idempotencyKey: string
  fromNumber: string
  toNumber: string
  text: string
  chatId: string
  messageHandle: string
  isGroup: boolean
  service: SendblueService
  /**
   * Email-sender resolution (SEV 2026-06-11): when the wire `from_number` was
   * an email-based Apple ID handle that resolved to a known candidate,
   * `fromNumber`/`chatId` are REWRITTEN to the canonical pa-users phone and
   * the original email handle is preserved here for audit (threaded into the
   * pa-inbound-events rawPayload). Absent on normal E.164 senders.
   */
  rawSenderHandle?: string
}
