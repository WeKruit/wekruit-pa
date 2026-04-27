/**
 * macOS iMessage worker: Photon + Firestore + agent-runtime + memory.
 * Set GOOGLE_APPLICATION_CREDENTIALS, OPENAI_API_KEY, optional MEM0_API_KEY.
 * Loads `apps/macos-imessage-worker/.env` when present (dotenv).
 */
import "dotenv/config"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"
import { IMessageError, IMessageSDK, type Message } from "@photon-ai/imessage-kit"
import { getDefaultAgent, getAgentById } from "@pa/agent-registry"
import { hasOpenAICompatKey, hydrateOpenAiFromAtm, runAgentTurn } from "@pa/agent-runtime"
import { getFirebaseApp, getFirestore } from "@pa/firebase-admin"
import {
  afterAssistantTurn,
  isMem0EnvConfigured,
  loadPersonalizationContext,
  loadRecentMessages,
} from "@pa/memory"
import {
  completeInboundEvent,
  createInboundEvent,
  failInboundEvent,
} from "@pa/pa-broker"
import {
  appendMessage,
  createProvisionalUser,
  findUserByParticipant,
  findMessageByIdempotencyKey,
  getOrCreateSession,
  setOnboardingStatus,
} from "@pa/pa-persistence"
import { useDmAllowlist, getPeerDisplay, getPeerAllowlist, isSamePeer } from "./config.js"
import { getImessageSessionExternalId } from "./imessage-session.js"
import { getPlatformFlags } from "./platform-flags.js"
import { deliverOutboundBody, startOutboundListener } from "./outbox.js"
import {
  getWorkerId,
  isCursorDisabled,
  loadWorkerCursor,
  saveWorkerCursor,
} from "./cursor.js"
import {
  getHealthState,
  initHealthConfigFromEnv,
  setHealthFlags,
  startHealthServer,
} from "./health-server.js"
import type { Firestore } from "firebase-admin/firestore"

const require = createRequire(import.meta.url)
const Database = require("better-sqlite3") as new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean }
) => {
  prepare(sql: string): {
    get(...params: unknown[]): { maxRowId?: number | bigint | null } | undefined
    all(...params: unknown[]): unknown[]
  }
  close(): void
}

initHealthConfigFromEnv()
setHealthFlags({ imessageReady: false })

function printDatabaseHelp() {
  console.error(`
[DATABASE] 无法打开 ~/Library/Messages/chat.db
请在 系统设置 → 隐私与安全性 → 完全磁盘访问 中勾选运行本进程的应用。`.trim())
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

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args)
}

const usePlatform = process.env.USE_PLATFORM_FIREBASE !== "0"

let db: Firestore | null = null
if (usePlatform) {
  try {
    db = getFirestore(getFirebaseApp())
    setHealthFlags({ firebase: true })
    log("[firebase] connected")
  } catch (e) {
    log("[firebase] init failed, echo-only mode:", e)
  }
  const atm = await hydrateOpenAiFromAtm()
  if (atm.ok) log("[atm] OpenAI runtime:", atm.reason || "hydrated")
  else if (atm.reason && atm.reason !== "no ATM url or token" && atm.reason !== "disabled") {
    log("[atm] skipped or failed:", atm.reason)
  }
} else {
  log("[config] USE_PLATFORM_FIREBASE=0 — echo-only, no Firestore")
}

if (db) {
  startOutboundListener(db, sdk, log)
  setHealthFlags({ outboundListener: true })
  log("[outbox] Firestore listener started")
}

const health = getHealthState()
if (health.port > 0) {
  startHealthServer()
}
const RECENT = Number(process.env.PA_MESSAGE_HISTORY || "40")
const POLL_MS = Number(process.env.PA_IMESSAGE_POLL_MS || "2000")
const WATCH_MODE = (process.env.PA_IMESSAGE_WATCH_MODE || "poll").trim().toLowerCase()
const SEND_ERROR_REPLIES = process.env.PA_SEND_ERROR_REPLIES === "1"
const SEND_WELCOME_ON_START = process.env.PA_SEND_WELCOME_ON_START === "1"
const WELCOME =
  process.env.PA_WELCOME_TEXT || "[pa] Assistant online. Send any message to continue."
const handledMessageRows = new Set<number>()
const handlingMessageRows = new Set<number>()

function brokerMode(): "legacy" | "shadow" | "primary" {
  const v = (process.env.PA_BROKER_MODE || "legacy").trim().toLowerCase()
  if (v === "shadow" || v === "primary") return v
  return "legacy"
}

