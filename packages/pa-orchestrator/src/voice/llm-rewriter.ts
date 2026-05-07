/**
 * Phase 21 — LLM output rewriter (Track 4 of prod-regression fix
 * 2026-04-27).
 *
 * WHY: Bible v5 + voice-reminder + filler blacklist + slang lex still
 * couldn't stop nano from defaulting to clinical "X 还是 Y" multi-choice
 * questions, "接住你 / 硬撑着 / 喘不过气那种" pop-therapy register,
 * invented user-categories ("工作这边 / 生活那边"), and productivity-
 * coach probes. The system-prompt + few-shot lever is saturated; we add
 * a cheap second-pass LLM normalizer at the orchestrator exit.
 *
 * ARCHITECTURE
 *   raw nano output
 *     → rewriteIfOff()      (this module — small-LLM rewrite if off-voice)
 *     → normalizeForIMessage (output-normalizer.ts — markdown/UTM strip)
 *     → outbox
 *
 * MODEL CHOICE (Phase 24 update):
 *   Default: Qwen/Qwen3-8B on SiliconFlow free tier.
 *   See DEFAULT_MODEL comment block below.
 *
 * COST BUDGET (Qwen3-8B SiliconFlow free tier):
 *   Free tier — no per-token cost. 1.5s timeout caps tail latency.
 *
 * ROLLBACK: `PA_LLM_REWRITE_DISABLED=true` short-circuits before any
 * model call. Module is also fail-open on every error path.
 *
 * TELEMETRY: callers SHOULD log `rewriteApplied` + `reason` on the turn
 * doc (see `pa_turns.usage` in orchestrator/src/index.ts) so we can
 * measure rewrite-rate offline without sampling raw conversations.
 */

import OpenAI from "openai"
import type { Firestore } from "firebase-admin/firestore"

// Phase 40 T5 — wrap SiliconFlow client with prefix cache for ~20-40% latency
// reduction on warm path (server-side KV cache hits on identical Bible +
// few-shot prefix). 0 net new LLM calls — wrapper, not duplicate caller.
//
// Adam iter 19 — module relocated to @pa/agent-runtime so the main agent LLM
// call path (`runWithOpenAI`) can use the same wrapper. Single source of truth.
import {
  wrapWithPrefixCache,
  type CachedChatClient,
  type PrefixCacheChatMessage as _PrefixCacheMsg,
} from "@pa/agent-runtime"
import type { ChatClient } from "@pa/agent-runtime"

// Phase 40 T4 — umbrella feature flag for v1.4 humanize-runtime stack.
import { getFlag } from "@pa/pa-persistence"

// Phase 35 — 4 deterministic detectors run post-gen on cleaned output.
import {
  runAllDetectors,
  type DetectorContext,
  type DetectorResult,
} from "./detectors/index.js"

// Phase 38 — memory policy advice tracker fires post-gen (fire-and-forget).
import { trackAdvice } from "./memory-policy/index.js"

// Phase 37 — FSM directive injection (ux_state + allowed_strategies).
import { runFsm, type FsmContext } from "./fsm/index.js"

/** What the caller learns about the rewrite attempt. */
export type RewriteReason =
  | "rewritten" // model returned a different non-empty text
  | "no_change" // model returned identical (or trim-equal) text
  | "empty_rewrite" // model returned "" — kept original for safety
  | "timeout" // race lost vs timeoutMs
  | "error" // upstream / parse / network error
  | "disabled" // PA_LLM_REWRITE_DISABLED=true OR empty input
  | "rewrite_unsafe" // Phase 24 — diff-guard rejected (length ratio out of bounds)
  | "circuit_open" // Phase 27 T1 — breaker is OPEN, fail-open with original text

export type RewriteResult = {
  text: string
  rewriteApplied: boolean
  reason: RewriteReason
  /** Phase 27 T1 — true when breaker is OPEN/HALF_OPEN-rejected; caller logs. */
  circuitOpen?: boolean
  /** Phase 35 — per-detector results when umbrella flag is ON. */
  detectorResults?: DetectorResult[]
  /** Phase 35 — true when a detector's suggested_action was applied (strip / regenerate). */
  detectorActionApplied?: boolean
  /** Phase 40 T5 — prefix-cache stats from the final LLM call (warm/cold + hashId). */
  cacheStats?: {
    warm: boolean
    hashId: string
    hitCount: number
    latencyMs: number
  }
}

