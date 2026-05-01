import { randomUUID } from "node:crypto"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import {
  getAgentById,
  getDefaultAgent,
  composeSystemPrompt as composeLegacyHandbookSystemPrompt,
  loadHandbook as loadLegacyHandbookSections,
} from "@pa/agent-registry"
import {
  composeSystemPrompt as composeHandbookV2SystemPrompt,
  loadHandbook as loadHandbookV2,
  DEFAULT_HANDBOOK_SLUG,
} from "./handbook/loader.js"
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
  buildPersonaCard,
  writeStylePreference,
  setVoiceStyleStore,
  createFirestoreVoiceStyleStore,
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
  resolveMem0PartitionKey,
  type AfterTurnResult,
  type LoadContextResult,
} from "@pa/memory"
import { appendAuditEvent } from "@pa/pa-broker"
import { checkPromptInjection, checkPromptInjectionAndRecord, enforceRateLimit } from "@pa/pa-safety"
import { resolveOnboardingStep, applyOnboardingStep, composeOnboardingInput } from "./onboarding.js"
import { LEGACY_V0_SYSTEM_PROMPT } from "./legacy-voice-prompt.js"
import { buildVoiceReminder, isVoiceV1Disabled } from "./voice-reminder.js"
import { computeMirrorForTurn, isVoiceMirrorDisabledFlag } from "./voice/mirror-injection.js"
import {
  rewriteIfOff,
  stripRepeatOpener,
  stripValidationTic,
  isHumanizeRuntimeEnabled,
} from "./voice/llm-rewriter.js"
// Phase 36 — ImperfectionInjector applied post-strip on final visible text.
import {
  injectImperfection,
  resolveArm,
} from "./voice/imperfection-injector/index.js"
// Phase 35/38 — detectors + advice tracker run UNCONDITIONALLY on the final
// visible text, regardless of whether `rewriteIfOff` short-circuited (no_change
// / rewrite_unsafe / timeout). Inner-rewriter wire-in only fires on the
// "rewrite happy path" — that's why pre-rev-00024 turns produced zero
// advice-tracker entries despite the flag being on for the user.
import {
  runAllDetectors,
  type DetectorContext,
} from "./voice/detectors/index.js"
import { trackAdvice } from "./voice/memory-policy/index.js"
import { tapCoachTokens } from "./voice/coach-token-monitor.js"
import { buildFewShotTurns, prefixFewShotToHistory } from "./voice/few-shot.js"
import { normalizeForIMessage } from "./output-normalizer.js"
// Phase 21 Track 5 — Headhunter playbook addendum (job-search probe rotation).
import { headhunterAddendum } from "./playbooks/headhunter.js"
// Phase 32 W3 — Firestore-backed playbook cache (30s TTL). Replaces the
// inline HEADHUNTER_TRIGGER_RE constant; the regex below is kept as a
// failsafe when Firestore is empty (zero-downtime cutover).
import { matchCachedPlaybooks } from "./playbook-cache.js"

const HEADHUNTER_PLAYBOOK_ID = "headhunter"
/**
 * Failsafe regex — only consulted when Firestore lookup returns 0 matches.
 * Once `seedDefaultPlaybooks` has run the regex set comes from the
 * dashboard-editable `pa-playbooks/headhunter.regexTriggers` array.
 */
