import { randomUUID } from "node:crypto"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import { getAgentById, getDefaultAgent } from "@pa/agent-registry"
import {
  runAgentTurn as defaultRunAgentTurn,
  stripLeadingIsoTimestamp,
  FirestoreSession,
  deriveSessionMessageIdempotencyKey,
  type AgentsSdkSession as Session,
  type AgentTurnTool,
} from "@pa/agent-runtime"
import {
  connectorRegistry,
  runConnector,
  type ConnectorName,
  type CurrentInfoConnectorInput,
  type CurrentInfoConnectorOutput,
} from "@pa/pa-connectors"
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
  clearUserMemory,
  createConfirmedMemoryFact,
  isResetCommand,
  summarizeClearResult,
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
  runCurrentInfoConnector(
    agent: AgentDef,
    input: CurrentInfoConnectorInput,
    turn: { turnId: string; userId: string; sessionId: string }
  ): Promise<CurrentInfoConnectorOutput>
  /**
   * Phase 10.5 T7 — build the per-turn AgentTurnTool[] for the SDK.
   * Default Firestore impl wraps `buildTurnTools` (free function) bound to
   * a Firestore handle. Tests can return [] or fake tools without touching
   * a connector registry.
   */
  buildTurnTools(
    agent: AgentDef,
    turn: { turnId: string; userId: string; sessionId: string }
  ): Promise<AgentTurnTool[]>
  /**
   * Phase 10.5 T9 — emit deferred-audit pa_tool_calls rows for hosted SDK
   * tools (e.g. web_search) that the SDK invoked internally. The synthetic
   * row preserves Phase 10's pa_tool_calls shape so the dashboard's
   * connector tab continues to render web_search hits even though the
   * runtime call did not pass through `runConnector`.
   */
  recordHostedToolCalls(input: {
    turnId: string
    userId: string
    sessionId: string
    calls: { name: string; count: number }[]
  }): Promise<void>
  /**
   * Phase 10.5 T3 — factory for the SDK Session backing this turn.
   * Default Firestore impl returns FirestoreSession bound to pa_messages.
   * Tests can return a fake. The orchestrator never sees Firestore directly
   * here, preserving the @pa/agent-runtime ↔ firebase-admin boundary at the
   * adapter level.
   */
  createSession(input: { sessionId: string; userId: string }): Session
  runAgentTurn: RunAgentTurn
  afterAssistantTurn(agent: AgentDef, input: {
    userId: string
    sessionId: string
    userText: string
    assistantText: string
    memoryMode: AgentDef["memoryMode"]
  }): Promise<AfterTurnResult>
  /**
   * In-band test-admin reset trigger. When `user.testMode === true` AND the
   * inbound `event.body` matches one of `RESET_PATTERNS`, the store runs
   * `clearUserMemory(userId, ...)` and returns `{ handled: true, summary }`.
   * Otherwise returns `{ handled: false }` and the orchestrator falls through
   * to normal memory-command + LLM routing.
   *
   * Production users (testMode unset/false) ALWAYS get `handled: false`,
   * even if they happen to type the magic string.
   */
  maybeHandleResetCommand(event: InboundEvent): Promise<{ handled: boolean; summary?: string }>
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

function shouldSuppressOutbound(event: InboundEvent): boolean {
  const harness = event.rawMeta?.harness
  return Boolean(
    harness &&
      typeof harness === "object" &&
      "suppressOutbound" in harness &&
      (harness as { suppressOutbound?: unknown }).suppressOutbound === true
  )
}

function hasCjk(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(text)
}

function messageDate(iso: string): string {
  const date = iso.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10)
}

