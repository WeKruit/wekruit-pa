/**
 * Tool: sendImessage
 *
 * Hand off a candidate-visible message request to Claire runtime by writing
 * a synthetic `pa-inbound-events` doc. The runtime decides whether/how to
 * message and is the only path allowed to create sendable `pa-outbound` rows.
 *
 * This tool never writes sendable transport rows directly.
 *
 * Idempotency: derived from `(userId, context)` so retries of the cron
 * path don't double-send the same job recs. Caller can pass an explicit
 * key (preferred for cron — `${userId}-${YYYYMMDD}-batch`).
 */

import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { tool } from "@openai/agents"
import { PA_COLLECTIONS, type Channel, type InboundEvent, type User } from "@pa/core-types"
import { SendImessageInputSchema, type SendImessageOutput } from "../types.js"

export type SendImessageDeps = {
  db: Firestore
  nowIso?: () => string
  /**
   * Phone resolver — production wires `getUser` from `@pa/pa-persistence`;
   * tests inject a fixed lookup.
   */
  getUser?: (db: Firestore, userId: string) => Promise<Pick<User, "id" | "phoneE164" | "channels"> | null>
  log?: (...args: unknown[]) => void
}

function defaultLog(..._args: unknown[]): void {
  /* swallow */
}

async function defaultGetUser(
  db: Firestore,
  userId: string
): Promise<Pick<User, "id" | "phoneE164" | "channels"> | null> {
  const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
  if (!snap.exists) return null
  const data = snap.data() as Partial<User> | undefined
  if (!data) return null
  return {
    id: userId,
    phoneE164: data.phoneE164 ?? "",
    channels: data.channels,
  } as Pick<User, "id" | "phoneE164" | "channels">
}

export type SendImessageArgs = {
  userId: string
  context: Record<string, unknown>
  /**
   * Optional caller-supplied idempotency key — used by the daily cron to
   * dedupe per-day batches. When omitted we hash context as a fallback.
   */
  idempotencyKey?: string
  /** Optional sessionId (links to pa-sessions for analytics). */
  sessionId?: string
}

const CANDIDATE_DRAFT_CONTEXT_KEYS = new Set([
  "candidateMessage",
  "candidateVisibleMessage",
  "content",
  "composedRecommendationMessage",
  "messageBody",
  "messageTemplate",
  "proposedMessage",
  "renderedTemplate",
  "sourceNotes",
])

function sanitizeRuntimeContext(context: Record<string, unknown>): {
  context: Record<string, unknown>
  removedDraftKeys: string[]
} {
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
  return { context: sanitize(context, "") as Record<string, unknown>, removedDraftKeys }
}

function compactContext(context: Record<string, unknown>): string {
  const sanitized = sanitizeRuntimeContext(context).context
  try {
    return JSON.stringify(sanitized).slice(0, 2500)
  } catch {
    return "{}"
  }
}

function deriveIdempotencyKey(userId: string, context: Record<string, unknown>): string {
  return createHash("sha1").update(`${userId}|${compactContext(context)}`).digest("hex")
}

function sessionDocId(userId: string, channel: Channel, externalChatId: string): string {
  const h = createHash("sha256").update(`${userId}|${channel}|${externalChatId}`).digest("hex")
  return `ses_${h.slice(0, 32)}`
}

function runtimeEventDocId(idempotencyKey: string): string {
  const h = createHash("sha256").update(`job-rec|${idempotencyKey}`, "utf8").digest("hex")
  return `runtime_${h.slice(0, 40)}`
}

function buildRuntimeEventBody(context: Record<string, unknown>): string {
  return [
    "[system-event:job_rec:send_imessage]",
    "A job recommendation/outbound request was produced by a non-runtime job-rec component.",
    "Decide whether Claire should message the candidate now. If no message should be sent, reply exactly __NO_SEND__.",
    "If a message should be sent, write it as Claire from scratch in English. Do not use Chinese or producer-written wording.",
    "Include job links and requirements when they appear in the structured context.",
    `Context: ${compactContext(context)}`,
  ].join("\n")
}

export async function sendImessage(
  args: SendImessageArgs,
  deps: SendImessageDeps
): Promise<SendImessageOutput> {
  const parsed = SendImessageInputSchema.parse({ userId: args.userId, context: args.context })
  const log = deps.log ?? defaultLog
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())
  const getUser = deps.getUser ?? defaultGetUser

  const user = await getUser(deps.db, parsed.userId)
  if (!user || !user.phoneE164) {
    log("[sendImessage] user_not_found_or_no_phone", { userId: parsed.userId })
    return { ok: false }
  }

  const idempotencyKey = args.idempotencyKey ?? deriveIdempotencyKey(parsed.userId, parsed.context)
  const id = runtimeEventDocId(idempotencyKey)
  const createdAt = nowIso()
  const sessionId = args.sessionId ?? sessionDocId(parsed.userId, "imessage", user.phoneE164)
  const sessionSnap = await deps.db.collection(PA_COLLECTIONS.sessions).doc(sessionId).get()
  if (!sessionSnap.exists) {
    log("[sendImessage] runtime_handoff_blocked_no_existing_session", {
      userId: parsed.userId,
      sessionId,
    })
    return { ok: false }
  }
  const existing = await deps.db.collection(PA_COLLECTIONS.inboundEvents).doc(id).get()
  if (existing.exists) {
    log("[sendImessage] runtime_dedup_hit", { userId: parsed.userId, idempotencyKey, prevId: id })
    return { ok: true, messageHandle: id, runtimeEventId: id }
  }
  const sanitized = sanitizeRuntimeContext(parsed.context)

  const event: InboundEvent = {
    id,
    userId: parsed.userId,
    sessionId,
    channel: "imessage",
    externalChatId: user.phoneE164,
    from: user.phoneE164,
    body: buildRuntimeEventBody(parsed.context),
    status: "pending",
    createdAt,
    idempotencyKey: `runtime-event:job-rec:${idempotencyKey}`,
    rawMeta: {
      source: "runtime_event_handoff",
      runtimeEvent: true,
      runtimeEventSource: "job_rec",
      runtimeEventKind: "send_imessage",
      runtimeNoSendToken: "__NO_SEND__",
      preferredLanguage: "en",
      context: sanitized.context,
      ...(sanitized.removedDraftKeys.length > 0
        ? { removedCandidateDraftContextKeys: sanitized.removedDraftKeys }
        : {}),
    },
  }

  await deps.db
    .collection(PA_COLLECTIONS.inboundEvents)
    .doc(id)
    .set(event as unknown as Record<string, unknown>)

  log("[sendImessage] runtime_event_enqueued", { userId: parsed.userId, id, idempotencyKey })
  return { ok: true, messageHandle: id, runtimeEventId: id }
}

export function createSendImessageTool(deps: SendImessageDeps) {
  return tool({
    name: "sendImessage",
    description:
      "Request a candidate iMessage through Claire runtime. This writes a " +
      "synthetic pa-inbound-events handoff; it does not create sendable pa-outbound directly.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: SendImessageInputSchema as any,
    execute: async (raw: unknown) => {
      const args = SendImessageInputSchema.parse(raw)
      const out = await sendImessage(args, deps)
      return JSON.stringify(out)
    },
  })
}
