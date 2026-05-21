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
 * this layer only produces the inbound row for the shared runtime path.
 */

import type { Firestore } from "firebase-admin/firestore"
import { createInboundEvent } from "@pa/pa-broker"

import { getFlag, checkAndIncrementRateLimit } from "@pa/pa-persistence"
import { PA_COLLECTIONS } from "@pa/core-types"
import { verifySendblueSignature, extractSendblueSignatureHeader } from "./hmac.js"
// Stream D — CV ingestion side-effect (fire-and-forget) on attachment receipt.
import { ingestCv as defaultIngestCv, type IngestCvInput, type IngestCvResult } from "../cv-ingest/cv-ingest.js"
import {
  isInboundReceiveEvent,
  normalizeSendblueInbound,
} from "./normalize.js"
import { useDmAllowlist, getPeerAllowlist, isSamePeer } from "./allowlist.js"
import { recordAuditEvent, type AuditEventInput } from "./audit.js"
import { classifyInboundSender } from "./handle-format.js"
import { parseInboundTapback } from "./tapback-parser.js"
// v1.8 Phase 77.2 — TriggerRouter table-driven dispatch for the new
// pre-screen + compact triggers. Strangler step 2: ADDITIVE — runs before
// the existing inline find_match/reset branches. If the router handles
// (prescreen / compact), short-circuit. If not, existing flow continues.
import {
  ApplyTrigger,
  CompactTrigger,
  LayoffTrigger,
  PrescreenTrigger,
  TriggerRouter,
} from "./triggers/index.js"
// v1.8 Phase 77.3 — real prescreen session bootstrap (replaces log placeholder).
import { runPreScreenForUser as defaultRunPreScreenForUser } from "../prescreen-session-start.js"
import {
  isLayoffIntakeActiveForUser,
  runLayoffSmsStart as defaultRunLayoffSmsStart,
} from "../layoff-sms-start.js"
import { runCompactionForUser } from "../compaction-run.js"
// v1.9 Phase 85 — PII confirm bootstrap (Apply trigger).
import { runPiiConfirmForUser as defaultRunPiiConfirmForUser } from "../pii-confirm-start.js"
import type { SendblueInboundPayload } from "./types.js"
import { inboundEventExpiresAtTs, outboundExpiresAtTs } from "./ttl.js"
import { resolveInboundUserId } from "../candidate-inbound-resolve.js"

function prescreenTriggerIdempotencyDocId(jobId: string, userId: string, messageHandle: string): string {
  return `${jobId}_${userId}_${encodeURIComponent(messageHandle || "missing_message_handle")}`
}
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

/**
 * Phase 60 (DEV-01) — `__PA_FIND_MATCH__` dev trigger args. Mirrors the
 * pattern Adam called out in CLAUDE.md (D14): admin-guarded iMessage token
 * forces an immediate generateJobRecs run for the sender. Production must
 * not allow this for arbitrary users → admin allowlist via env.
 */
export type FindMatchTriggerArgs = {
  userId: string
  /** Phone the user iMessaged from — used as the destination for the resulting job-rec push. */
  toE164: string
}

export type FindMatchTriggerResult = {
  ok: boolean
  /** Number of jobs surfaced; 0 when nothing passes the v1.6 hard-filter chain. */
  jobCount: number
  /** Skip reason when not authorized / no tags / no jobs / send failed. */
  reason?: string
}

