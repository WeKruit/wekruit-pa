/**
 * macOS iMessage worker: channel gateway only.
 * Correctness path is local durable queue -> Firestore inbound queue. `chat.db`
 * scans are startup/manual repair, not a continuous poll loop.
 */
import "dotenv/config"
import { IMessageError, IMessageSDK, type Message } from "@photon-ai/imessage-kit"
import { PA_COLLECTIONS } from "@pa/core-types"
import { getFirebaseApp, getFirestore } from "@pa/firebase-admin"
import type { Firestore } from "firebase-admin/firestore"
import { useDmAllowlist, getPeerDisplay, getPeerAllowlist, isSamePeer } from "./config.js"
import {
  createProvisionalUser,
  findUserByParticipant,
  getImessageSessionExternalId,
  getOrCreateSession,
  setOnboardingStatus,
} from "./persistence.js"
import { buildInboundEventFromMessage, enqueueInboundEvent } from "./inbound.js"
import { getPlatformFlags } from "./platform-flags.js"
import { startOutboundListener } from "./outbox.js"
import {
  getHealthState,
  initHealthConfigFromEnv,
  setHealthFlags,
  startHealthServer,
} from "./health-server.js"
import { getLatestMessageRowId } from "./chat-db.js"
import { ImessageChannelConnector } from "./connectors.js"
import { syncRetryableInbox } from "./inbox-sync.js"
import { openLocalQueue, type LocalInboxRow } from "./local-queue.js"

initHealthConfigFromEnv()
setHealthFlags({ imessageReady: false })

function printDatabaseHelp() {
  console.error(`
[DATABASE] 无法打开 ~/Library/Messages/chat.db
请在 系统设置 → 隐私与安全性 → 完全磁盘访问 中勾选运行本进程的应用。`.trim())
}

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args)
}

let sdk: IMessageSDK
try {
  sdk = new IMessageSDK({ debug: process.env.IMESSAGE_DEBUG === "1" })
  setHealthFlags({ imessageReady: true })
} catch (e) {
  if (e instanceof IMessageError && e.code === "DATABASE") {
    printDatabaseHelp()
    console.error((e as Error).message)
    process.exit(1)
  }
  throw e
}

const localQueue = openLocalQueue()
const ingressConnector = new ImessageChannelConnector(localQueue)
const usePlatform = process.env.USE_PLATFORM_FIREBASE !== "0"
const SEND_WELCOME_ON_START = process.env.PA_SEND_WELCOME_ON_START === "1"
const WELCOME =
  process.env.PA_WELCOME_TEXT || "[pa] Assistant online. Send any message to continue."
const LOCAL_SYNC_RETRY_MS = Number(process.env.PA_LOCAL_SYNC_RETRY_MS || "5000")
const REPAIR_LIMIT = Number(process.env.PA_IMESSAGE_REPAIR_LIMIT || "500")
const DISCOVERY_CURSOR = "chatdb:lastDiscoveredRowId"

let db: Firestore | null = null
if (usePlatform) {
  try {
    db = getFirestore(getFirebaseApp())
    setHealthFlags({ firebase: true })
    log("[firebase] connected")
  } catch (e) {
    log("[firebase] init failed, echo-only mode:", e)
  }
} else {
  log("[config] USE_PLATFORM_FIREBASE=0 - echo-only, no Firestore")
}

if (db) {
  startOutboundListener(db, sdk, log, localQueue)
  setHealthFlags({ outboundListener: true })
  log("[outbox] Firestore listener started")
}

const health = getHealthState()
if (health.port > 0) {
  startHealthServer()
}

function localRowToMessage(row: LocalInboxRow): Message {
  return {
    rowId: row.rowId,
    id: row.guid,
    text: row.text,
    participant: row.participant,
    isFromMe: false,
    chatKind: "dm",
    chatId: row.chatId ?? `iMessage;-;${row.participant}`,
  } as Message
}

