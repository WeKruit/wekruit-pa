import type { Firestore } from "firebase-admin/firestore"
import type { InboundEvent } from "@pa/core-types"
import { getFlag } from "@pa/pa-persistence"
import type { ResolvedVoiceProfile } from "./voice/voice-profiles/index.js"

export type CollabInviteSurfaceMode = "invite" | "clarify" | "declined_ack"

export function buildCollabInviteIntent(input: {
  jobTitle: string
  company: string
  mode: CollabInviteSurfaceMode
  voiceProfile: ResolvedVoiceProfile
  matchSummary?: string
}): string {
  const base =
    input.mode === "invite"
      ? `Invite the candidate to a quick (~5 min) partner-role prescreen for ${input.jobTitle} @ ${input.company}.`
      : input.mode === "clarify"
        ? "Clarify whether they want the quick partner prescreen — friend tone, one short question."
        : "Acknowledge they passed on the partner prescreen invite — stay warm, no pressure."

  const invariants: string[] = [
    "Compose ONE SMS only.",
    "Friend roommate tone — not HR, not formal interview register yet.",
  ]
  if (input.voiceProfile.invariants.noInterviewPromise) {
    invariants.push("Never promise they will get an interview or that they will pass.")
  }
  if (input.voiceProfile.invariants.noOversellLanguage) {
    invariants.push("No oversell (perfect fit, guaranteed, definitely, slam dunk).")
  }
  if (input.matchSummary?.trim()) {
    invariants.push(`Why it might fit (soft): ${input.matchSummary.trim()}`)
  }

  return [base, ...invariants].join("\n")
}

const ACCEPT_PATTERNS = [
  /\b(yes|yeah|yep|yup|sure|ok|okay|down|let'?s do|i'?m in|sounds good|why not)\b/i,
]
const DECLINE_PATTERNS = [
  /\b(no|nah|nope|pass|not now|not interested|skip|later)\b/i,
]

export type CollabInviteReplyIntent = "accept" | "decline" | "ambiguous"

/**
 * Deterministic regex floor for collab-invite accept/decline. KEPT as the
 * fail-open fallback under the LLM-primary {@link resolveCollabInviteReplyIntent}
 * (decline-first ordering preserved). Non-canary / LLM-down behavior is
 * byte-identical to today via this function.
 */
export function detectCollabInviteReplyIntent(body: string): CollabInviteReplyIntent {
  const t = body.trim()
  if (!t) return "ambiguous"
  if (DECLINE_PATTERNS.some((p) => p.test(t))) return "decline"
  if (ACCEPT_PATTERNS.some((p) => p.test(t))) return "accept"
  return "ambiguous"
}

// ---------------------------------------------------------------------------
// LLM accept/decline intent (2026-06-05) — migrate the meaning-classifying
// ACCEPT_PATTERNS/DECLINE_PATTERNS regex to an LLM intent extractor.
//
// CONVERSATION-CONTEXT-FIRST-PRINCIPLE: the LLM extracts the user's MEANING; a
// deterministic reducer (`handleCollabInviteReply`) owns STATE. This module
// only supplies the {accept|decline|ambiguous} label. LLM-primary, regex floor
// as the fail-open fallback. Modeled on `skill-intent-classifier.ts`
// (injectable llmCall, AbortController ~800ms, defensive JSON parse, closed
// 3-member enum, ≥0.6 confidence cutoff).
// ---------------------------------------------------------------------------

const COLLAB_INTENT_SET = new Set<CollabInviteReplyIntent>(["accept", "decline", "ambiguous"])
const COLLAB_INTENT_TIMEOUT_MS = 800
const COLLAB_INTENT_CONFIDENCE_CUTOFF = 0.6

/** Validated LLM verdict for a collab-invite reply. */
export type CollabInviteReplyLlmResult = {
  intent: CollabInviteReplyIntent
  confidence: number
  evidence?: string
}

/** Injectable LLM seam. Returns the model's JSON output as a STRING. */
export type CollabInviteIntentLlmCall = (
  prompt: { systemPrompt: string; userMessage: string },
  signal: AbortSignal
) => Promise<string>

export type CollabInviteIntentDeps = {
  llmCall?: CollabInviteIntentLlmCall
  timeoutMs?: number
  log?: (event: string, payload?: Record<string, unknown>) => void
}

const COLLAB_INTENT_SYSTEM_PROMPT = [
  "You classify a job-seeker's reply to a partner-role prescreen invite.",
  "Context: Claire invited them to a quick (~5 min) partner-role prescreen for a job.",
  "Classify their reply into ONE intent and a confidence (0.0-1.0).",
  "Return EXACTLY this JSON shape (no prose):",
  '  {"intent":"accept"|"decline"|"ambiguous","confidence":0.0-1.0,"evidence":"<short verbatim span>"}',
  "Rules:",
  '  - accept   → they agree to do the quick screen ("yeah", "sure", "let\'s do it", "i\'m in").',
  '  - decline  → they say no OR not right now. "not now" / "later" / "maybe another time" → decline.',
  '  - ambiguous → they ask a question, want more info ("tell me more", "what is it?"), or it is unclear.',
  "  - NEVER invent other labels. Use only accept / decline / ambiguous.",
  "  - Confidence reflects how sure you are; be conservative on borderline replies.",
].join("\n")