const HEADHUNTER_TRIGGER_RE = /帮我|想换|在看工作|在面|简历|offer/i
// Phase 22 — proactive cancellation NLU (D-07, PROACTIVE-06)
import { detectProactiveCancellation } from "./cancellation-nlu.js"
// Phase 30 T2 — Downstream Eval Connector hook (P9-Connectors).
import { runDownstreamConnector, withSoftBudget } from "./downstream.js"
import { defaultNlJudge } from "./eval-nl-judge.js"
// Re-export Phase 22 proactive modules for consumers (e.g. apps/functions)
export { detectProactiveCancellation, CANCELLATION_PATTERNS } from "./cancellation-nlu.js"
export { runProactiveTurn, type ProactiveTurnStore, type ProactiveTurnResult } from "./proactive-turn.js"
export { normalizeForIMessage } from "./output-normalizer.js"
// Phase 30 T2 — re-export downstream connector helpers for admin CF wiring.
export {
  runDownstreamConnector,
  withSoftBudget,
  EVAL_CONNECTORS_FLAG,
  type RunDownstreamConnectorInput,
  type RunDownstreamConnectorOptions,
  type RunDownstreamConnectorResult,
  type DownstreamFireRecord,
} from "./downstream.js"
// Phase 30 T-Wrap — re-export the production NL judge so the admin debug
// endpoint (paAdminBootstrap → evalDownstreamTriggers) can pass it in.
export { defaultNlJudge, _resetNlJudgeClient as _resetEvalNlJudgeClient } from "./eval-nl-judge.js"

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
  /**
   * Phase 11.3 — return the operator-set Mem0/Qdrant partition key for
   * this user, or `undefined` when unset. Callers MUST run the result
   * through `resolveMem0PartitionKey` (or use the resolver helper) — never
   * pass the raw value directly to mem0Search/mem0Add. Returning
   * `undefined` is the legacy path; the resolver falls back to `userId`.
   */
  getMem0UserId(userId: string): Promise<string | undefined>
  loadHistory(sessionId: string, limit: number): Promise<ChatMessage[]>
  enqueueOutbound(userId: string, toE164: string, body: string, input?: Partial<OutboundMessage>): Promise<void>
  listMemoryFacts(userId: string): Promise<MemoryFact[]>
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
    input: {
      userId: string
      /**
       * Phase 11.3 — resolved Mem0/Qdrant partition key. Caller (this
       * orchestrator) populates from `getMem0UserId` below.
       */
      mem0UserId?: string
      sessionId: string
      userMessage: string
      memoryMode: AgentDef["memoryMode"]
    },
    history: ChatMessage[]
  ): Promise<LoadContextResult>
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
    /** Phase 11.3 — resolved Mem0/Qdrant partition key. */
    mem0UserId?: string
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
  /**
   * v1.1 P0 — rate limit + regex injection gate before model turn.
   * Default Firestore impl uses @pa/pa-safety; tests return allow: true.
   */
  checkInboundSafety(event: InboundEvent): Promise<{ allow: boolean; reason?: string }>
  /**
   * Phase 22 — cancel all pending proactive jobs for a user (D-07, PROACTIVE-06).
   * Returns the count of jobs cancelled.
   */
  cancelAllPendingProactiveJobs(userId: string): Promise<number>
  /**
   * Phase 22 — write proactive_cancel audit event (D-09).
   */
  writeProactiveCancelAudit(input: {
    userId: string
    sessionId: string
    inboundEventId: string
    cancelledCount: number
  }): Promise<void>
  /**
   * Phase 23 — fetch minimal user fields needed for onboarding state machine.
   * Returns null when the user doc doesn't exist yet (edge case for new users).
   */
  getOnboardingUser(userId: string): Promise<{
    id: string
    phoneE164: string
    onboardingState?: "pending" | "first_mes_sent" | "grounding_q1_asked" | "complete"
  } | null>
  /**
   * Phase 23 — apply onboarding step to advance user state + promote beta participant.
   */
  applyOnboarding(userId: string, phoneE164: string, step: "send_first_mes" | "ask_grounding_q" | "complete"): Promise<void>

  /**
   * Phase 24.5 — optional Firestore handle for `getFlag()` reads. Tests omit
   * `db`; production wires the live Firestore so flag-backed kill-switches
   * (e.g. `PA_VOICE_MIRROR_DISABLED`) consult `pa-feature-flags`. env vars
   * still short-circuit inside the SDK as the emergency override.
   */
  db?: Firestore
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

/**
 * Phase 11.1.3 — legacy concatenated memory block.
 *
 * Surface contract:
 *  - LEGACY-FALLBACK ONLY. Consumed by the chat.completions emergency-
 *    rollback path (`PA_AGENT_RUNTIME=chat_completions`) via
 *    `runAgentTurn`'s legacy `memoryBlock` field. Keeping this helper
 *    intact keeps the kill-switch contract unchanged.
 *  - The default Agents SDK path NO LONGER calls this helper for the
 *    recall half of systemInputs. Use `buildRecallSystemInput` instead;
 *    facts now ride exclusively in the persona card (Phase 11.1.2)
 *    so the recall channel reflects only Mem0 semantic recall.
 *  - Persona card does NOT flow through this helper; persona is its own
 *    discrete `systemInputs[0]` entry built by `buildPersonaCard`.
 */
export function memoryBlockWithFacts(memoryBlock: string | null, facts: { content: string }[]) {
  const unique = uniqueFactsByContent(facts)
  const factBlock = unique.length ? unique.map((f) => `- ${f.content}`).join("\n") : null
  if (memoryBlock && factBlock) return `Confirmed user facts:\n${factBlock}\n\nRelevant memory:\n${memoryBlock}`
  if (factBlock) return `Confirmed user facts:\n${factBlock}`
  return memoryBlock
}

/**
 * Phase 11.1 cleanup D2 — recall-only system input for the default Agents
 * SDK path. Decoupled from `memoryBlockWithFacts` (which is now
 * legacy-fallback only). Persona/facts are NOT prepended here — the
 * persona card is its own discrete `systemInputs[0]` entry from 11.1.2.
 *
 * @returns The `Memory context:\n…` block alone, or `null` when there is
 *          no Mem0 recall to surface (no bare heading is ever injected).
 */
