/**
 * paSendblueWebhook — Cloud Function HTTPS handler (D-01).
 *
 * Flow:
 *   1. HMAC verify on raw body (401 if invalid)
 *   2. Parse JSON (400 if malformed)
 *   3. Route by shape:
 *      - is_outbound=true → outbound mirror, audit + 200 OK
 *      - missing message_handle/from_number/content → audit (typing/line/etc.) + 200 OK
 *      - empty content + media_url → attachment plumb-through (BUG #6 fix)
 *      - normalize → if null (empty + no media_url), 200 OK
 *      - group_id present → group_chat_rejected audit + 200 OK (Q-03 lock)
 *      - allowlist denied → audit allowlist_deny + 200 OK
 *      - tapback pattern → write pa-tapback-events row + still enqueue inbound
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

import { getFlag, checkAndIncrementRateLimit } from "@pa/pa-persistence"
import { verifySendblueSignature, extractSendblueSignatureHeader } from "./hmac.js"
import { sendReaction as defaultSendReaction, type SendReactionInput } from "./send-reaction.js"
// Stream D — CV ingestion side-effect (fire-and-forget) on attachment receipt.
import { ingestCv as defaultIngestCv, type IngestCvInput, type IngestCvResult } from "../cv-ingest/cv-ingest.js"
import {
  isInboundReceiveEvent,
  normalizeSendblueInbound,
} from "./normalize.js"
import { useDmAllowlist, getPeerAllowlist, isSamePeer } from "./allowlist.js"
import { recordAuditEvent, type AuditEventInput } from "./audit.js"
import { parseInboundTapback } from "./tapback-parser.js"
import type { SendblueInboundPayload } from "./types.js"
import { inboundEventExpiresAtTs, outboundExpiresAtTs } from "./ttl.js"
// v1.5 Stream-D — message coalescer dispatch (flag-gated; default off).
import {
  enqueueOrCoalesce as defaultEnqueueOrCoalesce,
  bumpCoalesceBuffer as defaultBumpCoalesceBuffer,
  type CoalescerDeps,
} from "../coalesce/paMessageCoalescer.js"

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
  /** Stream D — Sendblue Reactions API wrapper (tapback ❤️ on CV receipt). Inject for tests. */
  sendReaction?: (input: SendReactionInput) => Promise<unknown>
  /** Stream D — CV ingest pipeline (fire-and-forget). Inject for tests. */
  ingestCv?: (input: IngestCvInput) => Promise<IngestCvResult>
  /** Stream D — phone→userId resolver. Inject for tests. */
  lookupUserByPhone?: (db: Firestore, phoneE164: string) => Promise<string | null>
  /**
   * v1.5 Stream-D — message coalescer dispatch. Inject for tests; in
   * production the CF wrapper binds CoalescerDeps with a real Cloud Tasks
   * client. Webhook only calls this when paMessageCoalesceEnabled is true
   * for the message's userId.
   */
  enqueueOrCoalesce?: typeof defaultEnqueueOrCoalesce
  /**
   * v1.5 event-driven coalesce — Sendblue typing-indicator → buffer bump.
   * Adam 顶层设计 fix (2026-05-03). Inject for tests; production wiring uses
   * the same `coalescerDeps` bundle.
   */
  bumpCoalesceBuffer?: typeof defaultBumpCoalesceBuffer
  /** Coalescer dependency bundle bound at CF wrapper layer. Required only when
   *  enqueueOrCoalesce is invoked (i.e. flag=on). */
  coalescerDeps?: CoalescerDeps
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

// Phase 33 — recovery safety net. Writes EVERY webhook delivery to
// pa-sendblue-webhook-raw BEFORE verification, so a future deploy regression
// (e.g. header-name drift like the 2026-04-28 incident) does not silently
// destroy inbound traffic. TTL: 7 days via expiresAt field (operator must
// set TTL policy on the collection — runbook in admin-bootstrap).

