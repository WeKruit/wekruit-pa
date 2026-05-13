/**
 * v2.0 External Supply V1 — Wave C Block F2 — Instantly webhook receiver.
 *
 * HTTP function (NOT callable). Instantly POSTs server-to-server with a
 * standard event-payload envelope. F's job: idempotent persistence into
 * `pa-outreach-events`, plus a paired `pa-feedback-events` row for the
 * flywheel.
 *
 * Body shape (Instantly v1 webhook envelope, per their docs as of 2026-05):
 *  {
 *    "event_type": "reply" | "bounce" | "unsubscribe" | "open" | "click"
 *                | "sent" | "spam",
 *    "event_id": "<provider-supplied uuid>",
 *    "lead": { "email": "...", "id": "<instantly lead id>" },
 *    "campaign_id": "<...>",
 *    "occurred_at": "<iso8601>",
 *    ...arbitrary additional fields
 *  }
 *
 * Pipeline:
 *  1. Optional HMAC verify (only when INSTANTLY_WEBHOOK_SECRET configured).
 *  2. Parse + normalize event_type → OutreachEventKind.
 *  3. Build deterministic doc id `instantly__<event_id>` via the helper from
 *     core-types. Idempotency: same event POSTed twice → one persisted doc.
 *  4. Resolve `planId` via a reverse lookup on the email hash. When no plan
 *     matches, write the event with `planId: "unknown"` and a warning log
 *     so we don't lose the signal.
 *  5. Emit a paired `pa-feedback-events` row (kind depends on event):
 *       - reply → candidate_reply
 *       - bounce/unsubscribe/sent/spam → outreach_delivery
 *  6. We do NOT advance the v1.9 candidate-job state reducer here — that
 *     belongs to a follow-up integration sprint (per F Q4 lead resolution).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { onRequest } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  FeedbackEventSchema,
  OutreachEventSchema,
  PA_COLLECTIONS,
  createOutreachEventId,
  type FeedbackEvent,
  type OutreachEvent,
  type OutreachEventKind,
} from "@pa/core-types"

/**
 * INSTANTLY_WEBHOOK_SECRET is read from `process.env` at request time rather
 * than via `defineSecret(...)` because the secret is OPTIONAL per
 * .planning/external-supply-v1/PLAN.md §11 F. Without it the webhook accepts
 * unsigned requests (acceptable until Instantly is wired live). Once Adam
 * sets the Firebase Secret, deploy with `--update-secrets` to expose it; the
 * code below verifies HMAC iff the env var is non-empty.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InstantlyWebhookBody {
  event_type?: string
  event_id?: string
  lead?: { email?: string; id?: string }
  campaign_id?: string
  list_id?: string
  occurred_at?: string
  [key: string]: unknown
}

export interface InstantlyWebhookRequest {
  method?: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
  rawBody?: Buffer | string
}

export interface InstantlyWebhookResponse {
  status(code: number): InstantlyWebhookResponse
  json(body: unknown): unknown
  send(body: unknown): unknown
}

export interface InstantlyWebhookDeps {
  db: Firestore
  /** Optional HMAC secret. When empty, signature verification is skipped. */
  secret?: string
  now?: () => string
  newId?: () => string
}

export interface InstantlyWebhookResult {
  ok: boolean
  status: number
  eventId?: string
  kind?: OutreachEventKind
  reason?: string
}

// ---------------------------------------------------------------------------
// Event type → OutreachEventKind table
// ---------------------------------------------------------------------------

const EVENT_TYPE_TO_KIND: Record<string, OutreachEventKind> = {
  reply: "email_replied",
  bounce: "email_bounced",
  unsubscribe: "email_unsubscribed",
  open: "email_opened",
  opened: "email_opened",
  click: "email_clicked",
  clicked: "email_clicked",
  sent: "email_sent",
  spam: "email_marked_spam",
  marked_spam: "email_marked_spam",
}

const REPLY_KINDS: Set<OutreachEventKind> = new Set(["email_replied"])
const DELIVERY_KINDS: Set<OutreachEventKind> = new Set([
  "email_sent",
  "email_bounced",
  "email_unsubscribed",
  "email_marked_spam",
])

// ---------------------------------------------------------------------------
// Pure handler — used by tests
// ---------------------------------------------------------------------------

