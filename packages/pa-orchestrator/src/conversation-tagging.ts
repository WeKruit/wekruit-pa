/**
 * conversation-tagging.ts — THE unified, context-aware, conversational tagging
 * interface (Adam top-level design, 2026-05-30).
 *
 * ONE entry point that EVERY conversation→tags path shares:
 *
 *     extractFromConversation(context, candidateMessage)
 *       -> { tagDeltas, hardnessDeltas, feedbackEvents, routedWrites }
 *
 * The CONTEXT carries the conversation PURPOSE (onboarding-slot |
 * post-recommendation-feedback | job-preference-change | evaluation |
 * freeform-chat | future), WHAT was just asked/shown, and the current profile
 * snapshot. Given context + message + the canonical `@wekruit/shared-tags`
 * enums, the LLM extracts the RIGHT canonical tags / hardness / feedback and
 * this module ROUTES them to the correct store:
 *
 *   - durable preferences / tags  → pa-users.tags via applyPartialUserTags (D8)
 *   - recommendation feedback     → structured feedback event (sentiment +
 *                                   reason category + any pref/tag deltas)
 *   - per-axis hardness / buffer  → folded into tagDeltas.preferenceHardness
 *   - all multi-value             → OR arrays
 *
 * NO REGEX. The LLM proposes; the shared validators (onboarding-canonical-tags
 * + match-feedback-extractor) validate every pick against the closed enums and
 * drop off-vocab values. The deterministic FSM/order reducers stay — they own
 * FLOW/ORDER, not extraction.
 *
 * EXTENSIBLE: a new question type or tag axis = add a `purpose` + its prompt
 * framing here (and/or an enum to shared-tags), NOT a new bespoke extractor.
 * Each existing call-site (onboarding `record_onboarding_answer`, post-rec
 * "happy with these?" feedback, mid-chat `set_matching_preferences`, eval
 * answers) is a THIN ADAPTER over this one interface.
 */

import type { PartialUserTags } from "./tags/user-tags-writer.js"
import {
  validateOnboardingCanonicalTags,
  type OnboardingCanonicalTagInput,
  type HardnessProvenance,
} from "./tags/onboarding-canonical-tags.js"
import {
  extractMatchFeedback,
  type FeedbackLlmCall,
  type FeedbackQuestionKind,
  type FeedbackReplyKind,
  type MatchFeedbackResult,
} from "./match-feedback-extractor.js"

/** The closed set of conversation purposes the unified interface understands. */
export const CONVERSATION_PURPOSE_VOCAB = [
  "onboarding_slot", // answering an onboarding question (record_onboarding_answer)
  "post_rec_feedback", // "are you happy with these? why or why not" after job recs
  "job_preference_change", // mid-chat "set_matching_preferences" / volunteered change
  "evaluation", // QA / eval answer
  "freeform_chat", // general chat (durable prefs volunteered in passing)
] as const
export type ConversationPurpose = (typeof CONVERSATION_PURPOSE_VOCAB)[number]

/**
 * Context for one extraction. `purpose` selects the routing; the optional
 * fields tell the LLM WHAT was just asked/shown so it extracts the right thing.
 */
export interface ConversationContext {
  purpose: ConversationPurpose
  /** Current `pa-users.{uid}.tags` snapshot — emit deltas only. */
  existingTags?: Record<string, unknown>
  /** onboarding_slot — the slot/question being answered. */
  onboardingSlot?: string
  /** post_rec_feedback — what we recommended (the job we're asking about). */
  recommendation?: { jobId?: string; role?: string; company?: string }
  /**
   * post_rec_feedback — which feedback question (sentiment / reason / subscribe)
   * the candidate is answering. Defaults to rec_batch_sentiment.
   */
  feedbackQuestionKind?: FeedbackQuestionKind
  /** evaluation — the eval prompt the answer responds to. */
  evalPrompt?: string
  /** Provenance source stamped on hardness deltas. */
  hardnessSource?: HardnessProvenance["source"]
  /** Caller logger. */
  log?: (event: string, payload?: Record<string, unknown>) => void
}

/**
 * A structured recommendation-feedback event the caller persists to the
 * feedback-event store + candidate profile. Only present for purposes that
 * produce feedback (post_rec_feedback).
 */
