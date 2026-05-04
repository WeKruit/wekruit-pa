/**
 * iter30 WS1 — qaBank → Mem0 + tag-event coupling.
 *
 * For each `inferredAnswer` from the parser, we:
 *   1. Map question text → 9-tag intentTag bank (regex).
 *   2. Compute a 16-char dedupe hash sha256(userId::question).
 *   3. Pre-search Mem0 to skip if the same intent has been written.
 *   4. mem0Add with metadata (intentTag / qaConfidence / qaCategory / source).
 *   5. recordTagEvent (`pa-cv-ingest` source) with the intentTag as rawTag.
 *
 * Both writes are best-effort + non-throwing — partial failure on one item
 * doesn't fail the rest of the bank.
 */

import { createHash } from "node:crypto"
import type { InferredAnswer } from "./schema.js"
import type { Logger } from "./retry.js"

// ─────────────────────────────────────────────────────────────────
// Pattern bank — order matters; specific-to-generic.
// ─────────────────────────────────────────────────────────────────

export type IntentTag =
  | "work_authorization"
  | "salary_expectation"
  | "start_date"
  | "relocation_willingness"
  | "relevant_experience"
  | "remote_preference"
  | "sponsorship_need"
  | "career_goals"
  | "other"

const PATTERN_BANK: ReadonlyArray<readonly [RegExp, IntentTag]> = [
  [/(authoriz|visa|H1B|OPT|green card|绿卡|工作授权)/i, "work_authorization"],
  [/(sponsor|sponsorship|担保|赞助)/i, "sponsorship_need"],
  [/(salary|compensation|expected pay|薪资|期望工资|薪水|工资)/i, "salary_expectation"],
  [/(start date|when can you start|available|notice period|开始日期|入职|什么时候开始|多久能入职)/i, "start_date"],
  [/(relocate|move|relocation|搬|搬到|搬家|换城市)/i, "relocation_willingness"],
  [/(remote|on[- ]?site|hybrid|远程|线上|线下)/i, "remote_preference"],
  [/(years?\s+of\s+experience|工作年限|多少年经验|工作几年|经验有多少年)/i, "relevant_experience"],
  [/(career goal|long term|长期目标|事业目标|未来规划|职业规划)/i, "career_goals"],
] as const

export function mapQuestionToIntentTag(q: string): IntentTag {
  if (typeof q !== "string" || q.length === 0) return "other"
  for (const [re, tag] of PATTERN_BANK) {
    if (re.test(q)) return tag
  }
  return "other"
}

// ─────────────────────────────────────────────────────────────────
// Dedupe hash
// ─────────────────────────────────────────────────────────────────

