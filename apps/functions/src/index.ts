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
import { onRequest } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { setGlobalOptions, logger } from "firebase-functions/v2"
import { initializeApp, getApps } from "firebase-admin/app"
import { getAuth } from "firebase-admin/auth"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  claimAndProcessInboundEvent,
  createFirestoreOrchestratorStore,
  isInboundLeaseExpired,
  processInboundEvent,
} from "@pa/pa-orchestrator"
import { PA_COLLECTIONS, type Channel, type InboundEvent, type OnboardingStatus, type User } from "@pa/core-types"
import { clearUserMemory, recordDriftIfAny, resolveMem0PartitionKey, summarizeClearResult } from "@pa/memory"
import { createHash, randomUUID } from "node:crypto"

if (!getApps().length) initializeApp()

setGlobalOptions({ region: "us-central1" })

const SILICONFLOW_API_KEY = defineSecret("SILICONFLOW_API_KEY")
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const QDRANT_URL = defineSecret("QDRANT_URL")
const QDRANT_API_KEY = defineSecret("QDRANT_API_KEY")
const QDRANT_COLLECTION = "pa_memory"

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
    harness?: {
      runner?: string
      suppressOutbound?: boolean
    }
  }
}

type QdrantPoint = {
  id: string | number
  payload?: Record<string, unknown>
  vector?: unknown
}

type QdrantScrollResponse = {
  result?: {
    points?: QdrantPoint[]
    next_page_offset?: string | number | null
  }
}

function setCors(res: { set: (field: string, value: string) => unknown }) {
  res.set("Access-Control-Allow-Origin", "*")
  res.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
  res.set("Access-Control-Allow-Headers", "Authorization,Content-Type")
  res.set("Access-Control-Max-Age", "3600")
}

function normalizeAdminEmail(email: string | undefined) {
  return email?.trim().toLowerCase() ?? ""
}

function isDashboardAdminEmail(email: string | undefined): boolean {
  const normalized = normalizeAdminEmail(email)
  if (!normalized) return false
  const envAllowlist = (process.env.PA_DASHBOARD_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => normalizeAdminEmail(s))
    .filter(Boolean)
  return normalized.endsWith("@wekruit.com") || normalized === "indolencorlol@gmail.com" || envAllowlist.includes(normalized)
}

async function requireDashboardAdmin(req: { header: (name: string) => string | undefined }) {
  const authz = req.header("authorization") ?? req.header("Authorization") ?? ""
  const match = authz.match(/^Bearer\s+(.+)$/i)
  if (!match) throw Object.assign(new Error("Missing bearer token"), { status: 401 })
  const decoded = await getAuth().verifyIdToken(match[1]!)
  if (!isDashboardAdminEmail(decoded.email)) {
    throw Object.assign(new Error("Forbidden"), { status: 403 })
  }
  return decoded
}

function qdrantHeaders() {
  return { "api-key": QDRANT_API_KEY.value(), "content-type": "application/json" }
}

function qdrantBaseUrl() {
  return QDRANT_URL.value().replace(/\/+$/, "")
}

async function qdrantJson(path: string, init: RequestInit) {
  const resp = await fetch(`${qdrantBaseUrl()}${path}`, {
    ...init,
    headers: { ...qdrantHeaders(), ...(init.headers ?? {}) },
  })
  if (!resp.ok) {
    throw new Error(`Qdrant ${path} failed: ${resp.status} ${await resp.text()}`)
  }
  return resp.json() as Promise<unknown>
}

/**
 * Phase 11.3 kill switch — same semantics as stacked.ts. Default OFF
 * (legacy `userId`-keyed Qdrant) so Deploy 1 is a no-op. Set
 * `PA_MEM0_USE_PARTITION_KEY=true` in Deploy 2 to flip dashboard ops
 * onto the resolved partition.
 */
function partitionSwitchEnabled(): boolean {
  const raw = process.env.PA_MEM0_USE_PARTITION_KEY
  if (typeof raw !== "string") return false
  return raw.trim().toLowerCase() === "true"
}

function qdrantUserFilter(userId: string) {
  return { must: [{ key: "user_id", match: { value: userId } }] }
}

function pointMatchesQuery(point: QdrantPoint, q: string) {
  if (!q) return true
  return JSON.stringify(point.payload ?? {}).toLowerCase().includes(q.toLowerCase())
}

async function listQdrantMemories(userId: string, search: string, limit = 100) {
  const body = {
    filter: qdrantUserFilter(userId),
    limit: Math.min(Math.max(limit, 1), 200),
    with_payload: true,
    with_vector: false,
  }
  const json = await qdrantJson(`/collections/${QDRANT_COLLECTION}/points/scroll`, {
    method: "POST",
    body: JSON.stringify(body),
  }) as QdrantScrollResponse
  return (json.result?.points ?? []).filter((p) => pointMatchesQuery(p, search))
}

async function retrieveQdrantPoint(pointId: string) {
  const json = await qdrantJson(`/collections/${QDRANT_COLLECTION}/points`, {
    method: "POST",
    body: JSON.stringify({ ids: [pointId], with_payload: true, with_vector: false }),
  }) as { result?: QdrantPoint[] }
  return json.result?.[0] ?? null
}

