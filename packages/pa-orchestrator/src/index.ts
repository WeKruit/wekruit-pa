import { randomUUID } from "node:crypto"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import { getAgentById, getDefaultAgent } from "@pa/agent-registry"
import { runAgentTurn as defaultRunAgentTurn, stripLeadingIsoTimestamp } from "@pa/agent-runtime"
import {
  PA_COLLECTIONS,
  type AgentDef,
  type ChatMessage,
  type InboundEvent,
  type MemoryActionType,
  type MemoryFact,
  type OutboundMessage,
  type ProcessingStatus,
  type TurnStage,
} from "@pa/core-types"
import {
  afterAssistantTurn as defaultAfterAssistantTurn,
  createConfirmedMemoryFact,
  findMatchingFacts,
  listConfirmedMemoryFacts,
  loadPersonalizationContext as defaultLoadPersonalizationContext,
  loadRecentMessages,
  markMemoryFactsDeleted,
  parseMemoryCommand,
  recordMemoryAction as defaultRecordMemoryAction,
  shouldRejectMemoryFact,
  type AfterTurnResult,
  type LoadContextResult,
} from "@pa/memory"

type RunAgentTurn = typeof defaultRunAgentTurn

const INBOUND_LEASE_MS = Number(process.env.PA_INBOUND_LEASE_MS || "120000")

export type OrchestratorStore = {
  markEventRunning(eventId: string): Promise<void>
  markEventSucceeded(eventId: string): Promise<void>
  markEventFailed(eventId: string, errorCode: string, error: string): Promise<void>
  createTurn(event: InboundEvent): Promise<string>
  updateTurn(turnId: string, patch: Record<string, unknown>): Promise<void>
  appendMessage(message: Omit<ChatMessage, "id"> & { id?: string }): Promise<void>
  getAgentForUser(userId: string): Promise<AgentDef | null>
  loadHistory(sessionId: string, limit: number): Promise<ChatMessage[]>
  enqueueOutbound(userId: string, toE164: string, body: string, input?: Partial<OutboundMessage>): Promise<void>
  listMemoryFacts(userId: string): Promise<MemoryFact[] | { id: string; content: string }[]>
  createMemoryFact(userId: string, content: string): Promise<string>
  deleteMemoryFacts(userId: string, factIds: string[], eventId?: string): Promise<void>
  recordMemoryAction(input: {
    userId: string
    eventId?: string
    action: MemoryActionType
    status: ProcessingStatus
    content?: string
    factIds?: string[]
    reason?: string
  }): Promise<void>
  loadPersonalizationContext(
    agent: AgentDef,
    input: { userId: string; sessionId: string; userMessage: string; memoryMode: AgentDef["memoryMode"] },
    history: ChatMessage[]
  ): Promise<LoadContextResult>
  runAgentTurn: RunAgentTurn
  afterAssistantTurn(agent: AgentDef, input: {
    userId: string
    sessionId: string
    userText: string
    assistantText: string
    memoryMode: AgentDef["memoryMode"]
  }): Promise<AfterTurnResult>
  nowIso(): string
  log(...args: unknown[]): void
}

const HISTORY_LIMIT = Number(process.env.PA_MESSAGE_HISTORY || "40")

export function isInboundLeaseExpired(leaseUntil: string | undefined, now = new Date()): boolean {
  if (!leaseUntil) return true
  const t = Date.parse(leaseUntil)
  return !Number.isFinite(t) || t <= now.getTime()
}

function memoryReplyForList(facts: { content: string }[]) {
  const unique = uniqueFactsByContent(facts)
  if (unique.length === 0) return "我现在还没有保存你的长期记忆。你可以说：记住 我喜欢..."
  return `我记得这些：\n${unique.map((f, i) => `${i + 1}. ${f.content}`).join("\n")}`
}

function memoryBlockWithFacts(memoryBlock: string | null, facts: { content: string }[]) {
  const unique = uniqueFactsByContent(facts)
  const factBlock = unique.length ? unique.map((f) => `- ${f.content}`).join("\n") : null
  if (memoryBlock && factBlock) return `Confirmed user facts:\n${factBlock}\n\nRelevant memory:\n${memoryBlock}`
  if (factBlock) return `Confirmed user facts:\n${factBlock}`
  return memoryBlock
}