// Stream G4a — synthetic-webhook test marker. When `x-e2e-test: 1` is set on
// the incoming request, every downstream artifact this handler writes
// (pa-sendblue-webhook-raw, pa-inbound-events) is tagged with `e2eTest: true`
// so production analytics + pipelines can filter test traffic. Also bypasses
// the DM allowlist so synthetic from-numbers don't get rejected. Sendblue
// HMAC verification is unchanged — the E2E driver still must sign requests
// with the live signing secret.
function extractE2eTestFlag(headers: Record<string, string | string[] | undefined>): boolean {
  const candidates = ["x-e2e-test", "X-E2E-Test", "X-E2E-TEST"]
  for (const k of candidates) {
    const v = headers[k] ?? headers[k.toLowerCase()]
    const s = Array.isArray(v) ? v[0] : v
    if (typeof s === "string" && s.trim() === "1") return true
  }
  return false
}

async function logRawWebhook(
  deps: WebhookDeps,
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
  log: (...args: unknown[]) => void,
  e2eTest: boolean = false
): Promise<void> {
  try {
    const bodyText = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")
    // Mask security-relevant headers but keep the rest for replay context.
    const safeHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      const valStr = Array.isArray(v) ? v[0] : v
      if (typeof valStr !== "string") continue
      const lk = k.toLowerCase()
      // Strip the secret value from log; just record presence + length.
      if (lk === "sb-signing-secret" || lk.includes("signature") || lk === "authorization") {
        safeHeaders[lk] = `<redacted ${valStr.length} chars>`
      } else {
        safeHeaders[lk] = valStr
      }
    }
    const now = Date.now()
    const expiresAt = new Date(now + 7 * 24 * 60 * 60 * 1000) // 7-day TTL
    await deps.db.collection("pa-sendblue-webhook-raw").add({
      receivedAt: new Date(now).toISOString(),
      bodyText: bodyText.slice(0, 32 * 1024), // cap at 32 KiB
      bodyLen: bodyText.length,
      headers: safeHeaders,
      expiresAt,
      // Stream G4a — only present (and only `true`) when the request carried
      // `X-E2E-Test: 1`. Field is absent on organic traffic so existing
      // analytics queries (no field === false-ish in Firestore) keep working.
      ...(e2eTest ? { rawMeta: { e2eTest: true } } : {}),
    })
  } catch (err) {
    // Never let raw-log failure break the webhook path.
    log("[sendblue][webhook][raw-log] failed", err instanceof Error ? err.message : String(err))
  }
}

// BUG #6 fix — Sendblue delivers pure-attachment iMessages (PDF, image, etc.)
// with `content === ""` AND `media_url` populated. The original webhook
// inherited the macOS worker's "[dm] empty; skip" rule, which silently
// dropped these. Adam's CV upload on 2026-04-30 surfaced the gap. We now
// treat empty+media_url as a first-class inbound: thread the media URL into
// rawPayload so onPaInbound can fetch and ingest the attachment. Empty +
// no media_url remains a skip (typing aborts, retries with stale handle).
function extractMediaUrl(payload: Record<string, unknown>): string | null {
  const v = payload.media_url
  if (typeof v !== "string") return null
  const trimmed = v.trim()
  if (!trimmed) return null
  return trimmed
}

// Stream D — phone→userId resolver. Reads pa-users where phoneE164 == n
// (exact match — webhook only knows the from_number, no normalization needed
// because the upstream macOS worker + Sendblue both deliver E.164). Returns
// null if no row is found; webhook treats null as "ingest skipped".
async function defaultLookupUserByPhone(db: Firestore, phoneE164: string): Promise<string | null> {
  if (!phoneE164) return null
  try {
    const snap = await db.collection("pa-users").where("phoneE164", "==", phoneE164).limit(1).get()
    if (snap.empty) return null
    return snap.docs[0]!.id
  } catch {
    return null
  }
}