export type WebhookDeps = {
  db: Firestore
  secret: string
  /** Best-effort bot typing hint for accepted inbound messages. */
  sendTypingIndicator?: (input: { to: string }) => Promise<void>
  /** Inject for tests; defaults to @pa/pa-broker createInboundEvent. */
  createInboundEvent?: typeof createInboundEvent
  /** Inject for tests; defaults to recordAuditEvent. */
  recordAuditEvent?: typeof recordAuditEvent
  /** Stream D — CV ingest pipeline (fire-and-forget). Inject for tests. */
  ingestCv?: (input: IngestCvInput) => Promise<IngestCvResult>
  /** Stream D — phone→userId resolver. Optional inboundText enables Hello, WeKruit! uid bind. */
  lookupUserByPhone?: (db: Firestore, phoneE164: string, inboundText?: string) => Promise<string | null>
  /** WeKruit_LAID_OFF inbound trigger handler. Inject for tests. */
  runLayoffSmsStart?: typeof defaultRunLayoffSmsStart
  /** Job prescreen trigger handler. Inject for live-equivalent Sendblue entrypoint tests. */
  runPreScreenForUser?: typeof defaultRunPreScreenForUser
  /** Apply trigger PII-confirm handler. Inject for live-equivalent Sendblue entrypoint tests. */
  runPiiConfirmForUser?: typeof defaultRunPiiConfirmForUser
  /**
   * Phase 60 (DEV-01) — `__PA_FIND_MATCH__` dev trigger handler. When the
   * inbound text contains the trigger token AND the resolved user is in
   * `PA_ADMIN_USER_IDS`, the webhook short-circuits the normal orchestrator
   * path and force-runs the V16 match + runtime handoff. Returns immediately
   * (the trigger itself is fire-and-forget); the runtime decides whether to
   * send a recommendation. Inject for tests; production wires the V16 query +
   * runtime handoff adapter.
   */
  generateJobRecsForUser?: (args: FindMatchTriggerArgs) => Promise<FindMatchTriggerResult>
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
  /**
   * v1.5 TD-A (2026-05-03 Adam P0 race-condition): proper-fix fallback path.
   *
   *   When we pre-stamp `coalescing:true` on the inbound row at create time
   *   (TD-A race-window fix), `onPaInbound`'s onDocumentCreated trigger sees
   *   the flag and SKIPS processing — handing the row off to the coalescer.
   *   If the subsequent `enqueueOrCoalesce` call then FAILS (Cloud Tasks
   *   outage, etc.), the row is now orphaned: onPaInbound already declined to
   *   handle it because of the flag. Without an active fallback, the user
   *   gets NO reply.
   *
   *   This dep is the injection point for `processBrokerImessageEvent` (lives
   *   in apps/functions/src/index.ts, not exported as a package because it
   *   needs `getOrCreateSession`, etc.). The wiring in `buildSendblueWebhookDeps`
   *   passes it through. Default: undefined → fallback degrades to revert-only
   *   (matches pre-TD-A behaviour for callers who don't wire it).
   *
   *   Signature mirrors the production fn: takes the broker-shape event by
   *   id, drives orchestrator → ONE reply. Idempotent on its own (claim is
   *   transactional + lease-guarded inside the orchestrator).
   */
  processBrokerImessageFallback?: (eventId: string) => Promise<void>
  log?: (...args: unknown[]) => void
}

function reply(res: WebhookResponse, status: number, body: unknown): void {
  res.status(status).json(body)
}

function isBotTypingHintEnabled(): boolean {
  return process.env.PA_TYPING_INDICATOR !== "0"
}

async function sendAcceptedInboundTypingHint(
  deps: WebhookDeps,
  input: { to: string; correlationId?: string },
  log: (...args: unknown[]) => void,
): Promise<void> {
  if (!deps.sendTypingIndicator || !isBotTypingHintEnabled()) return
  try {
    await deps.sendTypingIndicator({ to: input.to })
    log("[sendblue][webhook] bot_typing_hint_sent", {
      toNumber: input.to,
      correlationId: input.correlationId,
    })
  } catch (err) {
    log(
      "[sendblue][webhook] bot_typing_hint_failed (non-fatal)",
      err instanceof Error ? err.message : String(err),
    )
  }
}