export function buildRecallSystemInput(memoryBlock: string | null): string | null {
  if (!memoryBlock) return null
  return `Memory context:\n${memoryBlock}`
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

async function sendMemoryReply(store: OrchestratorStore, event: InboundEvent, turnId: string, body: string) {
  const { text: safe } = normalizeForIMessage(body, { maxLength: 600 })
  const at = store.nowIso()
  await store.appendMessage({
    id: `out-${event.id}`,
    sessionId: event.sessionId,
    userId: event.userId,
    role: "assistant",
    body: safe,
    createdAt: at,
    idempotencyKey: `out-${event.id}`,
    rawMeta: { source: "pa_orchestrator", turnId: turnId, eventId: event.id },
  })
  if (shouldSuppressOutbound(event)) return
  await store.enqueueOutbound(event.userId, event.from, safe, {
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
 * `current-info` is intentionally hosted by T4 as the SDK's
 * `webSearchTool` (not a custom function tool). After Phase 10.5 cleanup
 * C6, no `current-info` registry entry exists; the allowlist string
 * "current-info" is still meaningful as the gate name read by
 * `buildHostedToolsForDefault`. The deferred audit row for hosted
 * web_search is emitted by T9 after the turn completes via
 * `recordHostedToolCalls`.
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
    // Phase 10.5 cleanup C6: the `current-info` connector registry entry
    // was removed; the SDK-hosted webSearchTool replaces it on the default
    // path. The string `"current-info"` remains valid in
    // `agent.allowedConnectors` as the gate name for buildHostedToolsForDefault,
    // but it is no longer a custom function tool — `name in connectorRegistry`
    // returns false and we skip below.
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
        source: "pa-inbound-event",
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

    const safety = await store.checkInboundSafety(event)
    if (!safety.allow) {
      const msg =
        safety.reason === "rate_limited"
          ? "You’re sending a bit too fast. Give it a few seconds and try again."
          : "I can’t work with that message. Try rephrasing."
      await sendMemoryReply(store, event, turnId, msg)
      await store.updateTurn(turnId, {
        status: "succeeded",
        stage: "succeeded",
        completedAt: store.nowIso(),
        errorCode: safety.reason,
        error: "inbound_safety_block",
      })
      await store.markEventSucceeded(event.id)
      return
    }

    // Phase 22 — proactive cancellation NLU pre-LLM hook (D-07, PROACTIVE-06).
    // Must run before memory commands so "停止提醒" short-circuits cleanly.
    if (detectProactiveCancellation(event.body)) {
      const cancelledCount = await store.cancelAllPendingProactiveJobs(event.userId)
      await store.writeProactiveCancelAudit({
        userId: event.userId,
        sessionId: event.sessionId,
        inboundEventId: event.id,
        cancelledCount,
      })
      // Voice v1-toned confirmation reply — concise, natural (D-07)
      const cancelReply = cancelledCount > 0 ? "好的，全停了 ✋" : "没有待发送的提醒了哦。"
      await sendMemoryReply(store, event, turnId, cancelReply)
      await store.updateTurn(turnId, { status: "succeeded", stage: "succeeded", completedAt: store.nowIso() })
      await store.markEventSucceeded(event.id)
      return
    }

    // Phase 10.5 T5: regex pre-routers for "remember" writes are gone — the
    // LLM owns memory writes via the `remember-fact` connector tool. We still
    // handle list/forget/clear at the orchestrator (those are admin commands,
    // not tools the LLM should own).
    const command = parseMemoryCommand(event.body)
    if (command && command.kind !== "remember" && await handleMemoryCommand(event, store, turnId, command)) {
      await store.updateTurn(turnId, { status: "succeeded", stage: "succeeded", completedAt: store.nowIso() })
      await store.markEventSucceeded(event.id)
      return
    }

    const agent = await store.getAgentForUser(event.userId)
    if (!agent) throw Object.assign(new Error("No agent configured"), { code: "NO_AGENT" })

    // Phase 23 — Onboarding state machine (D-03, D-04, D-08).
    // Run before normal LLM dispatch. For invited/new users, route through
    // onboarding steps using Voice v1 system prompt (D-04: no separate utility
    // prompt). On "complete", auto-promotes beta participant status.
    const onboardingUser = await store.getOnboardingUser(event.userId)
    if (onboardingUser) {
      const onboardingStep = resolveOnboardingStep(onboardingUser)
      if (onboardingStep !== "skip") {
        const syntheticInput = composeOnboardingInput(onboardingStep, agent)
        if (syntheticInput) {
          // Build system inputs for onboarding reply using the normal Voice v1 path
          const onboardingSystemInputs = [syntheticInput]
          const onboardingHistory = await store.loadHistory(event.sessionId, 5)
          const onboardingSession = store.createSession({ sessionId: event.sessionId, userId: event.userId })
          const { text: onboardingText } = await store.runAgentTurn({
            agent,
            systemPrompt: agent.systemPrompt,
            memoryBlock: null,
            history: onboardingHistory,
            userMessage: event.body,
            session: onboardingSession,
            systemInputs: onboardingSystemInputs,
            tools: [],
          })
          const onboardingReply = stripLeadingIsoTimestamp(onboardingText.trim()) || "在呢. 今天找你聊点啥? 🍋"
          const { text: normalizedOnboardingReply } = normalizeForIMessage(onboardingReply, { maxLength: 600 })
          await store.appendMessage({
            id: `out-${event.id}`,
            sessionId: event.sessionId,
            userId: event.userId,
            role: "assistant",
            body: normalizedOnboardingReply,
            createdAt: store.nowIso(),
            idempotencyKey: deriveSessionMessageIdempotencyKey(event.sessionId, "assistant", onboardingReply),
            rawMeta: { source: "pa_orchestrator", turnId, eventId: event.id, onboardingStep },
          })
          if (!shouldSuppressOutbound(event)) {
            await store.enqueueOutbound(event.userId, event.from, normalizedOnboardingReply, {
              sessionId: event.sessionId,
              role: "assistant",
              idempotencyKey: `outbound-onboarding-${event.id}`,
            })
          }
          // Advance onboarding state
          await store.applyOnboarding(event.userId, onboardingUser.phoneE164, onboardingStep)
          await store.updateTurn(turnId, {
            status: "succeeded",
            stage: "succeeded",
            completedAt: store.nowIso(),
            onboardingStep,
          })
          await store.markEventSucceeded(event.id)
          return
        }
        // complete step with no synthetic input — just advance state, fall through to normal turn
        await store.applyOnboarding(event.userId, onboardingUser.phoneE164, onboardingStep)
      }
    }

    await store.updateTurn(turnId, {
      agentId: agent.id,
      memoryMode: agent.memoryMode,
      stage: "memory_load" satisfies TurnStage,
      updatedAt: store.nowIso(),
    })
    const history = await store.loadHistory(event.sessionId, HISTORY_LIMIT)
    const facts = await store.listMemoryFacts(event.userId)
    // Phase 11.3 — load the Mem0 partition key once per turn and thread it
    // through both memory call sites. `stacked.ts` only honors this when
    // `PA_MEM0_USE_PARTITION_KEY=true`; passing it always is forward-safe
    // (worker path already does this), and means flipping the kill switch
    // is a pure env-var change with no orchestrator redeploy.
    const mem0UserIdForTurn = await store.getMem0UserId(event.userId)
    // Phase 11.3 / memory-opt — canonical resolver, never raw read.
    const mem0PartitionKey = resolveMem0PartitionKey({
      id: event.userId,
      mem0UserId: mem0UserIdForTurn,
    })
    const mem = await store.loadPersonalizationContext(
      agent,
      {
        userId: event.userId,
        mem0UserId: mem0PartitionKey,
        sessionId: event.sessionId,
        userMessage: event.body,
        memoryMode: agent.memoryMode,
      },
      history
    )
    await store.updateTurn(turnId, {
      mem0Degraded: mem.mem0Degraded,
      mem0DegradedReason: mem.mem0DegradedReason ?? null,
      mem0SearchResultCount: mem.mem0SearchResultCount,
      stage: "llm" satisfies TurnStage,
      updatedAt: store.nowIso(),
    })

    // Legacy `memoryBlock` field — consumed ONLY by the chat.completions
    // emergency-rollback path (PA_AGENT_RUNTIME=chat_completions). Shape
    // unchanged from pre-D2: `Confirmed user facts:\n…\n\nRelevant memory:\n…`
    // (facts + Mem0 concatenated). Kill-switch contract preserved.
    const memoryBlock = memoryBlockWithFacts(mem.memoryBlock, facts)
    const session = store.createSession({ sessionId: event.sessionId, userId: event.userId })
    // Phase 11.1.2 — persona card is a deterministic system input prepended
    // BEFORE the Mem0 recall block. Source is Firestore confirmed facts
    // only (never Mem0/Qdrant). `PA_PERSONA_CARD_DISABLED=true` is the
    // 1-line rollback flag (Phase 11.1 PLAN §5). Empty card → null →
    // omitted; no bare heading is ever injected.
    const personaCard =
      process.env.PA_PERSONA_CARD_DISABLED === "true"
        ? null
        : buildPersonaCard(facts)
    // Phase 11.1 cleanup D2 — default-path recall is Mem0-only. Facts are
    // already surfaced via persona card; do NOT double-write them into
    // the recall channel.
    const recallEntry = buildRecallSystemInput(mem.memoryBlock)
    const voiceReminder = buildVoiceReminder()
    // Phase 19 ADAPT-02 — adaptive mirror snippet. Per D-04 the snippet is
    // appended AFTER the Phase 18 voice reminder so it sits immediately
    // before the user turn. Per D-07 setting PA_VOICE_MIRROR_DISABLED=true
    // returns nulls (skips analyzer + injection) — `mirror.snippet` is
    // null and the filter below drops it. Same env flag also gates the
    // mem0 style-preference write in afterAssistantTurn (D-07: rollback
    // bleeds nothing).
    // Phase 24.5 — flag-backed kill switch. When store.db is present we
    // consult pa_feature_flags (env=true still short-circuits inside SDK).
    // Test path with no db falls through to the existing env-only check
    // inside computeMirrorForTurn. Pure wrapper — no logic change to the
    // existing snippet computation.
    const mirrorDisabledByFlag =
      store.db != null
        ? await isVoiceMirrorDisabledFlag(store.db, process.env)
        : false
    const mirror = mirrorDisabledByFlag
      ? { snapshot: null, snippet: null, audit: null }
      : computeMirrorForTurn(history, event.body)
    if (mirror.audit) {
      store.log("pa.voice.mirror.injected", {
        userId: event.userId,
        ...mirror.audit,
      })
    }
    // Phase 21 Track 5 → Phase 32 W3 — playbook activation now sources its
    // regex triggers + addendum bodies from `pa-playbooks/{playbookKey}` via
    // a 30s in-memory cache. Backward-compat: if Firestore returns no
    // matches (or the load fails), we fall back to the inline
    // HEADHUNTER_TRIGGER_RE + addendum so a first-deploy race or empty
    // collection never breaks the running playbook. Sits AFTER the
    // Phase 18 voice reminder and BEFORE the Phase 19 mirror snippet
    // (D-04 ordering intact).
    let playbookAddendum: string | null = null
    let headhunterActive = false
    if (store.db != null) {
      const { matched, addendum } = await matchCachedPlaybooks(store.db, event.body)
      if (matched.length > 0 && addendum.trim().length > 0) {
        playbookAddendum = addendum
        headhunterActive = matched.some((p) => p.playbookKey === HEADHUNTER_PLAYBOOK_ID)
      }
    }
    if (!playbookAddendum) {
      // Failsafe path — Firestore empty or load failed. Mirrors the
      // pre-Wave-3 behavior so the headhunter playbook still activates.
      const fallbackActive =
        (event as { playbook?: string }).playbook === HEADHUNTER_PLAYBOOK_ID ||
        HEADHUNTER_TRIGGER_RE.test(event.body)
      if (fallbackActive) {
        const fallbackEntry = headhunterAddendum({ active: true })
        if (fallbackEntry) {
          playbookAddendum = fallbackEntry
          headhunterActive = true
        }
      }
    } else if (
      // If Firestore matched but headhunter is hinted via ctx, ensure ctx
      // tag stays sticky for downstream consumers (probe rotation hint).
      (event as { playbook?: string }).playbook === HEADHUNTER_PLAYBOOK_ID
    ) {
      headhunterActive = true
    }
    // Suppress unused-warning when the failsafe path is dead (env-disabled).
    void headhunterActive
    const systemInputs: string[] = [
      personaCard,
      recallEntry,
      voiceReminder,
      playbookAddendum,
      mirror.snippet,
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    // Phase 10.5 T7 — bridge agent.allowedConnectors → SDK tools. When the
    // default agent's toolPolicy is still "none" (pre-T8), this returns []
    // and the SDK gets no custom tools, matching legacy behavior.
    const turnTools = await store.buildTurnTools(agent, { turnId, userId: event.userId, sessionId: event.sessionId })
    // Phase 29 T4 — Bible-as-data v2 (pa-handbooks/{slug} + immutable
    // versions/{v}). When the orchestrator was wired with a Firestore
    // handle, resolve the handbook slug from agent.handbookSlug (default
    // "claire") and compose the runtime systemPrompt. Falls back through
    // a 3-tier chain so live traffic NEVER goes promptless during cutover:
    //   1. pa-handbooks/{slug} v2 schema (this phase)        ← preferred
    //   2. legacy pa-handbook-sections (handbookEnabled=true) ← prior iter
    //   3. agent.systemPrompt inline string                   ← original
    // Empty composed output OR load error logs once + falls through. The
    // failsafe inline systemPrompt is retained for one phase per PLAN T4
    // DON'T; cleanup phase removes it after migration confidence builds.
    let composedSystemPrompt: string | null = null
    if (store.db != null) {
      const slug = (agent as { handbookSlug?: string }).handbookSlug ?? DEFAULT_HANDBOOK_SLUG
      try {
        const handbook = await loadHandbookV2(store.db, slug)
        if (handbook) {
          const composed = composeHandbookV2SystemPrompt(handbook).trim()
          if (composed.length > 0) {
            composedSystemPrompt = composed
          } else {
            store.log("pa.handbook.v2_empty_fallback", {
              agentId: agent.id,
              slug,
              version: handbook.version,
            })
          }
        } else {
          store.log("pa.handbook.v2_missing_fallback", {
            agentId: agent.id,
            slug,
          })
        }
      } catch (e) {
        store.log("pa.handbook.v2_load_failed_fallback", {
          agentId: agent.id,
          slug,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    // Tier 2 fallback — legacy flat-section schema (only when v2 didn't
    // resolve AND legacy is explicitly enabled on the agent doc).
    if (
      composedSystemPrompt === null &&
      (agent as { handbookEnabled?: boolean }).handbookEnabled === true &&
      store.db != null
    ) {
      try {
        const sections = await loadLegacyHandbookSections(store.db)
        const composed = composeLegacyHandbookSystemPrompt(sections).trim()
        if (composed.length > 0) {
          composedSystemPrompt = composed
        } else {
          store.log("pa.handbook.legacy_empty_fallback_inline", { agentId: agent.id })
        }
      } catch (e) {
        store.log("pa.handbook.legacy_load_failed_fallback_inline", {
          agentId: agent.id,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    const systemPrompt = isVoiceV1Disabled()
      ? LEGACY_V0_SYSTEM_PROMPT
      : composedSystemPrompt ?? agent.systemPrompt
    // Phase 24 T1B — few-shot relocation. Prepend 12 mes_examples as
    // messages-array alternating turns (~3x style transfer vs system-block).
    // Synthetic fs_* ids MUST be filtered before any Firestore write
    // (see persistence-layer filter; Pitfall 4 in 24-RESEARCH.md).
    // historyForModel is MODEL INPUT ONLY — `history` remains the
    // source-of-truth for persistence paths (no fs_* rows in pa_messages).
    const fewShotTurns = buildFewShotTurns(agent)
    const historyForModel = fewShotTurns.length > 0
      ? prefixFewShotToHistory(fewShotTurns, history)
      : history
    const { text, usage } = await store.runAgentTurn({
      agent,
      systemPrompt,
      // Default Agents SDK path consumes \`session\` + \`systemInputs\` +
      // \`tools\`. The legacy \`history\` + \`memoryBlock\` fields are only
      // consumed by the chat.completions emergency rollback
      // (PA_AGENT_RUNTIME=chat_completions); pass them through so that path
      // keeps working.
      memoryBlock,
      history: historyForModel,
      userMessage: event.body,
      session,
      systemInputs,
      tools: turnTools,
    })
    // Defense-in-depth: even if the model echoes a [ISO] prefix, strip it
    // before persisting + sending. Root cause is upstream in
    // `toOpenAIMessages` (was prefixing history bodies); this catches stragglers.
    const reply = stripLeadingIsoTimestamp(text.trim()) || "我暂时没有生成有效回复，请稍后再试。"
    // Phase 24 T1D — telemetry-only coach-token monitor. Pure observation.
    // Hits feed Phase 25 self-evolve dataset. NO transform on `reply`.
    tapCoachTokens(
      reply,
      { turnId, userId: event.userId, replyLength: reply.length },
      (evt, payload) => store.log(evt as string, payload as Record<string, unknown>)
    )
    // Phase 21 Track 4 — small-LLM normalizer. Catches off-voice patterns
    // (A/B framework, pop-therapy, invented categories, productivity probes)
    // that slipped past Bible v5 + few-shot. Fail-open; rollback via
    // PA_LLM_REWRITE_DISABLED=true. Telemetry sinks into pa_turns.usage
    // alongside token counts (rewriteApplied + rewriteReason).
    // Phase 33 — pass last 2 assistant replies as context so rewriter can
    // detect + fix opener repetition (嗯/哎/草) across turns.
    const priorAssistantReplies = (history ?? [])
      .filter((m) => m.role === "assistant")
      .slice(-2)
      .reverse()
      .map((m) => m.body)
    // Phase 35-40 wire-in — wider Claire history (last 5) for F1/F4 detectors
    // + Firestore handle + ids for umbrella-flag-gated module activations.
    // All optional in RewriteContext; modules skip silently when missing.
    const claireHistoryForDetectors = (history ?? [])
      .filter((m) => m.role === "assistant")
      .slice(-5)
      .reverse()
      .map((m) => m.body)
    const rewritten = await rewriteIfOff(
      reply,
      {},
      {
        priorAssistantReplies,
        db: store.db,
        userId: event.userId,
        turnId,
        claireHistoryForDetectors,
        lastUserMessage: event.body,
      }
    )
    // Phase 33 — unconditional telemetry. Without this we can't tell if the
    // rewriter is firing as no_change, timing out, or blocked by diff-guard.
    store.log("pa.voice.llm_rewriter.result", {
      userId: event.userId,
      turnId,
      applied: rewritten.rewriteApplied,
      reason: rewritten.reason,
      circuitOpen: rewritten.circuitOpen ?? false,
      beforeLen: reply.length,
      afterLen: rewritten.text.length,
    })
    // Phase 33b — deterministic opener strip, applied unconditionally so that
    // rewrite_unsafe / circuit_open / timeout fallbacks still get de-tic'd.
    // Phase 33e — also strip 我懂/我懂那种 validation tic (Qwen ignores DROP rule).
    const afterOpenerStrip =
      priorAssistantReplies.length > 0
        ? stripRepeatOpener(rewritten.text, priorAssistantReplies)
        : rewritten.text
    const stripped = stripValidationTic(afterOpenerStrip)
    // Phase 36 wire-in — ImperfectionInjector applied to FINAL visible text
    // post-strip. Gated by paHumanizeRuntimeEnabled umbrella + arm-resolver
    // (PA_IMPERFECTION_ARM env or userId-hash bucket). Default arm = "off"
    // → no-op. Sub-flag PA_IMPERFECTION_INJECTOR_ENABLED=false bypasses
    // entirely. < 5ms p95 latency.
    let replyAfterRewrite = stripped
    let injectorAppliedFlag = false
    let injectorArm: "off" | "low" | "high" = "off"
    try {
      const humanizeOn = await isHumanizeRuntimeEnabled(store.db, event.userId)
      if (humanizeOn && process.env.PA_IMPERFECTION_INJECTOR_ENABLED !== "false") {
        injectorArm = resolveArm(event.userId ?? "")
        if (injectorArm !== "off") {
          const injResult = injectImperfection({
            text: stripped,
            arm: injectorArm,
            userId: event.userId,
            prevAssistantReply: priorAssistantReplies[0],
          })
          replyAfterRewrite = injResult.injected
          injectorAppliedFlag = injResult.applied
          if (injResult.applied) {
            store.log("pa.voice.imperfection_injector.applied", {
              userId: event.userId,
              turnId,
              arm: injResult.arm,
              type: injResult.injection_type,
              position: injResult.position,
              beforeLen: stripped.length,
              afterLen: injResult.injected.length,
            })
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      store.log("pa.voice.imperfection_injector.error", {
        userId: event.userId,
        turnId,
        error: msg,
      })
      replyAfterRewrite = stripped
    }
    void injectorAppliedFlag
    void injectorArm
    // Phase 35/38 wire-in (LIFTED) — detectors + trackAdvice run on the FINAL
    // visible text regardless of `rewriteIfOff` outcome. Previously these
    // were gated behind the rewriter happy-path inside `rewriteIfOff` and
    // never fired on no_change / rewrite_unsafe / timeout exits, which is
    // why pa-advice-tracker stayed empty post-deploy-00023 even with the
    // umbrella flag ON for allowlisted users.
    try {
      const humanizeOnPost = await isHumanizeRuntimeEnabled(store.db, event.userId)
      if (humanizeOnPost) {
        if (process.env.PA_DETECTORS_ENABLED !== "false") {
          try {
            const detectorCtx: DetectorContext = {
              turn: { user: event.body, assistant: replyAfterRewrite },
              history: { claireReplies: claireHistoryForDetectors },
            }
            const detectorResults = await runAllDetectors(detectorCtx)
            const triggered = detectorResults.filter((r) => r.triggered)
            if (triggered.length > 0) {
              store.log("pa.voice.detectors.triggered", {
                userId: event.userId,
                turnId,
                detectors: triggered.map((r) => ({
                  id: r.id,
                  action: r.suggested_action ?? null,
                })),
              })
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            store.log("pa.voice.detectors.error", { userId: event.userId, turnId, error: msg })
          }
        }
        if (
          process.env.PA_MEMORY_POLICY_ENABLED !== "false" &&
          store.db &&
          event.userId &&
          turnId
        ) {
          void trackAdvice(
            event.userId,
            replyAfterRewrite,
            turnId,
            { db: store.db }
          ).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            store.log("pa.voice.advice_tracker.error", { userId: event.userId, turnId, error: msg })
          })
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      store.log("pa.voice.wire_in_post_hooks.error", {
        userId: event.userId,
        turnId,
        error: msg,
      })
    }
    if (rewritten.rewriteApplied) {
      store.log("pa.voice.llm_rewriter.applied", {
        userId: event.userId,
        turnId,
        reason: rewritten.reason,
        beforeLen: reply.length,
        afterLen: replyAfterRewrite.length,
      })
    }
    const rawVisible =
      mem.mem0Degraded && agent.memoryMode !== "firestore_only"
        ? `${replyAfterRewrite}\n\n（长期语义记忆暂时不可用；我仍使用已确认事实和最近对话。）`
        : replyAfterRewrite
    const norm = normalizeForIMessage(rawVisible, { maxLength: 600 })
    const visibleReply = norm.text
    const outboundParts =
      norm.chunks && norm.chunks.length > 1 ? norm.chunks : [visibleReply]

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
        ...(outboundParts.length > 1 ? { outputChunks: outboundParts } : {}),
        ...(norm.droppedTracking.length > 0 ? { droppedUrlParams: norm.droppedTracking } : {}),
      },
    })
    const after = await store.afterAssistantTurn(agent, {
      userId: event.userId,
      mem0UserId: mem0PartitionKey,
      sessionId: event.sessionId,
      userText: event.body,
      assistantText: reply,
      memoryMode: agent.memoryMode,
    })
    // Phase 19 ADAPT-03 — long-term style preference write. Per D-07 the
    // kill switch must ALSO disable mem0/style writes (otherwise rollback
    // bleeds state across sessions). We piggyback on mirror.snapshot:
    // when the kill switch is on, computeMirrorForTurn returns nulls so
    // this block is a no-op. Per-turn drift gate (in writeStylePreference)
    // collapses churn — chosen over a true session-end hook because
    // iMessage has no explicit session boundary, and drift-gating gives
    // the same end-state with simpler wiring (CONTEXT.md "Claude's
    // Discretion" §debounce).
    if (mirror.snapshot) {
      try {
        await writeStylePreference(
          mem0PartitionKey,
          mirror.snapshot,
          store.nowIso()
        )
      } catch (e) {
        store.log("[orchestrator] writeStylePreference failed", {
          turnId,
          userId: event.userId,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    if (!shouldSuppressOutbound(event)) {
      for (let i = 0; i < outboundParts.length; i++) {
        const part = outboundParts[i]!
        const idk = outboundParts.length > 1 ? `outbound-${event.id}-c${i}` : `outbound-${event.id}`
        await store.enqueueOutbound(event.userId, event.from, part, {
          sessionId: event.sessionId,
          role: "assistant",
          idempotencyKey: idk,
        })
      }
    }
    // Phase 30 T2 — Downstream Eval Connector hook (P9-Connectors).
    // Fire-and-forget: we await with a soft 2s budget so the chat path is
    // never blocked, but the underlying work continues in background. Any
    // failure inside the connector is swallowed (logged in `downstream.ts`).
    // Test paths that omit `store.db` skip the connector entirely.
    if (store.db != null) {
      const work = runDownstreamConnector(
        store.db,
        {
          userId: event.userId,
          conversationId: event.sessionId,
          lastUserTurn: event.body,
          lastAssistantTurn: visibleReply,
        },
        {
          log: (msg, fields) => store.log(`[downstream] ${msg}`, { turnId, ...(fields ?? {}) }),
          // Phase 30 — wire the production nano judge so kind=llm-judge
          // triggers actually evaluate at runtime. Without this, those
          // triggers silently no-op (evaluateTriggers returns no match
          // when llmJudge is undefined). 0 net new LLM calls when
          // `evalConnectorsEnabled=false` (master kill switch short-circuits
          // before any judge runs).
          llmJudge: defaultNlJudge,
        }
      ).catch((e) => {
        store.log("[downstream] runDownstreamConnector threw (should never happen)", {
          turnId,
          error: e instanceof Error ? e.message : String(e),
        })
      })
      await withSoftBudget(work, 2000, undefined)
    }
    // Phase 26 T3 — emit structured cost log (P9-Prod-Ops). Cloud Logging
    // aggregates this via the user-defined metric `pa.spend.daily`
    // (definition: infra/cloud-logging/README.md). The matching emitter
    // helper for non-orchestrator call sites is
    // `apps/functions/src/instrumentation/cost-logger.ts`.
    if (usage) {
      const u = usage as Record<string, unknown>
      store.log("pa.spend.daily", { "pa.metric": "pa.spend.daily", model: String((agent as { modelId?: string }).modelId ?? "unknown"), inputTokens: Number(u.inputTokens ?? 0), outputTokens: Number(u.outputTokens ?? 0), turnId, userId: event.userId })
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
      // Phase 21 Track 4 — telemetry for the LLM rewriter pass. Always
      // logged (even when not applied) so we can compute rewrite-rate
      // offline. `rewriteReason` distinguishes timeout/error/no-change/
      // rewritten/disabled — see voice/llm-rewriter.ts RewriteReason.
      usagePatch.rewriteApplied = rewritten.rewriteApplied
      usagePatch.rewriteReason = rewritten.reason
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
  // Phase 19 ADAPT-03 — provision the Firestore-backed voice style store
  // at orchestrator boot. Tests that build their own store should call
  // setVoiceStyleStore(createInMemoryVoiceStyleStore()) BEFORE invoking
  // processInboundEvent (or skip mirror-write entirely via the kill switch).
  setVoiceStyleStore(createFirestoreVoiceStyleStore(db))
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
        if (!existing.empty) {
          // Phase 10.5: SDK FirestoreSession.addItems may have already
          // written this row before the orchestrator's appendMessage call
          // (same hash idempotencyKey). Merge orchestrator-owned metadata
          // (rawMeta, idempotencyKey) into the existing row so dashboard /
          // harness consumers can still find it via rawMeta.eventId.
          // Phase 33c: also overwrite body — SDK stored the raw model reply,
          // orchestrator has the Qwen-rewritten body. History reads must see
          // the rewritten text so opener-rotation detection works correctly.
          const docRef = existing.docs[0]!.ref
          const existingBody = existing.docs[0]!.data().body
          const patch: Record<string, unknown> = {}
          if (message.rawMeta !== undefined) patch.rawMeta = message.rawMeta
          if (message.idempotencyKey !== undefined) patch.idempotencyKey = message.idempotencyKey
          if (message.body !== undefined && message.body !== existingBody) patch.body = message.body
          if (Object.keys(patch).length > 0) {
            await docRef.set(patch, { merge: true })
          }
          return
        }
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
    async getMem0UserId(userId) {
      const u = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      const raw = (u.data() as { mem0UserId?: string | null } | undefined)?.mem0UserId
      if (typeof raw === "string" && raw.trim().length > 0) return raw.trim()
      return undefined
    },
    async loadHistory(sessionId, limit) {
      // Fetch extra to allow dedup — SDK may write a second doc for the same
      // turn (same idempotencyKey, base model body). Prefer pa_orchestrator
      // source (rewritten body) so opener-rotation detection sees correct text.
      const msgs = await loadRecentMessages(db, sessionId, limit * 3)
      const seen = new Map<string, (typeof msgs)[0]>()
      for (const msg of msgs) {
        const key = (msg as Record<string, unknown>).idempotencyKey as string | undefined ?? msg.id
        const existing = seen.get(key)
        if (!existing) {
          seen.set(key, msg)
        } else {
          const isOrch = ((msg as Record<string, unknown>).rawMeta as Record<string, unknown> | undefined)?.source === "pa_orchestrator"
          if (isOrch) seen.set(key, msg)
        }
      }
      return Array.from(seen.values())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-limit)
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
    async checkInboundSafety(event) {
      const rl = await enforceRateLimit(db, { userId: event.userId, channel: event.channel })
      if (!rl.allow) {
        await appendAuditEvent(db, {
          kind: "rate_limit",
          message: "Inbound blocked: rate limit",
          userId: event.userId,
          sessionId: event.sessionId,
          inboundEventId: event.id,
          actor: "orchestrator",
        })
        return { allow: false, reason: rl.reason }
      }
      // Phase 23 — checkPromptInjectionAndRecord writes the pa_abuse_events row
      // (kind=prompt_injection) in addition to the audit event. The sync
      // checkPromptInjection is still imported for tests that don't need DB.
      const inj = await checkPromptInjectionAndRecord(db, {
        userId: event.userId,
        channel: event.channel,
        text: event.body,
      })
      if (!inj.allow) {
        return { allow: false, reason: inj.reason }
      }
      return { allow: true }
    },
    nowIso,
    log: (...args) => console.log(new Date().toISOString(), ...args),
    // Phase 24.5 — Firestore handle threaded into store so flag-backed
    // kill-switches (e.g. PA_VOICE_MIRROR_DISABLED) consult pa_feature_flags.
    db,
    // Phase 22 — proactive cancellation (D-07, PROACTIVE-06)
    async cancelAllPendingProactiveJobs(userId) {
      const snap = await db
        .collection(PA_COLLECTIONS.scheduledJobs)
        .where("userId", "==", userId)
        .where("status", "==", "pending")
        .get()
      if (snap.empty) return 0
      const batch = db.batch()
      for (const doc of snap.docs) {
        batch.update(doc.ref, {
          status: "cancelled_by_user",
          updatedAt: nowIso(),
        })
      }
      await batch.commit()
      return snap.size
    },
    async writeProactiveCancelAudit({ userId, sessionId, inboundEventId, cancelledCount }) {
      await appendAuditEvent(db, {
        kind: "proactive_cancel",
        message: `Cancelled ${cancelledCount} pending proactive job(s) via NLU`,
        userId,
        sessionId,
        inboundEventId,
        actor: "orchestrator",
        meta: { cancelledCount },
      })
    },
    // Phase 23 — onboarding state machine
    async getOnboardingUser(userId) {
      const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      if (!snap.exists) return null
      const data = snap.data() as {
        id?: string
        phoneE164?: string
        onboardingState?: "pending" | "first_mes_sent" | "grounding_q1_asked" | "complete"
      }
      return {
        id: data.id ?? userId,
        phoneE164: data.phoneE164 ?? "",
        onboardingState: data.onboardingState,
      }
    },
    async applyOnboarding(userId, phoneE164, step) {
      await applyOnboardingStep(db, { id: userId, phoneE164, onboardingState: undefined }, step)
    },
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
