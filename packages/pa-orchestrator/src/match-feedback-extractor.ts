/**
 * match-feedback-extractor.ts — LLM-driven match-FEEDBACK extraction (2026-05-30).
 *
 * Adam directive (2026-05-30): the match-feedback signal ("are you happy with
 * the matching / good or not / why or why not") must be LLM-extracted into
 * STRUCTURED feedback — sentiment + reason category + canonical tag deltas — and
 * the daily-subscribe yes/no intent must be LLM-classified too. NO regex /
 * keyword-list classification of the free-form candidate reply.
 *
 * This module:
 *   - calls an injectable LLM (`FeedbackLlmCall`) that proposes the structured
 *     feedback for one reply,
 *   - validates EVERY field against the `@wekruit/shared-tags` closed enums
 *     (sentiment / intent / reasonCategory) and the canonical tag vocab,
 *   - fails OPEN to `ambiguous` (the FSM then re-asks rather than mis-routing).
 *
 * Trivial normalization only (trim / lowercase / dedupe). Zero regex
 * classification — the SOURCE GUARD test asserts this.
 */

import { z } from "zod"
import {
  FEEDBACK_SENTIMENT_VOCAB,
  FEEDBACK_INTENT_VOCAB,
  FEEDBACK_REASON_CATEGORY_VOCAB,
  type FeedbackSentiment,
  type FeedbackIntent,
  type FeedbackReasonCategory,
} from "@wekruit/shared-tags"
import {
  validateOnboardingCanonicalTags,
  type OnboardingCanonicalTagInput,
} from "./tags/onboarding-canonical-tags.js"
import type { PartialUserTags } from "./tags/user-tags-writer.js"

/**
 * What we ask the LLM to classify. The caller tells the extractor which
 * question the candidate is answering so the model focuses on the right signal.
 */
export type FeedbackQuestionKind =
  | "rec_batch_sentiment" // "how did those roles feel — useful, meh, or off?"
  | "dislike_reason" // "what was off? role level, company, location, pay…"
  | "daily_subscribe" // "want daily matched roles? yes/no"

export interface FeedbackExtractRequest {
  questionKind: FeedbackQuestionKind
  /** The candidate's free-form reply. */
  reply: string
  /** Current canonical tags so the model emits deltas only (optional). */
  existingTags?: Record<string, unknown>
}

/** Injectable LLM seam. Returns parsed JSON; throws on provider failure. */
export type FeedbackLlmCall = (args: {
  prompt: string
  schemaName: "MatchFeedbackResult"
}) => Promise<{ json: unknown }>

/**
 * How the reply should be ROUTED — replaces the regex yield predicates. The FSM
 * yields a turn to other handlers when the candidate is asking an explicit
 * question or stating a concrete new job-search preference instead of answering
 * the feedback question.
 */
export const FEEDBACK_REPLY_KIND_VOCAB = [
  "feedback_answer", // answers the feedback / subscribe question
  "explicit_question", // asks Claire a question (yield)
  "job_search_preference", // states a concrete new search preference (yield)
] as const
export type FeedbackReplyKind = (typeof FEEDBACK_REPLY_KIND_VOCAB)[number]

/** Structured, validated feedback the FSM consumes. */
export interface MatchFeedbackResult {
  replyKind: FeedbackReplyKind
  sentiment: FeedbackSentiment
  intent: FeedbackIntent
  reasonCategory: FeedbackReasonCategory
  /** Canonical preference deltas the dislike reason implies (OR multi-pick). */
  tagDeltas: PartialUserTags
}

const SENTIMENT_SET = new Set<string>(FEEDBACK_SENTIMENT_VOCAB)
const INTENT_SET = new Set<string>(FEEDBACK_INTENT_VOCAB)
const REASON_SET = new Set<string>(FEEDBACK_REASON_CATEGORY_VOCAB)
const REPLY_KIND_SET = new Set<string>(FEEDBACK_REPLY_KIND_VOCAB)

/** The LLM response schema (loose — validated/normalized below). */
const MatchFeedbackLlmSchema = z.object({
  replyKind: z.string().optional(),
  sentiment: z.string().optional(),
  intent: z.string().optional(),
  reasonCategory: z.string().optional(),
  tagDeltas: z.record(z.unknown()).optional(),
})

function normEnum<T extends string>(value: unknown, set: Set<string>, fallback: T): T {
  if (typeof value !== "string") return fallback
  const t = value.trim().toLowerCase()
  return set.has(t) ? (t as T) : fallback
}

