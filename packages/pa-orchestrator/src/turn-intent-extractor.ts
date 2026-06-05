/**
 * turn-intent-extractor.ts — LLM-driven conversation TURN-INTENT extraction
 * (2026-06-05).
 *
 * Adam directive / CONVERSATION-CONTEXT-FIRST-PRINCIPLE: "the LLM extracts the
 * user's MEANING — regex never does." This module replaces the meaning-classifying
 * regex predicates in `conversation-turn-arbiter.ts` (asks-reason / mentions-role /
 * acknowledgment / confusion / negative-preference / find-jobs / preference-recall)
 * with a single LLM intent extractor over a CLOSED multi-label vocabulary.
 *
 * Design contract (mirrors `match-feedback-extractor.ts`):
 *   - one injectable LLM seam (`TurnIntentLlmCall`); default impl reuses the same
 *     gpt-5.4-nano → claude-sonnet-4-6 chain the conversation-extractor already runs
 *     in this code path (NO new client),
 *   - validates EVERY label against the closed `TURN_INTENT_VOCAB` (drop off-vocab),
 *   - multi-label OR (a turn can be `durable_preference_update` AND `job_search_request`),
 *   - hard timeout (~800ms) + FAIL-OPEN to a sentinel (`TURN_INTENT_UNAVAILABLE`,
 *     all labels absent) so the arbiter leaves `llmIntentFrames` unset and falls
 *     back to today's deterministic regex predicates.
 *
 * STATE and ROUTING stay deterministic: this module ONLY supplies
 * intent+confidence+evidence. The arbiter's `framesFromLlmIntent` mapper +
 * deterministic cascade decide what to do with it. SAFETY (STOP/privacy) and
 * marker (`__..__`) regexes are NOT migrated here — they remain in the arbiter.
 */

import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"

/**
 * Closed multi-label intent vocabulary — the MEANING signals the arbiter used to
 * derive via regex. Each is independent (multi-pick OR). Notably this set does
 * NOT include `safety_control` (kept as a deterministic SAFETY regex in the
 * arbiter) nor the system-control marker (kept as a marker regex).
 *
 *   meta_question            — user asks Claire an explicit question (why/how/what,
 *                              or a "what did you save for matching?" recall).
 *   saved_preference_recall  — specifically asks what preferences/profile Claire
 *                              has saved (a refinement of meta_question; kept as a
 *                              distinct label so the mapper can preserve nuance).
 *   prescreen_outcome_question — asks about a prescreen/job OUTCOME (why paused,
 *                              how to improve fit, why a role). STATE-gated on
 *                              prescreenEvidence by the mapper.
 *   durable_preference_update — states a durable role/matching preference change
 *                              (e.g. "product strategy only, no SWE"). Carries
 *                              polarity.
 *   job_search_request       — asks Claire to find / refresh / send roles.
 *   acknowledgment           — short low-information ack ("ok", "sure", 👍).
 *   confusion                — signals they don't understand ("not sure", "idk",
 *                              "what do you mean").
 */
export const TURN_INTENT_VOCAB = [
  "meta_question",
  "saved_preference_recall",
  "prescreen_outcome_question",
  "durable_preference_update",
  "job_search_request",
  "acknowledgment",
  "confusion",
] as const
export type TurnIntentLabel = (typeof TURN_INTENT_VOCAB)[number]

const PREFERENCE_POLARITY = ["positive", "negative"] as const
export type PreferencePolarity = (typeof PREFERENCE_POLARITY)[number]

/** Per-label presence + confidence. */
export type TurnIntentSignal = {
  present: boolean
  confidence: number
}

/**
 * The validated, structured turn-intent the arbiter consumes. `available=false`
 * is the FAIL-OPEN sentinel — the arbiter ignores it and uses its regex path.
 */
export type TurnIntentResult = {
  /** false → extractor unavailable (off-flag handled by caller, or LLM failed). */
  available: boolean
  labels: Record<TurnIntentLabel, TurnIntentSignal>
  /** Polarity of a durable preference update, when that label is present. */
  preferencePolarity?: PreferencePolarity
  /** Short verbatim span the model cited as evidence. */
  evidence: string
}

