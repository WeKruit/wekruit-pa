/**
 * v2.0 External Supply V1.1 — Mailgun webhook handler.
 *
 * Mirrors the Instantly webhook (`instantly-webhook.ts`) but consumes
 * Mailgun's `event-data` payload shape. Idempotent on
 * `(provider, event-data.id)` via `createOutreachEventId`. Optional HMAC
 * signature verify via `MAILGUN_WEBHOOK_SIGNING_KEY` (Mailgun's
 * "HTTP webhook signing key", not the API key).
 *
 * Event-kind mapping:
 *   delivered        → email_sent       (Mailgun "delivered" = remote MTA OK)
 *   opened           → email_opened
 *   clicked          → email_clicked
 *   complained       → email_marked_spam
 *   unsubscribed     → email_unsubscribed
 *   failed/bounced   → email_bounced
 *
 * Mailgun does NOT natively surface replies — those require a separate
 * inbound-route configuration. Reply mapping is left out of V1; if we
 * later enable inbound routing we'll add a `reply` -> `email_replied`
 * branch here.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import { onRequest } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import {
  FeedbackEventSchema,
  OutreachEventSchema,
  PA_COLLECTIONS,
  createOutreachEventId,
  type FeedbackEvent,
  type OutreachEvent,
  type OutreachEventKind,
} from "@pa/core-types"

const MAILGUN_WEBHOOK_SIGNING_KEY = defineSecret("MAILGUN_WEBHOOK_SIGNING_KEY")

// ---------------------------------------------------------------------------
// Types — public for tests
// ---------------------------------------------------------------------------

export interface MailgunWebhookSignature {
  timestamp: string
  token: string
  signature: string
}

export interface MailgunWebhookEventData {
  event?: string
  id?: string
  timestamp?: number
  recipient?: string
  message?: { headers?: { "message-id"?: string } }
}

export interface MailgunWebhookBody {
  signature?: MailgunWebhookSignature
  ["event-data"]?: MailgunWebhookEventData
}

export interface MailgunWebhookRequest {
  method?: string
  headers: Record<string, unknown>
  body: unknown
  rawBody?: Buffer
}

export interface MailgunWebhookResponse {
  status: (code: number) => { json: (body: unknown) => void; send: (body: unknown) => void }
  json: (body: unknown) => void
  send: (body: unknown) => void
}

export interface MailgunWebhookDeps {
  db: Firestore
  /** Optional HMAC signing key. Empty / absent disables signature verify. */
  signingKey?: string
  now?: () => string
}

// ---------------------------------------------------------------------------
// Event-kind mapping
// ---------------------------------------------------------------------------

const EVENT_KIND_MAP: Record<string, OutreachEventKind> = {
  delivered: "email_sent",
  opened: "email_opened",
  clicked: "email_clicked",
  complained: "email_marked_spam",
  unsubscribed: "email_unsubscribed",
  failed: "email_bounced",
  bounced: "email_bounced",
}