export function buildCurrentInfoBoundaryReply(userMessage: string, nowIso: string): string | null {
  const text = userMessage.trim()
  if (!text) return null

  const asksForExternalCurrentInfo =
    /(最近|最新|今天|今日|本周|这周|现在|刚刚|新闻|上映|票房|电影|天气|价格|股价|汇率|recent|latest|today|this week|news|weather|stock|price|exchange rate|movies?|showtimes?|now playing|released|ニュース|映画|上映|天気)/iu.test(text)
  if (!asksForExternalCurrentInfo) return null

  const isOnlyMemoryQuestion =
    /(你还?记得|还记得|我.*(说过|告诉过|提过|想过|想干嘛|喜欢)|remember what i|what did i (say|tell|want)|覚えて|私.*(言った|話した))/iu.test(text) &&
    !/(电影|上映|票房|新闻|天气|价格|股价|汇率|movies?|showtimes?|now playing|news|weather|stock|price|exchange rate|ニュース|映画|天気)/iu.test(text)
  if (isOnlyMemoryQuestion) return null

  const date = messageDate(nowIso)
  if (hasCjk(text)) {
    return `今天是 ${date}。这类“最近/最新”的电影、新闻、天气、价格等问题需要实时数据源；我现在这个 PA runtime 还没有接实时检索，所以不能可靠回答，也不会用旧片单或旧新闻代替实时结果。你想看电影这点我会作为对话意图处理，但最新上映/排片需要接入实时检索后再查。`
  }
  return `Today is ${date}. Questions about recent or latest movies, news, weather, prices, or other time-sensitive facts require a live data source. This PA runtime does not have live search wired in yet, so I should not guess from stale model knowledge. I can keep the movie-watching intent in context, but current releases or showtimes need live search first.`
}