export interface ConversationFeedbackEvent {
  /** Whether the reply answered the question or should yield (route) elsewhere. */
  replyKind: FeedbackReplyKind
  sentiment: MatchFeedbackResult["sentiment"]
  intent: MatchFeedbackResult["intent"]
  reasonCategory: MatchFeedbackResult["reasonCategory"]
  /** What we asked about (carried through from context). */
  recommendation?: { jobId?: string; role?: string; company?: string }
}

/** Where a routed write should land. */
export type RoutedWriteTarget = "pa_users_tags" | "feedback_event"

/** One routing instruction the caller (or `applyConversationExtraction`) executes. */
export interface RoutedWrite {
  target: RoutedWriteTarget
  reason: ConversationPurpose
}

/** The unified extraction output. */
export interface ConversationExtractionResult {
  /** Canonical durable tag deltas (OR multi-pick) → pa-users.tags. */
  tagDeltas: PartialUserTags
  /**
   * Per-axis hardness/buffer deltas — folded INTO `tagDeltas.preferenceHardness`
   * (kept here too for callers that want them split out). OR/per-axis.
   */
  hardnessDeltas: Record<string, unknown>
  /** Recommendation feedback events (post_rec_feedback only). */
  feedbackEvents: ConversationFeedbackEvent[]
  /** Routing instructions describing where the data should land. */
  routedWrites: RoutedWrite[]
}

/**
 * The LLM seam. The unified interface accepts a single feedback-style LLM call
 * (the same shape both underlying extractors already use), so production wires
 * ONE classifier and every purpose flows through it.
 */
export type ConversationLlmCall = FeedbackLlmCall

const EMPTY_RESULT: ConversationExtractionResult = {
  tagDeltas: {},
  hardnessDeltas: {},
  feedbackEvents: [],
  routedWrites: [],
}

function tagWriteRoute(purpose: ConversationPurpose, tags: PartialUserTags): RoutedWrite[] {
  return Object.keys(tags).length > 0 ? [{ target: "pa_users_tags", reason: purpose }] : []
}

/**
 * THE unified entry point. Given a conversation context + the candidate's
 * message, returns validated canonical tag deltas, hardness deltas, feedback
 * events, and routing instructions. NEVER throws (fails open to an empty
 * result). NO regex — all classification is LLM + closed-enum validation.
 */
export async function extractFromConversation(
  context: ConversationContext,
  candidateMessage: string,
  llm: ConversationLlmCall | undefined,
): Promise<ConversationExtractionResult> {
  const message = candidateMessage?.trim() ?? ""
  if (!message || !llm) return { ...EMPTY_RESULT, tagDeltas: {}, hardnessDeltas: {}, feedbackEvents: [], routedWrites: [] }
  const log = context.log
  const hardnessProvenance: HardnessProvenance = {
    source: context.hardnessSource ?? (context.purpose === "onboarding_slot" ? "onboarding" : "conversation"),
  }

  switch (context.purpose) {
    case "post_rec_feedback": {
      // Recommendation feedback → sentiment + reason category + any pref/tag deltas.
      const fb = await extractMatchFeedback(
        {
          questionKind: context.feedbackQuestionKind ?? "rec_batch_sentiment",
          reply: message,
          existingTags: context.existingTags,
        },
        llm,
        log,
      )
      const feedbackEvents: ConversationFeedbackEvent[] = [
        {
          replyKind: fb.replyKind,
          sentiment: fb.sentiment,
          intent: fb.intent,
          reasonCategory: fb.reasonCategory,
          ...(context.recommendation ? { recommendation: context.recommendation } : {}),
        },
      ]
      const routedWrites: RoutedWrite[] = [
        { target: "feedback_event", reason: context.purpose },
        ...tagWriteRoute(context.purpose, fb.tagDeltas),
      ]
      return {
        tagDeltas: fb.tagDeltas,
        hardnessDeltas: extractHardness(fb.tagDeltas),
        feedbackEvents,
        routedWrites,
      }
    }

    // Onboarding / preference-change / evaluation / freeform all extract durable
    // canonical tags (+ hardness) the same way — the difference is purpose
    // framing + provenance. Routed to pa-users.tags.
    case "onboarding_slot":
    case "job_preference_change":
    case "evaluation":
    case "freeform_chat":
    default: {
      const llmTags = await extractCanonicalTags(context, message, llm, log)
      const tagDeltas = validateOnboardingCanonicalTags(llmTags, hardnessProvenance)
      return {
        tagDeltas,
        hardnessDeltas: extractHardness(tagDeltas),
        feedbackEvents: [],
        routedWrites: tagWriteRoute(context.purpose, tagDeltas),
      }
    }
  }
}