// ─── Phase 27 T1 — Circuit breaker (in-memory) ───────────────────────────────
//
// In-process state Map<modelId, BreakerState>. Each rewriter module instance
// (per CF cold-start) maintains its own state — sufficient for fail-open
// protection on a single CF instance. When state grows complex (multi-region,
// shared-state) move to Firestore; for now in-memory is enough since CF Gen2
// instances die fast and a stale OPEN state self-resolves on cold-start.
//
// Thresholds:
//   - 5 consecutive failures (404 / timeout / network) → OPEN
//   - OPEN state lasts 60s; subsequent calls short-circuit to fail-open
//   - After 60s, next call is HALF_OPEN: 1 trial. Success → CLOSED. Fail → re-OPEN.

type BreakerStateName = "CLOSED" | "OPEN" | "HALF_OPEN"

type BreakerState = {
  consecutiveFailures: number
  lastFailAt: number
  openedAt: number | null
}

const FAILURE_THRESHOLD = 5
const OPEN_DURATION_MS = 60_000

const breakerStates = new Map<string, BreakerState>()

function getBreakerState(modelId: string): BreakerState {
  let s = breakerStates.get(modelId)
  if (!s) {
    s = { consecutiveFailures: 0, lastFailAt: 0, openedAt: null }
    breakerStates.set(modelId, s)
  }
  return s
}

/**
 * Phase 27 T1 — read-only view of current breaker state for a model.
 * Returns CLOSED / OPEN / HALF_OPEN based on `now` vs `openedAt + 60s`.
 */
export function getBreakerStateName(modelId: string, now: number = Date.now()): BreakerStateName {
  const s = breakerStates.get(modelId)
  if (!s || s.openedAt == null) return "CLOSED"
  if (now - s.openedAt < OPEN_DURATION_MS) return "OPEN"
  return "HALF_OPEN"
}

/** Phase 27 T1 — test helper. Resets all breaker state. */
export function __resetBreakerForTests() {
  breakerStates.clear()
}

function recordFailure(modelId: string, now: number = Date.now()) {
  const s = getBreakerState(modelId)
  s.consecutiveFailures += 1
  s.lastFailAt = now
  if (s.consecutiveFailures >= FAILURE_THRESHOLD && s.openedAt == null) {
    s.openedAt = now
  }
}

function recordSuccess(modelId: string) {
  const s = getBreakerState(modelId)
  s.consecutiveFailures = 0
  s.openedAt = null
}

/**
 * Indirection seam so unit tests can stub the model call without an OpenAI
 * client. In production `defaultDeps` wires this to the same baseURL/key
 * the agent uses (resolveOpenAICompatConfig pattern).
 */
export type RewriterDeps = {
  callRewriter: (
    rawText: string,
    signal: AbortSignal,
    /** Phase 33 — pass last 1-2 assistant replies so rewriter can rotate
     *  openers / detect repeat tics across turns. Optional for back-compat. */
    priorAssistantReplies?: string[],
    /** Phase 37 — FSM directive (ux_state + allowed_strategies) appended
     *  to system prompt for this turn. Optional for back-compat. */
    fsmDirective?: string
  ) => Promise<string>
}

export type RewriteOpts = {
  deps?: RewriterDeps
  /** Hard ceiling. Default 1500ms — well below user-perceptible turn time. */
  timeoutMs?: number
}

// Phase 33 — bumped 1500→4000ms. Production logs 2026-04-29 showed 6/8
// rewrites hitting timeout on SiliconFlow Qwen2.5-7B free tier; anti-tic
// rewrite is the whole point of this layer, so we accept the latency
// budget. Override via PA_LLM_REWRITE_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = Number(process.env.PA_LLM_REWRITE_TIMEOUT_MS ?? 4000)

// Phase 24 default — SiliconFlow free tier. Qwen3.5-4B is the documented
// target but NOT in SF catalog as of 2026-04-27 (24-RESEARCH.md critical
// finding 1). Swap to Qwen/Qwen3.5-4B via PA_LLM_REWRITE_MODEL env when
// SF adds it. Fallback chain via PA_LLM_REWRITE_FALLBACK_MODEL.
const DEFAULT_MODEL = process.env.PA_LLM_REWRITE_MODEL?.trim() || "Qwen/Qwen3-8B"

// Phase 24 fallback model — used at deploy-time by swapping PA_LLM_REWRITE_MODEL.
// Code-level retry is deferred; env-level fallback is simpler and sufficient
// for the current scale (single active user in closed beta).
const FALLBACK_MODEL = process.env.PA_LLM_REWRITE_FALLBACK_MODEL?.trim() || "Qwen/Qwen2.5-7B-Instruct"

