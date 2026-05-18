import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type Channel, type InboundEvent } from "@pa/core-types"

export type RuntimeEventHandoffInput = {
  userId: string
  toE164?: string
  channel?: Channel
  source: string
  eventKind: string
  idempotencyKey: string
  sessionId?: string
  context?: Record<string, unknown>
  requireExistingSession?: boolean
  nowIso?: () => string
}

export type RuntimeEventHandoffResult =
  | { ok: true; eventId: string; sessionId: string; created: boolean }
  | { ok: false; reason: "user_not_routable" | "no_existing_session"; eventId?: string; sessionId?: string }

const NO_SEND_TOKEN = "__NO_SEND__"
const CANDIDATE_DRAFT_CONTEXT_KEYS = new Set([
  "candidateMessage",
  "candidateVisibleMessage",
  "messageBody",
  "messageTemplate",
  "proposedMessage",
  "renderedTemplate",
])

function normalizeE164(phone: string): string {
  const d = phone.replace(/\D/g, "")
  if (phone.trim().startsWith("+")) return `+${d}`
  return d.length === 10 ? `+1${d}` : `+${d}`
}

function sessionDocId(userId: string, channel: Channel, externalChatId: string): string {
  const h = createHash("sha256").update(`${userId}|${channel}|${externalChatId}`).digest("hex")
  return `ses_${h.slice(0, 32)}`
}

function runtimeEventDocId(source: string, eventKind: string, idempotencyKey: string): string {
  const h = createHash("sha256").update(`${source}|${eventKind}|${idempotencyKey}`, "utf8").digest("hex")
  return `runtime_${h.slice(0, 40)}`
}

async function resolveUserPhone(db: Firestore, userId: string): Promise<string> {
  const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
  if (!snap.exists) return ""
  const data = snap.data() as { phoneE164?: string; phone?: string } | undefined
  const raw = data?.phoneE164 ?? data?.phone ?? ""
  return typeof raw === "string" && raw.trim() ? normalizeE164(raw) : ""
}

export function sanitizeRuntimeEventContext(
  context: Record<string, unknown> | undefined
): { context: Record<string, unknown>; removedDraftKeys: string[] } {
  if (!context || Object.keys(context).length === 0) return { context: {}, removedDraftKeys: [] }
  const removedDraftKeys: string[] = []
  const sanitize = (value: unknown, path: string): unknown => {
    if (!value || typeof value !== "object") return value
    if (Array.isArray(value)) return value.map((item, index) => sanitize(item, `${path}[${index}]`))
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key
      if (CANDIDATE_DRAFT_CONTEXT_KEYS.has(key)) {
        removedDraftKeys.push(childPath)
        continue
      }
      out[key] = sanitize(child, childPath)
    }
    return out
  }
  return {
    context: sanitize(context, "") as Record<string, unknown>,
    removedDraftKeys,
  }
}

function compactContext(context: Record<string, unknown> | undefined): string {
  const sanitized = sanitizeRuntimeEventContext(context).context
  if (Object.keys(sanitized).length === 0) return "{}"
  try {
    return JSON.stringify(sanitized).slice(0, 2500)
  } catch {
    return "{}"
  }
}

export function buildRuntimeEventBody(input: Pick<RuntimeEventHandoffInput, "source" | "eventKind" | "context">): string {
  return [
    `[system-event:${input.source}:${input.eventKind}]`,
    "An external product event arrived. Decide whether Claire should send the candidate a message now.",
    `If no candidate-facing message should be sent, reply exactly ${NO_SEND_TOKEN}.`,
    "If a message should be sent, write only that message. Keep the candidate's established language and context; do not expose internal event ids or system wording.",
    "Do not reuse producer-written candidate copy. Use only the structured facts, the recent conversation, and Claire's runtime policy.",
    `Context: ${compactContext(input.context)}`,
  ].join("\n")
}

export async function enqueueRuntimeEventHandoff(
  db: Firestore,
  input: RuntimeEventHandoffInput
): Promise<RuntimeEventHandoffResult> {
  const now = (input.nowIso ?? (() => new Date().toISOString()))()
  const channel = input.channel ?? "imessage"
  const toE164 = input.toE164?.trim() ? normalizeE164(input.toE164) : await resolveUserPhone(db, input.userId)
  if (!toE164) return { ok: false, reason: "user_not_routable" }

  const sessionId = input.sessionId?.trim() || sessionDocId(input.userId, channel, toE164)
  const sessionRef = db.collection(PA_COLLECTIONS.sessions).doc(sessionId)
  const existingSession = await sessionRef.get()
  if (input.requireExistingSession !== false && !existingSession.exists) {
    return { ok: false, reason: "no_existing_session", sessionId }
  }
  if (!existingSession.exists) {
    await sessionRef.set({
      id: sessionId,
      userId: input.userId,
      channel,
      externalChatId: toE164,
      createdAt: now,
      lastMessageAt: now,
    })
  }

  const eventId = runtimeEventDocId(input.source, input.eventKind, input.idempotencyKey)
  const eventRef = db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId)
  const existingEvent = await eventRef.get()
  if (existingEvent.exists) return { ok: true, eventId, sessionId, created: false }
  const sanitized = sanitizeRuntimeEventContext(input.context)

  const event: InboundEvent = {
    id: eventId,
    userId: input.userId,
    sessionId,
    channel,
    externalChatId: toE164,
    from: toE164,
    body: buildRuntimeEventBody(input),
    status: "pending",
    createdAt: now,
    idempotencyKey: `runtime-event:${input.source}:${input.idempotencyKey}`,
    rawMeta: {
      source: "runtime_event_handoff",
      runtimeEvent: true,
      runtimeEventSource: input.source,
      runtimeEventKind: input.eventKind,
      runtimeNoSendToken: NO_SEND_TOKEN,
      context: sanitized.context,
      ...(sanitized.removedDraftKeys.length > 0
        ? { removedCandidateDraftContextKeys: sanitized.removedDraftKeys }
        : {}),
    },
  }
  await eventRef.set(event)
  return { ok: true, eventId, sessionId, created: true }
}
