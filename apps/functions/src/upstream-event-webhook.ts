/**
 * Phase 31 T2 — paUpstreamEventWebhook handler.
 *
 * External partners POST signed events here. On success the handler:
 *   1. Verifies the HMAC signature against PA_UPSTREAM_HMAC_SECRET (401 fail).
 *   2. Parses `{ eventKind, userId, payload }` (400 on malformed body).
 *   3. Looks up the matching template by `eventKind` (404 if missing/disabled).
 *   4. Checks the `upstreamConnectorEnabled` feature flag (503 if disabled).
 *   5. Per-(template, user) hour-bucket rate-limit (429 if exceeded).
 *   6. Renders the template with payload vars.
 *   7. Enqueues a `pa-outbound/{outboundId}` row with status=pending.
 *      The existing paSendblueOutbox CF then sends the message.
 *   8. Audit row to `pa-audit-events` (kind="upstream_inbound").
 *   9. Returns `{ ok: true, outboundId }`.
 *
 * The handler stays pure (deps-injected) so unit tests can drive it without
 * a live Firestore. Production wiring is in apps/functions/src/index.ts.
 */

import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  checkUpstreamRateLimit,
  getFlag,
  getUpstreamTemplateByEventKind,
  renderUpstreamTemplate,
  type UpstreamTemplate,
} from "@pa/pa-persistence"

import {
  extractUpstreamSignatureHeader,
  verifyUpstreamSignature,
} from "./upstream-hmac.js"

export const UPSTREAM_FLAG_KEY = "upstreamConnectorEnabled"

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
}

export type UpstreamWebhookDeps = {
  db: Firestore
  /** HMAC shared secret (PA_UPSTREAM_HMAC_SECRET). */
  secret: string
  /** ISO clock; injectable for tests. */
  nowIso?: () => string
  /** Epoch ms; injectable for tests (rate-limit bucket). */
  nowMs?: () => number
  /** Outbound doc id factory; default randomUUID. */
  newId?: () => string
  log?: (...args: unknown[]) => void
  /**
   * Phone-number resolver for the target user. Implementations look up the
   * user's `phoneE164` (or equivalent SMS routing handle). Returns null
   * when the user is missing or has no usable phone number.
   */
  resolveUserPhone?: (db: Firestore, userId: string) => Promise<string | null>
}

export type UpstreamEventPayload = {
  eventKind?: unknown
  userId?: unknown
  payload?: unknown
}

const OUT = PA_COLLECTIONS.outbound
const AUDIT = PA_COLLECTIONS.auditEvents

function reply(res: WebhookResponse, status: number, body: unknown): void {
  res.status(status).json(body)
}

function safeIso(deps: UpstreamWebhookDeps): string {
  return (deps.nowIso ?? (() => new Date().toISOString()))()
}

function newOutboundId(deps: UpstreamWebhookDeps): string {
  if (deps.newId) return deps.newId()
  // Avoid pulling in node:crypto.randomUUID at module top — keeps the file
  // testable in non-Node runtimes used by some test harnesses.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require("node:crypto") as { randomUUID: () => string }
  return randomUUID()
}

async function recordAudit(
  deps: UpstreamWebhookDeps,
  fields: Record<string, unknown>
): Promise<void> {
  try {
    await deps.db.collection(AUDIT).add({
      kind: "upstream_inbound",
      createdAt: safeIso(deps),
      ...fields,
    })
  } catch (err) {
    deps.log?.("[upstream-webhook] audit failed", err instanceof Error ? err.message : String(err))
  }
}

async function defaultResolveUserPhone(
  db: Firestore,
  userId: string
): Promise<string | null> {
  const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
  if (!snap.exists) return null
  const data = snap.data() as { phoneE164?: string } | undefined
  const phone = data?.phoneE164
  return typeof phone === "string" && phone.length > 0 ? phone : null
}

/**
 * Pure webhook handler. Returns nothing; writes status + JSON body via res.
 */