// Suppress unused variable warning — FALLBACK_MODEL is intentionally exported
// as documentation and for future use in PA_LLM_REWRITE_FALLBACK_MODEL chain.
void FALLBACK_MODEL

/**
 * Phase 24 — strip Qwen3 thinking-mode blocks. Qwen3 / Qwen3.5 emit
 * <think>...</think> blocks by default. We tell the model not to in the
 * v2 system prompt, but defense-in-depth strips them here too — otherwise
 * the diff-guard sees abnormally long output and rejects valid rewrites
 * (Pitfall 2 in 24-RESEARCH.md).
 */
export function stripThinkBlocks(s: string): string {
  // Greedy match across lines — Qwen typically emits one block but defend
  // against multiple. Only complete <think>...</think> pairs stripped.
  return s.replace(/<think>[\s\S]*?<\/think>/g, "")
}

/**
 * Phase 24 diff guard — reject implausible rewrites:
 * - >1.6× length growth = model padded / hallucinated
 * - <40% length when input > 10 chars = model truncated
 * Returns true if the rewrite is plausibly safe to ship.
 */
/**
 * Deterministic opener-rotation guard (Phase 33d — generic signature-compare).
 *
 * REWRITE NOTE: replaces the previous word-list + clause-extract approach
 * (Phase 33b/c). Word lists were whack-a-mole — every new model preference
 * required adding more entries. This version is generic: extract a fixed-
 * length opener "signature" from each prior reply, strip if current matches.
 *
 * Algorithm:
 *   1. Signature = first 3 CJK chars OR first English word (lowercased).
 *   2. If current.sig === any prior.sig → strip the leading signature chars
 *      + trailing separators from current. Remainder must be ≥ 5 chars
 *      (otherwise return original — don't strip to near-empty).
 *
 * Examples (all opener types unified):
 *   prior=["嗯，X..."]            sig="嗯"   text="嗯，Y..." → strip → "Y..."
 *   prior=["你试试先投..."]        sig="你试试" text="你试试把..." → "把..."
 *   prior=["听起来挺烦的。X"]      sig="听起来" text="听起来挺累..." → "挺累..."
 *   prior=["感觉投递真磨人，X"]    sig="感觉投" text="感觉投递太累..." → "太累..."
 *   prior=["Yeah, X"]            sig="yeah" text="Yeah, Y" → "Y"
 */
function getOpenerSignature(text: string): string {
  const t = text.trim()
  // English: first contiguous word (case-insensitive)
  const enMatch = t.match(/^[A-Za-z]+/)
  if (enMatch) return enMatch[0].toLowerCase()
  // CJK: first 3 hanzi (covers 1-char "嗯", 2-char "感觉", 3-char "你试试/听起来")
  const cjkMatch = t.match(/^[\p{Script=Han}]+/u)
  if (!cjkMatch) return ""
  return cjkMatch[0].slice(0, 3)
}

function getOpenerClause(text: string): string {
  // Everything up to (but excluding) the first sentence separator.
  const m = text.match(/^([^，,。.;；!！？?\n…]+)[，,。.;；!！？?\n…]/)
  return m ? m[1].trim() : ""
}

export function stripRepeatOpener(text: string, priorReplies: string[]): string {
  const trimmed = text.trim()

  // Pass 1 — full-clause exact match (empathy phrases like "感觉投递真的挺磨人的")
  const currentClause = getOpenerClause(trimmed)
  if (currentClause.length >= 4) {
    for (const prior of priorReplies) {
      if (getOpenerClause(prior.trim()) !== currentClause) continue
      const stripped = trimmed
        .slice(currentClause.length)
        .replace(/^[…，,。.;；!！？?\s]+/, "")
        .trim()
      if (stripped.length >= 5) return stripped
    }
  }

  // Pass 2 — signature match. When sig matches, prefer to strip the WHOLE
  // opener clause (everything before first separator) — not just the 3-char
  // sig. Without this, "感觉投递真的挺磨人的的，X" only loses "感觉投" leaving
  // "递真的挺磨人的的，X" which a human still reads as the same phrase.
  // Falls back to sig-only strip when no separator exists in current text.
  const currentSig = getOpenerSignature(trimmed)
  if (currentSig.length === 0) return trimmed
  for (const prior of priorReplies) {
    const priorSig = getOpenerSignature(prior.trim())
    if (priorSig.length === 0 || priorSig !== currentSig) continue
    // Strip whole clause if separator present, else strip just sig.
    const clauseLen = currentClause.length > 0 ? currentClause.length : currentSig.length
    const stripped = trimmed
      .slice(clauseLen)
      .replace(/^[…，,。.;；!！？?\s]+/, "")
      .trim()
    if (stripped.length >= 5) return stripped
  }

  return trimmed
}

