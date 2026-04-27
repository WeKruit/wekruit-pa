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
 * MODEL CHOICE: gpt-5.4-nano. Reusing the agent's own model means no new
 * env vars / baseURL plumbing, and the existing OPENAI_API_KEY works.
 * SiliconFlow Qwen2.5-7B is cheaper (~5x) but adds infra surface; if
 * cost is the binding constraint we can flip via `PA_LLM_REWRITE_MODEL`
 * later. Current per-turn cost is bounded by the timeout + token caps
 * below.
 *
 * COST BUDGET (gpt-5.4-nano per Phase 14 illustrative pricing):
 *   input  $0.05 / 1M tokens — typical 250 tok prompt = $0.0000125
 *   output $0.40 / 1M tokens — capped 200 tok          = $0.00008
 *   ≈ $0.0001 / turn at p99 (well under the $0.0002 estimate quoted in
 *   the planning doc). 1.5s timeout caps tail latency.
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

export type RewriteResult = {
  text: string
  rewriteApplied: boolean
  reason: RewriteReason
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
const DEFAULT_MODEL = process.env.PA_LLM_REWRITE_MODEL?.trim() || "gpt-5.4-nano"

/**
 * The rewriter prompt. Positive framing per Adam constraint — we tell the
 * model what Claire's voice IS, not just a list of don'ts. Don't-list is
 * concrete enough that nano can execute it.
 *
 * Critical: "If text is clean, return it UNCHANGED." This makes the
 * common case a near-no-op and protects voice on already-good drafts.
 */
const REWRITER_SYSTEM_PROMPT = [
  "You are a style normalizer for Claire (柯莱儿 / 小柯), a Bay Area engineering manager texting a friend over iMessage.",
  "Claire's voice: short (1-2 sentences default), plain text, often single sentence with NO follow-up question. Code-switches zh/en the way bilingual friends do. Uses light slang when it fits (卷 / mid / emo / 测评 / lowkey / fr) — one term, never stacked. Sparse signature emoji 🍋 ☕ ok.",
  "You are given a DRAFT reply. Rewrite ONLY if it contains any of:",
  "- Multiple-choice question framework: 'X 还是 Y?' or 'X or Y?' as the question — rewrite to ONE open question, OR drop the question entirely.",
  "- Pop-therapy phrases: 接住你 / 找个人接住 / 硬撑着 / 喘不过气那种 / 这条路我懂 / I see you / hold space — delete or rewrite to plain language.",
  "- Invented categories the user did not say (e.g. '续命型 / 腻型', '工作这边 / 生活那边') — delete.",
  "- Productivity-coach probe at the end ('你现在最想先把哪一件搞定?' or similar) — delete UNLESS the user explicitly asked for a plan or list.",
  "- Markdown / bullet lists / numbered steps in a chit-chat reply.",
  "If the draft is already clean, return it UNCHANGED, byte-for-byte.",
  "Constraints: keep meaning. Keep Claire's voice (short, plain). Keep zh/en code-switch like the user does. Do NOT add new content the user didn't prompt for. Do NOT pad to look polite.",
  "Output ONLY the rewritten (or unchanged) reply text. No preface, no explanation, no quotes around it.",
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
        // Low temperature: this is a normalizer, not a generator. We want
        // the model to either echo or apply the deletion rules
        // deterministically.
        temperature: 0.2,
        // Cap output to keep latency + cost bounded. Real Claire replies
        // are ≤ ~120 chars; 200 tokens is plenty of headroom.
        max_tokens: 200,
        messages: [
          { role: "system", content: REWRITER_SYSTEM_PROMPT },
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

  // 3. Decide. Order matters: timeout > error > empty > no-change > rewrite.
  if (timeoutHit) {
    return { text: rawText, rewriteApplied: false, reason: "timeout" }
  }
  if (upstreamError || modelText == null) {
    return { text: rawText, rewriteApplied: false, reason: "error" }
  }
  if (modelText.trim().length === 0) {
    // Defense-in-depth: never ship empty.
    return { text: rawText, rewriteApplied: false, reason: "empty_rewrite" }
  }
  if (modelText.trim() === rawText.trim()) {
    return { text: rawText, rewriteApplied: false, reason: "no_change" }
  }

  return { text: modelText.trim(), rewriteApplied: true, reason: "rewritten" }
}