function normalizedFactContent(content: string) {
  return content.trim().replace(/\s+/g, " ")
}

function uniqueFactsByContent<T extends { content: string }>(facts: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const fact of facts) {
    const key = normalizedFactContent(fact.content)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(fact)
  }
  return out
}

async function sendMemoryReply(store: OrchestratorStore, event: InboundEvent, turnId: string, body: string) {
  const at = store.nowIso()
  await store.appendMessage({
    id: `out-${event.id}`,
    sessionId: event.sessionId,
    userId: event.userId,
    role: "assistant",
    body,
    createdAt: at,
    idempotencyKey: `out-${event.id}`,
    rawMeta: { source: "pa_orchestrator", turnId: turnId, eventId: event.id },
  })
  await store.enqueueOutbound(event.userId, event.from, body, {
    sessionId: event.sessionId,
    role: "assistant",
    idempotencyKey: `outbound-${event.id}`,
  })
}

async function handleMemoryCommand(
  event: InboundEvent,
  store: OrchestratorStore,
  turnId: string,
  command: NonNullable<ReturnType<typeof parseMemoryCommand>>
): Promise<boolean> {
  await store.updateTurn(turnId, { stage: "memory_command", updatedAt: store.nowIso() })
  if (command.kind === "remember") {
    const verdict = shouldRejectMemoryFact(command.content)
    if (verdict.reject) {
      await store.recordMemoryAction({
        userId: event.userId,
        eventId: event.id,
        action: "reject_sensitive",
        status: "succeeded",
        content: command.content,
        reason: verdict.reason,
      })
      await sendMemoryReply(store, event, turnId, "这类敏感信息我不能保存为长期记忆。")
      return true
    }
    const existing = (await store.listMemoryFacts(event.userId)).find(
      (fact) => normalizedFactContent(fact.content) === normalizedFactContent(command.content)
    )
    const factId = existing?.id ?? await store.createMemoryFact(event.userId, command.content)
    await store.recordMemoryAction({
      userId: event.userId,
      eventId: event.id,
      action: "remember",
      status: "succeeded",
      content: command.content,
      factIds: [factId],
    })
    await sendMemoryReply(store, event, turnId, `${existing ? "已经记住了" : "记住了"}：${command.content}`)
    return true
  }

  if (command.kind === "list") {
    const facts = await store.listMemoryFacts(event.userId)
    await store.recordMemoryAction({ userId: event.userId, eventId: event.id, action: "list", status: "succeeded" })
    await sendMemoryReply(store, event, turnId, memoryReplyForList(facts))
    return true
  }

  if (command.kind === "forget") {
    const facts = await store.listMemoryFacts(event.userId)
    const matches = findMatchingFacts(facts, command.query)
    if (matches.length === 0) {
      await sendMemoryReply(store, event, turnId, "我没有找到匹配的长期记忆。你可以说：我的记忆。")
      return true
    }
    if (matches.length > 1) {
      await sendMemoryReply(store, event, turnId, `我找到多条匹配记忆，请说得更具体：\n${memoryReplyForList(matches)}`)
      return true
    }
    await store.deleteMemoryFacts(event.userId, [matches[0]!.id], event.id)
    await store.recordMemoryAction({
      userId: event.userId,
      eventId: event.id,
      action: "forget",
      status: "succeeded",
      content: command.query,
      factIds: [matches[0]!.id],
    })
    await sendMemoryReply(store, event, turnId, `已忘记：${matches[0]!.content}`)
    return true
  }

  if (command.kind === "clear_request") {
    await store.recordMemoryAction({ userId: event.userId, eventId: event.id, action: "clear_request", status: "succeeded" })
    await sendMemoryReply(store, event, turnId, "这会删除我保存的所有长期记忆。请回复：确认清空记忆")
    return true
  }

  if (command.kind === "clear_confirm") {
    const facts = await store.listMemoryFacts(event.userId)
    await store.deleteMemoryFacts(event.userId, facts.map((f) => f.id), event.id)
    await store.recordMemoryAction({
      userId: event.userId,
      eventId: event.id,
      action: "clear_confirm",
      status: "succeeded",
      factIds: facts.map((f) => f.id),
    })
    await sendMemoryReply(store, event, turnId, `已清空 ${facts.length} 条长期记忆。`)
    return true
  }

  return false
}

