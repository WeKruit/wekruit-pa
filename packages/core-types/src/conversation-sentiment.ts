/**
 * Shared contract for the candidate conversation-sentiment review surface.
 *
 * One Firestore doc per candidate per scan run lives in
 * `pa-conversation-sentiment/{userId}` (see PA_COLLECTIONS.conversationSentiment).
 * It surfaces candidate↔Claire conversations where the candidate was unhappy
 * ("this is not good", wrong matches, agent went silent, dead links, etc.) with
 * a transcript preview + a concrete "how to improve" note on the admin
 * dashboard (/admin/conversation-feedback).
 *
 * Producers:
 *   - paConversationSentimentScan (scheduled/callable CF) scans pa-messages for
 *     the last 7 days, LLM-classifies each candidate conversation, and upserts.
 *   - apps/functions/scripts/backfill-conversation-sentiment.mjs seeds the
 *     existing .ops/sentiment-scan-transcripts.json as the first run.
 *
 * Consumers:
 *   - paAdminConversationFeedback (admin callable) returns the unhappy
 *     conversations sorted by severity for the dashboard.
 *
 * Both the CF and the dashboard client import these types so the wire shape and
 * the LLM JSON schema stay in sync.
 */

/** 5-point sentiment scale, very_negative (worst) → very_positive (best). */
export const CONVERSATION_SENTIMENTS = [
  "very_negative",
  "negative",
  "neutral",
  "positive",
  "very_positive",
] as const
export type ConversationSentiment = (typeof CONVERSATION_SENTIMENTS)[number]

/**
 * Coarse failure (or success) category. Mirrors the topUnhappyThemes buckets
 * from the 7-day sentiment scan report so the dashboard chips line up with the
 * known clusters.
 */
export const CONVERSATION_SENTIMENT_CATEGORIES = [
  "happy_engaged",
  "wrong_matches",
  "agent_went_silent",
  "not_conversational_abrupt",
  "expired_or_dead_link",
  "extraction_missed_preference",
  "confused_about_product",
  "other_negative",
  "neutral_incomplete",
] as const
export type ConversationSentimentCategory = (typeof CONVERSATION_SENTIMENT_CATEGORIES)[number]

/** Human-readable labels for the category chips. */
export const CONVERSATION_SENTIMENT_CATEGORY_LABELS: Record<ConversationSentimentCategory, string> = {
  happy_engaged: "Happy / engaged",
  wrong_matches: "Wrong matches",
  agent_went_silent: "Agent went silent",
  not_conversational_abrupt: "Not conversational / abrupt",
  expired_or_dead_link: "Expired / dead link",
  extraction_missed_preference: "Missed a preference",
  confused_about_product: "Confused about product",
  other_negative: "Other negative",
  neutral_incomplete: "Neutral / incomplete",
}

/** Sentiment that counts as "unhappy" for the default dashboard view. */
export function isUnhappySentiment(sentiment: ConversationSentiment): boolean {
  return sentiment === "negative" || sentiment === "very_negative"
}

/** Severity rank for sorting — very_negative first (highest), very_positive last. */
export function conversationSentimentRank(sentiment: ConversationSentiment): number {
  const idx = CONVERSATION_SENTIMENTS.indexOf(sentiment)
  // very_negative (idx 0) → 0; very_positive (idx 4) → 4. Lower = more severe.
  return idx < 0 ? CONVERSATION_SENTIMENTS.length : idx
}

/** What the LLM classifier emits per conversation (strict JSON). */
export type ConversationSentimentClassification = {
  sentiment: ConversationSentiment
  unhappy: boolean
  category: ConversationSentimentCategory
  /** Verbatim quote from the candidate that best evidences the sentiment. */
  evidenceQuote: string
  /** Short diagnosis of what went wrong (empty for happy conversations). */
  whatWentWrong: string
  /** Concrete "how to improve" note for the operator. */
  fixIdea: string
}

/** Persisted doc shape — pa-conversation-sentiment/{userId}. */
export type ConversationSentimentDoc = ConversationSentimentClassification & {
  userId: string
  phone?: string
  /** ISO timestamp of the candidate's last message in the scanned window. */
  lastMessageAt?: string
  /** Number of messages in the scanned conversation. */
  messageCount?: number
  /** ISO timestamp of the classification run. */
  classifiedAt: string
  /** Classifier model id (e.g. gpt-5.4-mini) for audit. */
  model?: string
  /** Classifier version for backfill/regression tracking. */
  classifierVersion?: string
}

/** A transcript message for the dashboard preview pane. */
export type ConversationSentimentMessage = {
  role: "user" | "assistant"
  body: string
  createdAt?: string
}