/** Parse + validate the model JSON against the closed 3-member enum. Never throws. */
export function parseCollabInviteIntentJson(raw: string): CollabInviteReplyLlmResult | null {
  if (!raw || typeof raw !== "string") return null
  let parsed: unknown
  try {
    const trimmed = raw.trim().startsWith("```")
      ? raw.trim().replace(/^```(json)?\s*/i, "").replace(/```$/i, "")
      : raw
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as { intent?: unknown; confidence?: unknown; evidence?: unknown }
  const intentRaw = typeof obj.intent === "string" ? obj.intent.trim().toLowerCase() : ""
  if (!COLLAB_INTENT_SET.has(intentRaw as CollabInviteReplyIntent)) return null
  const confidence = typeof obj.confidence === "number" ? Math.min(1, Math.max(0, obj.confidence)) : 0
  const evidence = typeof obj.evidence === "string" ? obj.evidence.slice(0, 160) : undefined
  return { intent: intentRaw as CollabInviteReplyIntent, confidence, ...(evidence ? { evidence } : {}) }
}

/**
 * Extract the accept/decline/ambiguous intent of a collab-invite reply via the
 * LLM. Never throws — provider/parse/timeout errors return `null` so the caller
 * falls back to the {@link detectCollabInviteReplyIntent} regex floor.
 */
export async function detectCollabInviteReplyIntentLlm(
  body: string,
  deps: CollabInviteIntentDeps = {}
): Promise<CollabInviteReplyLlmResult | null> {
  const t = (body ?? "").trim()
  if (!t) return null
  const llmCall = deps.llmCall ?? defaultCollabInviteIntentLlmCall
  const timeoutMs = deps.timeoutMs ?? COLLAB_INTENT_TIMEOUT_MS
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)
  let raw = ""
  try {
    raw = await llmCall(
      { systemPrompt: COLLAB_INTENT_SYSTEM_PROMPT, userMessage: t },
      controller.signal
    )
  } catch (err) {
    deps.log?.("pa.collab_invite.intent_llm_error", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  } finally {
    clearTimeout(timeoutHandle)
  }
  return parseCollabInviteIntentJson(raw)
}

/** Store surface needed to resolve the collab-invite reply intent (flag read). */
export type CollabInviteIntentStore = {
  db?: Firestore
}

/**
 * LLM-primary collab-invite reply intent with a deterministic regex floor.
 *
 *   1. `regexIntent = detectCollabInviteReplyIntent(body)` — always computed (the floor).
 *   2. GATE: `paCollabInviteLlmIntentEnabled` (per-user, default OFF). Off → return regexIntent.
 *   3. On: run the LLM; use its label only if it is a valid enum AND confidence ≥ 0.6;
 *      else return regexIntent.
 *
 * Monotonic: gated-and-confident → better; everything else byte-identical to today.
 */
export async function resolveCollabInviteReplyIntent(
  event: Pick<InboundEvent, "userId" | "body">,
  store: CollabInviteIntentStore,
  deps: CollabInviteIntentDeps = {}
): Promise<CollabInviteReplyIntent> {
  const regexIntent = detectCollabInviteReplyIntent(event.body ?? "")
  if (!store.db) return regexIntent

  let enabled = false
  try {
    enabled =
      (await getFlag(store.db, "paCollabInviteLlmIntentEnabled", {
        userId: event.userId,
        env: process.env,
      })) === true
  } catch {
    return regexIntent
  }
  if (!enabled) return regexIntent

  const llm = await detectCollabInviteReplyIntentLlm(event.body ?? "", deps)
  if (llm && COLLAB_INTENT_SET.has(llm.intent) && llm.confidence >= COLLAB_INTENT_CONFIDENCE_CUTOFF) {
    deps.log?.("pa.collab_invite.intent_llm_used", {
      userId: event.userId,
      intent: llm.intent,
      confidence: llm.confidence,
      regexIntent,
    })
    return llm.intent
  }
  return regexIntent
}

export function buildCollabInviteTemplate(input: {
  lang: "en" | "zh"
  jobTitle: string
  company: string
}): string {
  return `quick one — ${input.company} has a partner ${input.jobTitle} role and we can run a short ~5min screen first. wanna try? if it goes well I can intro you to the team — no guarantees on outcome tho`
}

// ---------------------------------------------------------------------------
// Default LLM call — cheap Qwen-7B json_object tier (same client style as
// skill-intent-classifier.ts). Injectable via `deps.llmCall` for tests.
// ---------------------------------------------------------------------------

const COLLAB_INTENT_DEFAULT_MODEL = "Qwen/Qwen2.5-7B-Instruct"
let cachedCollabIntentClient: import("openai").default | null = null

async function getDefaultCollabIntentClient(): Promise<import("openai").default> {
  if (cachedCollabIntentClient) return cachedCollabIntentClient
  const { default: OpenAI } = await import("openai")
  const apiKey =
    process.env.PA_SKILL_CLASSIFIER_API_KEY?.trim() ||
    process.env.SILICONFLOW_API_KEY?.trim() ||
    process.env.PA_LLM_REWRITE_API_KEY?.trim() ||
    ""
  const baseURL =
    process.env.PA_SKILL_CLASSIFIER_BASE_URL?.trim() || "https://api.siliconflow.cn/v1"
  cachedCollabIntentClient = new OpenAI({ apiKey, baseURL })
  return cachedCollabIntentClient
}

/** Default Qwen-7B (free-tier) collab-invite intent call. Returns model JSON as a string. */
export const defaultCollabInviteIntentLlmCall: CollabInviteIntentLlmCall = async (
  prompt,
  signal
) => {
  const client = await getDefaultCollabIntentClient()
  const model = process.env.PA_SKILL_CLASSIFIER_MODEL?.trim() || COLLAB_INTENT_DEFAULT_MODEL
  const resp = (await client.chat.completions.create(
    {
      model,
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: "system", content: prompt.systemPrompt },
        { role: "user", content: prompt.userMessage },
      ],
      response_format: { type: "json_object" },
    },
    { signal: signal as unknown as undefined }
  )) as { choices?: Array<{ message?: { content?: string | null } }> }
  return resp.choices?.[0]?.message?.content ?? ""
}
