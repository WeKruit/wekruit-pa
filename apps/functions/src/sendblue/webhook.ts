/**
 * paSendblueWebhook — Cloud Function HTTPS handler (D-01).
 *
 * Flow:
 *   1. HMAC verify on raw body (401 if invalid)
 *   2. Parse JSON (400 if malformed)
 *   3. Route by shape:
 *      - is_outbound=true → outbound mirror, audit + 200 OK
 *      - missing message_handle/from_number/content → audit (typing/line/etc.) + 200 OK
 *      - normalize → if null (empty content), 200 OK
 *      - group_id present → group_chat_rejected audit + 200 OK (Q-03 lock)
 *      - allowlist denied → audit allowlist_deny + 200 OK
 *      - else → broker.createInboundEvent (idempotent on sendblue-${handle})
 *   4. 200 OK with { ok, eventId, created }
 *
 * Critical: ALL paths return 2xx EXCEPT 401 (bad sig) and 400 (malformed JSON).
 * Sendblue's retry policy (3× on 5xx) means anything but 2xx triggers
 * re-delivery — undesirable for permanent rejections like allowlist_deny.
 *
 * Memory partition keying: this handler does NOT touch mem0 directly. The
 * downstream `onPaInbound` orchestrator path (apps/functions/src/index.ts:322)
 * calls `resolveMem0PartitionKey({id, mem0UserId})` per Phase 11.3 contract;
 * this layer just produces the inbound row, identical to what the macOS
 * worker did.
 */

import type { Firestore } from "firebase-admin/firestore"
import { createInboundEvent } from "@pa/pa-broker"

import { verifySendblueSignature, extractSendblueSignatureHeader } from "./hmac.js"
import {
  isInboundReceiveEvent,
  normalizeSendblueInbound,
} from "./normalize.js"
import { useDmAllowlist, getPeerAllowlist, isSamePeer } from "./allowlist.js"
import { recordAuditEvent, type AuditEventInput } from "./audit.js"
import type { SendblueInboundPayload } from "./types.js"

export type WebhookRequest = {
  rawBody?: Buffer | string
  body?: unknown
  headers: Record<string, string | string[] | undefined>
  method?: string
  header?: (name: string) => string | undefined
}

export type WebhookResponse = {
  status(code: number): WebhookResponse
  json(body: unknown): WebhookResponse
  send(body?: unknown): WebhookResponse
  set?(field: string, value: string): unknown
}

export type WebhookDeps = {
  db: Firestore
  secret: string
  /** Inject for tests; defaults to @pa/pa-broker createInboundEvent. */
  createInboundEvent?: typeof createInboundEvent
  /** Inject for tests; defaults to recordAuditEvent. */
  recordAuditEvent?: typeof recordAuditEvent
  log?: (...args: unknown[]) => void
}

function reply(res: WebhookResponse, status: number, body: unknown): void {
  res.status(status).json(body)
}

function safeAudit(
  deps: WebhookDeps,
  input: AuditEventInput,
  log: (...args: unknown[]) => void
): Promise<void> {
  const fn = deps.recordAuditEvent ?? recordAuditEvent
  return Promise.resolve(fn(deps.db, input)).catch((err) => {
    log("[sendblue][audit] failed", err instanceof Error ? err.message : String(err))
  })
}

