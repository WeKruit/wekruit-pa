/**
 * Phase 30 — default `llmJudge` for the Downstream Eval Connector.
 *
 * Runs a single-shot OpenAI chat call against the same nano model as the
 * agent runtime, with a 1.5s soft timeout and a 6-token budget — the parser
 * only looks at the first non-whitespace token so anything past "yes/no"
 * is wasted spend.
 *
 * Hard contract:
 *   - Returns "yes" or "no" (lower-case). Empty / errored / timed-out call
 *     resolves to "" so the caller's first-token-yes parser falls through
 *     to a no-match.
 *   - NEVER throws. The eval pipeline is fire-and-forget — a thrown error
 *     here would propagate up `runDownstreamConnector` and (despite its own
 *     try/catch) consume soft-budget unnecessarily.
 *   - 0 net new LLM calls in production unless `evalConnectorsEnabled` flag
 *     is ON AND at least one `kind=llm-judge` trigger is enabled. With both
 *     OFF (the default after seeding), this module is dead code at runtime.
 *
 * Wiring:
 *   - Production: `runDownstreamConnector(db, ctx, { llmJudge: defaultNlJudge })`
 *     — see `packages/pa-orchestrator/src/index.ts` post-turn hook.
 *   - Tests: pass an inline `llmJudge: async () => "yes"` stub instead.
 *
 * NOT USED for the Phase 21 voice rewriter — that's its own module
 * (`voice/llm-rewriter.ts`) with different prompt + model lineage. Kept
 * separate so Adam's WIP voice changes don't touch this code path.
 */

import OpenAI from "openai"

/** Default nano model — matches the agent runtime's default. */
const DEFAULT_JUDGE_MODEL = process.env.PA_EVAL_JUDGE_MODEL?.trim() || "gpt-5.4-nano"

/** Hard cap so the chat path never blocks > 1.5s on a judge call. */
const DEFAULT_TIMEOUT_MS = 1500

/** Output budget — only the first token matters; 6 leaves slack for "Yes." */
const DEFAULT_MAX_TOKENS = 6

let cachedClient: OpenAI | null = null
function getClient(): OpenAI {
  if (cachedClient) return cachedClient
  // Mirror the auth resolution pattern from voice/llm-rewriter.ts so the
  // judge inherits the same env contract operators already understand:
  // PA_OPENAI_AGENT_* preferred, OPENAI_* as fallback. Keep this module's
  // lookup INDEPENDENT of the rewriter's so a future env split is easy.
  // 2026-05-07 Adam directive — judge is real OpenAI. Drop poisoned
  // OPENAI_API_KEY / OPENAI_BASE_URL fallbacks. Always use explicit
  // OpenAI endpoint unless caller provides PA_EVAL_JUDGE_BASE_URL.
  const apiKey =
    process.env.PA_EVAL_JUDGE_API_KEY?.trim() ||
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() ||
    ""
  const baseURL =
    process.env.PA_EVAL_JUDGE_BASE_URL?.trim() ||
    "https://api.openai.com/v1"
  cachedClient = new OpenAI({ apiKey, baseURL })
  return cachedClient
}

export interface NlJudgeInput {
  prompt: string
  model?: string
  userTurn: string
  assistantTurn: string
}

const SYSTEM_PROMPT =
  "You are a binary classifier. Read the QUESTION and the CONVERSATION TURN. " +
  "Answer with a single word: 'yes' or 'no'. " +
  "Do not explain. Do not add punctuation past the word."

function buildUserMessage(input: NlJudgeInput): string {
  // Trim turns to keep prompt cheap. 1500 chars covers ~99% of single
  // iMessage turns; longer ones get truncated harmlessly.
  const u = String(input.userTurn ?? "").slice(0, 1500)
  const a = String(input.assistantTurn ?? "").slice(0, 1500)
  return [
    `QUESTION: ${input.prompt}`,
    "",
    "CONVERSATION TURN:",
    `user: ${u}`,
    `assistant: ${a}`,
    "",
    "ANSWER (yes or no):",
  ].join("\n")
}

/**
 * Production default judge invoker. Resolves to "yes" / "no" / "".
 *
 * Caller (`evaluateTriggers` in pa-persistence) parses the first non-word
 * boundary token — so "Yes.", "Yes — ...", "yes\n" all match.
 */
export async function defaultNlJudge(input: NlJudgeInput): Promise<string> {
  const model = input.model?.trim() || DEFAULT_JUDGE_MODEL
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const client = getClient()
    const resp = await client.chat.completions.create(
      {
        model,
        temperature: 0,
        max_tokens: DEFAULT_MAX_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(input) },
        ],
      },
      { signal: ctrl.signal }
    )
    const raw = resp.choices?.[0]?.message?.content ?? ""
    return String(raw).trim().toLowerCase()
  } catch {
    // Timeout, network, parse — every error path returns "" so the caller's
    // first-token parser falls through to no-match. NEVER throw out of here.
    return ""
  } finally {
    clearTimeout(timer)
  }
}

/** Test-only — clears the cached OpenAI client so env changes take effect. */
export function _resetNlJudgeClient(): void {
  cachedClient = null
}

/**
 * Test-only — install a fake client so unit tests can drive the judge
 * without hitting the network. Pair with `_resetNlJudgeClient()` to clear.
 */
export function _setNlJudgeClient(client: OpenAI): void {
  cachedClient = client
}