export function memDedupeHash(userId: string, question: string): string {
  return createHash("sha256")
    .update(`${userId}::${question.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 16)
}

// ─────────────────────────────────────────────────────────────────
// Mem0 + tag-event injection points (all optional for testability)
// ─────────────────────────────────────────────────────────────────

export type Mem0AddArgsForQa = {
  /** Canonical user id (used in dedupe hash, NOT the partition key). */
  userId: string
  /** Mem0 partition key (typically the same as userId, but mem0UserId override). */
  partitionKey: string
  question: string
  answer: string
  metadata: Record<string, string | number | boolean>
}

/**
 * Caller-supplied `mem0Add` adapter. Production wires it to `@pa/memory`'s
 * `mem0Add(cfg, [{role:"user", content:"..."}], partitionKey, { metadata, agentId })`.
 */
export type Mem0AddAdapter = (args: Mem0AddArgsForQa) => Promise<void>

/**
 * Caller-supplied `mem0Search` adapter for pre-write dedupe. Returns the
 * raw memory strings; we look for the dedupeHash substring.
 */
export type Mem0SearchAdapter = (args: {
  partitionKey: string
  query: string
}) => Promise<string[]>

/**
 * Caller-supplied tag-event recorder (matches `recordTagEvent` from
 * `@wekruit/shared-tags` PA-shorthand shape).
 */
export type TagEventAdapter = (args: {
  userId: string
  rawTag: string
  source: "pa-cv-ingest"
  sourceField?: string
  sourceDocId?: string
  evidence?: string
}) => Promise<void>

export type WriteQaBankToMem0Args = {
  userId: string
  partitionKey: string
  resumeId?: string
  inferredAnswers: InferredAnswer[]
  mem0Add: Mem0AddAdapter
  mem0Search?: Mem0SearchAdapter
  recordTagEvent?: TagEventAdapter
  nowIso?: () => string
  log?: Logger
}

export type WriteQaBankResult = {
  written: number
  skippedDedupe: number
  errored: number
  tagEventsRecorded: number
}

const MEM0_DEDUPE_QUERY_LIMIT = 8

export async function writeQaBankToMem0(
  args: WriteQaBankToMem0Args
): Promise<WriteQaBankResult> {
  const now = (args.nowIso ?? (() => new Date().toISOString()))()
  const result: WriteQaBankResult = {
    written: 0,
    skippedDedupe: 0,
    errored: 0,
    tagEventsRecorded: 0,
  }

  for (const ia of args.inferredAnswers) {
    if (!ia || typeof ia.question !== "string" || ia.question.trim().length === 0) {
      continue
    }
    const intentTag = mapQuestionToIntentTag(ia.question)
    const dedupeHash = memDedupeHash(args.userId, ia.question)

    // Stage 1: pre-search dedupe (best-effort).
    if (args.mem0Search) {
      try {
        const hits = await args.mem0Search({
          partitionKey: args.partitionKey,
          query: ia.question,
        }).then((r) => r.slice(0, MEM0_DEDUPE_QUERY_LIMIT))
        if (hits.some((h) => typeof h === "string" && h.includes(dedupeHash))) {
          result.skippedDedupe++
          args.log?.("pa.cv_qabank.mem0_dedupe_skip", {
            userId: args.userId,
            intentTag,
            dedupeHash,
          })
          // Even on dedupe-skip, we still emit a tag-event — this is a
          // separate signal stream. Idempotency on tag-events comes from
          // the shared-tags hash, NOT from Mem0.
          await emitTagEvent(ia.question, intentTag, args, result)
          continue
        }
      } catch (err) {
        args.log?.("pa.cv_qabank.mem0_search_error", {
          userId: args.userId,
          error: err instanceof Error ? err.message : String(err),
        })
        // Fall through to write — search-failure should not block writes.
      }
    }

    // Stage 2: mem0Add with metadata.
    try {
      await args.mem0Add({
        userId: args.userId,
        partitionKey: args.partitionKey,
        question: ia.question,
        answer: ia.answer,
        metadata: {
          source: "resume_inferred",
          qaCategory: ia.category,
          qaIntentTag: intentTag,
          qaConfidence: typeof ia.confidence === "number" ? ia.confidence : 0,
          qaDedupeHash: dedupeHash,
          ingestedAt: now,
          ...(args.resumeId ? { resumeId: args.resumeId } : {}),
        },
      })
      result.written++
      args.log?.("pa.cv_qabank.mem0_written", {
        userId: args.userId,
        intentTag,
        category: ia.category,
        confidence: ia.confidence,
      })
    } catch (err) {
      result.errored++
      args.log?.("pa.cv_qabank.mem0_error", {
        userId: args.userId,
        intentTag,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Stage 3: tag-event coupling.
    await emitTagEvent(ia.question, intentTag, args, result)
  }

  return result
}

async function emitTagEvent(
  questionText: string,
  intentTag: IntentTag,
  args: WriteQaBankToMem0Args,
  result: WriteQaBankResult
): Promise<void> {
  if (!args.recordTagEvent) return
  try {
    await args.recordTagEvent({
      userId: args.userId,
      rawTag: intentTag,
      source: "pa-cv-ingest",
      sourceField: "inferredAnswers.question",
      sourceDocId: args.resumeId ?? args.userId,
      evidence: questionText.slice(0, 500),
    })
    result.tagEventsRecorded++
  } catch (err) {
    args.log?.("pa.cv_qabank.tag_event_error", {
      userId: args.userId,
      intentTag,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