function mapEventKind(raw: string | undefined): OutreachEventKind | null {
  if (!raw) return null
  const key = raw.toLowerCase()
  return EVENT_KIND_MAP[key] ?? null
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Mailgun signs webhooks as `HMAC_SHA256(signing_key, timestamp + token)`
 * and returns the hex digest in `signature.signature`.
 */
export function verifyMailgunSignature(
  signingKey: string,
  sig: MailgunWebhookSignature | undefined,
): boolean {
  if (!sig || !sig.timestamp || !sig.token || !sig.signature) return false
  if (!signingKey || signingKey.length === 0) return false
  const expected = createHmac("sha256", signingKey)
    .update(`${sig.timestamp}${sig.token}`)
    .digest("hex")
  if (expected.length !== sig.signature.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig.signature, "hex"))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Plan reverse-lookup by recipient
// ---------------------------------------------------------------------------

async function findPlanByRecipient(
  db: Firestore,
  recipient: string,
): Promise<{
  planId?: string
  candidateId?: string
  jobId?: string
  companyId?: string
}> {
  if (!recipient || recipient.length === 0) return {}
  const normalized = recipient.trim().toLowerCase()
  // Find candidate via email handle (normalizedValue is lowercased).
  const handleSnap = await db
    .collection(PA_COLLECTIONS.candidateHandles)
    .where("kind", "==", "email")
    .where("normalizedValue", "==", normalized)
    .limit(1)
    .get()
    .catch(() => null)
  if (!handleSnap || handleSnap.empty) return {}
  const candidateId = (handleSnap.docs[0]!.data() as { candidateId?: string }).candidateId
  if (!candidateId) return {}
  // Find most recent outreach plan for this candidate.
  const planSnap = await db
    .collection(PA_COLLECTIONS.outreachPlans)
    .where("candidateId", "==", candidateId)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get()
    .catch(() => null)
  if (!planSnap || planSnap.empty) return { candidateId }
  const plan = planSnap.docs[0]!.data() as { planId?: string; jobId?: string; companyId?: string }
  return {
    candidateId,
    planId: plan.planId,
    jobId: plan.jobId,
    companyId: plan.companyId,
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleMailgunWebhook(
  req: MailgunWebhookRequest,
  res: MailgunWebhookResponse,
  deps: MailgunWebhookDeps,
): Promise<void> {
  if (req.method && req.method !== "POST") {
    res.status(405).send({ error: "method_not_allowed" })
    return
  }
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const signingKey = (deps.signingKey ?? "").trim()

  const body = (req.body ?? {}) as MailgunWebhookBody
  const eventData = body["event-data"] ?? {}

  // Signature verify (only when a signing key is configured).
  if (signingKey.length > 0) {
    if (!verifyMailgunSignature(signingKey, body.signature)) {
      logger.warn("external_supply.mailgun_webhook.bad_signature")
      res.status(401).send({ error: "invalid_signature" })
      return
    }
  }

  const kind = mapEventKind(eventData.event)
  if (!kind) {
    res.status(200).json({ ok: true, ignored: eventData.event ?? "" })
    return
  }

  const providerEventId = typeof eventData.id === "string" ? eventData.id : ""
  if (!providerEventId) {
    res.status(200).json({ ok: true, ignored: "missing_event_id" })
    return
  }
  const eventId = createOutreachEventId("mailgun", providerEventId)
  const eventRef = db.collection(PA_COLLECTIONS.outreachEvents).doc(eventId)
  const existing = await eventRef.get()
  if (existing.exists) {
    res.status(200).json({ ok: true, idempotent: true, eventId })
    return
  }

  const recipient = typeof eventData.recipient === "string" ? eventData.recipient : ""
  const planLookup = recipient ? await findPlanByRecipient(db, recipient) : {}
  const occurredAt = (() => {
    if (typeof eventData.timestamp === "number" && Number.isFinite(eventData.timestamp)) {
      return new Date(eventData.timestamp * 1000).toISOString()
    }
    return now()
  })()
  const recordedAt = now()

  const outreachEvent: OutreachEvent = {
    eventId,
    provider: "mailgun",
    providerEventId,
    candidateId: planLookup.candidateId ?? "unknown",
    planId: planLookup.planId ?? "unknown",
    jobId: planLookup.jobId ?? "unknown",
    companyId: planLookup.companyId ?? "unknown",
    kind,
    payloadRedacted: {
      recipientLocalLen: recipient.split("@")[0]?.length ?? 0,
      messageId: eventData.message?.headers?.["message-id"] ?? null,
      mailgunEvent: eventData.event ?? null,
    },
    occurredAt,
    recordedAt,
  }

  await eventRef.set(OutreachEventSchema.parse(outreachEvent), { merge: false })

  // Pair with a generic feedback event so the v1.9 flywheel sees it.
  const feedbackEvent: FeedbackEvent = {
    eventId,
    kind: kind === "email_bounced" || kind === "email_unsubscribed" ? "outreach_delivery" : "outreach_delivery",
    actor: "system",
    candidateId: outreachEvent.candidateId !== "unknown" ? outreachEvent.candidateId : undefined,
    jobId: outreachEvent.jobId !== "unknown" ? outreachEvent.jobId : undefined,
    outcome: kind,
    evidence: [
      {
        source: "instantly_delivery", // existing enum value, repurposed for any email-provider delivery
        summary: `mailgun.${eventData.event ?? "unknown"} for plan ${outreachEvent.planId}`,
      },
    ],
    payloadRedacted: outreachEvent.payloadRedacted,
    createdAt: recordedAt,
  }
  await db
    .collection(PA_COLLECTIONS.feedbackEvents)
    .doc(eventId)
    .set(FeedbackEventSchema.parse(feedbackEvent), { merge: false })

  res.status(200).json({ ok: true, eventId, kind })
}

// ---------------------------------------------------------------------------
// Cloud Function wiring
// ---------------------------------------------------------------------------

export const paExternalSupplyMailgunWebhook = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
    cors: false,
    secrets: [MAILGUN_WEBHOOK_SIGNING_KEY],
  },
  async (req, res) => {
    let signingKey = ""
    try {
      signingKey = MAILGUN_WEBHOOK_SIGNING_KEY.value() ?? ""
    } catch {
      /* secret optional — proceed without verification */
    }
    await handleMailgunWebhook(
      {
        method: req.method,
        headers: req.headers,
        body: req.body,
        rawBody: req.rawBody,
      },
      {
        status: (code) => res.status(code) as unknown as MailgunWebhookResponse,
        json: (b) => res.json(b),
        send: (b) => res.send(b),
      },
      { db: getFirestore(), signingKey },
    )
  },
)
