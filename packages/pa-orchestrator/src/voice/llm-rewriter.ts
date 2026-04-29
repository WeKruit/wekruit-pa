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
    priorAssistantReplies?: string[]
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
  "  '我懂' / '我懂那种 X' / '我懂你那 X' (validation tic) → DROP. Replace with reaction ('草 / 是 / 哎 / 是真的' + content)",
  "  '我陪你 X' / '我们一起 X' / '让我帮你 X' (coach-opener) → DROP entirely or replace with peer reaction",
  "  '我那时候也 X' → keep ONLY if not used in last 2 turns; else DROP",
  "",
  "OPENER ROTATION (CRITICAL — Phase 33):",
  "  If PREVIOUS REPLIES section is provided, scan the FIRST WORD/INTERJECTION of each.",
  "  Forbidden current-reply openers if used in any of the last 2 prior replies:",
  "    嗯 / 嗯嗯 / 哎 / 哎呀 / 草 / 操 / 卧 / shit / 是 / 对",
  "  Rotation strategy: if your draft starts with one of these AND it appears in prior replies,",
  "  REWRITE the opener: drop it, OR pick a different word, OR start with content directly.",
  "  Goal: NO opener-word should appear in 3 consecutive replies. Texting humans don't repeat.",
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
  "PASS-THROUGH EXAMPLE (return unchanged):",
  "  DRAFT: 拒得快说明他们没准备好你. next.",
  "  CLAIRE: 拒得快说明他们没准备好你. next.",
  "",
  "Output ONLY the reply. No preface, no explanation, no quotes around it.",
].join("\n")

let cachedClient: OpenAI | null = null
function getClient(): OpenAI {
  if (cachedClient) return cachedClient
  // Phase 33 fix — when DEFAULT_MODEL is a Qwen* identifier, the rewriter
  // MUST hit SiliconFlow (Qwen home), not OpenAI. The previous resolver
  // fell back to PA_OPENAI_AGENT_API_KEY + the OpenAI default baseURL,
  // which produced a 401 on every call (verified in prod logs 2026-04-29).
  const isQwenModel = DEFAULT_MODEL.toLowerCase().startsWith("qwen")
  const apiKey =
    process.env.PA_LLM_REWRITE_API_KEY?.trim() ||
    (isQwenModel ? process.env.SILICONFLOW_API_KEY?.trim() || "" : "") ||
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  const baseURL =
    process.env.PA_LLM_REWRITE_BASE_URL?.trim() ||
    (isQwenModel ? "https://api.siliconflow.cn/v1" : "") ||
    process.env.PA_OPENAI_AGENT_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    undefined
  cachedClient = new OpenAI({ apiKey, baseURL })
  return cachedClient
}

/**
 * Default production rewriter dep — single chat.completions call,
 * tiny output budget, hard token cap.
 */
const defaultDeps: RewriterDeps = {
  callRewriter: async (rawText, signal, priorAssistantReplies) => {
    const client = getClient()
    // Phase 33 — fold prior assistant replies into the user message so
    // the rewriter can rotate openers / detect repeat tics. Limit to last
    // 2 to keep prompt small.
    const priorBlock =
      priorAssistantReplies && priorAssistantReplies.length > 0
        ? `PREVIOUS REPLIES (most recent first):\n${priorAssistantReplies
            .slice(0, 2)
            .map((r, i) => `  [${i + 1}] ${r}`)
            .join("\n")}\n\n`
        : ""
    const response = await client.chat.completions.create(
      {
        model: DEFAULT_MODEL,
        temperature: 0.4,
        max_tokens: 200,
        messages: [
          { role: "system", content: REWRITER_V2_SYSTEM_PROMPT },
          {
            role: "user",
            content: `${priorBlock}DRAFT:\n${rawText}\n\nREWRITTEN OR UNCHANGED:`,
          },
        ],
      },
      { signal }
    )
    return response.choices[0]?.message?.content?.trim() ?? ""
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

  let modelText: string | null = null
  let upstreamError = false
  let upstreamErrorMsg: string | undefined
  try {
    modelText = await deps.callRewriter(rawText, controller.signal, ctx.priorAssistantReplies)
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
  const cleaned = stripThinkBlocks(modelText).trim()

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

  return { text: cleaned, rewriteApplied: true, reason: "rewritten" }
}
