/**
 * Cloud Functions Gen 2 wrapper for the PA orchestrator.
 *
 * Topology (Sprint-1 prod):
 *   Mac iMessage worker -> Firestore `pa-inbound-events`
 *   onPaInbound (this file) -> processInboundEvent (`@pa/pa-orchestrator`)
 *     -> SiliconFlow LLM + Qdrant via `@pa/memory` mem0 OSS wrapper
 *     -> Firestore `pa-messages` + `pa-outbound`
 *   Mac iMessage worker -> sends from `pa-outbound`
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

// Phase 21 Sendblue migration
import { handleSendblueWebhook } from "./sendblue/webhook.js"
import { paSendblueOutboxHandler } from "./sendblue/outbox.js"

// Phase 31 — Upstream Event Connector
import { handleUpstreamEventWebhook } from "./upstream-event-webhook.js"

// Phase 22 — proactive check-in sweep
export { paProactiveSweep } from "./proactive-sweep.js"

// Phase 24.5 — admin bootstrap (seed flags via PA_ADMIN_TOKEN, bypass local gcloud ADC)
export { paAdminBootstrap } from "./admin-bootstrap.js"

// Phase 27 T2 — public /health endpoints (one per existing CF). Returns
// {ok, name, version, ts, deps:{firestore, secrets}}. No auth (probes
// must be reachable). All endpoints HTTP 200 always; failure surfaces in body.
import { makeHealthHandler } from "./health.js"

export const paHealthSendblueWebhook = makeHealthHandler({
  name: "paSendblueWebhook",
  requiredSecrets: ["SENDBLUE_WEBHOOK_SIGNING_SECRET"],
})
export const paHealthSendblueOutbox = makeHealthHandler({
  name: "paSendblueOutbox",
  requiredSecrets: ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_SECRET_KEY"],
})
export const paHealthOnPaInbound = makeHealthHandler({
  name: "onPaInbound",
  requiredSecrets: ["SILICONFLOW_API_KEY", "QDRANT_URL", "QDRANT_API_KEY"],
})
export const paHealthProactiveSweep = makeHealthHandler({
  name: "paProactiveSweep",
  requiredSecrets: ["PA_ADMIN_TOKEN"],
})
export const paHealthMemoryAdmin = makeHealthHandler({
  name: "memoryAdmin",
  requiredSecrets: ["QDRANT_URL", "QDRANT_API_KEY"],
})
export const paHealthAdminBootstrap = makeHealthHandler({
  name: "paAdminBootstrap",
  requiredSecrets: ["PA_ADMIN_TOKEN"],
})

if (!getApps().length) initializeApp()

setGlobalOptions({ region: "us-central1" })

// Phase 21 Sendblue secrets — populated via `firebase functions:secrets:set` (D-07)
const SENDBLUE_API_KEY_ID = defineSecret("SENDBLUE_API_KEY_ID")
const SENDBLUE_API_SECRET_KEY = defineSecret("SENDBLUE_API_SECRET_KEY")
const SENDBLUE_WEBHOOK_SIGNING_SECRET = defineSecret("SENDBLUE_WEBHOOK_SIGNING_SECRET")
const SENDBLUE_FROM_NUMBER = defineSecret("SENDBLUE_FROM_NUMBER")

// Phase 31 — Upstream Event Connector HMAC shared secret. Distinct from
// Sendblue secrets so a compromised upstream partner cannot forge inbound
// Sendblue traffic (and vice versa). Set via:
//   echo "$TOKEN" | firebase functions:secrets:set PA_UPSTREAM_HMAC_SECRET --data-file=-
const PA_UPSTREAM_HMAC_SECRET = defineSecret("PA_UPSTREAM_HMAC_SECRET")

const SILICONFLOW_API_KEY = defineSecret("SILICONFLOW_API_KEY")
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const QDRANT_URL = defineSecret("QDRANT_URL")
const QDRANT_API_KEY = defineSecret("QDRANT_API_KEY")
// mem0/Qdrant convention — snake_case (NOT kebab).
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
      ...(payload.messageRowId !== undefined ? { messageRowId: payload.messageRowId } : {}),
      ...(payload.chatId !== undefined ? { chatId: payload.chatId } : {}),
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
    document: "pa-inbound-events/{eventId}",
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
    // Phase 24.5 — read paRateLimitPerUserEnabled (perUser scope) for the
    // event's user. Reading site only — actual enforcement is Phase 26.
    // Telemetry-friendly: logs the resolved value so the rate-limit
    // policy is observable BEFORE we wire enforcement.
    try {
      const { getFlag } = await import("@pa/pa-persistence")
      const userId = "userId" in data ? (data as { userId?: string }).userId : undefined
      const rateLimitEnabled = await getFlag(
        db,
        "paRateLimitPerUserEnabled",
        { userId, env: process.env },
        true
      )
      logger.debug("onPaInbound rate-limit flag", { userId, rateLimitEnabled })
      // Phase 26 T4 — log resolved agent-registry version per inbound for
      // forensic traceability (which prompt/version handled which turn).
      try {
        const { resolveAgentVersion } = await import("@pa/agent-registry")
        const r = await resolveAgentVersion(db, { getFlag: async (k) => String(await getFlag(db, k, { env: process.env }, "")), env: process.env as Record<string, string | undefined> })
        logger.info("onPaInbound agent-version resolved", { source: r.source, version: r.raw, agentId: r.agent?.id })
      } catch (avErr) { logger.warn("onPaInbound agent-version resolve failed", { err: avErr instanceof Error ? avErr.message : String(avErr) }) }
    } catch (flagErr) {
      // Never let a flag read break the inbound path — Phase 26 will
      // enforce; for now flag failures degrade silently.
      logger.warn("onPaInbound flag read failed", {
        eventId: data.id,
        err: flagErr instanceof Error ? flagErr.message : String(flagErr),
      })
    }
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

// =============================================================================
// Phase 21 — Sendblue channel migration (CHANNEL-01, CHANNEL-05)
// =============================================================================

/**
 * paSendblueWebhook — receives Sendblue inbound webhooks (HMAC-verified).
 * Per 21-CONTRACT-NOTES §2 + §3:
 *   - HMAC-SHA256(rawBody) hex; header Sendblue-Signature (+ aliases)
 *   - Subscribes in dashboard to: receive, outbound, typing_indicator, line_blocked
 *   - Idempotent on `sendblue-${message_handle}` (D-02)
 */
