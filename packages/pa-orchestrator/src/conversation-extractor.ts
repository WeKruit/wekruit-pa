/**
 * 2026-05-18 — chat → tag + memory extraction hook.
 *
 * Goal: .planning/GOAL-chat-tag-memory-extraction.md
 *
 * Why this exists: post-onboarding free-form chat ("actually I'd consider
 * fintech too", "I'm flexible on LA", "I want at least 140k") flows into
 * Qdrant `pa_memory` but never gets mirrored as structured `pa-users.tags`.
 * The match engine reads `tags` (not mem0 free-text), so chat-evolved
 * preferences never influence ranking. This module periodically scans recent
 * user messages, extracts canonical tag deltas via LLM, and dual-writes both
 * stores so the data flywheel stays coherent.
 *
 * Trigger evaluator runs on every turn (cheap). When ANY of three signals
 * fires (compact-time, 30min/3msg window, 10-turn floor), the orchestrator
 * fire-and-forget calls `runExtraction`. The actual LLM call is debounced 5
 * minutes so we never burn budget twice per turn-storm.
 *
 * Skip conditions: onboardingState !== 'complete' (deterministic q_* path
 * owns those answers), OR an active prescreen session (Claire is screening,
 * not chatting).
 *
 * Tests: __tests__/conversation-extractor.test.ts (10 cases — debounce,
 * compact, time_window, turn_count, no-trigger, empty-patch, dual-write,
 * idempotency, fallback model, confidence threshold).
 */

import { z } from "zod"
import {
  ROLE_FUNCTION_VOCAB,
  INDUSTRY_SECTOR_VOCAB,
  CAREER_STAGE_VOCAB,
  JOB_TYPE_VOCAB,
  type RoleFunction,
  type IndustrySector,
  type CareerStage,
  type JobType,
} from "@wekruit/shared-tags"
import type { PartialUserTags } from "./tags/user-tags-writer.js"

/** 2026-05-18 — visa canonical (D4 from CLAUDE.md). */
export const VISA_STATUS_VOCAB = ["citizen", "permanent_resident", "sponsor_needed", "other"] as const
export type VisaStatus = (typeof VISA_STATUS_VOCAB)[number]

/**
 * Trigger evaluator state shape. Keep this serializable so the orchestrator
 * can persist a snapshot in `pa-users.{uid}.extractionState`.
 */
export interface ExtractorTriggerState {
  /** ISO of the most recent extraction run, or null if never run. */
  lastExtractedAt: string | null
  /** Turn count at the time of the last extraction (used by turn_count floor). */
  lastExtractedTurnCount: number
  /** Current turn count (assistant-turn-aligned). */
  currentTurnCount: number
  /** Estimated total transcript tokens visible to the model in this session. */
  estimatedTranscriptTokens: number
  /** Hard input cap of the model — used to compute the 75% compact threshold. */
  modelContextLimit: number
  /** Count of user messages since the last extraction run. */
  userMsgsSinceLast: number
  /** Caller-injected `Date.now()` — required for determinism in tests. */
  nowMs: number
}

export type ExtractorTriggerKind = "compact" | "time_window" | "turn_count"

export interface ExtractorTriggerDecision {
  /** True if `runExtraction` should fire this turn. */
  run: boolean
  /** Which signal fired (undefined when `run === false`). */
  trigger?: ExtractorTriggerKind
  /** Free-text reason for telemetry / debug. */
  reason: string
}

const DEBOUNCE_MS = 5 * 60 * 1000
const COMPACT_RATIO = 0.75
const TIME_WINDOW_MS = 30 * 60 * 1000
const TIME_WINDOW_MIN_USER_MSGS = 3
const TURN_COUNT_FLOOR = 10

/**
 * Decide whether the extractor should run this turn. Pure / deterministic —
 * all inputs are passed explicitly so the same state always produces the same
 * decision. No I/O.
 *
 * Trigger precedence: debounce > compact > time_window > turn_count.
 * If `lastExtractedAt` is null (cold start) the debounce check is skipped so
 * the very first crossing of any threshold fires.
 */
