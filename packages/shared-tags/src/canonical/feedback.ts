/**
 * Canonical match-FEEDBACK vocab (2026-05-30).
 *
 * Adam directive (2026-05-30): the "are you happy with the matching / good or
 * not / why or why not" signal must be LLM-extracted into STRUCTURED feedback —
 * sentiment + reason category + tag deltas — validated against these closed
 * enums (never regex/keyword classification).
 *
 * Shared so the orchestrator's post-match retention FSM, the feedback writer,
 * and the eval flywheel all speak ONE vocabulary.
 */

import { z } from "zod"

/** Overall sentiment toward the rec batch ("good or not"). */
export const FEEDBACK_SENTIMENT_VOCAB = ["positive", "negative", "ambiguous"] as const
export type FeedbackSentiment = (typeof FEEDBACK_SENTIMENT_VOCAB)[number]
export const FeedbackSentimentSchema = z.enum(FEEDBACK_SENTIMENT_VOCAB)

/** Yes/no/ambiguous intent (e.g. daily-subscribe opt-in). */
export const FEEDBACK_INTENT_VOCAB = ["yes", "no", "ambiguous"] as const
export type FeedbackIntent = (typeof FEEDBACK_INTENT_VOCAB)[number]
export const FeedbackIntentSchema = z.enum(FEEDBACK_INTENT_VOCAB)

/**
 * Why the candidate disliked the batch ("why or why not"). Closed enum so the
 * flywheel can aggregate dislike reasons. `other` is the catch-all; `none` when
 * no clear reason was given.
 */
export const FEEDBACK_REASON_CATEGORY_VOCAB = [
  "wrong_role_function",
  "wrong_seniority",
  "wrong_industry",
  "wrong_location",
  "wrong_company_size",
  "wrong_company_stage",
  "salary_too_low",
  "visa_sponsorship",
  "wrong_job_type",
  "too_few_or_stale",
  "other",
  "none",
] as const
export type FeedbackReasonCategory = (typeof FEEDBACK_REASON_CATEGORY_VOCAB)[number]
export const FeedbackReasonCategorySchema = z.enum(FEEDBACK_REASON_CATEGORY_VOCAB)