function formatCurrentInfoReply(result: CurrentInfoConnectorOutput, userMessage: string): string {
  const summary = result.summary.trim()
  const date = messageDate(result.asOf)
  const sources = result.sources
    .filter((source) => source.url.trim())
    .slice(0, 3)
    .map((source, i) => {
      const title = source.title?.trim()
      return title ? `${i + 1}. ${title}: ${source.url}` : `${i + 1}. ${source.url}`
    })
  const suffix = hasCjk(userMessage)
    ? `截至 ${date}${sources.length ? `\n来源：\n${sources.join("\n")}` : ""}`
    : `As of ${date}${sources.length ? `\nSources:\n${sources.join("\n")}` : ""}`
  return `${summary}\n\n${suffix}`.slice(0, 1600)
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
  if (shouldSuppressOutbound(event)) return
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


/**
 * Phase 10.5 T7 — bridge `agent.allowedConnectors` → SDK `tool()` instances.
 *
 * Each entry in the returned array goes through `runConnector` so audit +
 * safety policy fire identically to the legacy regex paths. The shared
 * `counter` closure carries the per-turn `usedThisTurn` count so the
 * connector policy budget is enforced even when the SDK invokes multiple
 * tools concurrently.
 *
 * **Counter under SDK parallel tool execution.** The SDK's
 * `runner/toolExecution` uses `Promise.all` to dispatch function tool
 * calls within a turn, so two tool execute closures CAN start before
 * either resolves. JS is single-threaded, so the read+increment of a
 * primitive `counter.value` within a synchronous block is atomic — there
 * is no preemption mid-statement. The bridge captures the snapshot
 * BEFORE incrementing and BEFORE awaiting `runConnector`, so:
 *
 *   - n parallel calls each see a unique snapshot in [0..n-1].
 *   - canUseConnector denies once snapshot >= toolBudgetPerTurn.
 *
 * Mutex is unnecessary; if the SDK ever introduces a non-Node async
 * scheduler (workers), this comment is the canary — revisit and add a
 * proper atomic.
 *
 * `current-info` is intentionally skipped here because T4 attaches it as
 * the SDK's hosted `webSearchTool`, not a custom function tool. The
 * deferred audit row for hosted web_search is emitted by T9 after the
 * turn completes.
 */
export function buildTurnTools(
  db: Firestore,
  agent: AgentDef,
  turn: { turnId: string; userId: string; sessionId: string }
): AgentTurnTool[] {
  if (agent.toolPolicy === "none") return []
  const allowed = agent.allowedConnectors ?? []
  if (allowed.length === 0) return []
  const counter = { value: 0 }
  const tools: AgentTurnTool[] = []
  for (const name of allowed) {
    if (name === "current-info") continue
    if (!(name in connectorRegistry)) continue
    const def = connectorRegistry[name as ConnectorName]
    tools.push({
      name,
      description: def.description,
      // Each connector's zod input schema reaches the SDK directly.
      // pa-connectors uses zod ^3.24, agent-runtime types use zod^4 —
      // runtime shape is identical for object schemas. Cast through
      // unknown so the @pa boundary stays clean.
      parameters: def.inputSchema as unknown as AgentTurnTool["parameters"],
      execute: async (args: unknown) => {
        // Pre-increment: snapshot the current count, then bump. Both
        // operations are synchronous (no await between read and write),
        // so under JS's single-threaded model this gives each parallel
        // tool call a unique monotonically-increasing snapshot.
        const snapshot = counter.value
        counter.value = snapshot + 1
        try {
          const result = await runConnector(name as ConnectorName, args, {
            db,
            agent,
            turnId: turn.turnId,
            userId: turn.userId,
            sessionId: turn.sessionId,
            usedThisTurn: snapshot,
          })
          return JSON.stringify(result).slice(0, 1024)
        } catch (e) {
          // Surface to the SDK so the LLM can apologize. Do NOT swallow.
          throw e
        }
      },
    })
  }
  return tools
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
      // Use the same hash FirestoreSession derives so the SDK\u2019s addItems()
      // short-circuits on this row instead of double-writing the user turn.
      // Original inbound idempotencyKey is preserved in rawMeta for audit.
      idempotencyKey: deriveSessionMessageIdempotencyKey(event.sessionId, "user", event.body),
      rawMeta: {
        ...event.rawMeta,
        source: "pa_inbound_event",
        eventId: event.id,
        turnId,
        inboundIdempotencyKey: event.idempotencyKey,
      },
    })

    // Test-admin magic string. Must run BEFORE parseMemoryCommand so it
    // doesn't get swallowed by an unrelated memory grammar rule.
    const reset = await store.maybeHandleResetCommand(event)
    if (reset.handled) {
      await sendMemoryReply(store, event, turnId, reset.summary ?? "✓ 测试记忆已清空。")
      await store.updateTurn(turnId, { status: "succeeded", stage: "succeeded", completedAt: store.nowIso() })
      await store.markEventSucceeded(event.id)
      return
    }

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

    const currentInfoBoundaryReply = buildCurrentInfoBoundaryReply(event.body, store.nowIso())
    if (currentInfoBoundaryReply) {
      let reply = currentInfoBoundaryReply
      let currentInfoConnectorOk = false
      try {
        const result = await store.runCurrentInfoConnector(
          agent,
          { query: event.body, nowIso: store.nowIso() },
          { turnId, userId: event.userId, sessionId: event.sessionId }
        )
        if (result.ok) {
          reply = formatCurrentInfoReply(result, event.body)
          currentInfoConnectorOk = true
        }
      } catch (e) {
        store.log("[orchestrator] current-info connector unavailable", {
          turnId,
          eventId: event.id,
          error: e instanceof Error ? e.message : String(e),
        })
      }
      await store.appendMessage({
        id: `out-${event.id}`,
        sessionId: event.sessionId,
        userId: event.userId,
        role: "assistant",
        body: reply,
        createdAt: store.nowIso(),
        idempotencyKey: `out-${event.id}`,
        rawMeta: {
          source: "pa_orchestrator",
          turnId,
          eventId: event.id,
          currentInfoBoundary: !currentInfoConnectorOk,
          currentInfoConnectorOk,
        },
      })
      const after = await store.afterAssistantTurn(agent, {
        userId: event.userId,
        sessionId: event.sessionId,
        userText: event.body,
        assistantText: reply,
        memoryMode: agent.memoryMode,
      })
      if (!shouldSuppressOutbound(event)) {
        await store.enqueueOutbound(event.userId, event.from, reply, {
          sessionId: event.sessionId,
          role: "assistant",
          idempotencyKey: `outbound-${event.id}`,
        })
      }
      await store.updateTurn(turnId, {
        status: "succeeded",
        stage: "succeeded",
        completedAt: store.nowIso(),
        currentInfoBoundary: !currentInfoConnectorOk,
        currentInfoConnectorOk,
        mem0WritebackRan: after.writebackRan,
        mem0WritebackSkipReason: after.writebackSkipReason,
      })
      await store.markEventSucceeded(event.id)
      return
    }

    const memoryBlock = memoryBlockWithFacts(mem.memoryBlock, facts)
    const session = store.createSession({ sessionId: event.sessionId, userId: event.userId })
    const systemInputs = memoryBlock ? [`Memory context:\n${memoryBlock}`] : []
    // Phase 10.5 T7 — bridge agent.allowedConnectors → SDK tools. When the
    // default agent's toolPolicy is still "none" (pre-T8), this returns []
    // and the SDK gets no custom tools, matching legacy behavior.
    const turnTools = await store.buildTurnTools(agent, { turnId, userId: event.userId, sessionId: event.sessionId })
    const { text, usage } = await store.runAgentTurn({
      agent,
      systemPrompt: agent.systemPrompt,
      // Default Agents SDK path consumes \`session\` + \`systemInputs\` +
      // \`tools\`. The legacy \`history\` + \`memoryBlock\` fields are only
      // consumed by the chat.completions emergency rollback
      // (PA_AGENT_RUNTIME=chat_completions); pass them through so that path
      // keeps working.
      memoryBlock,
      history,
      userMessage: event.body,
      session,
      systemInputs,
      tools: turnTools,
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
      // Use the SDK-compatible hash on the raw model reply so
      // FirestoreSession.addItems() short-circuits this assistant row on
      // the default path (no double-write). Doc id stays \`out-${event.id}\`
      // for dashboard transcript continuity.
      idempotencyKey: deriveSessionMessageIdempotencyKey(event.sessionId, "assistant", reply),
      rawMeta: {
        source: "pa_orchestrator",
        turnId,
        eventId: event.id,
        outboundIdempotencyKey: `out-${event.id}`,
      },
    })
    const after = await store.afterAssistantTurn(agent, {
      userId: event.userId,
      sessionId: event.sessionId,
      userText: event.body,
      assistantText: reply,
      memoryMode: agent.memoryMode,
    })
    if (!shouldSuppressOutbound(event)) {
      await store.enqueueOutbound(event.userId, event.from, visibleReply, {
        sessionId: event.sessionId,
        role: "assistant",
        idempotencyKey: `outbound-${event.id}`,
      })
    }
    // Phase 10.5 T9 — persist token usage on the turn doc. Filter undefined
    // fields (Phase 10 bug #2 pattern) so Firestore never sees a literal
    // undefined value. Synthetic pa_tool_calls rows for hosted web_search
    // calls (deferred audit owed by T7) are emitted via store.recordHostedToolCalls
    // when usage.hostedToolCalls is populated.
    if (usage) {
      const usagePatch: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(usage)) {
        if (v !== undefined) usagePatch[k] = v
      }
      if (Object.keys(usagePatch).length > 0) {
        await store.updateTurn(turnId, { usage: usagePatch, updatedAt: store.nowIso() })
      }
      if (usage.hostedToolCalls && usage.hostedToolCalls.length > 0) {
        await store.recordHostedToolCalls({
          turnId,
          userId: event.userId,
          sessionId: event.sessionId,
          calls: usage.hostedToolCalls,
        })
      }
    }
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
    async runCurrentInfoConnector(agent, input, turn) {
      const allowed = new Set([...(agent.allowedConnectors ?? []), "current-info"])
      const currentInfoAgent: AgentDef = {
        ...agent,
        toolPolicy: "allowlist",
        allowedConnectors: [...allowed],
        toolBudgetPerTurn: Math.max(1, agent.toolBudgetPerTurn ?? 1),
      }
      return await runConnector("current-info", input, {
        db,
        agent: currentInfoAgent,
        turnId: turn.turnId,
        userId: turn.userId,
        sessionId: turn.sessionId,
        usedThisTurn: 0,
      }) as CurrentInfoConnectorOutput
    },
    async buildTurnTools(agent, turn) {
      return buildTurnTools(db, agent, turn)
    },
    async recordHostedToolCalls({ turnId, userId, sessionId, calls }) {
      // One synthetic pa_tool_calls row per hosted invocation, mirroring
      // Phase 10's shape: connectorName: "current-info" (the policy
      // identity), connectorVersion: "sdk-hosted" (so the dashboard can
      // distinguish runtime origin), policyDecision: "allow",
      // status: "completed". We filter undefined fields before .set()
      // (Phase 10 bug #2). userId/sessionId are kept on argsRedacted only
      // — pa_tool_calls today does not carry them top-level.
      const at = nowIso()
      for (const call of calls) {
        for (let i = 0; i < call.count; i += 1) {
          const id = randomUUID()
          const row: Record<string, unknown> = {
            id,
            turnId,
            connectorName: call.name === "web_search" ? "current-info" : call.name,
            connectorVersion: "sdk-hosted",
            status: "completed",
            argsDigest: "sdk-hosted",
            argsRedacted: { source: "agents_sdk_web_search", userId, sessionId, hostedTool: call.name },
            policyDecision: "allow",
            startedAt: at,
            completedAt: at,
          }
          // Defensive: filter undefined.
          for (const [k, v] of Object.entries(row)) {
            if (v === undefined) delete row[k]
          }
          await db.collection(PA_COLLECTIONS.toolCalls).doc(id).set(row)
        }
      }
    },
    createSession({ sessionId, userId }) {
      return new FirestoreSession({ db, sessionId, userId })
    },
    runAgentTurn: defaultRunAgentTurn,
    async afterAssistantTurn(agent, input) {
      return defaultAfterAssistantTurn(db, agent, input)
    },
    async maybeHandleResetCommand(event) {
      if (!isResetCommand(event.body)) return { handled: false }
      // Two-gate authorization, EITHER passes:
      //   (a) per-user opt-in: pa_users/{id}.testMode === true
      //   (b) deploy-time admin allowlist: PA_ADMIN_USER_IDS env (CSV of UUIDs)
      // Production users never get the magic string — testMode is unset and
      // their UUID is not in the env allowlist.
      const adminUserIds = (process.env.PA_ADMIN_USER_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const isAdminAllowlisted = adminUserIds.includes(event.userId)
      let isTestUser = false
      if (!isAdminAllowlisted) {
        const userSnap = await db.collection(PA_COLLECTIONS.users).doc(event.userId).get()
        const user = userSnap.exists ? (userSnap.data() as { testMode?: boolean }) : null
        isTestUser = user?.testMode === true
      }
      if (!isAdminAllowlisted && !isTestUser) return { handled: false }

      const qdrantUrl = process.env.QDRANT_URL
      const qdrantApiKey = process.env.QDRANT_API_KEY
      if (!qdrantUrl || !qdrantApiKey) {
        return { handled: true, summary: "✗ 测试记忆清空失败：QDRANT_URL/QDRANT_API_KEY 未配置" }
      }
      try {
        // Auto-promote allowlisted admin to testMode so subsequent runs go
        // through the cheaper testMode branch (skips the env var lookup
        // dependency for ops who later remove the allowlist).
        if (isAdminAllowlisted) {
          await db.collection(PA_COLLECTIONS.users).doc(event.userId).set(
            { testMode: true, updatedAt: nowIso() },
            { merge: true }
          )
        }
        const result = await clearUserMemory(
          event.userId,
          { db, qdrantUrl, qdrantApiKey, qdrantCollection: process.env.QDRANT_COLLECTION },
          { keepMessages: false, dryRun: false }
        )
        return { handled: true, summary: summarizeClearResult(result) }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { handled: true, summary: `✗ 测试记忆清空失败：${msg}` }
      }
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