export async function processInboundEvent(event: InboundEvent, store: OrchestratorStore): Promise<void> {
  await store.markEventRunning(event.id)
  const turnId = await store.createTurn(event)
  const at = store.nowIso()
  try {
    await store.appendMessage({
      sessionId: event.sessionId,
      userId: event.userId,
      role: "user",
      body: event.body,
      createdAt: event.createdAt,
      idempotencyKey: event.idempotencyKey,
      rawMeta: { ...event.rawMeta, source: "pa_inbound_event", eventId: event.id, turnId },
    })

    const command = parseMemoryCommand(event.body)
    if (command && await handleMemoryCommand(event, store, turnId, command)) {
      await store.updateTurn(turnId, { status: "succeeded", stage: "succeeded", completedAt: store.nowIso() })
      await store.markEventSucceeded(event.id)
      return
    }

    const agent = await store.getAgentForUser(event.userId)
    if (!agent) throw Object.assign(new Error("No agent configured"), { code: "NO_AGENT" })

    await store.updateTurn(turnId, {
      agentId: agent.id,
      memoryMode: agent.memoryMode,
      stage: "memory_load" satisfies TurnStage,
      updatedAt: store.nowIso(),
    })
    const history = await store.loadHistory(event.sessionId, HISTORY_LIMIT)
    const facts = await store.listMemoryFacts(event.userId)
    const mem = await store.loadPersonalizationContext(
      agent,
      { userId: event.userId, sessionId: event.sessionId, userMessage: event.body, memoryMode: agent.memoryMode },
      history
    )
    await store.updateTurn(turnId, {
      mem0Degraded: mem.mem0Degraded,
      mem0DegradedReason: mem.mem0DegradedReason ?? null,
      mem0SearchResultCount: mem.mem0SearchResultCount,
      stage: "llm" satisfies TurnStage,
      updatedAt: store.nowIso(),
    })
    const { text } = await store.runAgentTurn({
      agent,
      systemPrompt: agent.systemPrompt,
      memoryBlock: memoryBlockWithFacts(mem.memoryBlock, facts),
      history,
      userMessage: event.body,
    })
    // Defense-in-depth: even if the model echoes a [ISO] prefix, strip it
    // before persisting + sending. Root cause is upstream in
    // `toOpenAIMessages` (was prefixing history bodies); this catches stragglers.
    const reply = stripLeadingIsoTimestamp(text.trim()) || "我暂时没有生成有效回复，请稍后再试。"
    const visibleReply =
      mem.mem0Degraded && agent.memoryMode !== "firestore_only"
        ? `${reply}\n\n（长期语义记忆暂时不可用；我仍使用已确认事实和最近对话。）`
        : reply

    await store.appendMessage({
      id: `out-${event.id}`,
      sessionId: event.sessionId,
      userId: event.userId,
      role: "assistant",
      body: visibleReply,
      createdAt: store.nowIso(),
      idempotencyKey: `out-${event.id}`,
      rawMeta: { source: "pa_orchestrator", turnId, eventId: event.id },
    })
    const after = await store.afterAssistantTurn(agent, {
      userId: event.userId,
      sessionId: event.sessionId,
      userText: event.body,
      assistantText: reply,
      memoryMode: agent.memoryMode,
    })
    await store.enqueueOutbound(event.userId, event.from, visibleReply, {
      sessionId: event.sessionId,
      role: "assistant",
      idempotencyKey: `outbound-${event.id}`,
    })
    await store.updateTurn(turnId, {
      status: "succeeded",
      stage: "succeeded",
      completedAt: store.nowIso(),
      mem0WritebackRan: after.writebackRan,
      mem0WritebackSkipReason: after.writebackSkipReason,
    })
    await store.markEventSucceeded(event.id)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    const errorCode = typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "TURN_FAILED"
    store.log("[orchestrator] turn failed", { turnId, eventId: event.id, userId: event.userId, errorCode, error })
    await store.updateTurn(turnId, {
      status: "failed",
      stage: "failed",
      errorCode,
      error,
      completedAt: store.nowIso(),
    })
    await store.markEventFailed(event.id, errorCode, error)
    await sendMemoryReply(store, event, turnId, "Sorry — something went wrong. Try again shortly.")
  }
}