async function deleteQdrantPointForUser(userId: string, pointId: string) {
  const point = await retrieveQdrantPoint(pointId)
  if (!point) throw Object.assign(new Error("Memory point not found"), { status: 404 })
  if (point.payload?.user_id !== userId) throw Object.assign(new Error("Memory point does not belong to user"), { status: 403 })
  await qdrantJson(`/collections/${QDRANT_COLLECTION}/points/delete?wait=true`, {
    method: "POST",
    body: JSON.stringify({ points: [point.id] }),
  })
}

function sendJson(res: { status: (code: number) => { json: (body: unknown) => unknown } }, status: number, body: unknown) {
  res.status(status).json(body)
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
      ...(payload.harness ? { harness: payload.harness } : {}),
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
    secrets: [SILICONFLOW_API_KEY, PA_OPENAI_AGENT_API_KEY, QDRANT_URL, QDRANT_API_KEY],
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
    try {
      const openAiAgentKey = PA_OPENAI_AGENT_API_KEY.value().trim()
      if (openAiAgentKey) {
        process.env.PA_OPENAI_AGENT_API_KEY = openAiAgentKey
      } else {
        delete process.env.PA_OPENAI_AGENT_API_KEY
      }
    } catch {
      delete process.env.PA_OPENAI_AGENT_API_KEY
    }
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
      logger.info("onPaInbound processed", { eventId: data.id, userId: "userId" in data ? data.userId : undefined, processed })
    } catch (err) {
      logger.error("onPaInbound failed", {
        eventId: data.id,
        userId: "userId" in data ? data.userId : undefined,
        err: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  },
)

export const memoryAdmin = onRequest(
  {
    region: "us-central1",
    secrets: [QDRANT_URL, QDRANT_API_KEY],
    memory: "512MiB",
    timeoutSeconds: 120,
    cors: false,
  },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }

    try {
      await requireDashboardAdmin(req)
      const userId = String(req.query.userId ?? req.body?.userId ?? "").trim()
      if (!userId) {
        sendJson(res, 400, { error: "userId is required" })
        return
      }

      // Phase 11.3 — resolve the Mem0/Qdrant partition key. Behind the
      // kill switch (default OFF) all paths still scope on `userId` so
      // dashboard behavior is byte-identical to pre-11.3.
      const db = getFirestore()
      let mem0PartitionKey = userId
      if (partitionSwitchEnabled()) {
        const userSnap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
        if (!userSnap.exists) {
          sendJson(res, 404, { error: "user_not_found", userId })
          return
        }
        const userData = userSnap.data() as Pick<User, "id" | "mem0UserId"> | undefined
        mem0PartitionKey = resolveMem0PartitionKey({
          id: userId,
          mem0UserId: userData?.mem0UserId,
        })
        // Best-effort drift telemetry — never throws.
        if (mem0PartitionKey !== userId) {
          void recordDriftIfAny(
            { userId, mem0UserId: mem0PartitionKey, surface: "memory_admin" },
            { db }
          )
        }
      }

      if (req.method === "GET") {
        const search = String(req.query.q ?? "").trim()
        const limit = Number(req.query.limit ?? "100")
        const points = await listQdrantMemories(mem0PartitionKey, search, Number.isFinite(limit) ? limit : 100)
        sendJson(res, 200, { userId, mem0PartitionKey, collection: QDRANT_COLLECTION, points })
        return
      }

      if (req.method === "DELETE") {
        const pointId = String(req.query.pointId ?? req.body?.pointId ?? "").trim()
        if (!pointId) {
          sendJson(res, 400, { error: "pointId is required" })
          return
        }
        await deleteQdrantPointForUser(mem0PartitionKey, pointId)
        sendJson(res, 200, { userId, mem0PartitionKey, pointId, deleted: true })
        return
      }

      if (req.method === "POST") {
        const action = String(req.body?.action ?? "").trim()
        if (action !== "clear") {
          sendJson(res, 400, { error: "Unsupported action" })
          return
        }
        const result = await clearUserMemory(
          userId,
          {
            db,
            qdrantUrl: QDRANT_URL.value(),
            qdrantApiKey: QDRANT_API_KEY.value(),
            qdrantCollection: QDRANT_COLLECTION,
          },
          {
            keepMessages: req.body?.keepMessages === true,
            dryRun: req.body?.dryRun === true,
            // Only set when the kill switch is on AND the resolved partition
            // diverges from `userId`. When equal, we omit so downstream stays
            // byte-identical to the pre-11.3 path.
            ...(partitionSwitchEnabled() && mem0PartitionKey !== userId
              ? { mem0PartitionKey }
              : {}),
          }
        )
        sendJson(res, 200, { userId, mem0PartitionKey, result, summary: summarizeClearResult(result) })
        return
      }

      sendJson(res, 405, { error: "Method not allowed" })
    } catch (err) {
      const rawStatus = typeof err === "object" && err && "status" in err ? Number((err as { status: unknown }).status) : 500
      const status = Number.isFinite(rawStatus) ? rawStatus : 500
      logger.warn("memoryAdmin failed", { status, error: err instanceof Error ? err.message : String(err) })
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) })
    }
  }
)