async function syncLocalInboxToFirestore() {
  if (!db) return
  const firestore = db
  await syncRetryableInbox(
    localQueue,
    async (row) => {
      const from = row.participant
      const text = row.text.trim()
      if (useDmAllowlist() && !getPeerAllowlist().some((peer) => isSamePeer(from, peer))) {
        throw new Error("sender blocked by IMESSAGE_DM_ALLOWLIST")
      }
      if (!text) {
        throw new Error("empty message text")
      }

      const platformFlags = await getPlatformFlags(firestore)
      if (process.env.PA_LLM_KILL_SWITCH === "1" || platformFlags.llmKillSwitch) {
        throw new Error("LLM kill switch active")
      }

      let user = await findUserByParticipant(firestore, from)
      if (!user) {
        user = await createProvisionalUser(firestore, from)
        await setOnboardingStatus(firestore, user.id, "provisional")
        log("[user] provisional", user.id)
      }
      if (user.onboardingStatus === "provisional" && text.length > 0) {
        await setOnboardingStatus(firestore, user.id, "active")
      }

      const chatId = row.chatId ?? `iMessage;-;${row.participant}`
      const session = await getOrCreateSession(
        firestore,
        user.id,
        "imessage",
        getImessageSessionExternalId(from, chatId)
      )

      const event = buildInboundEventFromMessage({
        msg: localRowToMessage(row),
        userId: user.id,
        sessionId: session.id,
        externalChatId: session.externalChatId,
        createdAt: row.firstSeenAt,
      })
      const created = await enqueueInboundEvent(firestore, event)
      log("[inbound]", created ? "queued" : "duplicate", event.id, "row=", row.rowId, "user=", user.id, "session=", session.id)
      return event.id
    },
    { log }
  )
}

async function reconcileProcessedLocalInbox() {
  if (!db) return
  const firestore = db
  const rows = localQueue.listEnqueuedInbox(50)
  for (const row of rows) {
    if (!row.eventId) continue
    try {
      const snap = await firestore.collection(PA_COLLECTIONS.inboundEvents).doc(row.eventId).get()
      const status = snap.exists ? (snap.data() as { status?: string } | undefined)?.status : undefined
      if (status === "succeeded") {
        localQueue.markInboxProcessed(row.rowId)
      }
    } catch (e) {
      log("[local-inbox] processed reconcile failed", { rowId: row.rowId, eventId: row.eventId, error: e instanceof Error ? e.message : String(e) })
    }
  }
}

async function storeDiscoveredMessage(msg: Message, source: "watcher" | "repair") {
  const row = ingressConnector.storeLocal(msg)
  if (!row) return
  localQueue.setCursor(DISCOVERY_CURSOR, Math.max(localQueue.getCursor(DISCOVERY_CURSOR) ?? 0, row.rowId))
  log("[local-inbox]", source, "stored", row.rowId, row.guid)
  await syncLocalInboxToFirestore()
}

async function runStartupRepairScan() {
  const configuredFromRowRaw = process.env.PA_IMESSAGE_REPAIR_FROM_ROW?.trim()
  const configuredFromRow = configuredFromRowRaw ? Number(configuredFromRowRaw) : NaN
  let fromRow: number
  if (Number.isFinite(configuredFromRow) && configuredFromRow >= 0) {
    fromRow = configuredFromRow
  } else {
    const existing = localQueue.getCursor(DISCOVERY_CURSOR)
    if (existing == null) {
      const latest = getLatestMessageRowId()
      localQueue.setCursor(DISCOVERY_CURSOR, latest)
      log("[repair] initialized discovery cursor", latest)
      return
    }
    fromRow = existing
  }

  const messages = ingressConnector.discover(fromRow, REPAIR_LIMIT)
  if (messages.length === 0) return
  log("[repair] discovered rows", messages.map((m) => m.rowId).join(","))
  for (const msg of messages) {
    await storeDiscoveredMessage(msg, "repair")
  }
}

await runStartupRepairScan().catch((e) => {
  log("[repair] startup scan failed", e)
})

await sdk.startWatching({
  onDirectMessage: (msg) => {
    void storeDiscoveredMessage(msg, "watcher").catch((e) => log("[watcher] store/sync failed", e))
  },
  onError: (err) => {
    log("[watcher error]", err)
  },
})

log(`Watcher running. Allowlist: ${useDmAllowlist() ? getPeerDisplay() : "all DMs"}`)
log(`[local-inbox] Firestore sync retry every ${LOCAL_SYNC_RETRY_MS}ms`)
const syncTimer =
  LOCAL_SYNC_RETRY_MS > 0
    ? setInterval(() => {
        void syncLocalInboxToFirestore()
          .then(() => reconcileProcessedLocalInbox())
          .catch((e) => log("[local-inbox] retry error", e))
      }, LOCAL_SYNC_RETRY_MS)
    : null

const peer = getPeerAllowlist()[0] ?? ""

if (SEND_WELCOME_ON_START && usePlatform && db && peer) {
  try {
    await sdk.send({ to: peer, text: WELCOME })
    log("Welcome sent to", peer)
  } catch (e) {
    if (e instanceof IMessageError) log(`[welcome] ${e.code}: ${e.message}`)
  }
}

process.on("SIGINT", async () => {
  log("closing...")
  if (syncTimer) clearInterval(syncTimer)
  localQueue.close()
  await sdk.close()
  process.exit(0)
})

process.on("SIGTERM", async () => {
  if (syncTimer) clearInterval(syncTimer)
  localQueue.close()
  await sdk.close()
  process.exit(0)
})
