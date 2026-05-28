/**
 * 2026-05-18 — runtime wire-up for the chat → tag + memory extractor.
 *
 * Provides the concrete dep injection for `runExtraction` so the
 * orchestrator turn handler can fire-and-forget the extractor without
 * carrying around OpenAI / Anthropic / Qdrant plumbing.
 *
 * Three layers:
 *   1. `makeExtractorDeps(opts)` — builds a `ConversationExtractorDeps`
 *      bundle backed by:
 *        - OpenAI gpt-5.4-nano JSON-mode (primary) → Anthropic claude-
 *          sonnet-4-6 (fallback) for LLM
 *        - `applyPartialUserTags(source:'chat')` for the Firestore tag write
 *        - Qdrant pa_memory_entities upsert for memory entity writes
 *        - `pa-cost-ledger` row per LLM call
 *        - `pa-extraction-runs` audit row per successful run
 *
 *   2. `maybeRunExtractor(...)` — convenience wrapper the turn handler
 *      calls. Reads `pa-users.{uid}.extractionState`, runs
 *      `shouldRunExtractor`, fires the LLM if and only if the trigger
 *      decision is true, then persists the new extractionState. Skips
 *      cleanly when `onboardingState !== "complete"` or an active
 *      prescreen session is detected.
 *
 *   3. `buildNeedsOnboardingDirective(missingAxes)` — composes the Claire
 *      system-prompt injection text when V16 surfaces a `needsOnboarding`
 *      flag. The orchestrator inserts the directive into the assistant
 *      prompt so Claire weaves the missing onboarding questions back into
 *      the next 2-3 replies.
 *
 * Feature flag: `PA_CHAT_EXTRACTOR_ENABLED=true` enables the live LLM call.
 * Default off (the trigger evaluator still runs and persists state, but
 * `runExtraction` is short-circuited) so the rollout is opt-in until live
 * verify lands.
 */

import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"
import type { Firestore } from "firebase-admin/firestore"
import {
  shouldRunExtractor,
  runExtraction,
  ConversationExtractResultSchema,
  type ExtractorTriggerState,
  type ExtractorTriggerKind,
  type ConversationExtractMessage,
  type ConversationExtractRequest,
  type ConversationExtractorDeps,
  type ExtractionLlmCall,
  type MemoryEntity,
  type RunExtractionOutcome,
} from "./conversation-extractor.js"
import { applyPartialUserTags } from "./tags/user-tags-writer.js"

const PA_USERS_COLLECTION = "pa-users"
const COST_LEDGER_COLLECTION = "pa-cost-ledger"
const AUDIT_COLLECTION = "pa-extraction-runs"

const OPENAI_MODEL = "gpt-5.4-nano"
const ANTHROPIC_MODEL = "claude-sonnet-4-6"

const OPENAI_USD_PER_1K_INPUT = 0.0001 // pre-launch budget reference; tune at deploy
const OPENAI_USD_PER_1K_OUTPUT = 0.0003
const ANTHROPIC_USD_PER_1K_INPUT = 0.003
const ANTHROPIC_USD_PER_1K_OUTPUT = 0.015

const QDRANT_MEMORY_ENTITIES_COLLECTION = "pa_memory_entities"

// Soft ceiling on tokens we send to the model. gpt-5.4-nano supports much
// more, but this caps cost and aligns with the "compact" trigger threshold.
const PROMPT_TOKEN_BUDGET = 6_000

// ────────────────────────────────────────────────────────────────────────
// LLM caller
// ────────────────────────────────────────────────────────────────────────

let cachedOpenAI: OpenAI | null = null
function openAiClient(): OpenAI {
  if (cachedOpenAI) return cachedOpenAI
  const apiKey =
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || ""
  cachedOpenAI = new OpenAI({ apiKey })
  return cachedOpenAI
}

let cachedAnthropic: Anthropic | null = null
function anthropicClient(): Anthropic | null {
  if (cachedAnthropic) return cachedAnthropic
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || ""
  if (!apiKey) return null
  cachedAnthropic = new Anthropic({ apiKey })
  return cachedAnthropic
}