/** Build the extraction prompt. Closed enums; the model never invents values. */
export function buildFeedbackExtractPrompt(req: FeedbackExtractRequest): string {
  return [
    "You classify a job-seeker's reply to a match-feedback question into STRUCTURED feedback.",
    "Output JSON ONLY (no prose) for the `MatchFeedbackResult` schema:",
    `  replyKind (string):       one of ${FEEDBACK_REPLY_KIND_VOCAB.join(", ")} — "feedback_answer" if they answer the question; "explicit_question" if they instead ASK Claire something (e.g. "what preferences did you save?"); "job_search_preference" if they instead state a concrete NEW search ask (e.g. "find me remote senior backend roles").`,
    `  sentiment (string):       one of ${FEEDBACK_SENTIMENT_VOCAB.join(", ")} — overall feeling about the recommended roles ("good or not").`,
    `  intent (string):          one of ${FEEDBACK_INTENT_VOCAB.join(", ")} — yes/no when the question asks for a decision (e.g. daily subscribe); else "ambiguous".`,
    `  reasonCategory (string):  one of ${FEEDBACK_REASON_CATEGORY_VOCAB.join(", ")} — WHY the batch was off (use "none" if no reason given, "other" if unclear).`,
    "  tagDeltas (object):       canonical preference deltas the reply implies — closed enums, multi-value = OR. Keys (emit only what's clearly stated):",
    "      targetRoleFunction, negativeRoleFunction, industrySector, negativeIndustrySector, companySize, targetLocations, targetJobType, careerStage, visaStatus, minSalary.",
    "      Example: \"too junior, I want senior backend roles\" → reasonCategory=wrong_seniority, tagDeltas={careerStage:'senior'}.",
    "      Example: \"these are all fintech, I'm into healthcare\" → reasonCategory=wrong_industry, tagDeltas={industrySector:['healthcare_and_life_sciences'], negativeIndustrySector:['financial_technology']}.",
    "Rules:",
    "  - Use ONLY the closed enum tokens above; drop anything you're unsure of.",
    "  - If the reply is a bare yes/no with no reason, set reasonCategory='none' and tagDeltas={}.",
    `  - Question being answered: ${req.questionKind}.`,
    req.existingTags ? `  - Existing tags (do NOT duplicate): ${JSON.stringify(req.existingTags)}` : "",
    "",
    `Candidate reply: ${JSON.stringify(req.reply)}`,
    "Output JSON only.",
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * Validate the LLM's structured proposal against the shared-tags closed enums.
 * Off-vocab values fall back to safe defaults (sentiment/intent → "ambiguous",
 * reasonCategory → "none"); tag deltas are validated + dropped if off-vocab.
 */
export function validateFeedbackResult(raw: unknown): MatchFeedbackResult {
  const parsed = MatchFeedbackLlmSchema.safeParse(raw)
  const obj = parsed.success ? parsed.data : {}
  return {
    replyKind: normEnum<FeedbackReplyKind>(obj.replyKind, REPLY_KIND_SET, "feedback_answer"),
    sentiment: normEnum<FeedbackSentiment>(obj.sentiment, SENTIMENT_SET, "ambiguous"),
    intent: normEnum<FeedbackIntent>(obj.intent, INTENT_SET, "ambiguous"),
    reasonCategory: normEnum<FeedbackReasonCategory>(obj.reasonCategory, REASON_SET, "none"),
    tagDeltas: validateOnboardingCanonicalTags(obj.tagDeltas as OnboardingCanonicalTagInput | undefined),
  }
}

/** Safe fail-open default — the FSM treats `ambiguous` as "re-ask". */
export const AMBIGUOUS_FEEDBACK: MatchFeedbackResult = {
  replyKind: "feedback_answer",
  sentiment: "ambiguous",
  intent: "ambiguous",
  reasonCategory: "none",
  tagDeltas: {},
}

/**
 * Extract structured match-feedback from a free-form reply via the LLM. Never
 * throws — provider/parse errors fail OPEN to {@link AMBIGUOUS_FEEDBACK} so the
 * FSM re-asks instead of mis-routing.
 */
export async function extractMatchFeedback(
  req: FeedbackExtractRequest,
  llm: FeedbackLlmCall,
  log?: (event: string, payload?: Record<string, unknown>) => void,
): Promise<MatchFeedbackResult> {
  const reply = req.reply?.trim() ?? ""
  if (!reply) return AMBIGUOUS_FEEDBACK
  let out: { json: unknown }
  try {
    out = await llm({ prompt: buildFeedbackExtractPrompt(req), schemaName: "MatchFeedbackResult" })
  } catch (err) {
    log?.("pa.match_feedback.llm_error", {
      questionKind: req.questionKind,
      error: err instanceof Error ? err.message : String(err),
    })
    return AMBIGUOUS_FEEDBACK
  }
  const result = validateFeedbackResult(out.json)
  log?.("pa.match_feedback.extracted", {
    questionKind: req.questionKind,
    sentiment: result.sentiment,
    intent: result.intent,
    reasonCategory: result.reasonCategory,
    tagDeltaKeys: Object.keys(result.tagDeltas),
  })
  return result
}