export type TurnIntentExtractRequest = {
  /** The candidate's free-form inbound text. */
  text: string
  /**
   * Lightweight conversation context so the model disambiguates (e.g. an "ok"
   * after Claire asked a question is an acknowledgment, not a job search).
   * Last assistant turn body is the most useful single signal.
   */
  lastAssistantText?: string
  /**
   * Whether a prescreen outcome is on record for this user — lets the model
   * prefer `prescreen_outcome_question` over a generic `meta_question`. This is
   * a CONTEXT hint only; the arbiter still STATE-gates the frame on evidence.
   */
  hasPrescreenEvidence?: boolean
}

/** Injectable LLM seam. Returns parsed JSON; throws on provider failure. */
export type TurnIntentLlmCall = (args: {
  prompt: string
  schemaName: "TurnIntentResult"
}) => Promise<{ json: unknown }>

const LABEL_SET = new Set<string>(TURN_INTENT_VOCAB)
const POLARITY_SET = new Set<string>(PREFERENCE_POLARITY)
const DEFAULT_TIMEOUT_MS = 800

/** All-absent label map. */
function emptyLabels(): Record<TurnIntentLabel, TurnIntentSignal> {
  const out = {} as Record<TurnIntentLabel, TurnIntentSignal>
  for (const label of TURN_INTENT_VOCAB) out[label] = { present: false, confidence: 0 }
  return out
}

/** FAIL-OPEN sentinel — arbiter leaves `llmIntentFrames` unset on this. */
export const TURN_INTENT_UNAVAILABLE: TurnIntentResult = {
  available: false,
  labels: emptyLabels(),
  evidence: "",
}

/** Build the extraction prompt. Closed enum; the model never invents labels. */
export function buildTurnIntentPrompt(req: TurnIntentExtractRequest): string {
  return [
    "You classify a job-seeker's chat reply into STRUCTURED conversation-turn intents.",
    "A reply can carry MULTIPLE intents at once (multi-label). Output JSON ONLY (no prose).",
    "Schema `TurnIntentResult`:",
    '  labels (object): for EACH label below emit {"present": boolean, "confidence": 0.0-1.0}.',
    "  Labels (use ONLY these keys — never invent):",
    "    meta_question            — they ASK Claire an explicit question (why / how / what / could you / explain).",
    "    saved_preference_recall  — they specifically ask WHAT preferences / matching profile Claire has SAVED.",
    "    prescreen_outcome_question — they ask about a prescreen or job OUTCOME (why paused / failed, how to improve fit for a role).",
    "    durable_preference_update — they state a DURABLE role/matching preference change (e.g. 'product strategy only, no SWE', 'only remote startups').",
    "    job_search_request       — they ask Claire to FIND / refresh / send / recommend roles.",
    "    acknowledgment           — a short low-information ack ('ok', 'sure', 'sounds good', a thumbs-up) with no new info.",
    "    confusion                — they signal they don't understand ('not sure', 'idk', 'what do you mean', 'confused').",
    '  preferencePolarity (string, optional): when durable_preference_update is present, "negative" if they are EXCLUDING something (no/avoid/stop), else "positive".',
    "  evidence (string): a short verbatim span from their reply justifying the strongest label (<=120 chars).",
    "Rules:",
    "  - Set present=false (confidence 0) for any label that does not clearly apply.",
    "  - Confidence reflects how sure you are; be conservative on borderline replies.",
    "  - meta_question and prescreen_outcome_question can BOTH be present (an outcome question is also a question).",
    "  - durable_preference_update and job_search_request can BOTH be present ('stop sending SWE, find me PM roles').",
    "  - Do NOT classify safety / stop / privacy / unsubscribe requests here — those are handled elsewhere; leave all labels false for them.",
    req.lastAssistantText
      ? `  - Claire's previous message (context): ${JSON.stringify(req.lastAssistantText.slice(0, 280))}`
      : "",
    req.hasPrescreenEvidence
      ? "  - A prescreen outcome IS on record for this user; prefer prescreen_outcome_question over a bare meta_question when they ask about a role/fit/pause."
      : "",
    "",
    `Candidate reply: ${JSON.stringify(req.text)}`,
    "Output JSON only.",
  ]
    .filter(Boolean)
    .join("\n")
}

function coerceSignal(value: unknown): TurnIntentSignal {
  if (!value || typeof value !== "object") return { present: false, confidence: 0 }
  const v = value as { present?: unknown; confidence?: unknown }
  const present = v.present === true
  const confRaw = typeof v.confidence === "number" ? v.confidence : 0
  const confidence = present ? Math.min(1, Math.max(0, confRaw)) : 0
  return { present, confidence }
}

/**
 * Validate the LLM's structured proposal against the closed label vocab.
 * Off-vocab keys are dropped; non-boolean `present` → absent. Never throws.
 */