async function handleDirectMessage(msg: Message) {
  if (msg.isFromMe) return
  if (handledMessageRows.has(msg.rowId) || handlingMessageRows.has(msg.rowId)) return
  handlingMessageRows.add(msg.rowId)

  try {
    const from = msg.participant
    if (!from) return
    if (useDmAllowlist()) {
      const peers = getPeerAllowlist()
      if (peers.length === 0) {
        log(`[allowlist] DENY (empty list, enforcement on) from=${from} rowId=${msg.rowId}`)
        return
      }
      if (!peers.some((peer) => isSamePeer(from, peer))) {
        log(`[allowlist] DENY (not in list) from=${from} rowId=${msg.rowId}`)
        return
      }
    }
    if (!msg.chatId) {
      log("[skip] no chatId")
      return
    }
    const text = msg.text?.trim() ?? ""
    if (!text) {
      log("[dm] empty; skip")
      return
    }

    const idempotencyKey = `imessage-in-${msg.rowId}`

    if (!db) {
      log(`[echo] ${from}: ${text.slice(0, 120)}`)
      try {
        await sdk.send({ to: msg.chatId, text: `收到: ${text}` })
      } catch (e) {
        if (e instanceof IMessageError) log(`[send error] ${e.code}: ${e.message}`)
        else throw e
      }
      return
    }

    const existingReply = await findMessageByIdempotencyKey(db, `out-${idempotencyKey}`)
    if (existingReply) {
      log("[skip] already completed inbound", idempotencyKey)
      return
    }

    const bm = brokerMode()
    let inboundEventId: string | undefined
    if (bm === "shadow" || bm === "primary") {
      const created = await createInboundEvent(db, {
        channel: "imessage",
        idempotencyKey,
        rawPayload: {
          kind: "imessage",
          participant: from,
          chatId: msg.chatId,
          messageRowId: msg.rowId,
          text,
        },
      })
      inboundEventId = created.id
      log(`[broker] inbound ${created.id} created=${created.created} mode=${bm}`)
      if (bm === "primary") {
        return
      }
    }

    try {
      let user = await findUserByParticipant(db, from)
      if (!user) {
        user = await createProvisionalUser(db, from)
        await setOnboardingStatus(db, user.id, "provisional")
        log("[user] provisional", user.id)
      }

      if (user.onboardingStatus === "provisional" && text.length > 0) {
        await setOnboardingStatus(db, user.id, "active")
      }

      const session = await getOrCreateSession(
        db,
        user.id,
        "imessage",
        getImessageSessionExternalId(from, msg.chatId)
      )
      const createdAt = new Date().toISOString()

      const historyBefore = await loadRecentMessages(db, session.id, RECENT)

      await appendMessage(db, {
        sessionId: session.id,
        userId: user.id,
        role: "user",
        body: text,
        createdAt,
        idempotencyKey,
        rawMeta: { source: "imessage", messageRowId: msg.rowId },
      })

      const agent =
        (user.activeAgentId && (await getAgentById(db, user.activeAgentId))) ||
        (await getDefaultAgent(db))
      if (!agent) {
        await sdk.send({
          to: msg.chatId,
          text: "Service misconfigured: no agent. Check Firestore collection pa_agents.",
        })
        if (bm === "shadow" && inboundEventId) {
          await completeInboundEvent(db, inboundEventId, {
            userId: user.id,
            sessionId: session.id,
          })
        }
        return
      }

      const platformFlags = await getPlatformFlags(db)
      const envKill = process.env.PA_LLM_KILL_SWITCH === "1"
      if (envKill || platformFlags.llmKillSwitch) {
        const sorry = "Assistant is temporarily unavailable. Please try again later."
        const outId = `out-${idempotencyKey}-kill`
        await appendMessage(db, {
          id: outId,
          sessionId: session.id,
          userId: user.id,
          role: "assistant",
          body: sorry,
          createdAt: new Date().toISOString(),
          idempotencyKey: outId,
        })
        await sdk.send({ to: msg.chatId, text: sorry })
        log("[flags] LLM kill switch active")
        if (bm === "shadow" && inboundEventId) {
          await completeInboundEvent(db, inboundEventId, {
            userId: user.id,
            sessionId: session.id,
          })
        }
        return
      }

      const effectiveAgent =
        platformFlags.defaultModelOverride && platformFlags.defaultModelOverride.length > 0
          ? { ...agent, model: platformFlags.defaultModelOverride }
          : agent

      const memMode = effectiveAgent.memoryMode
      const {
        memoryBlock,
        mem0Degraded,
        mem0SearchResultCount,
        mem0DegradedReason,
      } = await loadPersonalizationContext(
        db,
        {
          userId: user.id,
          mem0UserId: user.mem0UserId ?? user.id,
          sessionId: session.id,
          userMessage: text,
          memoryMode: memMode,
        },
        historyBefore
      )
      if (mem0Degraded && memMode !== "firestore_only") {
        log(
          `[memory] mem0Degraded reason=${mem0DegradedReason ?? "unknown"} (mode=${memMode})`
        )
      }

      const history = historyBefore
      if (!hasOpenAICompatKey()) {
        const fallback = `收到: ${text}`
        const outId = `out-${idempotencyKey}`
        await appendMessage(db, {
          id: outId,
          sessionId: session.id,
          userId: user.id,
          role: "assistant",
          body: fallback,
          createdAt: new Date().toISOString(),
          idempotencyKey: outId,
        })
        await sdk.send({ to: msg.chatId, text: fallback })
        if (bm === "shadow" && inboundEventId) {
          await completeInboundEvent(db, inboundEventId, {
            userId: user.id,
            sessionId: session.id,
          })
        }
        return
      }

      const { text: reply } = await runAgentTurn({
        agent: effectiveAgent,
        systemPrompt: effectiveAgent.systemPrompt,
        memoryBlock,
        history,
        userMessage: text,
      })

      const outId = `out-${idempotencyKey}`
      const outAt = new Date().toISOString()
      await appendMessage(db, {
        id: outId,
        sessionId: session.id,
        userId: user.id,
        role: "assistant",
        body: reply,
        createdAt: outAt,
        idempotencyKey: outId,
      })

      const afterMem = await afterAssistantTurn(db, effectiveAgent, {
        userId: user.id,
        mem0UserId: user.mem0UserId ?? user.id,
        sessionId: session.id,
        userText: text,
        assistantText: reply,
        memoryMode: memMode,
      })

      const mem0EnvConfigured = isMem0EnvConfigured()
      log(
        "[memory] turn " +
          JSON.stringify({
            userId: user.id,
            selectedUserId: user.id,
            userActiveAgentId: user.activeAgentId ?? null,
            selectedAgentId: effectiveAgent.id,
            effectiveAgentId: effectiveAgent.id,
            memoryMode: memMode,
            mem0EnvConfigured,
            mem0SearchResultCount,
            mem0Degraded,
            mem0DegradedReason,
            mem0WritebackRan: afterMem.writebackRan,
            mem0WritebackSkipReason: afterMem.writebackSkipReason,
          })
      )

      const deliveryResult = await deliverOutboundBody(sdk, msg.chatId, reply)
      if (deliveryResult.chunkErrorIndex !== undefined) {
        log(
          "[send err] chunk",
          deliveryResult.chunkErrorIndex,
          "failed:",
          deliveryResult.chunkErrorCause
        )
      }
      log(
        "[send] ok assistant len=",
        reply.length,
        " chunks=",
        deliveryResult.chunkPlan?.chunks.length ?? 1,
        " mem0 turn complete user=",
        user.id,
        " agent=",
        effectiveAgent.id
      )
      if (bm === "shadow" && inboundEventId) {
        await completeInboundEvent(db, inboundEventId, {
          userId: user.id,
          sessionId: session.id,
        })
      }
    } catch (e) {
      log("[turn error]", e)
      if (bm === "shadow" && inboundEventId) {
        await failInboundEvent(
          db,
          inboundEventId,
          e instanceof Error ? e.message : String(e)
        )
      }
      if (SEND_ERROR_REPLIES) {
        try {
          await sdk.send({ to: msg.chatId, text: "Sorry — something went wrong. Try again shortly." })
        } catch (sendErr) {
          log("[send err2]", sendErr)
        }
      }
    }
  } finally {
    handlingMessageRows.delete(msg.rowId)
    handledMessageRows.add(msg.rowId)
  }
}

