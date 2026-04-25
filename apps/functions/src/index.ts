/**
 * Cloud Functions Gen 2 wrapper for the PA orchestrator.
 *
 * Topology (Sprint-1 prod):
 *   Mac iMessage worker -> Firestore `pa_inbound_events`
 *   onPaInbound (this file) -> processInboundEvent (`@pa/pa-orchestrator`)
 *     -> SiliconFlow LLM + Qdrant via `@pa/memory` mem0 OSS wrapper
 *     -> Firestore `pa_messages` + `pa_outbound`
 *   Mac iMessage worker -> sends from `pa_outbound`
 *
 * The function is idempotent: pa-orchestrator skips events already in a non-
 * `pending` status, and message writes are guarded by `idempotencyKey`.
 */
import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { defineSecret } from "firebase-functions/params"
import { setGlobalOptions, logger } from "firebase-functions/v2"
import { initializeApp, getApps } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  claimAndProcessInboundEvent,
  createFirestoreOrchestratorStore,
  isInboundLeaseExpired,
  processInboundEvent,
} from "@pa/pa-orchestrator"
import { PA_COLLECTIONS, type Channel, type InboundEvent, type OnboardingStatus, type User } from "@pa/core-types"
import { createHash, randomUUID } from "node:crypto"

if (!getApps().length) initializeApp()

setGlobalOptions({ region: "us-central1" })

const SILICONFLOW_API_KEY = defineSecret("SILICONFLOW_API_KEY")
const QDRANT_URL = defineSecret("QDRANT_URL")
const QDRANT_API_KEY = defineSecret("QDRANT_API_KEY")

type BrokerImessageEvent = {
  id: string
  status?: string
  idempotencyKey: string
  createdAt: string
  leaseUntil?: string
  rawPayload?: {
    kind?: string
    participant?: string
    chatId?: string
    messageRowId?: number
    text?: string
  }
}

function nowIso() {
  return new Date().toISOString()
}

function normalizeE164(phone: string): string {
  const d = phone.replace(/\D/g, "")
  if (phone.trim().startsWith("+")) return `+${d}`
  return d.length === 10 ? `+1${d}` : `+${d}`
}

function normalizeImessageParticipant(participant: string): string {
  const value = participant.trim()
  if (!value) return ""
  if (value.includes("@")) return value.toLowerCase()
  return normalizeE164(value)
}

function sessionDocId(userId: string, channel: Channel, externalChatId: string): string {
  const h = createHash("sha256").update(`${userId}|${channel}|${externalChatId}`).digest("hex")
  return `ses_${h.slice(0, 32)}`
}

async function findUserByParticipant(db: Firestore, participant: string): Promise<User | null> {
  const n = normalizeImessageParticipant(participant)
  if (!n) return null
  const query = n.includes("@")
    ? db.collection(PA_COLLECTIONS.users).where("channels.imessageHandle", "==", n)
    : db.collection(PA_COLLECTIONS.users).where("phoneE164", "==", n)
  const snap = await query.limit(1).get()
  if (snap.empty) return null
  const d = snap.docs[0]!
  return { id: d.id, ...d.data() } as User
}

async function createProvisionalUser(db: Firestore, participant: string): Promise<User> {
  const id = randomUUID()
  const n = normalizeImessageParticipant(participant)
  const u: User = {
    id,
    phoneE164: n,
    createdAt: nowIso(),
    onboardingStatus: "provisional" as OnboardingStatus,
    channels: { imessageHandle: n },
  }
  await db.collection(PA_COLLECTIONS.users).doc(id).set(u)
  return u
}

async function getOrCreateSession(
  db: Firestore,
  userId: string,
  channel: Channel,
  externalChatId: string
): Promise<{ id: string; userId: string; externalChatId: string; channel: Channel }> {
  const id = sessionDocId(userId, channel, externalChatId)
  const ref = db.collection(PA_COLLECTIONS.sessions).doc(id)
  const existing = await ref.get()
  if (existing.exists) {
    const d = existing.data()!
    return { id, userId, externalChatId, channel, ...d } as {
      id: string
      userId: string
      externalChatId: string
      channel: Channel
    }
  }
  await ref.set({ id, userId, channel, externalChatId, createdAt: nowIso(), lastMessageAt: nowIso() })
  return { id, userId, externalChatId, channel }
}

function isBrokerImessageEvent(data: InboundEvent | BrokerImessageEvent): data is BrokerImessageEvent {
  return (data as BrokerImessageEvent).rawPayload?.kind === "imessage"
}

async function claimBrokerEvent(db: Firestore, data: BrokerImessageEvent): Promise<BrokerImessageEvent | null> {
  const ref = db.collection(PA_COLLECTIONS.inboundEvents).doc(data.id)
  const now = new Date()
  const claimedAt = now.toISOString()
  const leaseUntil = new Date(now.getTime() + 120_000).toISOString()
  return db.runTransaction(async (t) => {
    const snap = await t.get(ref)
    if (!snap.exists) return null
    const raw = { id: snap.id, ...snap.data() } as BrokerImessageEvent
    const status = raw.status
    if (
      status &&
      status !== "pending" &&
      status !== "failed" &&
      !(status === "running" && isInboundLeaseExpired(raw.leaseUntil, now)) &&
      !(status === "processing" && isInboundLeaseExpired(raw.leaseUntil, now))
    ) {
      return null
    }
    t.set(ref, { status: "running", claimedAt, leaseUntil, startedAt: claimedAt, updatedAt: claimedAt }, { merge: true })
    return { ...raw, status: "running", claimedAt, leaseUntil }
  })
}

