import type { Firestore } from "firebase-admin/firestore"
import { buildAgentSystemPrompt, getAgentById, getDefaultAgent } from "@pa/agent-registry"
import { hasOpenAICompatKey, runAgentTurn } from "@pa/agent-runtime"
import {
  ImessageInboundPayloadSchema,
  PA_COLLECTIONS,
  type AgentDef,
  type PaInboundEvent,
} from "@pa/core-types"
import {
  appendAuditEvent,
  completeInboundEvent,
  createAgentTurn,
  enqueueOutbound,
  failInboundEvent,
  listClaimableInboundIds,
  setTurnStatus,
  tryClaimInboundEvent,
  updateAgentTurn,
} from "@pa/pa-broker"
import { runConnector, type ConnectorName } from "@pa/pa-connectors"
import {
  appendMessage,
  createProvisionalUser,
  findMessageByIdempotencyKey,
  findUserByParticipant,
  getOrCreateSession,
  normalizeE164,
  normalizeImessageParticipant,
  setOnboardingStatus,
} from "@pa/pa-persistence"
import { checkPromptInjection, enforceRateLimit, filterMemoryWrite } from "@pa/pa-safety"
import {
  afterAssistantTurn,
  isMem0EnvConfigured,
  loadPersonalizationContext,
  loadRecentMessages,
} from "@pa/memory"
import { getPlatformFlags } from "./platform-flags.js"

export type OrchestratorOptions = {
  claimerId: string
  leaseMs?: number
  historyLimit?: number
  batchSize?: number
}

export type OrchestratorDeps = {
  hasOpenAICompatKey: typeof hasOpenAICompatKey
  runAgentTurn: typeof runAgentTurn
}

const defaultDeps: OrchestratorDeps = {
  hasOpenAICompatKey,
  runAgentTurn,
}

export type OrchestratorResult = {
  claimed: number
  completed: number
  failed: number
}

function getImessageSessionExternalId(participant: string, chatId: string): string {
  if (process.env.PA_IMESSAGE_SESSION_KEY === "chatid") return chatId
  return participant.includes("@") ? participant.trim().toLowerCase() : normalizeE164(participant)
}

function requestedConnector(text: string): ConnectorName | null {
  const lower = text.toLowerCase()
  if (lower.includes("fake connector") || lower.includes("fake-echo")) return "fake-echo"
  if (lower.includes("wekruit matching")) return "wekruit-matching"
  if (lower.includes("findx")) return "findx"
  if (lower.includes("score candidate") || lower.includes("scoring")) return "scoring"
  return null
}

function connectorArgs(name: ConnectorName, text: string): unknown {
  if (name === "scoring") return { text }
  return { query: text }
}

function applyConnectorContext(memoryBlock: string | null, result: unknown): string {
  const connectorBlock = `Connector result:\n${JSON.stringify(result, null, 2)}`
  return memoryBlock ? `${memoryBlock}\n\n${connectorBlock}` : connectorBlock
}

async function resolveAgent(db: Firestore, agentId?: string): Promise<AgentDef | null> {
  if (agentId) {
    const explicit = await getAgentById(db, agentId)
    if (explicit) return explicit
  }
  return getDefaultAgent(db)
}