/**
 * Phase 33e — deterministic strip of "我懂"/"我懂那种"/"我懂你那" validation tic.
 * The system prompt instructs Qwen to drop these but compliance is unreliable.
 * This guard runs unconditionally: strips the entire validation clause anywhere
 * it appears at start of reply OR after a leading reaction word.
 *
 * Examples:
 *   "我懂那种卡住的感觉" → ""  (caller falls back to original)
 *   "草 我懂那种卡住的感觉。继续。" → "草 继续。"
 *   "嗯，我懂你那种纠结。X" → "嗯，X"
 */
export function stripValidationTic(text: string): string {
  const trimmed = text.trim()
  // Bible bans "我懂" — strip ALL occurrences anywhere (mid-sentence too).
  // Examples that need handling:
  //   "我懂那种X。Y" → "Y"               (start + clause)
  //   "草 我懂那种X。Y" → "草 Y"         (after reaction)
  //   "你这纠结我懂，X" → "你这纠结，X"  (mid-sentence)
  //   "嗯，我懂你那种Z。X" → "嗯，Z。X"  (after separator + variant)
  let result = trimmed.replace(/我懂(?:那种|你那种?)?/gu, "")
  // Clean up artifacts: collapse "，，" / ", ," that may form after strip.
  result = result.replace(/([，,。.;；!！？?])\s*[，,。.;；!！？?]/g, "$1")
  // Strip leading separators (in case 我懂 was at very start).
  result = result.replace(/^[，,。.;；!！？?\s]+/, "").trim()
  return result.length >= 5 ? result : trimmed
}

export function isDiffSafe(inputText: string, outputText: string): boolean {
  const inLen = inputText.trim().length
  const outLen = outputText.trim().length
  // Phase 33 — padding guard unchanged.
  if (outLen > 1.6 * inLen) return false
  // Phase 33 — shrink threshold relaxed 0.4→0.2. Anti-tic rewrites often
  // strip "嗯，我懂那种 X，因为..." (40 chars) → "X." (10 chars) which is
  // exactly what we want; the old 0.4 floor was rejecting them.
  // Also exempt very-short outputs (< 8 chars) like "嗯." / "next." which
  // are valid 1-word reactions even when input was a paragraph.
  if (inLen > 10 && outLen < 0.2 * inLen && outLen >= 8) return false
  return true
}

/**
 * Rewriter v2 system prompt (Phase 24).
 *
 * Key changes from v1:
 * - Opening "Do not think out loud" suppresses Qwen3 thinking mode at prompt level
 * - Positive replacement table (not a blacklist)
 * - In-prompt failure exemplar (wekruit投递 case → Claire-voice rewrite)
 * - Pass-through exemplar (clean reply → return unchanged)
 * - Tone modes: [reactive] / [casual] / [planning]
 *
 * Note: negative-instruction blacklists belong in eval rubric or here in the
 * REWRITER prompt only — NOT in the agent system_prompt (token-activation hazard
 * on nano per 24-CONTEXT.md constraint).
 */