export function shouldRunExtractor(state: ExtractorTriggerState): ExtractorTriggerDecision {
  // Debounce — applies once we've ever extracted before.
  if (state.lastExtractedAt) {
    const lastMs = Date.parse(state.lastExtractedAt)
    if (!Number.isFinite(lastMs)) {
      // Corrupted ISO — treat as if never run (cold start).
    } else if (state.nowMs - lastMs < DEBOUNCE_MS) {
      return { run: false, reason: "debounce_5min" }
    }
  }

  // Compact-time: transcript fills > 75% of model context.
  if (
    state.modelContextLimit > 0 &&
    state.estimatedTranscriptTokens / state.modelContextLimit >= COMPACT_RATIO
  ) {
    return { run: true, trigger: "compact", reason: "transcript_75pct_of_ctx" }
  }

  // Time-window: 30min+ AND 3+ user messages since last.
  if (state.lastExtractedAt) {
    const lastMs = Date.parse(state.lastExtractedAt)
    if (Number.isFinite(lastMs)) {
      const elapsedMs = state.nowMs - lastMs
      if (elapsedMs >= TIME_WINDOW_MS && state.userMsgsSinceLast >= TIME_WINDOW_MIN_USER_MSGS) {
        return { run: true, trigger: "time_window", reason: ">30min_>3msgs" }
      }
    }
  }

  // Turn-count floor: 10 turns since last.
  const turnsSinceLast = state.currentTurnCount - state.lastExtractedTurnCount
  if (turnsSinceLast >= TURN_COUNT_FLOOR) {
    return { run: true, trigger: "turn_count", reason: "10_turns_floor" }
  }

  return { run: false, reason: "no_trigger_yet" }
}

// ────────────────────────────────────────────────────────────────────────
// runExtraction
// ────────────────────────────────────────────────────────────────────────

export interface ConversationExtractMessage {
  role: "user" | "assistant"
  body: string
  /** ISO timestamp; required so the prompt can give the model temporal hints. */
  createdAt: string
}

export interface ConversationExtractRequest {
  userId: string
  /** Last ~20 turns (orchestrator caller decides slice depth). */
  recentMessages: ConversationExtractMessage[]
  /** Current `pa-users.{uid}.tags` snapshot — model must not duplicate. */
  existingTags: Record<string, unknown>
  trigger: ExtractorTriggerKind
}

export interface MemoryEntity {
  entityKind: string
  value: string
  confidence: number
  evidence: string
}

/** Canonical schema for the LLM response. Strict — drops unknown fields. */
export const ConversationExtractResultSchema = z.object({
  tagPatch: z
    .object({
      targetRoleFunction: z.array(z.enum(ROLE_FUNCTION_VOCAB)).optional(),
      industrySector: z.array(z.enum(INDUSTRY_SECTOR_VOCAB)).optional(),
      visaStatus: z.enum(VISA_STATUS_VOCAB).optional(),
      careerStage: z.enum(CAREER_STAGE_VOCAB).optional(),
      targetJobType: z.array(z.enum(JOB_TYPE_VOCAB)).optional(),
      targetLocations: z.array(z.string().min(1).max(80)).optional(),
      minSalaryUsd: z.number().int().nonnegative().optional(),
      relevantTags: z.array(z.string().min(1).max(40)).max(12).optional(),
    })
    .strict(),
  memoryEntities: z.array(
    z.object({
      entityKind: z.string().min(1).max(80),
      value: z.string().min(1).max(240),
      confidence: z.number().min(0).max(1),
      evidence: z.string().min(1).max(400),
    })
  ),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(0).max(800),
})

export type ConversationExtractResult = z.infer<typeof ConversationExtractResultSchema>

export type ExtractionLlmCall = (args: {
  prompt: string
  schemaName: "ConversationExtractResult"
}) => Promise<{
  json: unknown
  modelUsed: string
  tokensIn: number
  tokensOut: number
  costUsd: number
}>