export async function handleInstantlyWebhook(
  req: InstantlyWebhookRequest,
  res: InstantlyWebhookResponse,
  deps: InstantlyWebhookDeps,
): Promise<InstantlyWebhookResult> {
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())

  if ((req.method ?? "POST").toUpperCase() !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" })
    return { ok: false, status: 405, reason: "method_not_allowed" }
  }

  // HMAC verify when secret configured.
  if (deps.secret && deps.secret.length > 0) {
    const rawBody = extractRawBody(req)
    const sig = extractSignatureHeader(req.headers ?? {})
    if (!verifyInstantlySignature(rawBody, sig, deps.secret)) {
      res.status(401).json({ ok: false, error: "invalid_signature" })
      return { ok: false, status: 401, reason: "invalid_signature" }
    }
  }

  // Parse JSON body.
  let body: InstantlyWebhookBody
  try {
    body = parseBody(req)
  } catch (err) {
    logger.warn("external_supply.instantly_webhook.body_parse_failed", {
      err: err instanceof Error ? err.message : String(err),
    })
    res.status(400).json({ ok: false, error: "invalid_body" })
    return { ok: false, status: 400, reason: "invalid_body" }
  }

  const eventTypeRaw = typeof body.event_type === "string" ? body.event_type.trim().toLowerCase() : ""
  const kind = EVENT_TYPE_TO_KIND[eventTypeRaw]
  if (!kind) {
    res.status(200).json({ ok: true, ignored: eventTypeRaw })
    return { ok: true, status: 200, reason: "unknown_event_type" }
  }

  const providerEventId =
    typeof body.event_id === "string" && body.event_id.trim().length > 0
      ? body.event_id.trim()
      : undefined
  const eventId = createOutreachEventId("instantly", providerEventId)

  // Idempotency check — same event POSTed twice should land one doc.
  const eventRef = db.collection(PA_COLLECTIONS.outreachEvents).doc(eventId)
  const existing = await eventRef.get()
  if (existing.exists) {
    res.status(200).json({ ok: true, idempotent: true, eventId })
    return { ok: true, status: 200, eventId, kind, reason: "idempotent" }
  }

  const occurredAt = parseTimestampOr(body.occurred_at, now())
  const recordedAt = now()
  const email =
    typeof body.lead?.email === "string" ? body.lead.email.trim().toLowerCase() : ""

  // Plan lookup via email hash.
  const planLookup = email
    ? await lookupPlanByEmailHash(db, email)
    : { planId: undefined, candidateId: undefined, jobId: undefined, companyId: undefined }
  const planId = planLookup.planId ?? "unknown"
  const candidateId = planLookup.candidateId ?? "unknown"
  const jobId = planLookup.jobId ?? "unknown"
  const companyId = planLookup.companyId ?? "unknown"

  if (!planLookup.planId) {
    logger.warn("external_supply.instantly_webhook.plan_not_found_for_email", {
      eventId,
      kind,
      emailLen: email.length,
    })
  }

  const event: OutreachEvent = {
    eventId,
    provider: "instantly",
    candidateId,
    planId,
    jobId,
    companyId,
    kind,
    payloadRedacted: redactPayload(body),
    occurredAt,
    recordedAt,
  }
  if (providerEventId) event.providerEventId = providerEventId
  await eventRef.set(OutreachEventSchema.parse(event), { merge: false })

  // Companion feedback event.
  const feedbackKind: FeedbackEvent["kind"] = REPLY_KINDS.has(kind)
    ? "candidate_reply"
    : DELIVERY_KINDS.has(kind)
      ? "outreach_delivery"
      : "outreach_delivery"
  const feedbackId = `instantly__${eventId}`
  const feedback: FeedbackEvent = {
    eventId: feedbackId,
    kind: feedbackKind,
    actor: "system",
    outcome: kind,
    evidence: [
      {
        source: "instantly_delivery",
        summary: `Instantly ${kind} event ${providerEventId ?? "<no-id>"}`,
        confidence: 0.8,
        refId: eventId,
      },
    ],
    payloadRedacted: { eventId, kind, occurredAt },
    createdAt: recordedAt,
  }
  if (candidateId !== "unknown") feedback.candidateId = candidateId
  if (jobId !== "unknown") feedback.jobId = jobId
  await db
    .collection(PA_COLLECTIONS.feedbackEvents)
    .doc(feedbackId)
    .set(FeedbackEventSchema.parse(feedback), { merge: false })

  res.status(200).json({ ok: true, eventId, kind })
  return { ok: true, status: 200, eventId, kind }
}