const REWRITER_V2_SYSTEM_PROMPT = [
  "You are a style normalizer for Claire (柯莱儿 / 小柯). Do not think out loud. Output ONLY the rewritten reply text. NO preface like 'CLAIRE:' or 'REWRITTEN:'.",
  "",
  "Tone modes — detect and apply:",
  "  [reactive]: user vented/complained → 1 short empathy sentence, no follow-up question",
  "  [casual]: small talk → 1-2 short sentences, slang ok",
  "  [planning]: user explicitly asked for plan/list → may use structured format",
  "",
  "POSITIVE REPLACEMENTS (apply these, do not just delete):",
  "  '我建议你 X' → '你试试 X' / '要不要 X'",
  "  '你应该 X' → '感觉 X 可能会好一点' / drop entirely",
  "  'X 还是 Y?' (binary choice) → drop the question entirely",
  "  '你最近怎么 X' / probing question → drop it",
  "  Pop-therapy (接住你/硬撑着/hold space) → plain empathy ('听起来挺烦的')",
  "  '我懂' / '我懂那种 X' / '我懂你那 X' (validation tic) → DELETE the entire phrase AND X. Keep ONLY direct content. (Iter 16: do not echo any meta-tokens or placeholder labels in output.)",
  "  '我陪你 X' / '我们一起 X' / '让我帮你 X' (coach-opener) → DROP entirely or replace with peer reaction",
  "  '我那时候也 X' → keep ONLY if not used in last 2 turns; else DROP",
  "",
  "OPENER ROTATION (CRITICAL — Phase 33):",
  "  If PREVIOUS REPLIES section is provided, scan the FIRST CLAUSE (everything before the first",
  "  comma / period / semicolon / 。／，) of each prior reply.",
  "  RULE 1 — Clause-level: if your draft's first clause matches any prior reply's first clause",
  "  exactly (e.g. '感觉投递真的挺磨人的' repeating) → MUST use a different opener.",
  "  RULE 2 — Word-level: these openers are forbidden if they appear in prior replies:",
  "    ZH: 嗯 / 嗯嗯 / 哎 / 哎呀 / 草 / 操 / 卧 / shit / 是 / 对 / 你试试 / 听起来",
  "    EN: Yeah / yeah / Ugh / ugh / Oh / oh / Right / right / Totally / totally / Honestly / honestly / Exactly / exactly",
  "  Fix: drop the opener entirely, pick a different word/phrase, or start with content directly.",
  "  Goal: first clause must differ from ALL prior replies. Texting humans don't repeat.",
  "",
  "LENGTH CAP:",
  "  Max ~80 Chinese chars or ~140 English chars. If draft is longer, cut to the strongest 1-2 sentences.",
  "  No bullets, no markdown, no numbered lists.",
  "",
  "FAILURE EXAMPLE → CLAIRE REWRITE:",
  "  DRAFT: 听起来有点闷，前两天投了还没回也很正常，Wekruit 这类有时候就是慢或者直接默拒。你先别自己脑补太多，我建议你把投递时间记一下，然后等到下一周中后段再看要不要 follow up。",
  "  CLAIRE: 可能下周回. 也可能默拒. 别先 emo.",
  "",
  "FAILURE EXAMPLE 2 (validation tic + escalation):",
  "  PREVIOUS REPLIES (most recent first): ['嗯，面试卡壳那种不确定感最磨人了...']",
  "  DRAFT: 嗯，我懂那种'讲经历一紧张就断片'的落差，听起来你其实技术题反而更稳。你要是想更自信一点，我觉得就先把自我介绍那段练到不靠临场组织也能顺出来。",
  "  CLAIRE: 自我介绍其实最该练熟到能脑子放空也说出来.",
  "",
  "FAILURE EXAMPLE 3 (repeat opener):",
  "  PREVIOUS REPLIES: ['嗯…投这么久没回音确实磨人']",
  "  DRAFT: 嗯，middle 那段最容易卡，因为它既要承上启下又要把重点抛出来；你先把自我介绍拆成三句话",
  "  CLAIRE: middle 段最容易卡 — 拆成 3 句, 不要现场扩写.",
  "",
  "FAILURE EXAMPLE 4 (EN repeat opener):",
  "  PREVIOUS REPLIES: [\"Yeah that's brutal—crickets after you sent emails is rough\"]",
  "  DRAFT: Yeah, I totally get it—getting hit from both sides with the clock and the pressure is exhausting.",
  "  CLAIRE: both sides at once is rough. clock + pressure is a lot.",
  "",
  "PASS-THROUGH EXAMPLE (return unchanged):",
  "  DRAFT: 拒得快说明他们没准备好你. next.",
  "  CLAIRE: 拒得快说明他们没准备好你. next.",
  "",
  "Output ONLY the reply. No preface, no explanation, no quotes around it.",
].join("\n")