export const paSendblueWebhook = onRequest(
  {
    region: "us-central1",
    secrets: [SENDBLUE_WEBHOOK_SIGNING_SECRET],
    // 14MB monolithic bundle + node + firebase-admin + zod ~= 250MB floor; 256Mi
    // OOMed under burst (Phase 40 stress baseline). 512Mi gives safety margin.
    memory: "512MiB",
    timeoutSeconds: 60,
    cors: false,
    // R-05 mitigation: keep at least one warm to stay <30s p95 (CHANNEL-09).
    // Dial up post-cutover if smoke shows cold-start issues.
    minInstances: 1,
  },
  async (req, res) => {
    try {
      await handleSendblueWebhook(
        {
          rawBody: req.rawBody,
          body: req.body,
          headers: req.headers as Record<string, string | string[] | undefined>,
          method: req.method,
          header: (n: string) => req.header(n) ?? undefined,
        },
        {
          status(code: number) {
            res.status(code)
            return this
          },
          json(body: unknown) {
            res.json(body)
            return this
          },
          send(body?: unknown) {
            res.send(body)
            return this
          },
          set(field: string, value: string) {
            return res.set(field, value)
          },
        },
        {
          db: getFirestore(),
          secret: SENDBLUE_WEBHOOK_SIGNING_SECRET.value(),
          log: (...args: unknown[]) => logger.info("[sendblue][webhook]", ...args),
        }
      )
    } catch (err) {
      logger.error("paSendblueWebhook fatal", { error: err instanceof Error ? err.message : String(err) })
      // Sendblue retry policy will redeliver on 5xx — appropriate for unexpected errors.
      if (!res.headersSent) res.status(500).json({ ok: false, error: "internal" })
    }
  }
)

/**
 * paSendblueOutbox — Firestore trigger on pa_outbound writes; POSTs to
 * Sendblue REST. Honors PA_CHANNEL_LEGACY=1 early-return (D-08) for
 * parallel-run rollback safety.
 */
