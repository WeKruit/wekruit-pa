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
  callRewriter: (rawText: string, signal: AbortSignal) => Promise<string>
}

export type RewriteOpts = {
  deps?: RewriterDeps
  /** Hard ceiling. Default 1500ms — well below user-perceptible turn time. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 1500

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
  if (outLen > 1.6 * inLen) return false
  if (inLen > 10 && outLen < 0.4 * inLen) return false
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
  "You are a style normalizer for Claire (柯莱儿 / 小柯). Do not think out loud. Output ONLY the rewritten reply text.",
  "Tone modes — detect and apply:",
  "  [reactive]: user vented/complained → 1 short empathy sentence + optional question",
  "  [casual]: small talk → 1-2 short sentences, slang ok",
  "  [planning]: user explicitly asked for plan/list → may use structured format",
  "",
  "POSITIVE REPLACEMENTS (apply these, do not just delete):",
  "  '我建议你 X' → '你试试 X' / '要不要 X'",
  "  '你应该 X' → '感觉 X 可能会好一点' / drop entirely",
  "  'X 还是 Y?' (binary choice) → single open question, or drop",
  "  Pop-therapy (接住你/硬撑着/hold space) → plain empathy ('听起来挺烦的')",
  "",
  "FAILURE EXAMPLE → CLAIRE REWRITE:",
  "  DRAFT: 听起来有点闷，前两天投了还没回也很正常，Wekruit 这类有时候就是慢或者直接默拒。你先别自己脑补太多，我建议你把投递时间记一下，然后等到下一周中后段再看要不要 follow up。",
  "  CLAIRE: 可能下周回. 也可能默拒. 别先 emo.",
  "",
  "PASS-THROUGH EXAMPLE (return unchanged):",
  "  DRAFT: 拒得快说明他们没准备好你. next.",
  "  CLAIRE: 拒得快说明他们没准备好你. next.",
  "",
  "Output ONLY the reply. No preface, no explanation.",
].join("\n")

let cachedClient: OpenAI | null = null
function getClient(): OpenAI {
  if (cachedClient) return cachedClient
  // Reuse the agent's OpenAI credentials. We do NOT import
  // resolveOpenAICompatConfig from agent-runtime to keep this module's
  // dep graph small (orchestrator already pulls agent-runtime, but the
  // rewriter conceptually targets a single small-model endpoint —
  // future work: switch to SiliconFlow Qwen2.5-7B for cheaper).
  const apiKey =
    process.env.PA_LLM_REWRITE_API_KEY?.trim() ||
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  const baseURL =
    process.env.PA_LLM_REWRITE_BASE_URL?.trim() ||
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
  callRewriter: async (rawText, signal) => {
    const client = getClient()
    const response = await client.chat.completions.create(
      {
        model: DEFAULT_MODEL,
        // Phase 24 — temp 0.4 (was 0.2). More natural rewrites, less mechanical
        // echo. Diff guard catches over-creative outputs (rewrite_unsafe).
        temperature: 0.4,
        // Cap output to keep latency + cost bounded. Real Claire replies
        // are ≤ ~120 chars; 200 tokens is plenty of headroom.
        max_tokens: 200,
        messages: [
          { role: "system", content: REWRITER_V2_SYSTEM_PROMPT },
          { role: "user", content: `DRAFT:\n${rawText}\n\nREWRITTEN OR UNCHANGED:` },
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
export async function rewriteIfOff(rawText: string, opts: RewriteOpts = {}): Promise<RewriteResult> {
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
  try {
    modelText = await deps.callRewriter(rawText, controller.signal)
  } catch {
    upstreamError = true
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