let cachedClient: CachedChatClient | null = null
function getClient(): CachedChatClient {
  if (cachedClient) return cachedClient
  // Phase 33 fix — when DEFAULT_MODEL is a Qwen* identifier, the rewriter
  // MUST hit SiliconFlow (Qwen home), not OpenAI. The previous resolver
  // fell back to PA_OPENAI_AGENT_API_KEY + the OpenAI default baseURL,
  // which produced a 401 on every call (verified in prod logs 2026-04-29).
  // 2026-05-07 Adam directive — explicit provider, no env aliasing.
  // Qwen models → SiliconFlow + SF endpoint. Non-Qwen (gpt-4.x etc) →
  // real OpenAI + OpenAI endpoint. NEVER fall through to poisoned
  // OPENAI_API_KEY or OPENAI_BASE_URL env vars.
  const isQwenModel = DEFAULT_MODEL.toLowerCase().startsWith("qwen")
  const apiKey = isQwenModel
    ? (process.env.PA_LLM_REWRITE_API_KEY?.trim() || process.env.SILICONFLOW_API_KEY?.trim() || "")
    : (process.env.PA_LLM_REWRITE_API_KEY?.trim() || process.env.PA_OPENAI_AGENT_API_KEY?.trim() || "")
  const baseURL = isQwenModel
    ? (process.env.PA_LLM_REWRITE_BASE_URL?.trim() || "https://api.siliconflow.cn/v1")
    : (process.env.PA_LLM_REWRITE_BASE_URL?.trim() || "https://api.openai.com/v1")
  // Phase 40 T5 — wrap with prefix-cache. Returns a CachedChatClient which
  // is structurally compatible with OpenAI for the chat.completions.create
  // surface used by defaultDeps below. _cacheStats appended on responses.
  // Cast at boundary: OpenAI's ChatCompletionMessageParam is a stricter
  // discriminated union than prefix-cache's lighter ChatMessage shape; the
  // wrapper only forwards the request body unchanged, so casting is safe.
  const openaiClient = new OpenAI({ apiKey, baseURL }) as unknown as ChatClient
  cachedClient = wrapWithPrefixCache(openaiClient, { capacity: 50 })
  return cachedClient
}

/**
 * Default production rewriter dep — single chat.completions call,
 * tiny output budget, hard token cap.
 */
const defaultDeps: RewriterDeps = {
  callRewriter: async (rawText, signal, priorAssistantReplies, fsmDirective) => {
    const client = getClient()
    // Phase 33 — fold prior assistant replies into the user message so
    // the rewriter can rotate openers / detect repeat tics. Limit to last
    // 2 to keep prompt small.
    // Phase 33f: send ONLY opener fragments (first 12 chars), not full prior
    // replies. Sending full text caused Qwen to copy-paste prior content into
    // new replies — confused "previous reply" with "context to draw from."
    // Truncating to opener-only makes it physically impossible to copy.
    const priorBlock =
      priorAssistantReplies && priorAssistantReplies.length > 0
        ? `OPENER-AVOIDANCE LIST (do NOT copy any text below; only use to avoid starting your reply with the SAME opener phrase):\n${priorAssistantReplies
            .slice(0, 2)
            .map((r, i) => `  [prev-${i + 1}-opener] ${r.trim().slice(0, 12)}…`)
            .join("\n")}\n\n`
        : ""
    // Phase 37 — append FSM directive to system prompt when caller provides
    // one. Empty / undefined → no change. Directive is short (~80-150 chars
    // gloss naming ux_state + allowed strategies).
    const systemPromptWithFsm =
      fsmDirective && fsmDirective.trim().length > 0
        ? `${REWRITER_V2_SYSTEM_PROMPT}\n\n${fsmDirective.trim()}`
        : REWRITER_V2_SYSTEM_PROMPT
    const response = await client.chat.completions.create(
      {
        model: DEFAULT_MODEL,
        temperature: 0.4,
        // Phase 33e: bumped 200→500. Old cap truncated mid-sentence on longer
        // Chinese replies (~150 chars hit the limit). System prompt's 80-char
        // soft cap still applies — this is just a hard ceiling for safety.
        max_tokens: 500,
        messages: [
          { role: "system", content: systemPromptWithFsm },
          {
            role: "user",
            content: `${priorBlock}DRAFT:\n${rawText}\n\nREWRITTEN OR UNCHANGED:`,
          },
        ],
      },
      { signal }
    )
    // Phase 33e: detect length-truncation. If the model hit max_tokens, the
    // last sentence is mid-word — better to return empty (caller falls back
    // to original draft) than ship "...这块也一样，你".
    const choice = response.choices[0]
    if (choice?.finish_reason === "length") return ""
    return choice?.message?.content?.trim() ?? ""
  },
}

/**
 * Rewrite a draft reply if it looks off-voice. Fail-open on every error.
 *
 * @param rawText Draft Claire reply, post-trim.
 * @returns `{ text, rewriteApplied, reason }`. Telemetry consumers should
 *   log `rewriteApplied` + `reason` on the turn doc.
 */