export const paSendblueOutbox = onDocumentCreated(
  {
    document: "pa-outbound/{docId}",
    region: "us-central1",
    secrets: [SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET_KEY, SENDBLUE_FROM_NUMBER],
    // BUG #2 — OOMed at 256Mi when payload contained markdown URLs (Phase 40
    // observed 2026-04-30 on web_search reply). 512Mi keeps a comfortable
    // ceiling for the 14MB bundle + Sendblue REST roundtrip.
    memory: "512MiB",
    timeoutSeconds: 120,
    concurrency: 1,
  },
  async (event) => {
    // Bind secrets into env so sendblue-client reads them without prop-drilling.
    process.env.SENDBLUE_API_KEY_ID = SENDBLUE_API_KEY_ID.value()
    process.env.SENDBLUE_API_SECRET_KEY = SENDBLUE_API_SECRET_KEY.value()
    try {
      const fromNumber = SENDBLUE_FROM_NUMBER.value().trim()
      if (fromNumber) process.env.SENDBLUE_FROM_NUMBER = fromNumber
    } catch {
      // SENDBLUE_FROM_NUMBER is optional on paid lines.
    }

    const { sendImessage } = await import("./sendblue/sendblue-client.js")
    const { sendTypingIndicator } = await import("./sendblue/typing-indicator.js")
    const { appendMessage, getOrCreateSession, getUser } = await import("@pa/pa-persistence")

    const data = event.data?.data() as Record<string, unknown> | undefined
    if (!data) {
      logger.warn("paSendblueOutbox fired without data", { docId: event.params.docId })
      return
    }

    await paSendblueOutboxHandler(
      {
        params: { docId: event.params.docId },
        data: { data: () => data, id: event.params.docId },
      },
      {
        db: getFirestore(),
        sendblueClient: { sendImessage, sendTypingIndicator },
        log: (...args: unknown[]) => logger.info("[sendblue][outbox]", ...args),
        appendMessage,
        getOrCreateSession,
        getUser,
      }
    )
  }
)

// =============================================================================
// Stream A — Tapback → matching-feedback CF (BUG #6 sister-feature)
// =============================================================================
//
// Trigger: onDocumentCreated("pa-tapback-events/{id}"). Reads the tapback
// row, looks up Claire's recent outbound for that user, extracts mentioned
// jobIds, writes one matching-feedback row per jobId. See
// src/job-rec/match-feedback.ts for the matching heuristic.

export const paOnTapbackEvent = onDocumentCreated(
  {
    document: "pa-tapback-events/{id}",
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
    concurrency: 1,
  },
  async (event) => {
    const snap = event.data
    if (!snap) {
      logger.warn("paOnTapbackEvent fired without snapshot", { id: event.params.id })
      return
    }
    const data = snap.data() as
      | {
          userId?: string
          fromNumber?: string
          kind?: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question"
          quotedText?: string
        }
      | undefined
    if (!data || !data.userId || !data.kind || !data.quotedText) {
      logger.warn("paOnTapbackEvent skipping malformed row", { id: event.params.id })
      return
    }
    try {
      const { processTapbackForFeedback } = await import("./job-rec/match-feedback.js")
      const result = await processTapbackForFeedback(getFirestore(), {
        userId: data.userId,
        fromNumber: data.fromNumber,
        kind: data.kind,
        quotedText: data.quotedText,
      })
      logger.info("paOnTapbackEvent processed", {
        id: event.params.id,
        kind: data.kind,
        written: result.written,
        jobIds: result.jobIds,
      })
    } catch (err) {
      logger.error("paOnTapbackEvent failed", {
        id: event.params.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
)

// =============================================================================
// Phase 31 — Upstream Event Connector
// =============================================================================
//
// External partners POST signed events to /paUpstreamEventWebhook. The
// handler verifies HMAC, looks up a matching template, gates on the
// `upstreamConnectorEnabled` flag, applies a per-(template,user) hourly
// rate limit, renders the template, and enqueues `pa-outbound`. The
// existing paSendblueOutbox CF then sends the message via Sendblue.

export const paUpstreamEventWebhook = onRequest(
  {
    region: "us-central1",
    secrets: [PA_UPSTREAM_HMAC_SECRET],
    // Same bundle floor as sendblue webhook — 256Mi too tight under burst.
    memory: "512MiB",
    timeoutSeconds: 60,
    cors: false,
  },
  async (req, res) => {
    try {
      await handleUpstreamEventWebhook(
        {
          rawBody: req.rawBody,
          body: req.body,
          headers: req.headers as Record<string, string | string[] | undefined>,
          method: req.method,
          header: (n: string) => req.header(n) ?? undefined,
        },
        {
          status(code: number) {
            res.status(code)
            return this
          },
          json(body: unknown) {
            res.json(body)
            return this
          },
        },
        {
          db: getFirestore(),
          secret: PA_UPSTREAM_HMAC_SECRET.value(),
          log: (...args: unknown[]) => logger.info("[upstream-webhook]", ...args),
        }
      )
    } catch (err) {
      logger.error("paUpstreamEventWebhook fatal", {
        error: err instanceof Error ? err.message : String(err),
      })
      if (!res.headersSent) res.status(500).json({ ok: false, error: "internal" })
    }
  }
)

export const paHealthUpstreamEventWebhook = makeHealthHandler({
  name: "paUpstreamEventWebhook",
  requiredSecrets: ["PA_UPSTREAM_HMAC_SECRET"],
})