/** Pull the preferenceHardness sub-object out of a tag patch (for callers). */
function extractHardness(tags: PartialUserTags): Record<string, unknown> {
  const ph = (tags as { preferenceHardness?: Record<string, unknown> }).preferenceHardness
  return ph && typeof ph === "object" ? ph : {}
}

/**
 * Ask the LLM for canonical tag deltas (+ per-axis hardness) for a durable-
 * preference purpose. Reuses the feedback LLM seam: the model returns
 * `{ tagDeltas: {...canonical...} }`, validated by the caller against the
 * shared-tags enums. NO regex.
 */
async function extractCanonicalTags(
  context: ConversationContext,
  message: string,
  llm: ConversationLlmCall,
  log?: (event: string, payload?: Record<string, unknown>) => void,
): Promise<OnboardingCanonicalTagInput> {
  const prompt = buildCanonicalTagPrompt(context, message)
  try {
    const out = await llm({ prompt, schemaName: "MatchFeedbackResult" })
    const obj = out.json && typeof out.json === "object" ? (out.json as Record<string, unknown>) : {}
    // Accept either a bare canonical object or `{ tagDeltas: {...} }`.
    const deltas = obj.tagDeltas && typeof obj.tagDeltas === "object" ? obj.tagDeltas : obj
    return deltas as OnboardingCanonicalTagInput
  } catch (err) {
    log?.("pa.conversation_tagging.llm_error", {
      purpose: context.purpose,
      error: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
}

/** Build the canonical-tag extraction prompt for a durable-preference purpose. */
export function buildCanonicalTagPrompt(context: ConversationContext, message: string): string {
  const framing: Record<ConversationPurpose, string> = {
    onboarding_slot: `The candidate is answering the onboarding question "${context.onboardingSlot ?? "(unknown)"}".`,
    job_preference_change: "The candidate is changing or stating their job-search preferences mid-conversation.",
    evaluation: `The candidate is answering an evaluation prompt: "${context.evalPrompt ?? "(unknown)"}".`,
    freeform_chat: "The candidate volunteered preferences in free-form chat.",
    post_rec_feedback: "The candidate is reacting to recommended jobs.",
  }
  return [
    "Extract the candidate's DURABLE job-search preferences into canonical tag deltas. Output JSON ONLY:",
    "  { \"tagDeltas\": { ...canonical fields... } }",
    framing[context.purpose],
    "Canonical fields (closed enums from @wekruit/shared-tags; multi-value = OR; emit ONLY what's clearly stated):",
    "  targetRoleFunction[], negativeRoleFunction[], industrySector[], negativeIndustrySector[], companySize[],",
    "  companyStage[] (funding stage — ORTHOGONAL to companySize: pre_seed/seed/series_a/.../ipo_public),",
    "  targetLocations[], targetCountry[], targetJobType[], negativeJobType[] (job types the candidate does",
    "  NOT want, e.g. \"I am not looking for an internship\" → ['internship']), careerStage, visaStatus, minSalary,",
    "  preferenceHardness { <axis>: { hardness: 'hard'|'soft', bufferPct?, bufferSteps? } } keyed by:",
    "    salary, industrySector, companyStage, companySize, location, jobType, careerStage, roleFunction.",
    "Rules: use ONLY canonical tokens; capture hardness/negotiability degree when signalled (e.g. \"need 140k but",
    "could flex to 130\" → minSalary 140000 + preferenceHardness.salary {hardness:'soft', bufferPct:0.07}); drop anything off-vocab.",
    context.existingTags ? `Existing tags (do NOT duplicate): ${JSON.stringify(context.existingTags)}` : "",
    "",
    `Candidate message: ${JSON.stringify(message)}`,
    "Output JSON only.",
  ]
    .filter(Boolean)
    .join("\n")
}