export interface ConversationExtractorDeps {
  llm: ExtractionLlmCall
  writeUserTags: (
    userId: string,
    patch: PartialUserTags,
  ) => Promise<{ ok: boolean; error?: string }>
  writeMemoryEntities: (
    userId: string,
    ents: MemoryEntity[],
  ) => Promise<{ ok: boolean; added: number; error?: string }>
  writeCostLedger?: (entry: {
    api: string
    cost_usd: number
    success: boolean
    ts: string
    userId: string
    model: string
  }) => Promise<void>
  writeAudit?: (entry: {
    userId: string
    trigger: ExtractorTriggerKind
    tagFieldsChanged: string[]
    memoryEntitiesAdded: number
    confidence: number
    modelUsed: string
    runAt: string
  }) => Promise<void>
  log?: (event: string, payload?: Record<string, unknown>) => void
  now?: () => Date
}

export interface RunExtractionOutcome {
  ran: boolean
  reason: string
  tagFieldsChanged?: string[]
  memoryEntitiesAdded?: number
  confidence?: number
  modelUsed?: string
}

/** Minimum LLM confidence for any write. Below this → audit + skip. */
export const MIN_CONFIDENCE = 0.7

/**
 * Build the extractor prompt. Exposed for tests so the canonical vocab list
 * is verifiable from a single source. The prompt is intentionally strict +
 * deltas-only — the model must NOT duplicate existing tags.
 */
export function buildExtractorPrompt(req: ConversationExtractRequest): string {
  const turns = req.recentMessages
    .slice(-20)
    .map((m) => `[${m.role}] ${m.body}`)
    .join("\n")

  return [
    "You are an extraction agent for a candidate-marketplace product. Read the recent",
    "conversation and emit canonical preference deltas the user volunteered in chat.",
    "",
    "Rules:",
    "  - Output ONLY new info (deltas). If `existingTags` already has a value, do NOT re-emit.",
    "  - Use the closed enums below; do NOT invent values.",
    "  - Skip ambiguous signals — emit only what the user clearly stated.",
    "  - `confidence` is your overall belief in the extraction (0..1).",
    `  - If confidence < ${MIN_CONFIDENCE}, return empty tagPatch + empty memoryEntities.`,
    "",
    "Canonical vocabs:",
    `  roleFunction:   ${ROLE_FUNCTION_VOCAB.join(", ")}`,
    `  industrySector: ${INDUSTRY_SECTOR_VOCAB.join(", ")}`,
    `  visaStatus:     ${VISA_STATUS_VOCAB.join(", ")}`,
    `  careerStage:    ${CAREER_STAGE_VOCAB.join(", ")}`,
    `  jobType:        ${JOB_TYPE_VOCAB.join(", ")}`,
    "",
    "Existing tags (do NOT duplicate):",
    JSON.stringify(req.existingTags),
    "",
    "Recent conversation (oldest → newest):",
    turns,
    "",
    "Output JSON only — schema: ConversationExtractResult.",
  ].join("\n")
}

/**
 * Run the extractor end-to-end. Idempotent at the write layer:
 *   - `applyPartialUserTags` is merge-safe (writeUserTags wraps it).
 *   - Memory-entity writes are deduped by (userId, entityKind, value).
 *
 * Fail-open: LLM errors, parse errors, write errors are all logged + return
 * a soft outcome. The caller (turn handler) must not block the user reply.
 */