function estimateCostUsd(args: {
  provider: "openai" | "anthropic"
  inputTokens: number
  outputTokens: number
}): number {
  if (args.provider === "openai") {
    return (
      (args.inputTokens / 1000) * OPENAI_USD_PER_1K_INPUT +
      (args.outputTokens / 1000) * OPENAI_USD_PER_1K_OUTPUT
    )
  }
  return (
    (args.inputTokens / 1000) * ANTHROPIC_USD_PER_1K_INPUT +
    (args.outputTokens / 1000) * ANTHROPIC_USD_PER_1K_OUTPUT
  )
}

function safeParseJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith("```")) {
    // Strip ```json ... ``` fences the model sometimes emits.
    const inner = trimmed.replace(/^```(json)?\s*/i, "").replace(/```$/i, "")
    return JSON.parse(inner)
  }
  return JSON.parse(trimmed)
}

const SYSTEM_PROMPT =
  "You extract canonical preference deltas from chat between a job-seeker and an assistant. " +
  "Output JSON only that validates the `ConversationExtractResult` schema (tagPatch, " +
  "memoryEntities, confidence, rationale). No prose."

async function callOpenAi(args: {
  prompt: string
}): Promise<Awaited<ReturnType<ExtractionLlmCall>>> {
  const client = openAiClient()
  const resp = await client.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: args.prompt },
    ],
  })
  const raw = resp.choices?.[0]?.message?.content ?? "{}"
  const json = safeParseJson(raw)
  const inputTokens = resp.usage?.prompt_tokens ?? 0
  const outputTokens = resp.usage?.completion_tokens ?? 0
  return {
    json,
    modelUsed: OPENAI_MODEL,
    tokensIn: inputTokens,
    tokensOut: outputTokens,
    costUsd: estimateCostUsd({ provider: "openai", inputTokens, outputTokens }),
  }
}

async function callAnthropic(args: {
  prompt: string
}): Promise<Awaited<ReturnType<ExtractionLlmCall>>> {
  const client = anthropicClient()
  if (!client) throw new Error("anthropic_unavailable")
  const resp = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: args.prompt }],
  })
  const text = resp.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("")
  const json = safeParseJson(text)
  const inputTokens = resp.usage?.input_tokens ?? 0
  const outputTokens = resp.usage?.output_tokens ?? 0
  return {
    json,
    modelUsed: ANTHROPIC_MODEL,
    tokensIn: inputTokens,
    tokensOut: outputTokens,
    costUsd: estimateCostUsd({ provider: "anthropic", inputTokens, outputTokens }),
  }
}

/** OpenAI-primary, Anthropic-fallback LLM call for the extractor. */
export const productionLlmCall: ExtractionLlmCall = async ({ prompt }) => {
  try {
    return await callOpenAi({ prompt })
  } catch (primaryErr) {
    const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
    if (!anthropicClient()) {
      throw new Error(`openai_failed_no_fallback: ${msg}`)
    }
    return callAnthropic({ prompt })
  }
}

// ────────────────────────────────────────────────────────────────────────
// Qdrant memory-entities writer
// ────────────────────────────────────────────────────────────────────────

/**
 * Upsert one Qdrant point per extracted memory entity. Each point is keyed
 * deterministically by `${userId}:${entityKind}:${value}` so a repeat
 * extraction with the same evidence does not balloon the index.
 *
 * Embeddings are NOT generated here — the pa_memory_entities collection
 * supports payload-only points via a placeholder vector (zeroes). The
 * matching layer reads payload, not vector cosine, for entity recall.
 */