export type RewriteContext = {
  /** Last 1-2 assistant replies in this session (most recent first). */
  priorAssistantReplies?: string[]
  /**
   * Phase 35-40 wire-in fields. All optional — when absent, module activations
   * skip silently (fail-safe OFF). Required when umbrella flag is ON for
   * actual humanize-runtime behavior.
   */
  /** Firestore handle for getFlag + memory tracker writes. */
  db?: Firestore
  /** Current user id — used for getFlag perUser scope + advice tracker keys. */
  userId?: string
  /** Current turn id — used for advice tracker doc keys. */
  turnId?: string
  /**
   * Last N Claire replies (most recent first). Wider history surface than
   * priorAssistantReplies (which is opener-rotation only). Used by F1 verb-
   * mirror n-gram detector + F4 advice-repeat BGE-M3 cos-sim.
   */
  claireHistoryForDetectors?: string[]
  /** Last user message (raw text) — used by F1 verb-mirror against user input. */
  lastUserMessage?: string
  /** User language hint passed through to memory policy injection. */
  userLang?: "zh" | "en" | "mixed"
  /**
   * Phase 37 FSM — last N user messages (most recent first), for ux_state
   * gravity computation. Optional; FSM falls back to current turn only.
   */
  userHistoryForFsm?: string[]
  /**
   * Phase 37 FSM — 1-indexed turn number in current session. Used to map
   * to one of 3 stages (early/mid/late). Defaults to 1 when absent.
   */
  turnNumber?: number
}

/**
 * Phase 40 T4 — umbrella flag check for v1.4 humanize-runtime stack.
 * Returns true when ALL of (Phase 35 detectors, Phase 38 memory-policy)
 * should activate for this user. Default OFF.
 *
 * Emergency disable env: `PA_HUMANIZE_RUNTIME_DISABLED=true` short-circuits
 * to false BEFORE Firestore read. Missing db = OFF.
 */
export async function isHumanizeRuntimeEnabled(
  db: Firestore | undefined,
  userId: string | undefined
): Promise<boolean> {
  if (process.env.PA_HUMANIZE_RUNTIME_DISABLED === "true") return false
  if (!db) return false
  try {
    const v = await getFlag(db, "paHumanizeRuntimeEnabled", {
      userId,
      env: process.env,
    })
    return v === true
  } catch {
    return false
  }
}