export async function runExtraction(
  req: ConversationExtractRequest,
  deps: ConversationExtractorDeps,
): Promise<RunExtractionOutcome> {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => new Date())

  if (!req.userId) {
    log("pa.conversation_extractor.skip", { reason: "no_user_id" })
    return { ran: false, reason: "no_user_id" }
  }
  if (req.recentMessages.length === 0) {
    log("pa.conversation_extractor.skip", { reason: "empty_transcript" })
    return { ran: false, reason: "empty_transcript" }
  }

  const prompt = buildExtractorPrompt(req)
  let llmOut: Awaited<ReturnType<ExtractionLlmCall>>
  try {
    llmOut = await deps.llm({ prompt, schemaName: "ConversationExtractResult" })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log("pa.conversation_extractor.llm_error", { userId: req.userId, error: msg })
    return { ran: false, reason: `llm_error:${msg}` }
  }

  // Cost ledger row — append regardless of parse outcome so spend is visible.
  if (deps.writeCostLedger) {
    try {
      await deps.writeCostLedger({
        api: "openai",
        cost_usd: llmOut.costUsd,
        success: true,
        ts: now().toISOString(),
        userId: req.userId,
        model: llmOut.modelUsed,
      })
    } catch (err) {
      log("pa.conversation_extractor.cost_ledger_error", {
        userId: req.userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  let parsed: ConversationExtractResult
  try {
    parsed = ConversationExtractResultSchema.parse(llmOut.json)
  } catch (err) {
    log("pa.conversation_extractor.parse_error", {
      userId: req.userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ran: false, reason: "parse_error" }
  }

  if (parsed.confidence < MIN_CONFIDENCE) {
    log("pa.conversation_extractor.low_confidence", {
      userId: req.userId,
      confidence: parsed.confidence,
      threshold: MIN_CONFIDENCE,
    })
    return {
      ran: false,
      reason: "low_confidence",
      confidence: parsed.confidence,
      modelUsed: llmOut.modelUsed,
    }
  }

  const tagFields = Object.keys(parsed.tagPatch)
  const memoryCount = parsed.memoryEntities.length

  if (tagFields.length === 0 && memoryCount === 0) {
    log("pa.conversation_extractor.empty_patch", {
      userId: req.userId,
      confidence: parsed.confidence,
    })
    return {
      ran: false,
      reason: "empty_patch",
      confidence: parsed.confidence,
      modelUsed: llmOut.modelUsed,
    }
  }

  // Dual-write with Promise.allSettled so a Qdrant outage never blocks the
  // Firestore write (or vice versa). Both are logged on failure.
  const tagPatch: PartialUserTags = parsed.tagPatch as PartialUserTags
  const [tagWrite, memWrite] = await Promise.allSettled([
    tagFields.length > 0
      ? deps.writeUserTags(req.userId, tagPatch)
      : Promise.resolve({ ok: true } as { ok: boolean }),
    memoryCount > 0
      ? deps.writeMemoryEntities(req.userId, parsed.memoryEntities)
      : Promise.resolve({ ok: true, added: 0 } as { ok: boolean; added: number }),
  ])

  if (tagWrite.status === "rejected") {
    log("pa.conversation_extractor.tag_write_error", {
      userId: req.userId,
      error: tagWrite.reason instanceof Error ? tagWrite.reason.message : String(tagWrite.reason),
    })
  }
  if (memWrite.status === "rejected") {
    log("pa.conversation_extractor.memory_write_error", {
      userId: req.userId,
      error: memWrite.reason instanceof Error ? memWrite.reason.message : String(memWrite.reason),
    })
  }

  if (deps.writeAudit) {
    try {
      await deps.writeAudit({
        userId: req.userId,
        trigger: req.trigger,
        tagFieldsChanged: tagFields,
        memoryEntitiesAdded: memoryCount,
        confidence: parsed.confidence,
        modelUsed: llmOut.modelUsed,
        runAt: now().toISOString(),
      })
    } catch (err) {
      log("pa.conversation_extractor.audit_error", {
        userId: req.userId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  log("pa.conversation_extractor.ok", {
    userId: req.userId,
    trigger: req.trigger,
    tagFieldsChanged: tagFields,
    memoryEntitiesAdded: memoryCount,
    confidence: parsed.confidence,
    modelUsed: llmOut.modelUsed,
  })

  return {
    ran: true,
    reason: "ok",
    tagFieldsChanged: tagFields,
    memoryEntitiesAdded: memoryCount,
    confidence: parsed.confidence,
    modelUsed: llmOut.modelUsed,
  }
}

// Re-export the canonical types so consumers don't need a second import.
export type { RoleFunction, IndustrySector, CareerStage, JobType }