export async function writeMemoryEntitiesToQdrant(args: {
  userId: string
  ents: MemoryEntity[]
  qdrantUrl: string
  qdrantApiKey: string
  fetchFn?: typeof fetch
  vectorSize?: number
  collection?: string
}): Promise<{ ok: boolean; added: number; error?: string }> {
  if (args.ents.length === 0) return { ok: true, added: 0 }
  const url = args.qdrantUrl.replace(/\/+$/, "")
  const collection = args.collection ?? QDRANT_MEMORY_ENTITIES_COLLECTION
  const fetchFn = args.fetchFn ?? fetch
  const headers = {
    "api-key": args.qdrantApiKey,
    "content-type": "application/json",
  }
  // Discover the collection's vector size lazily so we never push a
  // mismatched dimension. Use the collection info endpoint (GET, no body).
  let vectorSize = args.vectorSize ?? 0
  if (!vectorSize) {
    const info = await fetchFn(`${url}/collections/${collection}`, {
      method: "GET",
      headers: { "api-key": args.qdrantApiKey },
    })
    if (info.ok) {
      const json = (await info.json()) as {
        result?: { config?: { params?: { vectors?: { size?: number } } } }
      }
      vectorSize = json.result?.config?.params?.vectors?.size ?? 1536
    } else {
      vectorSize = 1536
    }
  }
  const placeholderVector = new Array<number>(vectorSize).fill(0)

  // Qdrant accepts unsigned-int or UUID ids; build a deterministic short
  // uuid-v5-style hash so re-extraction is idempotent.
  const points = await Promise.all(
    args.ents.map(async (e) => ({
      id: await deterministicQdrantId(args.userId, e.entityKind, e.value),
      vector: placeholderVector,
      payload: {
        user_id: args.userId,
        entity_kind: e.entityKind,
        value: e.value,
        confidence: e.confidence,
        evidence: e.evidence,
        extracted_at: new Date().toISOString(),
        source: "chat_extractor",
      },
    })),
  )

  const r = await fetchFn(`${url}/collections/${collection}/points?wait=true`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ points }),
  })
  if (!r.ok) {
    return { ok: false, added: 0, error: `${r.status} ${await r.text()}` }
  }
  return { ok: true, added: points.length }
}

async function deterministicQdrantId(
  userId: string,
  entityKind: string,
  value: string,
): Promise<string> {
  const input = `${userId}\x00${entityKind}\x00${value}`
  const encoder = new TextEncoder()
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(input))
  const bytes = new Uint8Array(buf)
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  // Format as a UUID-v4-shaped string (Qdrant accepts arbitrary UUID strings
  // for the point id; deterministic content is what matters for idempotency).
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    "a" + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-")
}

// ────────────────────────────────────────────────────────────────────────
// Dep bundle
// ────────────────────────────────────────────────────────────────────────

export interface MakeExtractorDepsOptions {
  db: Firestore
  log?: (event: string, payload?: Record<string, unknown>) => void
  qdrantUrl?: string
  qdrantApiKey?: string
  /** Override the LLM caller (tests inject a stub). */
  llm?: ExtractionLlmCall
  /** Override the Qdrant writer (tests inject a stub). */
  writeMemoryEntities?: ConversationExtractorDeps["writeMemoryEntities"]
}

/**
 * Build the live `ConversationExtractorDeps` bundle. Reads QDRANT_URL +
 * QDRANT_API_KEY from process.env when not passed; logs every layer to the
 * caller-provided logger.
 */