async function processBrokerImessageEvent(db: Firestore, data: BrokerImessageEvent): Promise<number> {
  const claimed = await claimBrokerEvent(db, data)
  if (!claimed) return 0
  const payload = claimed.rawPayload
  if (!payload?.participant || !payload.text || !payload.chatId) {
    throw new Error("Invalid broker iMessage payload")
  }
  let user = await findUserByParticipant(db, payload.participant)
  if (!user) {
    user = await createProvisionalUser(db, payload.participant)
  }
  if (user.onboardingStatus === "provisional") {
    await db.collection(PA_COLLECTIONS.users).doc(user.id).set({ onboardingStatus: "active", updatedAt: nowIso() }, { merge: true })
  }
  const externalChatId = normalizeImessageParticipant(payload.participant)
  const session = await getOrCreateSession(db, user.id, "imessage", externalChatId)
  const event: InboundEvent = {
    id: claimed.id,
    userId: user.id,
    sessionId: session.id,
    channel: "imessage",
    externalChatId,
    from: payload.participant,
    body: payload.text.trim(),
    status: "pending",
    createdAt: claimed.createdAt,
    idempotencyKey: claimed.idempotencyKey,
    rawMeta: {
      source: "imessage_broker",
      messageRowId: payload.messageRowId,
      chatId: payload.chatId,
      brokerEventId: claimed.id,
    },
  }
  await db.collection(PA_COLLECTIONS.inboundEvents).doc(claimed.id).set(
    { userId: user.id, sessionId: session.id, externalChatId, from: payload.participant, body: payload.text.trim() },
    { merge: true }
  )
  await processInboundEvent(event, createFirestoreOrchestratorStore(db))
  return 1
}

export const onPaInbound = onDocumentCreated(
  {
    document: "pa_inbound_events/{eventId}",
    region: "us-central1",
    secrets: [SILICONFLOW_API_KEY, QDRANT_URL, QDRANT_API_KEY],
    memory: "1GiB",
    timeoutSeconds: 300,
    concurrency: 1,
  },
  async (event) => {
    const snap = event.data
    if (!snap) {
      logger.warn("onPaInbound fired without snapshot", { eventId: event.params.eventId })
      return
    }
    const data = snap.data() as (InboundEvent | BrokerImessageEvent) | undefined
    if (!data) {
      logger.warn("onPaInbound fired without data", { eventId: event.params.eventId })
      return
    }
    if (data.status && data.status !== "pending") {
      logger.info("onPaInbound skipping non-pending event", {
        eventId: data.id,
        status: data.status,
      })
      return
    }

    // Re-export secret values into the env so that `@pa/memory` and
    // `@pa/agent-runtime` (which read process.env) pick them up. Cloud
    // Functions Gen 2 maps secrets into env automatically when listed in
    // `secrets`, but we also expose under MEM0_LLM_API_KEY for the OSS path.
    process.env.SILICONFLOW_API_KEY = SILICONFLOW_API_KEY.value()
    process.env.QDRANT_URL = QDRANT_URL.value()
    process.env.QDRANT_API_KEY = QDRANT_API_KEY.value()
    if (!process.env.OPENAI_API_KEY) {
      // agent-runtime's OpenAI-compatible client points at SiliconFlow.
      process.env.OPENAI_API_KEY = SILICONFLOW_API_KEY.value()
    }
    const siliconflowBase = "https://api.siliconflow.cn/v1"
    const trimOr = (v: string | undefined, fallback: string) => {
      const t = v?.trim()
      return t && t.length > 0 ? t.replace(/\/+$/, "") : fallback
    }
    process.env.OPENAI_BASE_URL = trimOr(process.env.OPENAI_BASE_URL, siliconflowBase)
    // mem0ai embedder merge does not fall back to a remote baseURL when unset — empty strings route to OpenAI.com with bge-m3 → 400 invalid model.
    process.env.MEM0_LLM_BASE_URL = trimOr(process.env.MEM0_LLM_BASE_URL, process.env.OPENAI_BASE_URL)
    process.env.MEM0_LLM_MODEL = trimOr(process.env.MEM0_LLM_MODEL, "Qwen/Qwen2.5-72B-Instruct")
    process.env.MEM0_EMBED_MODEL = trimOr(process.env.MEM0_EMBED_MODEL, "BAAI/bge-m3")
    process.env.MEM0_EMBED_DIMS = trimOr(process.env.MEM0_EMBED_DIMS, "1024")

    const db = getFirestore()
    try {
      const processed = isBrokerImessageEvent(data)
        ? await processBrokerImessageEvent(db, data)
        : await claimAndProcessInboundEvent(db, data.id)
      logger.info("onPaInbound processed", { eventId: data.id, userId: data.userId, processed })
    } catch (err) {
      logger.error("onPaInbound failed", {
        eventId: data.id,
        userId: data.userId,
        err: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  },
)