export function createFirestoreOrchestratorStore(db: Firestore): OrchestratorStore {
  const nowIso = () => new Date().toISOString()
  return {
    async markEventRunning(eventId) {
      const now = new Date()
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId).set(
        {
          status: "running",
          startedAt: now.toISOString(),
          updatedAt: now.toISOString(),
          claimedAt: now.toISOString(),
          leaseUntil: new Date(now.getTime() + INBOUND_LEASE_MS).toISOString(),
        },
        { merge: true }
      )
    },
    async markEventSucceeded(eventId) {
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId).set(
        {
          status: "succeeded",
          completedAt: nowIso(),
          updatedAt: nowIso(),
          errorCode: FieldValue.delete(),
          error: FieldValue.delete(),
        },
        { merge: true }
      )
    },
    async markEventFailed(eventId, errorCode, error) {
      await db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId).set(
        { status: "failed", errorCode, error, completedAt: nowIso(), updatedAt: nowIso() },
        { merge: true }
      )
    },
    async createTurn(event) {
      const id = randomUUID()
      await db.collection(PA_COLLECTIONS.turns).doc(id).set({
        id,
        eventId: event.id,
        userId: event.userId,
        sessionId: event.sessionId,
        status: "running",
        stage: "received",
        createdAt: nowIso(),
      })
      return id
    },
    async updateTurn(turnId, patch) {
      await db.collection(PA_COLLECTIONS.turns).doc(turnId).set({ ...patch, updatedAt: nowIso() }, { merge: true })
    },
    async appendMessage(message) {
      const id = message.id ?? randomUUID()
      const idempotencyKey = message.idempotencyKey
      if (idempotencyKey) {
        const existing = await db
          .collection(PA_COLLECTIONS.messages)
          .where("idempotencyKey", "==", idempotencyKey)
          .limit(1)
          .get()
        if (!existing.empty) return
      }
      await db.collection(PA_COLLECTIONS.messages).doc(id).set({ id, ...message })
      await db.collection(PA_COLLECTIONS.sessions).doc(message.sessionId).set(
        { lastMessageAt: message.createdAt },
        { merge: true }
      )
    },
    async getAgentForUser(userId) {
      const u = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      const activeAgentId = (u.data() as { activeAgentId?: string } | undefined)?.activeAgentId
      return (activeAgentId && (await getAgentById(db, activeAgentId))) || (await getDefaultAgent(db))
    },
    async loadHistory(sessionId, limit) {
      return loadRecentMessages(db, sessionId, limit)
    },
    async enqueueOutbound(userId, toE164, body, input) {
      const id = randomUUID()
      const doc: OutboundMessage = {
        id,
        userId,
        toE164,
        body,
        status: "pending",
        createdAt: nowIso(),
        attempts: 0,
        ...(input ?? {}),
      }
      await db.collection(PA_COLLECTIONS.outbound).doc(id).set(doc)
    },
    async listMemoryFacts(userId) {
      return listConfirmedMemoryFacts(db, userId)
    },
    async createMemoryFact(userId, content) {
      return createConfirmedMemoryFact(db, userId, content, "explicit_user")
    },
    async deleteMemoryFacts(userId, factIds, eventId) {
      await markMemoryFactsDeleted(db, userId, factIds, eventId)
    },
    async recordMemoryAction(input) {
      await defaultRecordMemoryAction(db, input)
    },
    async loadPersonalizationContext(_agent, input, history) {
      return defaultLoadPersonalizationContext(db, input, history)
    },
    runAgentTurn: defaultRunAgentTurn,
    async afterAssistantTurn(agent, input) {
      return defaultAfterAssistantTurn(db, agent, input)
    },
    nowIso,
    log: (...args) => console.log(new Date().toISOString(), ...args),
  }
}