// ---------------------------------------------------------------------------
// HMAC verification
// ---------------------------------------------------------------------------

const SIGNATURE_HEADERS = [
  "x-instantly-signature",
  "instantly-signature",
  "x-webhook-signature",
] as const

function extractSignatureHeader(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  for (const name of SIGNATURE_HEADERS) {
    const value = headers[name] ?? headers[name.toLowerCase()]
    if (typeof value === "string" && value.length > 0) return value
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) {
      return value[0]
    }
  }
  return undefined
}

function extractRawBody(req: InstantlyWebhookRequest): Buffer {
  if (req.rawBody !== undefined) {
    return typeof req.rawBody === "string" ? Buffer.from(req.rawBody, "utf8") : req.rawBody
  }
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8")
  if (req.body && typeof req.body === "object") {
    return Buffer.from(JSON.stringify(req.body), "utf8")
  }
  return Buffer.from("", "utf8")
}

export function verifyInstantlySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header || !secret) return false
  const trimmed = header.trim().toLowerCase()
  if (!/^[0-9a-f]+$/.test(trimmed)) return false
  let providedBuf: Buffer
  try {
    providedBuf = Buffer.from(trimmed, "hex")
  } catch {
    return false
  }
  if (providedBuf.length === 0) return false
  let expected: Buffer
  try {
    expected = createHmac("sha256", secret).update(rawBody).digest()
  } catch {
    return false
  }
  if (providedBuf.length !== expected.length) return false
  try {
    return timingSafeEqual(providedBuf, expected)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBody(req: InstantlyWebhookRequest): InstantlyWebhookBody {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body as InstantlyWebhookBody
  }
  const raw =
    req.rawBody !== undefined
      ? typeof req.rawBody === "string"
        ? req.rawBody
        : req.rawBody.toString("utf8")
      : typeof req.body === "string"
        ? req.body
        : ""
  if (!raw) throw new Error("empty_body")
  return JSON.parse(raw) as InstantlyWebhookBody
}

function parseTimestampOr(raw: unknown, fallback: string): string {
  if (typeof raw === "string" && raw.trim().length > 0) {
    const ms = Date.parse(raw)
    if (!Number.isNaN(ms)) return new Date(ms).toISOString()
  }
  return fallback
}

function redactPayload(body: InstantlyWebhookBody): Record<string, unknown> {
  return {
    eventType: body.event_type,
    occurredAt: body.occurred_at,
    campaignId: body.campaign_id,
    listId: body.list_id,
    leadId: body.lead?.id,
    // Email is hashed in our lookup; we keep only length + domain hint.
    leadEmailLength: body.lead?.email?.length ?? 0,
    leadEmailDomain: body.lead?.email?.split("@")[1] ?? undefined,
  }
}

function emailLookupHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex")
}

async function lookupPlanByEmailHash(
  db: Firestore,
  email: string,
): Promise<{
  planId?: string
  candidateId?: string
  jobId?: string
  companyId?: string
}> {
  const hash = emailLookupHash(email)
  try {
    const snap = await db
      .collection(PA_COLLECTIONS.outreachPlans)
      .where("emailHash", "==", hash)
      .get()
    if (snap.empty || snap.docs.length === 0) return {}
    const doc = snap.docs[0]!
    const data = doc.data() as Record<string, unknown>
    return {
      planId: typeof data.planId === "string" ? data.planId : doc.id,
      candidateId: typeof data.candidateId === "string" ? data.candidateId : undefined,
      jobId: typeof data.jobId === "string" ? data.jobId : undefined,
      companyId: typeof data.companyId === "string" ? data.companyId : undefined,
    }
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Production CF wrapper
// ---------------------------------------------------------------------------

export const paExternalSupplyInstantlyWebhook = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
    cors: false,
  },
  async (req, res) => {
    const secret = process.env.INSTANTLY_WEBHOOK_SECRET ?? ""
    await handleInstantlyWebhook(
      {
        method: req.method,
        headers: req.headers,
        body: req.body,
        rawBody: req.rawBody,
      },
      {
        status: (code) => res.status(code) as unknown as InstantlyWebhookResponse,
        json: (body) => res.json(body),
        send: (body) => res.send(body),
      },
      { db: getFirestore(), secret },
    )
  },
)