export function validateTurnIntentResult(raw: unknown): TurnIntentResult {
  const labels = emptyLabels()
  let evidence = ""
  let preferencePolarity: PreferencePolarity | undefined
  if (raw && typeof raw === "object") {
    const obj = raw as { labels?: unknown; evidence?: unknown; preferencePolarity?: unknown }
    if (obj.labels && typeof obj.labels === "object") {
      for (const [key, value] of Object.entries(obj.labels as Record<string, unknown>)) {
        const norm = key.trim().toLowerCase()
        if (LABEL_SET.has(norm)) labels[norm as TurnIntentLabel] = coerceSignal(value)
      }
    }
    if (typeof obj.evidence === "string") evidence = obj.evidence.slice(0, 240)
    if (typeof obj.preferencePolarity === "string") {
      const p = obj.preferencePolarity.trim().toLowerCase()
      if (POLARITY_SET.has(p)) preferencePolarity = p as PreferencePolarity
    }
  }
  return {
    available: true,
    labels,
    ...(preferencePolarity ? { preferencePolarity } : {}),
    evidence,
  }
}

/**
 * Extract structured turn-intent from a free-form reply via the LLM. Never
 * throws — provider/parse/timeout errors fail OPEN to
 * {@link TURN_INTENT_UNAVAILABLE} so the arbiter uses its deterministic regex
 * path (behavior identical to today).
 */
export async function extractTurnIntent(
  req: TurnIntentExtractRequest,
  llm: TurnIntentLlmCall = defaultTurnIntentLlmCall,
  opts: {
    timeoutMs?: number
    log?: (event: string, payload?: Record<string, unknown>) => void
  } = {},
): Promise<TurnIntentResult> {
  const text = req.text?.trim() ?? ""
  if (!text) return TURN_INTENT_UNAVAILABLE
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const log = opts.log

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("turn_intent_timeout")), timeoutMs)
  })

  let out: { json: unknown }
  try {
    out = await Promise.race([
      llm({ prompt: buildTurnIntentPrompt(req), schemaName: "TurnIntentResult" }),
      timeoutPromise,
    ])
  } catch (err) {
    log?.("pa.turn_intent.llm_error", {
      error: err instanceof Error ? err.message : String(err),
    })
    return TURN_INTENT_UNAVAILABLE
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }

  const result = validateTurnIntentResult(out.json)
  log?.("pa.turn_intent.extracted", {
    present: TURN_INTENT_VOCAB.filter((label) => result.labels[label].present),
    preferencePolarity: result.preferencePolarity,
  })
  return result
}

// ────────────────────────────────────────────────────────────────────────
// Default LLM call — gpt-5.4-nano (primary) → claude-sonnet-4-6 (fallback),
// the same chain the conversation-extractor already runs in this code path.
// ────────────────────────────────────────────────────────────────────────

const OPENAI_MODEL = "gpt-5.4-nano"
const ANTHROPIC_MODEL = "claude-sonnet-4-6"

const TURN_INTENT_SYSTEM_PROMPT =
  "You are a precise multi-label intent classifier for a job-search assistant. " +
  "Output JSON only that validates the `TurnIntentResult` schema. No prose."

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

function safeParseJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith("```")) {
    const inner = trimmed.replace(/^```(json)?\s*/i, "").replace(/```$/i, "")
    return JSON.parse(inner)
  }
  return JSON.parse(trimmed)
}

async function callOpenAi(prompt: string): Promise<{ json: unknown }> {
  const client = openAiClient()
  const resp = await client.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: TURN_INTENT_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  })
  const raw = resp.choices?.[0]?.message?.content ?? "{}"
  return { json: safeParseJson(raw) }
}

async function callAnthropic(prompt: string): Promise<{ json: unknown }> {
  const client = anthropicClient()
  if (!client) throw new Error("anthropic_unavailable")
  const resp = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 512,
    system: TURN_INTENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  })
  const text = resp.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("")
  return { json: safeParseJson(text) }
}

/** OpenAI-primary, Anthropic-fallback default LLM call for turn-intent. */
export const defaultTurnIntentLlmCall: TurnIntentLlmCall = async ({ prompt }) => {
  try {
    return await callOpenAi(prompt)
  } catch (primaryErr) {
    const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
    if (!anthropicClient()) {
      throw new Error(`openai_failed_no_fallback: ${msg}`)
    }
    return callAnthropic(prompt)
  }
}