// Always log allowlist state regardless of watch/poll mode — operator must
// see at-a-glance whether the gate is fail-closed (peers listed) or
// explicitly disabled (IMESSAGE_DM_ALLOWLIST=0).
const allowlistOn = useDmAllowlist()
const peerList = getPeerAllowlist()
if (allowlistOn) {
  if (peerList.length === 0) {
    log("[allowlist] ENFORCED but EMPTY — denying ALL inbound + outbound. Set IMESSAGE_PEERS to enable.")
  } else {
    log(`[allowlist] ENFORCED peers=${peerList.length} (${getPeerDisplay()})`)
  }
} else {
  log("[allowlist] DISABLED (IMESSAGE_DM_ALLOWLIST=0) — accepting ALL DMs")
}

if (WATCH_MODE === "watch" || WATCH_MODE === "watch-and-poll") {
  await sdk.startWatching({
    onDirectMessage: handleDirectMessage,
    onError: (err) => {
      log("[watcher error]", err)
    },
  })
  log(`Watcher running.`)
} else {
  log(`Watcher disabled (PA_IMESSAGE_WATCH_MODE=${WATCH_MODE}); using polling fallback`)
}

type PollQuery = Parameters<IMessageSDK["getMessages"]>[0] & {
  sinceRowId?: number
  orderByRowIdAsc?: boolean
}