function safeAudit(
  deps: WebhookDeps,
  input: AuditEventInput,
  log: (...args: unknown[]) => void
): Promise<void> {
  const fn = deps.recordAuditEvent ?? recordAuditEvent
  const normalized = { channel: "imessage_sendblue" as const, ...input }
  return Promise.resolve(fn(deps.db, normalized)).catch((err) => {
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
// with `content === ""` AND `media_url` populated. Treat empty+media_url as
// a first-class inbound: thread the media URL into rawPayload so onPaInbound
// can fetch and ingest the attachment. Empty + no media_url remains a skip
// (typing aborts, retries with stale handle).
function extractMediaUrl(payload: Record<string, unknown>): string | null {
  const v = payload.media_url
  if (typeof v !== "string") return null
  const trimmed = v.trim()
  if (!trimmed) return null
  return trimmed
}

// Phone → userId resolver.
//
// 2026-05-19 (Adam directive: "user exist check has to consider more, phone
// number / email / resume etc. not just from one single point") — multi-handle
// resolution. Primary path stays `pa-users.phoneE164` for the common case where
// the website-registered candidate texts from the same number they typed into
// the form. Fallback checks `pa-candidate-handles` for a hashed phone handle
// that points at a `candidateId` — this covers candidates whose pa-users row
// was created by bulk resume upload, ATS inbound, or external supply intake,
// where phoneE164 may not have been stamped on pa-users yet but the handle
// link was. Email-side resolution is not reachable from an SMS payload (we
// only have from_number), so it is intentionally not attempted here.
async function defaultLookupUserByPhone(
  db: Firestore,
  phoneE164: string,
  inboundText?: string,
): Promise<string | null> {
  return resolveInboundUserId(db, phoneE164, inboundText)
}

async function hasActivePrescreenSession(db: Firestore, userId: string): Promise<boolean> {
  const snap = await db
    .collection("pa-prescreen-sessions")
    .where("userId", "==", userId)
    .where("terminal", "==", null)
    .limit(1)
    .get()
  return !snap.empty
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
      // Empty content + no media_url — skip empty typing/transport echoes.
      reply(res, 200, { ok: true, ignored: "empty_content" })
      return
    }
  }

  // ---- 3c1. E.164 sender gate (identity hardening 2026-05-20) -----------
  // Sendblue accepts inbound from email-based Apple IDs (per FAQ) but the
  // REST API has no outbound path for them, and our downstream identity
  // layer assumes E.164. Reject non-E.164 senders before they pollute
  // pa-users / pa-candidate-handles. Email Apple ID support: GH #142.
  const senderFormat = classifyInboundSender(normalized.fromNumber)
  if (senderFormat !== "e164_phone") {
    await safeAudit(
      deps,
      {
        type: "non_e164_sender_rejected",
        channel: "imessage_sendblue",
        fromNumber: normalized.fromNumber,
        reason: senderFormat,
        correlationId: normalized.messageHandle,
      },
      log
    )
    reply(res, 200, { ok: true, ignored: "non_e164_sender_rejected" })
    return
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

  await sendAcceptedInboundTypingHint(
    deps,
    { to: normalized.fromNumber, correlationId: normalized.messageHandle },
    log,
  )

  // ---- 3e0. v1.9 G2 — ATS pending-trigger virtualization --------------
  //
  // If this inbound is from a candidate who recently received an ATS
  // invite SMS (paAtsInboundWebhook stamped pa-ats-pending-trigger/{phone}
  // within 24h), synthesize the WeKruit_<jobId>_<userId>_Job trigger body
  // so the candidate doesn't have to manually type it. Any non-trigger
  // reply (e.g. "START", "hi", "yes") activates the pending trigger.
  //
  // Skip when: media attached, already a verbatim trigger text, or no
  // pending row exists.
  if (!mediaUrl && typeof normalized.text === "string") {
    const looksLikeTrigger = /WeKruit_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+_(Job|Apply)/.test(normalized.text)
    if (!looksLikeTrigger) {
      try {
        const pendingRef = deps.db
          .collection("pa-ats-pending-trigger")
          .doc(normalized.fromNumber)
        const pendingSnap = await pendingRef.get()
        const pendingData = pendingSnap.data() as
          | { jobId?: string; userId?: string; expiresAtMs?: number }
          | undefined
        const nowMs = Date.now()
        if (
          pendingData?.jobId &&
          pendingData?.userId &&
          typeof pendingData.expiresAtMs === "number" &&
          pendingData.expiresAtMs > nowMs
        ) {
          if (await isLayoffIntakeActiveForUser(deps.db, pendingData.userId)) {
            log("[sendblue][webhook] ats-pending-trigger consumed during active layoff intake", {
              fromNumber: normalized.fromNumber,
              jobId: pendingData.jobId,
              userId: pendingData.userId,
            })
            await pendingRef.delete().catch(() => undefined)
          } else {
            const virtualTrigger = `WeKruit_${pendingData.jobId}_${pendingData.userId}_Job`
            log("[sendblue][webhook] ats-pending-trigger virtualized", {
              fromNumber: normalized.fromNumber,
              jobId: pendingData.jobId,
              userId: pendingData.userId,
              origText: normalized.text.slice(0, 40),
            })
            // Mutate normalized.text so the downstream TriggerRouter sees the
            // synthesized trigger pattern. Consume the pending doc to prevent
            // replay on subsequent inbounds.
            ;(normalized as { text: string }).text = virtualTrigger
            await pendingRef.delete().catch(() => undefined)
          }
        }
      } catch (err) {
        log("[sendblue][webhook] ats-pending-trigger check failed (non-fatal)", {
          fromNumber: normalized.fromNumber,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // ---- 3e1. v1.8 Phase 77 — TriggerRouter (prescreen + compact) ----------
  //
  // Additive dispatch ahead of the legacy inline branches. Handles:
  //   - WeKruit_<jobId>_<userId>_Job  → PrescreenTrigger (PS7)
  //   - __PA_COMPACT__                 → CompactTrigger (Phase 74.5 admin)
  //
  // The inline `__PA_FIND_MATCH__` (line ~640) is NOT yet routed here — that
  // migration is gated on HMAC contract byte-identical verification per
  // CLAUDE.md no-no list. Patterns don't overlap; safe to coexist.
  if (!mediaUrl && typeof normalized.text === "string") {
    const adminUidsRouter = (process.env.PA_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const lookupFnRouter = deps.lookupUserByPhone ?? defaultLookupUserByPhone
    const lookupForInbound = (phone: string) => lookupFnRouter(deps.db, phone, normalized.text)
    const runLayoffSmsStart = deps.runLayoffSmsStart ?? defaultRunLayoffSmsStart
    const runPreScreenForUser = deps.runPreScreenForUser ?? defaultRunPreScreenForUser
    const runPiiConfirmForUser = deps.runPiiConfirmForUser ?? defaultRunPiiConfirmForUser
    const router = new TriggerRouter({
      triggers: [
        new LayoffTrigger({
          lookupUserByPhone: lookupForInbound,
          getLastFiredMs: async (userId) => {
            try {
              const snap = await deps.db
                .collection("pa-layoff-trigger-idempotency")
                .doc(userId)
                .get()
              const data = snap.data()
              return typeof data?.lastFiredMs === "number" ? data.lastFiredMs : null
            } catch {
              return null
            }
          },
          setLastFiredMs: async (userId, ms) => {
            await deps.db
              .collection("pa-layoff-trigger-idempotency")
              .doc(userId)
              .set({ lastFiredMs: ms, userId, updatedAt: new Date().toISOString() })
          },
          runLayoffStart: async ({ userId, toE164 }) => {
            const result = await runLayoffSmsStart({
              db: deps.db,
              userId,
              toE164,
              log: (event, payload) => log(`pa.layoff.${event}`, payload),
            })
            log("[sendblue][webhook] layoff_start", {
              userId,
              ok: result.ok,
              ...(result.ok
                ? { kickoffOutboundId: result.kickoffOutboundId, created: result.kickoffCreated }
                : { reason: result.reason }),
            })
          },
          audit: async (evt) => {
            await safeAudit(deps, evt as AuditEventInput, log)
          },
        }),
        new PrescreenTrigger({
          lookupUserByPhone: lookupForInbound,
          isAdmin: async (uid) => adminUidsRouter.includes(uid),
          getLastFiredMs: async (jobId, userId, messageHandle) => {
            try {
              const snap = await deps.db
                .collection("pa-prescreen-trigger-idempotency")
                .doc(prescreenTriggerIdempotencyDocId(jobId, userId, messageHandle))
                .get()
              const data = snap.data()
              return typeof data?.lastFiredMs === "number" ? data.lastFiredMs : null
            } catch {
              return null
            }
          },
          setLastFiredMs: async (jobId, userId, messageHandle, ms) => {
            await deps.db
              .collection("pa-prescreen-trigger-idempotency")
              .doc(prescreenTriggerIdempotencyDocId(jobId, userId, messageHandle))
              .set({ lastFiredMs: ms, jobId, userId, messageHandle, updatedAt: new Date().toISOString() })
          },
          runPreScreen: async ({ jobId, userId, toE164, sourceRequestedUserId }) => {
            // Phase 77.3 — real handler: load config, build state, send 1st Q.
            // v1.9 hotfix 2026-05-13 — sourceRequestedUserId passed through
            // for attribution when bound via public-page pending-invite.
            const result = await runPreScreenForUser({
              db: deps.db,
              jobId,
              userId,
              toE164,
              sourceRequestedUserId,
              log: (event, payload) => log(`pa.prescreen.${event}`, payload),
            })
            log("[sendblue][webhook] prescreen_run", {
              jobId, userId, sessionId: result.sessionId,
              reason: result.reason, ok: result.ok,
              ...(sourceRequestedUserId ? { sourceRequestedUserId } : {}),
            })
          },
          audit: async (evt) => {
            await safeAudit(deps, evt as AuditEventInput, log)
          },
          // v1.9 hotfix 2026-05-13 — pending-invite binding for public-page flow.
          getPendingInvite: async (requestedUserId) => {
            try {
              const snap = await deps.db
                .collection("pa-prescreen-pending-invites")
                .doc(requestedUserId)
                .get()
              if (!snap.exists) return null
              const data = snap.data() as { jobId?: string; createdAt?: string } | undefined
              return data ?? null
            } catch {
              return null
            }
          },
          consumePendingInvite: async (requestedUserId) => {
            await deps.db
              .collection("pa-prescreen-pending-invites")
              .doc(requestedUserId)
              .delete()
              .catch(() => undefined)
          },
        }),
        new ApplyTrigger({
          lookupUserByPhone: lookupForInbound,
          findRecentPass: async ({ jobId, userId, sinceMs }) => {
            try {
              const cutoffIso = new Date(Date.now() - sinceMs).toISOString()
              const snap = await deps.db
                .collection("pa-prescreen-sessions")
                .where("jobId", "==", jobId)
                .where("userId", "==", userId)
                .where("terminal", "==", "PASS")
                .orderBy("updatedAt", "desc")
                .limit(1)
                .get()
              if (snap.empty) return null
              const doc = snap.docs[0]
              const data = doc.data() as { updatedAt?: string }
              if (!data.updatedAt || data.updatedAt < cutoffIso) return null
              return {
                sessionId: doc.id,
                terminalAtMs: Date.parse(data.updatedAt),
              }
            } catch {
              return null
            }
          },
          getLastFiredMs: async (jobId, userId) => {
            try {
              const snap = await deps.db
                .collection("pa-apply-trigger-idempotency")
                .doc(`${jobId}_${userId}`)
                .get()
              const data = snap.data()
              return typeof data?.lastFiredMs === "number" ? data.lastFiredMs : null
            } catch {
              return null
            }
          },
          setLastFiredMs: async (jobId, userId, ms) => {
            await deps.db
              .collection("pa-apply-trigger-idempotency")
              .doc(`${jobId}_${userId}`)
              .set({ lastFiredMs: ms, jobId, userId, updatedAt: new Date().toISOString() })
          },
          runPiiConfirm: async ({ jobId, userId, toE164, sourceSessionId }) => {
            await runPiiConfirmForUser({
              db: deps.db,
              jobId,
              userId,
              toE164,
              sourceSessionId,
              log: (event, payload) => log(`pa.pii.${event}`, payload),
            })
          },
          runPreScreen: async ({ jobId, userId, toE164 }) => {
            await runPreScreenForUser({
              db: deps.db,
              jobId,
              userId,
              toE164,
              log: (event, payload) => log(`pa.prescreen.${event}`, payload),
            })
          },
          audit: async (evt) => {
            await safeAudit(deps, evt as AuditEventInput, log)
          },
        }),
        new CompactTrigger({
          lookupUserByPhone: lookupForInbound,
          isAdmin: async (uid) => adminUidsRouter.includes(uid),
          runCompaction: async ({ userId, reason }) => {
            // Phase 77.3 — real handler: runCompactionForUser pulls turns,
            // wires Firestore deps, calls runCompactionTurn pure orchestrator.
            const result = await runCompactionForUser({
              db: deps.db,
              userId,
              reason: reason as "admin_trigger" | "turn_count" | "session_end",
              log: (event, payload) => log(event, payload),
            })
            log("[sendblue][webhook] compact_run", {
              userId, reason, ok: result.ok,
              outcome: result.reason, factsWritten: result.factsWritten,
            })
          },
          audit: async (evt) => {
            await safeAudit(deps, evt as AuditEventInput, log)
          },
        }),
      ],
      log: (event, payload) => log(`pa.trigger.${event}`, payload),
    })
    const routerResult = await router.dispatch({
      text: normalized.text,
      fromNumber: normalized.fromNumber,
      messageHandle: normalized.messageHandle,
      receivedAtIso: new Date().toISOString(),
      log: (event, payload) => log(`pa.trigger.${event}`, payload),
      hasMedia: !!mediaUrl,
    })
    if (routerResult.handled) {
      const action =
        routerResult.outcome?.kind === "handled"
          ? routerResult.outcome.action
          : `${routerResult.triggerName}_${routerResult.outcome?.kind ?? "unknown"}`
      reply(res, 200, { ok: true, action })
      return
    }
  }

  // ---- 3e2. Phase 60 (DEV-01) — `__PA_FIND_MATCH__` dev trigger ----------
  //
  // CLAUDE.md D14: an admin iMessage containing the literal token
  // `__PA_FIND_MATCH__` force-runs the v1.6 match cascade for that user.
  // Useful in production for Adam ("ping myself to refresh recs") and in
  // staging for end-to-end verification of the match path without waiting
  // for the daily 09:00 cron.
  //
  // Security: GUARDED by `PA_ADMIN_USER_IDS` env (comma-separated userId
  // allowlist) OR per-user `testMode: true`, matching reset-command auth.
  // HMAC verify already ran at line 285 — request came from Sendblue.
  // Admin/test-mode auth + HMAC together guarantee a production user typing
  // the literal token cannot trigger the path.
  //
  // Flow on detect-and-authorized:
  //   1. lookup userId by phone (same resolver as coalesce path)
  //   2. validate against `PA_ADMIN_USER_IDS` or `pa-users/{id}.testMode`
  //   3. invoke `deps.generateJobRecsForUser` (fire-and-forget)
  //   4. audit `dev_trigger_find_match`
  //   5. SKIP broker enqueue + return 200 OK with action marker
  //
  // The trigger short-circuits the orchestrator path so Claire doesn't
  // also try to respond to the literal token (which would be confusing).
  if (
    !mediaUrl &&
    typeof normalized.text === "string" &&
    normalized.text.includes("__PA_FIND_MATCH__")
  ) {
    const adminUids = (process.env.PA_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const lookupFn = deps.lookupUserByPhone ?? defaultLookupUserByPhone
    let triggerUserId: string | null = null
    try {
      triggerUserId = await lookupFn(deps.db, normalized.fromNumber, normalized.text)
    } catch (err) {
      log("[sendblue][webhook] find_match phone lookup failed",
        err instanceof Error ? err.message : String(err))
    }
    let isTestUser = false
    if (triggerUserId && !adminUids.includes(triggerUserId)) {
      try {
        const userSnap = await deps.db.collection("pa-users").doc(triggerUserId).get()
        isTestUser = userSnap.exists && userSnap.data()?.testMode === true
      } catch (err) {
        log("[sendblue][webhook] find_match testMode lookup failed",
          err instanceof Error ? err.message : String(err))
      }
    }
    const authorized = !!triggerUserId && (adminUids.includes(triggerUserId) || isTestUser)
    if (!authorized) {
      log("pa.dev_trigger.find_match.unauthorized", {
        fromNumber: normalized.fromNumber,
        userId: triggerUserId,
        adminCount: adminUids.length,
        testMode: isTestUser,
      })
      await safeAudit(
        deps,
        {
          type: "inbound_skipped",
          channel: "imessage_sendblue",
          fromNumber: normalized.fromNumber,
          reason: "find_match_unauthorized",
          correlationId: normalized.messageHandle,
        },
        log
      )
      reply(res, 200, { ok: true, ignored: "find_match_unauthorized" })
      return
    }
    log("pa.dev_trigger.find_match", {
      userId: triggerUserId,
      fromNumber: normalized.fromNumber,
      handle: normalized.messageHandle,
    })
    // Fire-and-forget — the trigger handler does the V16 query + send.
    // We don't await so the 200 OK to Sendblue is fast (HMAC retries on 5xx).
    if (deps.generateJobRecsForUser) {
      void Promise.resolve()
        .then(() =>
          deps.generateJobRecsForUser!({
            userId: triggerUserId!,
            toE164: normalized.fromNumber,
          })
        )
        .then((res) => {
          log("[sendblue][webhook] find_match completed", {
            userId: triggerUserId,
            jobCount: res.jobCount,
            ok: res.ok,
            reason: res.reason,
          })
        })
        .catch((err) => {
          log("[sendblue][webhook] find_match handler threw",
            err instanceof Error ? err.message : String(err))
        })
    } else {
      log("[sendblue][webhook] find_match no handler wired (dev only)", {
        userId: triggerUserId,
      })
    }
    await safeAudit(
      deps,
      {
        type: "dev_trigger_find_match",
        channel: "imessage_sendblue",
        fromNumber: normalized.fromNumber,
        correlationId: normalized.messageHandle,
        payload: { userId: triggerUserId },
      },
      log
    )
    reply(res, 200, { ok: true, action: "find_match_triggered" })
    return
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
  //
  // v1.5 TD-A (2026-05-03 Adam P0): atomic-coalescing-flag-on-create.
  //
  //   Before TD-A: webhook called broker.createInboundEvent FIRST, then
  //   coalescer.enqueueOrCoalesce ran a Firestore transaction and merged
  //   coalescing:true on the doc. In between those two writes,
  //   `onPaInbound` (onDocumentCreated trigger) fires within milliseconds and
  //   reads the OLD doc where coalescing is still undefined → it processes
  //   the row as an independent turn. Adam's "4 quick messages → 4 turns"
  //   incident was exactly this race for every single message.
  //
  //   Fix: PRE-DECIDE whether this row goes to coalescer (cheap reads only —
  //   phone lookup + flag get — both already in the post-broker block) and
  //   pass `coalescing:true` to broker.createInboundEvent so the flag is
  //   present in the SAME doc.create() write. onPaInbound's single read
  //   then sees the flag and skips correctly — race window closed.
  //
  //   The coalescer's later `merge({coalescing:true})` becomes a no-op (still
  //   safe, idempotent), but its `coalesceTurnId` stamp still adds value
  //   because we don't know turnSeq at create time.
  let willCoalesce = false
  let resolvedUserIdForCoalesce: string | null = null
  let activePrescreenForCoalesce = false
  let activeSharedOnboardingForCoalesce = false
  if (!mediaUrl && deps.enqueueOrCoalesce && deps.coalescerDeps) {
    try {
      const lookupFn = deps.lookupUserByPhone ?? defaultLookupUserByPhone
      resolvedUserIdForCoalesce = await lookupFn(deps.db, normalized.fromNumber, normalized.text)
      if (resolvedUserIdForCoalesce) {
        const coalesceFlag = await getFlag(
          deps.db,
          "paMessageCoalesceEnabled",
          { userId: resolvedUserIdForCoalesce, env: process.env },
          false
        )
        // 2026-05-15 prescreen fix + 2026-05-19 shared-onboarding fix:
        // these agent-runtime conversations often receive one human answer
        // split across several iMessages. Coalesce them into one runtime turn
        // before the orchestrator judges or scores the reply.
        let onboardingState: string | null = null
        try {
          const userSnap = await deps.db
            .collection("pa-users")
            .doc(resolvedUserIdForCoalesce)
            .get()
          if (userSnap.exists) {
            const data = userSnap.data() as {
              onboardingState?: string
              workSession?: { kind?: string; status?: string }
              sharedOnboarding?: { status?: string; completed?: boolean }
            } | undefined
            onboardingState = typeof data?.onboardingState === "string" ? data.onboardingState : null
            activeSharedOnboardingForCoalesce = Boolean(
              data?.sharedOnboarding?.completed !== true &&
              (
                (data?.workSession?.kind === "shared_onboarding" && data.workSession.status === "active") ||
                data?.sharedOnboarding?.status === "active"
              )
            )
          }
        } catch {
          onboardingState = null
          activeSharedOnboardingForCoalesce = false
        }
        try {
          activePrescreenForCoalesce = await hasActivePrescreenSession(deps.db, resolvedUserIdForCoalesce)
        } catch {
          activePrescreenForCoalesce = false
        }
        willCoalesce = coalesceFlag === true && (
          onboardingState === "complete" ||
          activePrescreenForCoalesce ||
          activeSharedOnboardingForCoalesce
        )
      }
    } catch (preErr) {
      // Pre-decision failure: do not stamp coalescing, so onPaInbound owns
      // this event through the normal runtime path.
      log("[coalesce][webhook] pre-decision failed (non-fatal — runtime path)",
        preErr instanceof Error ? preErr.message : String(preErr))
      willCoalesce = false
      resolvedUserIdForCoalesce = null
      activeSharedOnboardingForCoalesce = false
    }
  }

  const broker = deps.createInboundEvent ?? createInboundEvent
  try {
    const result = await broker(deps.db, {
      channel: "imessage",
      idempotencyKey: normalized.idempotencyKey,
      // TD-A: when willCoalesce=true, broker writes coalescing:true on the
      // SAME create() call → onPaInbound's onDocumentCreated trigger sees
      // the flag in its first read → skip → no race-induced split.
      ...(willCoalesce ? { coalescing: true } : {}),
      rawPayload: {
        kind: "imessage",
        source: "sendblue",
        fromNumber: normalized.fromNumber,
        toNumber: normalized.toNumber,
        text: normalized.text,
        chatId: normalized.chatId,
        messageHandle: normalized.messageHandle,
        service: normalized.service,
        // Preserve BrokerImessageEvent's canonical participant field.
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
    // TD-A note: the pre-decision already ran BEFORE broker.create — see the
    // willCoalesce / resolvedUserIdForCoalesce locals computed above. If
    // willCoalesce=true, the doc was written with `coalescing:true` so
    // onPaInbound's onDocumentCreated trigger has already skipped it. We now
    // just enqueue the Cloud Tasks task. On hard enqueue failure we MUST
    // actively drive the runtime path because onPaInbound will not re-fire
    // (onDocumentCreated is one-shot per row, and the flag is true).
    if (willCoalesce && resolvedUserIdForCoalesce && deps.enqueueOrCoalesce && deps.coalescerDeps) {
      try {
        await deps.enqueueOrCoalesce(deps.coalescerDeps, {
          userId: resolvedUserIdForCoalesce,
          fromNumber: normalized.fromNumber,
          toNumber: normalized.toNumber,
          messageHandle: normalized.messageHandle,
          body: normalized.text,
          inboundEventId: result.id,
          isOnboarding: activeSharedOnboardingForCoalesce,
          isPrescreen: activePrescreenForCoalesce,
        })
        log("[coalesce][webhook] enqueued", {
          userId: resolvedUserIdForCoalesce,
          eventId: result.id,
          handle: normalized.messageHandle,
        })
      } catch (coalesceErr) {
        // Cloud Tasks enqueue failed. Pre-TD-A this would just log and let
        // onPaInbound handle it via onDocumentCreated. POST-TD-A that trigger
        // already saw `coalescing:true` and skipped, so we must drive the
        // runtime orchestrator path explicitly:
        //   1. revert the flag (cosmetic — for dashboards / forensic reads)
        //   2. invoke the injected processBrokerImessageFallback if wired
        //      (CF wrapper passes processBrokerImessageEvent in production)
        log("[coalesce][webhook] enqueue failed — invoking runtime fallback", {
          userId: resolvedUserIdForCoalesce,
          err: coalesceErr instanceof Error ? coalesceErr.message : String(coalesceErr),
        })
        try {
          await deps.db.collection("pa-inbound-events").doc(result.id).set(
            { coalescing: false, coalesceFallback: true },
            { merge: true }
          )
        } catch {/* swallow — flag is cosmetic at this point */}
        if (deps.processBrokerImessageFallback) {
          try {
            await deps.processBrokerImessageFallback(result.id)
            log("[coalesce][webhook] runtime fallback completed", { eventId: result.id })
          } catch (fallbackErr) {
            log("[coalesce][webhook] runtime fallback FAILED — user gets no reply this turn", {
              eventId: result.id,
              err: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
            })
          }
        } else {
          log("[coalesce][webhook] no processBrokerImessageFallback wired — row stays pending", {
            eventId: result.id,
          })
        }
      }
    }

    // Stream D — CV side-effect (fire-and-forget):
    //   CV ingestion → parsedCandidateResumes.
    // Webhook-level tapbacks were removed so candidate-visible reactions are
    // not produced before the runtime has judged the turn.
    if (mediaUrl) {
      const ingestFn = deps.ingestCv ?? defaultIngestCv
      const lookupFn = deps.lookupUserByPhone ?? defaultLookupUserByPhone
      void Promise.resolve()
        .then(async () => {
          const userId = await lookupFn(deps.db, normalized.fromNumber, normalized.text)
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