export async function processInboundEvent(
  db: Firestore,
  event: PaInboundEvent,
  deps: OrchestratorDeps = defaultDeps
): Promise<void> {
  const payload = ImessageInboundPayloadSchema.parse(event.rawPayload)
  const text = payload.text.trim()
  if (!text) {
    await completeInboundEvent(db, event.id, {})
    return
  }

  const existingReply = await findMessageByIdempotencyKey(db, `out-${event.idempotencyKey}`)
  if (existingReply) {
    await completeInboundEvent(db, event.id, {
      userId: existingReply.userId,
      sessionId: existingReply.sessionId,
    })
    return
  }

  let user = await findUserByParticipant(db, payload.participant)
  if (!user) {
    user = await createProvisionalUser(db, payload.participant)
    await setOnboardingStatus(db, user.id, "provisional")
  }
  if (user.onboardingStatus === "provisional") {
    await setOnboardingStatus(db, user.id, "active")
    user = { ...user, onboardingStatus: "active" }
  }

  const session = await getOrCreateSession(
    db,
    user.id,
    "imessage",
    getImessageSessionExternalId(payload.participant, payload.chatId)
  )
  const rate = await enforceRateLimit(db, { userId: user.id, channel: "imessage" })
  if (!rate.allow) {
    await appendAuditEvent(db, {
      actor: "orchestrator",
      kind: "safety_block",
      userId: user.id,
      sessionId: session.id,
      inboundEventId: event.id,
      message: `Inbound blocked: ${rate.reason}`,
    })
    await failInboundEvent(db, event.id, rate.reason ?? "rate_limited", { bumpAttempt: false })
    return
  }

  const injection = checkPromptInjection(text)
  if (!injection.allow) {
    await appendAuditEvent(db, {
      actor: "orchestrator",
      kind: "safety_block",
      userId: user.id,
      sessionId: session.id,
      inboundEventId: event.id,
      message: `Inbound blocked: ${injection.reason}`,
      meta: { signals: injection.signals },
    })
    await failInboundEvent(db, event.id, injection.reason ?? "safety_block", { bumpAttempt: false })
    return
  }

  const userMessage = await appendMessage(db, {
    sessionId: session.id,
    userId: user.id,
    role: "user",
    body: text,
    createdAt: new Date().toISOString(),
    idempotencyKey: event.idempotencyKey,
    rawMeta: { source: "imessage", inboundEventId: event.id, messageRowId: payload.messageRowId },
  })

  const agent = await resolveAgent(db, user.activeAgentId)
  if (!agent) {
    throw new Error("No agent configured in pa_agents")
  }
  const flags = await getPlatformFlags(db)
  const effectiveAgent =
    flags.defaultModelOverride && flags.defaultModelOverride.length > 0
      ? { ...agent, model: flags.defaultModelOverride }
      : agent
  const systemPrompt = buildAgentSystemPrompt(effectiveAgent)

  const turn = await createAgentTurn(db, {
    inboundEventId: event.id,
    userId: user.id,
    sessionId: session.id,
    agentId: effectiveAgent.id,
    idempotencyKey: `turn-${event.id}`,
  })
  await setTurnStatus(db, turn.id, "processing")

  const replyId = flags.llmKillSwitch ? `out-${event.idempotencyKey}-kill` : `out-${event.idempotencyKey}`
  const historyBefore = await loadRecentMessages(
    db,
    session.id,
    Number(process.env.PA_MESSAGE_HISTORY || "40")
  )
  const history = historyBefore.filter((m) => m.id !== userMessage.id)

  let reply = "Assistant is temporarily unavailable. Please try again later."
  let memoryBlock: string | null = null
  let toolUseCount = 0
  let replySource: "kill_switch" | "no_openai_key_fallback" | "openai" | "unavailable" = flags.llmKillSwitch
    ? "kill_switch"
    : "unavailable"

  if (!flags.llmKillSwitch) {
    const memory = await loadPersonalizationContext(
      db,
      {
        userId: user.id,
        mem0UserId: user.mem0UserId ?? user.id,
        sessionId: session.id,
        userMessage: text,
        memoryMode: effectiveAgent.memoryMode,
      },
      history
    )
    memoryBlock = memory.memoryBlock
    if (memory.mem0Degraded && effectiveAgent.memoryMode !== "firestore_only") {
      await db.collection(PA_COLLECTIONS.memoryEvents).add({
        kind: "degraded",
        createdAt: new Date().toISOString(),
        userId: user.id,
        mem0UserId: user.mem0UserId ?? user.id,
        message: memory.mem0DegradedReason ?? "mem0 degraded",
      })
    }

    const connectorName = requestedConnector(text)
    if (connectorName) {
      const result = await runConnector(connectorName, connectorArgs(connectorName, text), {
        db,
        agent: effectiveAgent,
        turnId: turn.id,
        userId: user.id,
        sessionId: session.id,
        usedThisTurn: toolUseCount,
      })
      toolUseCount++
      memoryBlock = applyConnectorContext(memoryBlock, result)
    }

    if (!deps.hasOpenAICompatKey()) {
      reply = `收到: ${text}`
      replySource = "no_openai_key_fallback"
    } else {
      const run = await deps.runAgentTurn({
        agent: effectiveAgent,
        systemPrompt,
        memoryBlock,
        history,
        userMessage: text,
      })
      reply = run.text
      replySource = "openai"
    }
  }

  const assistantMessage = await appendMessage(db, {
    id: replyId,
    sessionId: session.id,
    userId: user.id,
    role: "assistant",
    body: reply,
    createdAt: new Date().toISOString(),
    idempotencyKey: replyId,
    rawMeta: {
      inboundEventId: event.id,
      turnId: turn.id,
      replySource,
      provider: effectiveAgent.provider,
      model: effectiveAgent.model,
    },
  })

  const memoryDecision = filterMemoryWrite({ userText: text, assistantText: reply })
  if (memoryDecision.allow) {
    await afterAssistantTurn(db, effectiveAgent, {
      userId: user.id,
      mem0UserId: user.mem0UserId ?? user.id,
      sessionId: session.id,
      userText: text,
      assistantText: reply,
      memoryMode: effectiveAgent.memoryMode,
    })
  } else {
    await appendAuditEvent(db, {
      actor: "orchestrator",
      kind: "memory_filter_block",
      userId: user.id,
      sessionId: session.id,
      turnId: turn.id,
      inboundEventId: event.id,
      message: "Unsafe Mem0 writeback blocked",
      meta: { reason: memoryDecision.reason, signals: memoryDecision.signals },
    })
    await db.collection(PA_COLLECTIONS.memoryEvents).add({
      kind: "filter_block",
      createdAt: new Date().toISOString(),
      userId: user.id,
      mem0UserId: user.mem0UserId ?? user.id,
      message: memoryDecision.reason ?? "unsafe memory write",
      meta: { signals: memoryDecision.signals },
    })
  }

  const out = await enqueueOutbound(db, {
    userId: user.id,
    toE164: normalizeImessageParticipant(payload.participant),
    imessageChatId: payload.chatId,
    body: reply,
    idempotencyKey: replyId,
  })

  await updateAgentTurn(db, turn.id, {
    status: "completed",
    assistantMessageId: assistantMessage.id,
    outboundId: out.id,
    appendStep: {
      at: new Date().toISOString(),
      name: "reply_written_and_outbound_enqueued",
      detail: {
        assistantMessageId: assistantMessage.id,
        outboundId: out.id,
        toolUseCount,
        mem0EnvConfigured: isMem0EnvConfigured(),
        replySource,
        provider: effectiveAgent.provider,
        model: effectiveAgent.model,
      },
    },
  })
  await completeInboundEvent(db, event.id, {
    userId: user.id,
    sessionId: session.id,
    agentTurnId: turn.id,
  })
}

export async function processAvailableInboundEvents(
  db: Firestore,
  opts: OrchestratorOptions,
  deps: OrchestratorDeps = defaultDeps
): Promise<OrchestratorResult> {
  const ids = await listClaimableInboundIds(db, opts.batchSize ?? 10)
  let claimed = 0
  let completed = 0
  let failed = 0
  for (const id of ids) {
    const event = await tryClaimInboundEvent(db, id, {
      claimerId: opts.claimerId,
      leaseMs: opts.leaseMs ?? 5 * 60_000,
    })
    if (!event) continue
    claimed++
    try {
      await processInboundEvent(db, event, deps)
      completed++
    } catch (e) {
      failed++
      const err = e instanceof Error ? e.message : String(e)
      await failInboundEvent(db, event.id, err)
    }
  }
  return { claimed, completed, failed }
}