export async function handleUpstreamEventWebhook(
  req: WebhookRequest,
  res: WebhookResponse,
  deps: UpstreamWebhookDeps
): Promise<void> {
  const log = deps.log ?? console.log

  // ---- 1. HMAC verify (401 on fail) -------------------------------------
  const rawBody: Buffer | string =
    req.rawBody !== undefined
      ? req.rawBody
      : typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body ?? {})

  const sigHeader = extractUpstreamSignatureHeader(req.headers ?? {})
  if (!verifyUpstreamSignature(rawBody, sigHeader, deps.secret)) {
    log("[upstream-webhook] HMAC verify failed", { hasHeader: !!sigHeader })
    reply(res, 401, { ok: false, error: "invalid_signature" })
    return
  }

  // ---- 2. Parse JSON ----------------------------------------------------
  let parsed: unknown
  try {
    const text = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")
    parsed = JSON.parse(text)
  } catch {
    reply(res, 400, { ok: false, error: "malformed_body" })
    return
  }
  if (!parsed || typeof parsed !== "object") {
    reply(res, 400, { ok: false, error: "malformed_body" })
    return
  }
  const body = parsed as UpstreamEventPayload
  const eventKind = typeof body.eventKind === "string" ? body.eventKind : ""
  const userId = typeof body.userId === "string" ? body.userId : ""
  const payload =
    body.payload && typeof body.payload === "object"
      ? (body.payload as Record<string, unknown>)
      : {}
  if (!eventKind || !userId) {
    reply(res, 400, { ok: false, error: "missing_eventKind_or_userId" })
    return
  }

  // ---- 3. Template lookup (404) -----------------------------------------
  let template: UpstreamTemplate | null
  try {
    template = await getUpstreamTemplateByEventKind(deps.db, eventKind)
  } catch (err) {
    log("[upstream-webhook] template lookup failed", err instanceof Error ? err.message : String(err))
    reply(res, 500, { ok: false, error: "template_lookup_failed" })
    return
  }
  if (!template) {
    await recordAudit(deps, { result: "no_template", eventKind, userId })
    reply(res, 404, { ok: false, error: "no_template_for_eventKind" })
    return
  }

  // ---- 4. Flag gate (503 if disabled) ----------------------------------
  let flagOn = false
  try {
    flagOn = Boolean(
      await getFlag(deps.db, UPSTREAM_FLAG_KEY, { userId, env: process.env }, false)
    )
  } catch (err) {
    log("[upstream-webhook] flag read failed", err instanceof Error ? err.message : String(err))
  }
  if (!flagOn) {
    await recordAudit(deps, {
      result: "disabled_by_flag",
      eventKind,
      userId,
      templateId: template.templateId,
    })
    reply(res, 503, { ok: false, error: "upstream_connector_disabled" })
    return
  }

  // ---- 5. Rate limit (429) ----------------------------------------------
  const nowMs = (deps.nowMs ?? (() => Date.now()))()
  const limit = Math.max(1, Math.floor(template.rateLimitPerHour))
  const rl = await checkUpstreamRateLimit(deps.db, template.templateId, userId, limit, nowMs)
  if (!rl.allowed) {
    await recordAudit(deps, {
      result: "rate_limited",
      eventKind,
      userId,
      templateId: template.templateId,
      bucketId: rl.bucketId,
    })
    reply(res, 429, { ok: false, error: "rate_limited", bucketId: rl.bucketId })
    return
  }

  // ---- 6. Render --------------------------------------------------------
  const messageBody = renderUpstreamTemplate(template.messageTemplate, {
    userId,
    eventKind,
    ...payload,
  })

  // ---- 7. Resolve target phone + enqueue pa-outbound -------------------
  const resolvePhone = deps.resolveUserPhone ?? defaultResolveUserPhone
  let toE164: string | null = null
  try {
    toE164 = await resolvePhone(deps.db, userId)
  } catch (err) {
    log("[upstream-webhook] phone lookup failed", err instanceof Error ? err.message : String(err))
  }
  if (!toE164) {
    await recordAudit(deps, {
      result: "user_not_routable",
      eventKind,
      userId,
      templateId: template.templateId,
    })
    reply(res, 422, { ok: false, error: "user_not_routable" })
    return
  }

  const outboundId = newOutboundId(deps)
  const at = safeIso(deps)
  const outboundDoc: Record<string, unknown> = {
    id: outboundId,
    status: "pending",
    userId,
    toE164,
    body: messageBody,
    channel: template.channel || "imessage",
    source: "upstream_event",
    sourceEventKind: eventKind,
    sourceTemplateId: template.templateId,
    sourcePayload: payload,
    idempotencyKey: `upstream-${template.templateId}-${userId}-${rl.bucketId}`,
    createdAt: at,
    updatedAt: at,
  }
  try {
    await deps.db.collection(OUT).doc(outboundId).set(outboundDoc)
  } catch (err) {
    log("[upstream-webhook] outbound write failed", err instanceof Error ? err.message : String(err))
    reply(res, 500, { ok: false, error: "outbound_write_failed" })
    return
  }

  // ---- 8. Audit ---------------------------------------------------------
  await recordAudit(deps, {
    result: "enqueued",
    eventKind,
    userId,
    templateId: template.templateId,
    outboundId,
    bucketId: rl.bucketId,
  })

  // ---- 9. Reply ---------------------------------------------------------
  reply(res, 200, { ok: true, outboundId })
}