export async function rewriteIfOff(
  rawText: string,
  opts: RewriteOpts = {},
  ctx: RewriteContext = {}
): Promise<RewriteResult> {
  // 1. Kill switches & cheap exits.
  if (process.env.PA_LLM_REWRITE_DISABLED === "true") {
    return { text: rawText, rewriteApplied: false, reason: "disabled" }
  }
  if (!rawText || !rawText.trim()) {
    return { text: rawText, rewriteApplied: false, reason: "disabled" }
  }

  const deps = opts.deps ?? defaultDeps
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const modelId = DEFAULT_MODEL

  // Phase 27 T1 — circuit breaker check. If OPEN, fail-open immediately.
  // HALF_OPEN allows one trial call through; if that fails it re-OPENs.
  const stateName = getBreakerStateName(modelId)
  if (stateName === "OPEN") {
    return { text: rawText, rewriteApplied: false, reason: "circuit_open", circuitOpen: true }
  }

  // 2. Race the model call against the timeout. We use AbortController
  //    so a slow upstream doesn't keep tokens flowing after we've moved on.
  const controller = new AbortController()
  let timeoutHit = false
  const timer = setTimeout(() => {
    timeoutHit = true
    controller.abort()
  }, timeoutMs)

  // Phase 37 — compute FSM directive PRE-gen when umbrella ON + sub-flag.
  // Latency budget < 10ms p95 (rule-based, no LLM). 0 net new LLM calls.
  // Computed before the LLM call so the directive can append to system prompt.
  let fsmDirective: string | undefined
  const humanizeEnabledForFsm = await isHumanizeRuntimeEnabled(ctx.db, ctx.userId)
  if (humanizeEnabledForFsm && process.env.PA_FSM_ENABLED !== "false") {
    try {
      const fsmCtx: FsmContext = {
        turn: { user: ctx.lastUserMessage ?? "" },
        history: {
          userTurns: ctx.userHistoryForFsm ?? [],
          claireReplies: ctx.claireHistoryForDetectors ?? [],
        },
        turnNumber: ctx.turnNumber ?? 1,
      }
      const fsmResult = runFsm(fsmCtx, { userLang: ctx.userLang })
      fsmDirective = fsmResult.directive
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log("[llm-rewriter] runFsm failed (degrade)", { msg })
    }
  }

  let modelText: string | null = null
  let upstreamError = false
  let upstreamErrorMsg: string | undefined
  try {
    modelText = await deps.callRewriter(
      rawText,
      controller.signal,
      ctx.priorAssistantReplies,
      fsmDirective
    )
  } catch (err) {
    upstreamError = true
    upstreamErrorMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    // Phase 33 — surface upstream error so we can diagnose. Always-on,
    // not a console.error (CFs forward console.log).
    console.log("[llm-rewriter] upstream error", { msg: upstreamErrorMsg, model: modelId })
  } finally {
    clearTimeout(timer)
  }

  // 3. Decide. Order matters: timeout > error > think-strip > empty > no-change > diff-guard > rewrite.
  if (timeoutHit) {
    recordFailure(modelId)
    const reopenedOpen = getBreakerStateName(modelId) === "OPEN"
    return { text: rawText, rewriteApplied: false, reason: "timeout", circuitOpen: reopenedOpen }
  }
  if (upstreamError || modelText == null) {
    recordFailure(modelId)
    const reopenedOpen = getBreakerStateName(modelId) === "OPEN"
    return { text: rawText, rewriteApplied: false, reason: "error", circuitOpen: reopenedOpen }
  }

  // Successful upstream call — reset breaker (closes HALF_OPEN, clears failure count).
  recordSuccess(modelId)

  // Phase 24 — strip Qwen3 thinking blocks BEFORE any length check (Pitfall 2
  // in 24-RESEARCH.md: unstripped think blocks trip the 1.6x diff guard and
  // reject valid rewrites).
  // Phase 33c — strip role-tag prefix if Qwen leaks conversation format.
  // Regex: strip leading lines that look like "Assistant\nuser\n" role markers.
  const roleTagStripped = modelText.replace(/^(Assistant|User|ASSISTANT|USER)\s*\n(user|assistant|User|Assistant)\s*\n/gi, "")
  const cleaned = stripThinkBlocks(roleTagStripped).trim()

  if (cleaned.length === 0) {
    // Defense-in-depth: never ship empty.
    return { text: rawText, rewriteApplied: false, reason: "empty_rewrite" }
  }
  if (cleaned === rawText.trim()) {
    return { text: rawText, rewriteApplied: false, reason: "no_change" }
  }

  // Phase 24 diff guard — reject implausible rewrites (padded or truncated).
  if (!isDiffSafe(rawText, cleaned)) {
    return { text: rawText, rewriteApplied: false, reason: "rewrite_unsafe" }
  }

  // Phase 35-40 — humanize-runtime stack post-gen activation. All gated by
  // umbrella flag `paHumanizeRuntimeEnabled` (default OFF). When OFF: skip
  // entire block + return cleaned text as before. When ON: run F1-F4
  // detectors + fire-and-forget advice tracker write.
  let detectorResults: DetectorResult[] | undefined
  let detectorActionApplied = false
  let finalText = cleaned

  const humanizeEnabled = await isHumanizeRuntimeEnabled(ctx.db, ctx.userId)
  if (humanizeEnabled) {
    // Phase 35 — detector pass on cleaned output. Sub-flag PA_DETECTORS_ENABLED
    // allows surgical disable when umbrella ON. p95 < 250ms (Promise.allSettled
    // parallel; F4 BGE-M3 fire-and-forget on missing key).
    if (process.env.PA_DETECTORS_ENABLED !== "false") {
      try {
        const detectorCtx: DetectorContext = {
          turn: {
            user: ctx.lastUserMessage ?? "",
            assistant: cleaned,
          },
          history: {
            claireReplies: ctx.claireHistoryForDetectors ?? [],
          },
        }
        detectorResults = await runAllDetectors(detectorCtx)
        // Apply suggested actions: "strip" → keep; "regenerate" / "reject_resample"
        // → caller decides. v1: log only, do not regenerate (would double LLM
        // call, breaks 0-net-new constraint). Strip already applied earlier.
        const actionable = detectorResults.find(
          (r) => r.triggered && r.suggested_action != null
        )
        if (actionable) detectorActionApplied = true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log("[llm-rewriter] detector pass failed (degrade)", { msg })
      }
    }

    // Phase 38 — fire-and-forget advice tracker write. Skip if missing
    // db/userId/turnId; skip on missing API key (BGE embed degrades).
    if (
      process.env.PA_MEMORY_POLICY_ENABLED !== "false" &&
      ctx.db &&
      ctx.userId &&
      ctx.turnId
    ) {
      void trackAdvice(
        ctx.userId,
        finalText,
        ctx.turnId,
        { db: ctx.db }
      ).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.log("[llm-rewriter] trackAdvice failed (degrade)", { msg })
      })
    }
  }

  // Phase 33b — deterministic opener rotation. LLMs don't reliably rotate
  // openers via prompt alone; strip repeat opener tokens after rewriting.
  return {
    text: finalText,
    rewriteApplied: true,
    reason: "rewritten",
    detectorResults,
    detectorActionApplied,
  }
}