export async function handleSendblueWebhook(
  req: WebhookRequest,
  res: WebhookResponse,
  deps: WebhookDeps
): Promise<void> {
  const log = deps.log ?? console.log

  // ---- 1. HMAC verify (401 on fail) -------------------------------------
  const rawBody: Buffer | string =
    req.rawBody !== undefined
      ? req.rawBody
      : typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body ?? {})

  const sigHeader = extractSendblueSignatureHeader(req.headers ?? {})
  const isValid = verifySendblueSignature(rawBody, sigHeader, deps.secret)
  if (!isValid) {
    log("[sendblue][webhook] HMAC verify failed", {
      hasHeader: !!sigHeader,
      bodyLen: typeof rawBody === "string" ? rawBody.length : rawBody.byteLength,
    })
    reply(res, 401, { ok: false, error: "invalid_signature" })
    return
  }

  // ---- 2. Parse JSON (400 on malformed) ---------------------------------
  let parsed: unknown
  try {
    const text = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")
    parsed = JSON.parse(text)
  } catch (err) {
    log("[sendblue][webhook] malformed JSON", err instanceof Error ? err.message : String(err))
    reply(res, 400, { ok: false, error: "malformed_body" })
    return
  }

  if (!parsed || typeof parsed !== "object") {
    reply(res, 400, { ok: false, error: "malformed_body" })
    return
  }

  const payload = parsed as Record<string, unknown>

  // ---- 3a. Outbound mirror events (is_outbound=true) --------------------
  if (payload.is_outbound === true) {
    await safeAudit(
      deps,
      {
        type: "outbound_mirror",
        channel: "imessage_sendblue",
        fromNumber: typeof payload.from_number === "string" ? payload.from_number : undefined,
        toNumber: typeof payload.number === "string" ? payload.number : undefined,
        correlationId:
          typeof payload.message_handle === "string"
            ? payload.message_handle
            : typeof payload.uuid === "string"
              ? (payload.uuid as string)
              : undefined,
      },
      log
    )
    reply(res, 200, { ok: true, ignored: "outbound_mirror" })
    return
  }

  // ---- 3b. Non-receive events (typing_indicator / line_blocked / other) -
  if (!isInboundReceiveEvent(payload)) {
    const typeHint =
      typeof payload.type === "string"
        ? payload.type
        : "unknown"
    let auditType: AuditEventInput["type"] = "inbound_skipped"
    if (typeHint === "typing_indicator") auditType = "typing_indicator_received"
    else if (typeHint === "line_blocked") auditType = "line_blocked_received"
    await safeAudit(
      deps,
      {
        type: auditType,
        channel: "imessage_sendblue",
        reason: typeHint,
        fromNumber: typeof payload.from_number === "string" ? payload.from_number : undefined,
      },
      log
    )
    reply(res, 200, { ok: true, ignored: typeHint })
    return
  }

  // ---- 3c. Normalize (validated receive event) --------------------------
  let normalized
  try {
    normalized = normalizeSendblueInbound(payload as SendblueInboundPayload)
  } catch (err) {
    log("[sendblue][webhook] normalize threw", err instanceof Error ? err.message : String(err))
    await safeAudit(
      deps,
      {
        type: "inbound_skipped",
        channel: "imessage_sendblue",
        reason: "normalize_error",
      },
      log
    )
    reply(res, 200, { ok: true, ignored: "normalize_error" })
    return
  }
  if (!normalized) {
    // Empty content — match macOS worker '[dm] empty; skip'
    reply(res, 200, { ok: true, ignored: "empty_content" })
    return
  }

  // ---- 3d. Group chat reject (Q-03 lock) --------------------------------
  if (normalized.isGroup) {
    await safeAudit(
      deps,
      {
        type: "group_chat_rejected",
        channel: "imessage_sendblue",
        fromNumber: normalized.fromNumber,
        correlationId: normalized.messageHandle,
        payload: { group_id: typeof payload.group_id === "string" ? payload.group_id : undefined },
      },
      log
    )
    reply(res, 200, { ok: true, ignored: "group_chat_rejected" })
    return
  }

  // ---- 3e. Allowlist gate (fail-closed) ---------------------------------
  if (useDmAllowlist()) {
    const peers = getPeerAllowlist()
    const matched = peers.length > 0 && peers.some((p) => isSamePeer(normalized.fromNumber, p))
    if (!matched) {
      await safeAudit(
        deps,
        {
          type: "allowlist_deny",
          channel: "imessage_sendblue",
          fromNumber: normalized.fromNumber,
          reason: peers.length === 0 ? "empty_allowlist" : "not_in_allowlist",
          correlationId: normalized.messageHandle,
        },
        log
      )
      reply(res, 200, { ok: true, ignored: "allowlist_deny" })
      return
    }
  }

  // ---- 4. Broker enqueue (idempotent on sendblue-${handle}) -------------
  const broker = deps.createInboundEvent ?? createInboundEvent
  try {
    const result = await broker(deps.db, {
      channel: "imessage",
      idempotencyKey: normalized.idempotencyKey,
      rawPayload: {
        kind: "imessage",
        source: "sendblue",
        fromNumber: normalized.fromNumber,
        toNumber: normalized.toNumber,
        text: normalized.text,
        chatId: normalized.chatId,
        messageHandle: normalized.messageHandle,
        service: normalized.service,
        // Mirror legacy macOS worker keys so onPaInbound's
        // BrokerImessageEvent path keeps working unchanged.
        participant: normalized.fromNumber,
        // text + participant + chatId form the minimum contract; preserve
        // everything else as raw passthrough for forensic logs.
        original: payload,
      } as Record<string, unknown>,
    })
    log("[sendblue][webhook] enqueued", {
      eventId: result.id,
      created: result.created,
      handle: normalized.messageHandle,
    })
    reply(res, 200, { ok: true, eventId: result.id, created: result.created })
    return
  } catch (err) {
    log("[sendblue][webhook] broker error", err instanceof Error ? err.message : String(err))
    // Sendblue retry policy: return 5xx so they redeliver.
    reply(res, 500, { ok: false, error: "broker_error" })
    return
  }
}