async function startPollingFallback() {
  if (POLL_MS <= 0) return
  const configuredFromRowRaw = process.env.PA_IMESSAGE_POLL_FROM_ROW?.trim()
  const configuredFromRow = configuredFromRowRaw ? Number(configuredFromRowRaw) : NaN
  const envOverride = Number.isFinite(configuredFromRow) && configuredFromRow >= 0
  const cursorEnabled = !isCursorDisabled() && db !== null
  const workerId = getWorkerId()

  let lastRowId: number
  let cursorSource: "env-override" | "firestore" | "latest" = "latest"
  if (envOverride) {
    lastRowId = configuredFromRow
    cursorSource = "env-override"
  } else if (cursorEnabled) {
    const stored = db ? await loadWorkerCursor(db, workerId) : null
    if (stored) {
      lastRowId = stored.lastRowId
      cursorSource = "firestore"
    } else {
      lastRowId = await getLatestMessageRowId()
    }
  } else {
    lastRowId = await getLatestMessageRowId()
  }
  log(
    `[poll] inbound fallback every ${POLL_MS}ms from row ${lastRowId} ` +
      `source=${cursorSource} worker=${workerId} cursor=${cursorEnabled ? "on" : "off"}`
  )

  let polling = false
  const poll = async () => {
    if (polling) return
    polling = true
    let advanced = false
    try {
      const messages = getDirectMessagesAfterRowId(lastRowId)
      if (messages.length > 0) {
        log("[poll] messages", messages.map((m) => m.rowId).join(","))
      }
      for (const msg of messages) {
        if (msg.rowId > lastRowId) {
          lastRowId = msg.rowId
          advanced = true
        }
        await handleDirectMessage(msg)
      }
    } catch (e) {
      log("[poll] error", e)
    } finally {
      polling = false
    }
    if (advanced && cursorEnabled && db) {
      try {
        await saveWorkerCursor(db, workerId, lastRowId)
        log(`[cursor] saved row=${lastRowId} worker=${workerId}`)
      } catch (e) {
        log("[cursor] save failed", e)
      }
    }
  }

  const interval = setInterval(() => {
    void poll()
  }, POLL_MS)
  void poll()
  process.once("SIGINT", () => clearInterval(interval))
  process.once("SIGTERM", () => clearInterval(interval))
}

async function getLatestMessageRowId(): Promise<number> {
  const chatDb = join(homedir(), "Library/Messages/chat.db")
  const db = new Database(chatDb, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare("SELECT max(ROWID) AS maxRowId FROM message").get()
    const maxRowId = row?.maxRowId
    return typeof maxRowId === "bigint" ? Number(maxRowId) : maxRowId ?? 0
  } finally {
    db.close()
  }
}

function getDirectMessagesAfterRowId(rowId: number): Message[] {
  const chatDb = join(homedir(), "Library/Messages/chat.db")
  const db = new Database(chatDb, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare(
        `
        SELECT
          message.ROWID AS rowId,
          message.guid AS guid,
          message.text AS text,
          handle.id AS participant
        FROM message
        LEFT JOIN handle ON message.handle_id = handle.ROWID
        WHERE message.ROWID > ?
          AND message.is_from_me = 0
          AND handle.id IS NOT NULL
          AND message.text IS NOT NULL
          AND (message.associated_message_type IS NULL OR message.associated_message_type = 0)
        ORDER BY message.ROWID ASC
        LIMIT 100
        `
      )
      .all(rowId) as Array<{
      rowId: number
      guid: string
      text: string
      participant: string
    }>

    return rows.map((row) => ({
      rowId: row.rowId,
      id: row.guid,
      text: row.text,
      participant: row.participant,
      isFromMe: false,
      chatKind: "dm",
      chatId: `iMessage;-;${row.participant}`,
    })) as Message[]
  } finally {
    db.close()
  }
}

await startPollingFallback()

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
  log("closing…")
  await sdk.close()
  process.exit(0)
})

process.on("SIGTERM", async () => {
  await sdk.close()
  process.exit(0)
})