/** One row returned by paAdminConversationFeedback (doc + transcript). */
export type ConversationFeedbackRow = ConversationSentimentDoc & {
  /** Full transcript for the detail pane. Omitted in list-only responses. */
  transcript?: ConversationSentimentMessage[]
}

export type ConversationFeedbackInput = {
  /** Default true — only return unhappy conversations. false = all. */
  unhappyOnly?: boolean
  category?: ConversationSentimentCategory
  sentiment?: ConversationSentiment
  /** Max rows (default 100, cap 300). */
  limit?: number
  adminToken?: string
}

export type ConversationFeedbackResponse = {
  generatedAt: string
  /** Count per category across the unhappy set (for the top-strip chips). */
  byCategory: Record<string, number>
  /** Count per sentiment across the returned set. */
  bySentiment: Record<string, number>
  rows: ConversationFeedbackRow[]
}

/**
 * Strict JSON schema for the classifier (OpenAI Responses / Anthropic
 * tool-use). `additionalProperties:false` + every property required is what the
 * 3-tier router enforces in strict mode.
 */
export const CONVERSATION_SENTIMENT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    sentiment: { type: "string", enum: [...CONVERSATION_SENTIMENTS] },
    unhappy: { type: "boolean" },
    category: { type: "string", enum: [...CONVERSATION_SENTIMENT_CATEGORIES] },
    evidenceQuote: { type: "string" },
    whatWentWrong: { type: "string" },
    fixIdea: { type: "string" },
  },
  required: ["sentiment", "unhappy", "category", "evidenceQuote", "whatWentWrong", "fixIdea"],
}

export const CONVERSATION_SENTIMENT_CLASSIFIER_VERSION = "v1"

export const CONVERSATION_SENTIMENT_SYSTEM_PROMPT = `You are WeKruit's candidate-experience analyst. You read a transcript of a conversation between a candidate and "Claire", WeKruit's AI recruiter (delivered over iMessage). Classify the CANDIDATE's overall experience.

Output STRICT JSON matching the schema. Nothing else.

Fields:
- sentiment: the candidate's overall sentiment toward the experience — one of very_negative, negative, neutral, positive, very_positive. Judge from the CANDIDATE's words and reactions, not Claire's tone. Frustration, "this is not good", "stop", swearing, opting out, switching languages in anger -> negative/very_negative. Warmth, thanks, excitement, "loved" reactions -> positive/very_positive. Sparse/one-sided/incomplete with no clear signal -> neutral.
- unhappy: true when sentiment is negative or very_negative, OR the candidate clearly expressed a problem even if politely. false otherwise.
- category: the single best-fit bucket:
  - happy_engaged: candidate is satisfied/engaged (use for positive/very_positive).
  - wrong_matches: recommended roles violated stated/obvious constraints (role function, seniority, job type, location/remote, visa).
  - agent_went_silent: candidate asked for status/an answer and got silence, a duplicate cold opener, or a canned "still under review" loop.
  - not_conversational_abrupt: Claire re-asked already-answered questions, looped, was terse/robotic, or leaked internal/system messages.
  - expired_or_dead_link: a job/apply link was dead, expired, or spammy/junk.
  - extraction_missed_preference: a stated preference (especially a negative like "no customer service") was not captured/honored.
  - confused_about_product: candidate didn't understand prescreen/status vocabulary, whether they applied, or what happens next.
  - other_negative: a negative experience that doesn't fit the above (eligibility/auth/language gates discovered late, can't auto-apply, harsh rejection, etc.).
  - neutral_incomplete: neutral and inconclusive; nothing actionable.
- evidenceQuote: the single most representative VERBATIM quote from the candidate (their own words). If the candidate said almost nothing, quote the most telling line available (candidate or Claire) and keep it short.
- whatWentWrong: one or two sentences diagnosing the problem from the candidate's point of view. Empty string "" when the conversation was happy/positive.
- fixIdea: one or two sentences of concrete, actionable "how to improve" guidance for the WeKruit team. For happy conversations, note what worked and is worth preserving.

Be precise and concise. Do not invent details not present in the transcript.`

/** Render a transcript into the LLM user message. */
export function renderConversationForClassifier(
  messages: ConversationSentimentMessage[],
  opts: { maxMessages?: number; maxBodyChars?: number; maxTotalChars?: number } = {},
): string {
  const maxMessages = opts.maxMessages ?? 60
  const maxBodyChars = opts.maxBodyChars ?? 600
  const maxTotalChars = opts.maxTotalChars ?? 12_000
  const slice = messages.slice(-maxMessages)
  const lines = slice.map((m) => {
    const who = m.role === "assistant" ? "Claire" : "Candidate"
    const body = (m.body ?? "").replace(/\s+/g, " ").trim().slice(0, maxBodyChars)
    return `${who}: ${body}`
  })
  return lines.join("\n").slice(-maxTotalChars)
}