export async function processPendingInboundEvents(db: Firestore, limit = 10): Promise<number> {
  const snap = await db
    .collection(PA_COLLECTIONS.inboundEvents)
    .where("status", "==", "pending")
    .orderBy("createdAt", "asc")
    .limit(limit)
    .get()
  let processed = 0
  for (const doc of snap.docs) {
    processed += await claimAndProcessInboundEvent(db, doc.id)
  }
  return processed
}

export async function claimInboundEvent(db: Firestore, eventId: string, now = new Date()): Promise<InboundEvent | null> {
  const ref = db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId)
  return db.runTransaction(async (t) => {
    const snap = await t.get(ref)
    if (!snap.exists) return null
    const raw = snap.data() as InboundEvent & { attempts?: number; leaseUntil?: string }
    if (raw.status !== "pending" && !(raw.status === "running" && isInboundLeaseExpired(raw.leaseUntil, now))) {
      return null
    }
    const claimedAt = now.toISOString()
    const leaseUntil = new Date(now.getTime() + INBOUND_LEASE_MS).toISOString()
    const patch = {
      status: "running" as const,
      attempts: (raw.attempts ?? 0) + 1,
      claimedAt,
      leaseUntil,
      startedAt: raw.startedAt ?? claimedAt,
      updatedAt: claimedAt,
    }
    t.set(ref, patch, { merge: true })
    return { ...raw, ...patch }
  })
}

export async function claimAndProcessInboundEvent(
  db: Firestore,
  eventId: string,
  log: (...args: unknown[]) => void = (...args) => console.log(new Date().toISOString(), ...args)
): Promise<number> {
  const event = await claimInboundEvent(db, eventId)
  if (!event) return 0
  await processInboundEvent(event, createFirestoreOrchestratorStore(db))
  log("[orchestrator] processed", eventId)
  return 1
}

export async function reclaimExpiredInboundEvents(
  db: Firestore,
  log: (...args: unknown[]) => void = (...args) => console.log(new Date().toISOString(), ...args),
  now = new Date()
): Promise<number> {
  const snap = await db.collection(PA_COLLECTIONS.inboundEvents).where("status", "==", "running").limit(50).get()
  let reclaimed = 0
  for (const doc of snap.docs) {
    const raw = doc.data() as { leaseUntil?: string }
    if (!isInboundLeaseExpired(raw.leaseUntil, now)) continue
    log("[orchestrator] reclaim expired inbound lease", doc.id)
    reclaimed += await claimAndProcessInboundEvent(db, doc.id, log)
  }
  return reclaimed
}

export function startInboundEventListener(
  db: Firestore,
  log: (...args: unknown[]) => void = (...args) => console.log(new Date().toISOString(), ...args),
  input?: { reclaimMs?: number }
) {
  const ref = db
    .collection(PA_COLLECTIONS.inboundEvents)
    .where("status", "==", "pending")
    .orderBy("createdAt", "asc")

  const reclaimMs = input?.reclaimMs ?? Math.max(30_000, INBOUND_LEASE_MS)
  const reclaimTimer = setInterval(() => {
    void reclaimExpiredInboundEvents(db, log).catch((e) => log("[orchestrator] reclaim error", e))
  }, reclaimMs)

  const unsubscribe = ref.onSnapshot(
    (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== "added") continue
        void claimAndProcessInboundEvent(db, change.doc.id, log).catch((e) => {
          log("[orchestrator] listener process error", change.doc.id, e)
        })
      }
    },
    (err) => log("[orchestrator] listener error", err)
  )

  void reclaimExpiredInboundEvents(db, log).catch((e) => log("[orchestrator] initial reclaim error", e))

  return () => {
    clearInterval(reclaimTimer)
    unsubscribe()
  }
}