export async function handleSendblueWebhook(
  req: WebhookRequest,
  res: WebhookResponse,
  deps: WebhookDeps
): Promise<void> {
  const log = deps.log ?? console.log

  // Stream G4a — extract synthetic-test marker BEFORE any pipeline work so
  // every downstream write can carry it consistently. Organic Sendblue traffic
  // never sets this header; it's only used by the apps/functions/test-e2e
  // driver to drive Adam's CV-onboarding pipeline against the LIVE webhook
  // without polluting analytics or tripping the DM allowlist.
  const isE2eTest = extractE2eTestFlag(req.headers ?? {})

  // ---- 1. HMAC verify (401 on fail) -------------------------------------
  const rawBody: Buffer | string =
    req.rawBody !== undefined
      ? req.rawBody
      : typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body ?? {})

  // Phase 33 — log every delivery BEFORE verify so a regression in the
  // verifier does not silently drop inbound traffic. Fire-and-forget;
  // failure here must never break the path.
  void logRawWebhook(deps, rawBody, req.headers ?? {}, log, isE2eTest)

  const sigHeader = extractSendblueSignatureHeader(req.headers ?? {})
  const isValid = verifySendblueSignature(rawBody, sigHeader, deps.secret)
  if (!isValid) {
    const headerNames = Object.keys(req.headers ?? {}).filter(
      (h) => /sig|hmac|sb|sendblue|x-sb|webhook/i.test(h),
    )
    log("[sendblue][webhook] HMAC verify failed", {
      hasHeader: !!sigHeader,
      bodyLen: typeof rawBody === "string" ? rawBody.length : rawBody.byteLength,
      candidateHeaders: headerNames,
      allHeaderNames: Object.keys(req.headers ?? {}),
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
  // Stream H9 TD3 — Sendblue delivers SENT → DELIVERED → (FAILED) status
  // updates as inbound `is_outbound:true` webhooks. Look up the matching
  // pa-outbound row by messageHandle and persist the latest sendblueStatus,
  // plus a per-state timestamp (sendblueDeliveredAt / sendblueFailedAt). The
  // update is idempotent — re-delivery overwrites with merge:true and the
  // SENT → DELIVERED state machine is monotonic on these fields.
  if (payload.is_outbound === true) {
    const handle =
      typeof payload.message_handle === "string"
        ? payload.message_handle
        : typeof payload.uuid === "string"
          ? (payload.uuid as string)
          : undefined
    const sbStatus =
      typeof payload.status === "string" ? payload.status.toUpperCase() : undefined
    if (handle && sbStatus) {
      // Best-effort tracking — never break the 200 OK or fail the audit.
      try {
        const snap = await deps.db
          .collection("pa-outbound")
          .where("messageHandle", "==", handle)
          .limit(1)
          .get()
        if (!snap.empty) {
          const docRef = snap.docs[0]!.ref
          const nowIso = new Date().toISOString()
          const patch: Record<string, unknown> = {
            sendblueStatus: sbStatus,
            updatedAt: nowIso,
            expiresAtTs: outboundExpiresAtTs(),
          }
          if (sbStatus === "DELIVERED") patch.sendblueDeliveredAt = nowIso
          if (sbStatus === "FAILED" || sbStatus === "ERROR")
            patch.sendblueFailedAt = nowIso
          await docRef.set(patch, { merge: true })
          log("[sendblue][webhook] outbound_status_tracked", {
            handle,
            sendblueStatus: sbStatus,
            docId: snap.docs[0]!.id,
          })
        } else {
          log("[sendblue][webhook] outbound_status_no_row", {
            handle,
            sendblueStatus: sbStatus,
          })
        }
      } catch (trackErr) {
        log("[sendblue][webhook] outbound_status_track_failed (non-fatal)",
          trackErr instanceof Error ? trackErr.message : String(trackErr))
      }
    }
    await safeAudit(
      deps,
      {
        type: "outbound_mirror",
        channel: "imessage_sendblue",
        fromNumber: typeof payload.from_number === "string" ? payload.from_number : undefined,
        toNumber: typeof payload.number === "string" ? payload.number : undefined,
        correlationId: handle,
      },
      log
    )
    reply(res, 200, { ok: true, ignored: "outbound_mirror" })
    return
  }

  // ---- 3b. Non-receive events (typing_indicator / line_blocked / other) -
  // v1.5 event-driven coalesce — Adam 顶层设计 fix (2026-05-03):
  //   We have ALWAYS received Sendblue's `typing_indicator` events here, but
  //   historically only logged + dropped them. They're now first-class
  //   buffer-bump signals: when the user is still composing, we extend the
  //   coalesce window so natural typing gaps > DEFAULT_DELAY_MS don't
  //   wave-split a single thought into multiple replies.
  //
  //   Sendblue typing payload (verified 2026-05-03 via docs.sendblue.com):
  //     { number, is_typing, from_number, timestamp }
  //   Note: `number` = the contact who is typing (the user), `from_number` =
  //   the Sendblue line — REVERSED relative to receive events.
  if (!isInboundReceiveEvent(payload)) {
    const typeHint =
      typeof payload.type === "string"
        ? payload.type
        : "unknown"
    let auditType: AuditEventInput["type"] = "inbound_skipped"
    if (typeHint === "typing_indicator") auditType = "typing_indicator_received"
    else if (typeHint === "line_blocked") auditType = "line_blocked_received"

    // typing → BUFFER BUMP (fail-open).
    if (typeHint === "typing_indicator") {
      // typing payload field semantics — be defensive:
      //   - `number` is the user typing (E.164 from the device).
      //   - `is_typing` may be missing on legacy / minimal payloads. Treat
      //     missing as `true` (conservative: extend the window).
      const typerNumber =
        typeof payload.number === "string" ? payload.number : ""
      const isTyping =
        typeof payload.is_typing === "boolean" ? payload.is_typing : true

      if (typerNumber && deps.coalescerDeps) {
        try {
          const lookupFn = deps.lookupUserByPhone ?? defaultLookupUserByPhone
          const resolvedUserId = await lookupFn(deps.db, typerNumber)
          if (resolvedUserId) {
            const coalesceFlag = await getFlag(
              deps.db,
              "paMessageCoalesceEnabled",
              { userId: resolvedUserId, env: process.env },
              false
            )
            if (coalesceFlag === true) {
              const bumpFn = deps.bumpCoalesceBuffer ?? defaultBumpCoalesceBuffer
              const bumpRes = await bumpFn(deps.coalescerDeps, {
                userId: resolvedUserId,
                isTyping,
              })
              log("[coalesce][webhook] typing-bump", {
                userId: resolvedUserId,
                isTyping,
                action: bumpRes.action,
                taskName: bumpRes.taskName,
                delayMs: bumpRes.delayMs,
              })
            }
          } else {
            log("[coalesce][webhook] typing-skip — no userId for phone", {
              phone: typerNumber,
            })
          }
        } catch (bumpErr) {
          // Fail-open: typing is a hint, never a blocker. The audit + 200 OK
          // path below still runs.
          log(
            "[coalesce][webhook] typing-bump failed (non-fatal)",
            bumpErr instanceof Error ? bumpErr.message : String(bumpErr),
          )
        }
      }
    }

    await safeAudit(
      deps,
      {
        type: auditType,
        channel: "imessage_sendblue",
        // Forensics: the user's number for typing events lives in `number`,
        // not `from_number`. Persist the right one so dashboard filters work.
        fromNumber:
          typeHint === "typing_indicator"
            ? typeof payload.number === "string"
              ? payload.number
              : undefined
            : typeof payload.from_number === "string"
              ? payload.from_number
              : undefined,
        reason: typeHint,
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
  // BUG #6 — empty content path. If media_url is present, synthesize a
  // normalized inbound so the rest of the pipeline (rate-limit / allowlist /
  // broker enqueue) treats this as a real message. Reuses the same
  // idempotency convention so dedupe still works.
  const mediaUrl = extractMediaUrl(payload)
  if (!normalized) {
    if (mediaUrl) {
      const messageHandle = typeof payload.message_handle === "string" ? payload.message_handle.trim() : ""
      const fromNumber = typeof payload.from_number === "string" ? payload.from_number : ""
      const toNumber = typeof payload.to_number === "string" ? payload.to_number : ""
      const groupIdRaw = typeof payload.group_id === "string" ? payload.group_id.trim() : ""
      const isGroup = groupIdRaw.length > 0
      const chatId = isGroup ? `iMessage;+;${groupIdRaw}` : `iMessage;-;${fromNumber}`
      const service = payload.service === "SMS" ? "SMS" : "iMessage"
      if (!messageHandle) {
        // Defensive — isInboundReceiveEvent already required this. Audit and skip.
        await safeAudit(
          deps,
          { type: "inbound_skipped", channel: "imessage_sendblue", reason: "attachment_no_handle" },
          log
        )
        reply(res, 200, { ok: true, ignored: "attachment_no_handle" })
        return
      }
      normalized = {
        idempotencyKey: `sendblue-${messageHandle}`,
        fromNumber,
        toNumber,
        text: "[attachment]",
        chatId,
        messageHandle,
        isGroup,
        service,
      }
    } else {
      // Empty content + no media_url — match macOS worker '[dm] empty; skip'
      reply(res, 200, { ok: true, ignored: "empty_content" })
      return
    }
  }

  // ---- 3c2. Rate-limit (Phase 26 T1, flag-gated) ------------------------
  if (await getFlag(deps.db, "paRateLimitPerUserEnabled", { userId: normalized.fromNumber, env: process.env }, false)) {
    const rl = await checkAndIncrementRateLimit(deps.db, normalized.fromNumber, { limit: 20, windowSec: 60 })
    if (!rl.allowed) { await safeAudit(deps, { type: "rate_limit_exceeded", channel: "imessage_sendblue", fromNumber: normalized.fromNumber, correlationId: normalized.messageHandle }, log); reply(res, 429, { ok: false, error: "rate_limited" }); return }
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
  // Stream G4a — when X-E2E-Test:1 is set, bypass the allowlist so the test
  // driver can synthesize from-numbers that aren't on the production peer
  // allowlist. Bypass is safe because requests still must pass HMAC verify.
  if (useDmAllowlist() && !isE2eTest) {
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

  // ---- 3f. Tapback parser (BUG #6 sister-feature) -----------------------
  // Inbound iMessage tapback reactions arrive as plaintext content — we
  // detect them, fan-out a row to pa-tapback-events for the matching
  // pipeline (paOnTapbackEvent CF), and STILL enqueue the normal inbound
  // event so Claire gets a chance to acknowledge in chat. Fire-and-forget
  // write — failure must not break the inbound path.
  if (normalized.text && normalized.text !== "[attachment]") {
    const tapback = parseInboundTapback(normalized.text)
    if (tapback) {
      try {
        const ts = new Date().toISOString()
        await deps.db.collection("pa-tapback-events").add({
          userId: normalized.fromNumber,
          jobId: null,
          kind: tapback.kind,
          quotedText: tapback.quotedText,
          sourceMessageHandle: normalized.messageHandle,
          fromNumber: normalized.fromNumber,
          toNumber: normalized.toNumber,
          ts,
          createdAt: ts,
        })
        log("[sendblue][webhook] tapback recorded", { kind: tapback.kind, handle: normalized.messageHandle })
      } catch (err) {
        log("[sendblue][webhook] tapback record failed", err instanceof Error ? err.message : String(err))
      }
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
        // BUG #6 — surface attachment URL into rawPayload so the orchestrator
        // can fetch + ingest. Absent on text-only messages.
        ...(mediaUrl ? { mediaUrl, attachmentReceived: true } : {}),
        // text + participant + chatId form the minimum contract; preserve
        // everything else as raw passthrough for forensic logs.
        original: payload,
        // Stream G4a — synthetic-test marker. Absent on organic traffic.
        ...(isE2eTest ? { e2eTest: true } : {}),
      } as Record<string, unknown>,
    })
    log("[sendblue][webhook] enqueued", {
      eventId: result.id,
      created: result.created,
      handle: normalized.messageHandle,
      hasAttachment: !!mediaUrl,
    })
    // Stream H9 TD1 — write Timestamp-typed `expiresAtTs` (60d) so the
    // pa-inbound-events TTL policy can GC the row. The broker writes only
    // ISO strings; Firestore TTL only fires on Timestamp fields. Idempotent
    // (merge:true) — safe under re-delivery + safe under both created paths.
    try {
      await deps.db.collection("pa-inbound-events").doc(result.id).set(
        { expiresAtTs: inboundEventExpiresAtTs() },
        { merge: true }
      )
    } catch (ttlErr) {
      log("[sendblue][webhook] expiresAtTs write failed (non-fatal)",
        ttlErr instanceof Error ? ttlErr.message : String(ttlErr))
    }

    // v1.5 Stream-D — message coalescer dispatch (flag-gated, attachment-skip).
    //
    // Conditions for entering the coalescer:
    //   - paMessageCoalesceEnabled flag = true for THIS user (perUser scope)
    //   - text-only inbound (mediaUrl absent — attachments have their own
    //     ❤️ + CV-ingest flow that must not be deferred)
    //   - coalescerDeps + enqueueOrCoalesce wired by CF wrapper
    //
    // The original pa-inbound-events row written by the broker above stays
    // in place; the coalescer marks it `coalescing:true` so onPaInbound
    // skips it. On enqueue failure we fall back to legacy direct path
    // (do nothing — onPaInbound's onDocumentCreated will fire normally).
    if (!mediaUrl && deps.enqueueOrCoalesce && deps.coalescerDeps) {
      try {
        // Resolve userId via phone lookup. If absent, treat as legacy path —
        // we can't write a buffer keyed by an unknown userId.
        const lookupFn = deps.lookupUserByPhone ?? defaultLookupUserByPhone
        const resolvedUserId = await lookupFn(deps.db, normalized.fromNumber)
        if (!resolvedUserId) {
          log("[coalesce][webhook] no userId for phone — skipping coalesce, legacy path proceeds", {
            phone: normalized.fromNumber,
          })
        } else {
          const coalesceFlag = await getFlag(
            deps.db,
            "paMessageCoalesceEnabled",
            { userId: resolvedUserId, env: process.env },
            false
          )
          if (coalesceFlag === true) {
            try {
              await deps.enqueueOrCoalesce(deps.coalescerDeps, {
                userId: resolvedUserId,
                fromNumber: normalized.fromNumber,
                toNumber: normalized.toNumber,
                messageHandle: normalized.messageHandle,
                body: normalized.text,
                inboundEventId: result.id,
              })
              log("[coalesce][webhook] enqueued", {
                userId: resolvedUserId,
                eventId: result.id,
                handle: normalized.messageHandle,
              })
            } catch (coalesceErr) {
              // Cloud Tasks enqueue failed — bail out of coalesce path; the
              // pa-inbound-events row is still pending so onPaInbound's
              // onDocumentCreated will fire and the user gets a (single,
              // non-coalesced) reply. ZERO-regression on hard failure.
              log("[coalesce][webhook] enqueue failed — falling back to legacy direct path", {
                userId: resolvedUserId,
                err: coalesceErr instanceof Error ? coalesceErr.message : String(coalesceErr),
              })
              // Important: revert the `coalescing:true` flag if the coalescer
              // managed to set it before failing. Best-effort.
              try {
                await deps.db.collection("pa-inbound-events").doc(result.id).set(
                  { coalescing: false, coalesceFallback: true },
                  { merge: true }
                )
              } catch {/* swallow */}
            }
          }
        }
      } catch (flagErr) {
        log("[coalesce][webhook] flag/lookup failed (non-fatal)",
          flagErr instanceof Error ? flagErr.message : String(flagErr))
      }
    }

    // Stream D — CV side-effects (fire-and-forget). Both run in parallel:
    //   1. Tapback ❤️ via Sendblue Reactions API — immediate user ack.
    //   2. CV ingestion → parsedCandidateResumes — async best-effort.
    // Either failure is logged but never blocks the 200 OK to Sendblue.
    if (mediaUrl) {
      const sendReactionFn = deps.sendReaction ?? defaultSendReaction
      void Promise.resolve()
        .then(() =>
          sendReactionFn({
            to: normalized.fromNumber,
            messageHandle: normalized.messageHandle,
            reaction: "love",
          })
        )
        .then(() => {
          log("[sendblue][reaction] love sent", { handle: normalized.messageHandle, to: normalized.fromNumber })
        })
        .catch((reactErr) => {
          log("[sendblue][reaction] failed", reactErr instanceof Error ? reactErr.message : String(reactErr))
        })

      const ingestFn = deps.ingestCv ?? defaultIngestCv
      const lookupFn = deps.lookupUserByPhone ?? defaultLookupUserByPhone
      void Promise.resolve()
        .then(async () => {
          const userId = await lookupFn(deps.db, normalized.fromNumber)
          if (!userId) {
            log("[sendblue][cv-ingest] skipped — no userId for phone", { phone: normalized.fromNumber })
            return { ok: false, reason: "no_user" } as IngestCvResult
          }
          return ingestFn({ userId, mediaUrl, sessionId: undefined })
        })
        .then((res) => {
          log("[sendblue][cv-ingest] done", res)
        })
        .catch((ingestErr) => {
          log("[sendblue][cv-ingest] failed", ingestErr instanceof Error ? ingestErr.message : String(ingestErr))
        })
    }
    reply(res, 200, { ok: true, eventId: result.id, created: result.created })
    return
  } catch (err) {
    log("[sendblue][webhook] broker error", err instanceof Error ? err.message : String(err))
    // Sendblue retry policy: return 5xx so they redeliver.
    reply(res, 500, { ok: false, error: "broker_error" })
    return
  }
}
