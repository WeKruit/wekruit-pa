/**
 * Tool: sendImessage
 *
 * Enqueue an outbound iMessage by writing a `pa-outbound` Firestore doc.
 * The existing `paSendblueOutbox` Cloud Function (apps/functions/src/index.ts)
 * picks the doc up via `onDocumentCreated`, talks to Sendblue REST, and
 * marks it sent — we do NOT call Sendblue here. Owner of that path is
 * Stream A; we just produce the same shape the outbox already consumes.
 *
 * The OutboundMessageSchema is the contract (packages/core-types). We
 * write only the fields it requires; everything else (chunkPlan,
 * leaseUntil, etc.) is left for the outbox CF to fill in.
 *
 * Idempotency: derived from `(userId, content)` so retries of the cron
 * path don't double-send the same job recs. Caller can pass an explicit
 * key (preferred for cron — `${userId}-${YYYYMMDD}-batch`).
 */

import { createHash, randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { tool } from "@openai/agents"
import { PA_COLLECTIONS, OutboundMessageSchema, type OutboundMessage, type User } from "@pa/core-types"
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
  content: string
  /**
   * Optional caller-supplied idempotency key — used by the daily cron to
   * dedupe per-day batches. When omitted we hash content as a fallback.
   */
  idempotencyKey?: string
  /** Optional sessionId (links to pa-sessions for analytics). */
  sessionId?: string
}

function deriveIdempotencyKey(userId: string, content: string): string {
  return createHash("sha1").update(`${userId}|${content}`).digest("hex")
}

export async function sendImessage(
  args: SendImessageArgs,
  deps: SendImessageDeps
): Promise<SendImessageOutput> {
  const parsed = SendImessageInputSchema.parse({ userId: args.userId, content: args.content })
  const log = deps.log ?? defaultLog
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())
  const getUser = deps.getUser ?? defaultGetUser

  const user = await getUser(deps.db, parsed.userId)
  if (!user || !user.phoneE164) {
    log("[sendImessage] user_not_found_or_no_phone", { userId: parsed.userId })
    return { ok: false }
  }

  const idempotencyKey = args.idempotencyKey ?? deriveIdempotencyKey(parsed.userId, parsed.content)
  // Short-circuit: if a prior write already used this idempotency key,
  // return ok: true without enqueuing a second copy. This matches the
  // OutboundMessage idempotency contract (the worker treats matching
  // keys as duplicates regardless).
  const existing = await deps.db
    .collection(PA_COLLECTIONS.outbound)
    .where("idempotencyKey", "==", idempotencyKey)
    .limit(1)
    .get()
  if (!existing.empty) {
    const prevId = existing.docs[0]?.id
    log("[sendImessage] dedup_hit", { userId: parsed.userId, idempotencyKey, prevId })
    return { ok: true, messageHandle: prevId }
  }

  const id = randomUUID()
  const createdAt = nowIso()

  // OutboundMessage.imessageChatId is optional and the live User.channels
  // shape (packages/core-types) does NOT carry imessageChatId — only
  // imessageHandle. The outbox CF resolves the chat id via Sendblue
  // session lookup, so omitting here is correct.
  const message: OutboundMessage = {
    id,
    userId: parsed.userId,
    toE164: user.phoneE164,
    body: parsed.content,
    status: "pending",
    createdAt,
    createdBy: "job-rec@wekruit",
    idempotencyKey,
    role: "assistant",
  }
  if (args.sessionId) message.sessionId = args.sessionId

  // Validate against the canonical schema before write — catches contract
  // drift between job-rec and pa-orchestrator.
  OutboundMessageSchema.parse(message)

  await deps.db
    .collection(PA_COLLECTIONS.outbound)
    .doc(id)
    .set(message as unknown as Record<string, unknown>)

  log("[sendImessage] enqueued", { userId: parsed.userId, id, idempotencyKey })
  return { ok: true, messageHandle: id }
}

export function createSendImessageTool(deps: SendImessageDeps) {
  return tool({
    name: "sendImessage",
    description:
      "Enqueue an outbound iMessage to the candidate. Reuses the production " +
      "pa-outbound queue; do NOT call Sendblue REST directly. Use this to " +
      "send a sample job preview during onboarding or daily recs from cron.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: SendImessageInputSchema as any,
    execute: async (raw: unknown) => {
      const args = SendImessageInputSchema.parse(raw)
      const out = await sendImessage(args, deps)
      return JSON.stringify(out)
    },
  })
}