export function makeExtractorDeps(opts: MakeExtractorDepsOptions): ConversationExtractorDeps {
  const log = opts.log ?? (() => {})
  const qdrantUrl = (opts.qdrantUrl ?? process.env.QDRANT_URL ?? "").trim()
  const qdrantApiKey = (opts.qdrantApiKey ?? process.env.QDRANT_API_KEY ?? "").trim()

  const writeMemoryEntities: ConversationExtractorDeps["writeMemoryEntities"] =
    opts.writeMemoryEntities ??
    (async (userId, ents) => {
      if (!qdrantUrl || !qdrantApiKey) {
        return { ok: false, added: 0, error: "qdrant_credentials_missing" }
      }
      return writeMemoryEntitiesToQdrant({
        userId,
        ents,
        qdrantUrl,
        qdrantApiKey,
      })
    })

  const writeUserTags: ConversationExtractorDeps["writeUserTags"] = async (userId, patch) => {
    return applyPartialUserTags(opts.db, userId, patch, { source: "chat", log })
  }

  const writeCostLedger: ConversationExtractorDeps["writeCostLedger"] = async (entry) => {
    try {
      await opts.db.collection(COST_LEDGER_COLLECTION).add({
        ...entry,
        source: "conversation_extractor",
      })
    } catch (err) {
      log("pa.conversation_extractor.cost_ledger_write_error", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const writeAudit: ConversationExtractorDeps["writeAudit"] = async (entry) => {
    try {
      await opts.db.collection(AUDIT_COLLECTION).add(entry)
    } catch (err) {
      log("pa.conversation_extractor.audit_write_error", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    llm: opts.llm ?? productionLlmCall,
    writeUserTags,
    writeMemoryEntities,
    writeCostLedger,
    writeAudit,
    log,
    now: () => new Date(),
  }
}

// ────────────────────────────────────────────────────────────────────────
// Turn-handler convenience wrapper
// ────────────────────────────────────────────────────────────────────────

export interface ExtractionState {
  lastExtractedAt: string | null
  lastExtractedTurnCount: number
  cumulativeExtractions: number
  lastModelUsed?: string
}

const DEFAULT_STATE: ExtractionState = {
  lastExtractedAt: null,
  lastExtractedTurnCount: 0,
  cumulativeExtractions: 0,
}

export async function readExtractionState(
  db: Firestore,
  userId: string,
): Promise<ExtractionState> {
  const snap = await db.collection(PA_USERS_COLLECTION).doc(userId).get()
  const raw = snap.data()?.extractionState as Partial<ExtractionState> | undefined
  return {
    ...DEFAULT_STATE,
    ...(raw ?? {}),
  }
}

export async function writeExtractionState(
  db: Firestore,
  userId: string,
  next: ExtractionState,
): Promise<void> {
  // Firestore rejects `undefined` values; strip any optional field that the
  // caller didn't fill in so the merge write goes through cleanly.
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(next)) {
    if (v !== undefined) cleaned[k] = v
  }
  await db
    .collection(PA_USERS_COLLECTION)
    .doc(userId)
    .set({ extractionState: cleaned, updatedAt: new Date().toISOString() }, { merge: true })
}

export interface MaybeRunExtractorArgs {
  db: Firestore
  userId: string
  recentMessages: ConversationExtractMessage[]
  existingTags: Record<string, unknown>
  /** Live onboardingState — extractor short-circuits if !== "complete". */
  onboardingState?: string | null
  /** Active prescreen sessionId — extractor short-circuits if set. */
  activePrescreenSessionId?: string | null
  /** Estimated tokens of transcript visible to the chat model (post-compaction). */
  estimatedTranscriptTokens?: number
  /** Hard input cap of the chat model — used for the 75% compact threshold. */
  modelContextLimit?: number
  /** Count of user messages in this turn batch (since last extraction). */
  userMsgsThisBatch?: number
  /** Optional flag for feature gating. Defaults to PA_CHAT_EXTRACTOR_ENABLED env. */
  enabled?: boolean
  /** Caller-supplied logger; defaults to console.log when omitted. */
  log?: (event: string, payload?: Record<string, unknown>) => void
  /** Caller-supplied deps; built lazily via makeExtractorDeps when omitted. */
  deps?: ConversationExtractorDeps
  qdrantUrl?: string
  qdrantApiKey?: string
  /**
   * Caller signals the reducer MUST fire this turn (typically because the
   * conversation arbiter detected `durable_preference_update` intent). Bypasses
   * the `PA_CHAT_EXTRACTOR_ENABLED` feature flag AND every debounce/time-window
   * trigger inside `shouldRunExtractor`. The trigger kind is recorded as
   * `intent_signal` on the run audit so we can separate intent-driven from
   * passive extraction runs.
   *
   * Matcher correctness depends on this firing — when a user says "actually
   * avoid pure SWE, product strategy only", the canonical `pa-users.tags` must
   * be updated BEFORE V16 reads them on the next matcher invocation. Letting
   * the debounce skip this would re-introduce the stale-tag bug.
   */
  forceTrigger?: ExtractorTriggerKind
}

const DEFAULT_MODEL_CONTEXT_LIMIT = 128_000

function envFlagEnabled(): boolean {
  const v = process.env.PA_CHAT_EXTRACTOR_ENABLED
  if (!v) return false
  return v.toLowerCase() === "true" || v === "1"
}

/**
 * Read state → decide → fire-and-forget. Resolves to a discriminated outcome
 * the caller can log; never throws (every error path returns a soft
 * `{ ran: false, reason }`).
 */
export async function maybeRunExtractor(
  args: MaybeRunExtractorArgs,
): Promise<RunExtractionOutcome> {
  const log = args.log ?? (() => {})
  // Intent-driven extraction (forceTrigger) bypasses the feature flag —
  // matcher correctness depends on it. Passive extraction still respects the
  // flag for gradual rollout.
  const enabled = args.forceTrigger ? true : (args.enabled ?? envFlagEnabled())
  if (!enabled) return { ran: false, reason: "feature_flag_off" }
  if (!args.userId) return { ran: false, reason: "no_user_id" }
  if (args.onboardingState && args.onboardingState !== "complete") {
    return { ran: false, reason: `onboarding_incomplete:${args.onboardingState}` }
  }
  if (args.activePrescreenSessionId) {
    return { ran: false, reason: "active_prescreen" }
  }
  if (args.recentMessages.length === 0) {
    return { ran: false, reason: "empty_transcript" }
  }

  let state: ExtractionState
  try {
    state = await readExtractionState(args.db, args.userId)
  } catch (err) {
    log("pa.conversation_extractor.state_read_error", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    state = DEFAULT_STATE
  }

  const triggerState: ExtractorTriggerState = {
    lastExtractedAt: state.lastExtractedAt,
    lastExtractedTurnCount: state.lastExtractedTurnCount,
    currentTurnCount: state.lastExtractedTurnCount + (args.userMsgsThisBatch ?? 1),
    estimatedTranscriptTokens: args.estimatedTranscriptTokens ?? 0,
    modelContextLimit: args.modelContextLimit ?? DEFAULT_MODEL_CONTEXT_LIMIT,
    userMsgsSinceLast: args.userMsgsThisBatch ?? 0,
    nowMs: Date.now(),
    ...(args.forceTrigger ? { forceTrigger: args.forceTrigger } : {}),
  }
  const decision = shouldRunExtractor(triggerState)
  if (!decision.run) {
    log("pa.conversation_extractor.trigger_skipped", {
      userId: args.userId,
      reason: decision.reason,
      triggerState: {
        lastExtractedAt: triggerState.lastExtractedAt,
        userMsgsSinceLast: triggerState.userMsgsSinceLast,
        currentTurnCount: triggerState.currentTurnCount,
      },
    })
    return { ran: false, reason: decision.reason }
  }

  const trigger = decision.trigger as ExtractorTriggerKind
  log("pa.conversation_extractor.trigger_fire", {
    userId: args.userId,
    trigger,
    reason: decision.reason,
  })

  const deps =
    args.deps ??
    makeExtractorDeps({
      db: args.db,
      log,
      qdrantUrl: args.qdrantUrl,
      qdrantApiKey: args.qdrantApiKey,
    })

  const req: ConversationExtractRequest = {
    userId: args.userId,
    recentMessages: args.recentMessages,
    existingTags: args.existingTags,
    trigger,
  }
  const outcome = await runExtraction(req, deps)

  // Persist state regardless of outcome — `cumulativeExtractions` increments
  // on any LLM attempt (counts spend, not success).
  try {
    await writeExtractionState(args.db, args.userId, {
      lastExtractedAt: new Date().toISOString(),
      lastExtractedTurnCount: triggerState.currentTurnCount,
      cumulativeExtractions: state.cumulativeExtractions + 1,
      lastModelUsed: outcome.modelUsed,
    })
  } catch (err) {
    log("pa.conversation_extractor.state_write_error", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return outcome
}

// ────────────────────────────────────────────────────────────────────────
// Claire system-prompt directive for V16 needsOnboarding signal
// ────────────────────────────────────────────────────────────────────────

const AXIS_HUMAN_LABELS: Record<string, string> = {
  targetRoleFunction: "what kind of role they want (engineering, design, sales, etc)",
  targetLocations: "where they want to work (cities or remote)",
  visaStatus: "their work-authorization status (citizen, permanent resident, sponsorship needed)",
  careerStage: "their seniority level / years of experience",
  targetJobType: "the job type they want (full-time, internship, contract)",
}

/**
 * Compose the system-prompt directive to inject when V16 returns
 * `needsOnboarding=true`. The orchestrator concatenates this onto the end
 * of the existing system prompt so Claire weaves the missing onboarding
 * questions into the next 2-3 replies naturally.
 *
 * Returns an empty string when nothing is missing (caller can append
 * unconditionally without changing prompt shape).
 */
export function buildNeedsOnboardingDirective(missingAxes: string[] | undefined): string {
  if (!missingAxes || missingAxes.length === 0) return ""
  const items = missingAxes
    .map((axis) => `- ${AXIS_HUMAN_LABELS[axis] ?? axis}`)
    .join("\n")
  return [
    "",
    "[onboarding-gap]",
    "User's preference profile is incomplete — these axes are missing or empty:",
    items,
    "Weave these questions naturally into your next 2-3 replies. Do NOT ask all",
    "at once — pick whichever fits the user's current message best. Skip if the",
    "user has already volunteered the answer earlier in conversation.",
  ].join("\n")
}

// Re-exports so callers only pull from this module.
export { shouldRunExtractor, runExtraction, ConversationExtractResultSchema }
