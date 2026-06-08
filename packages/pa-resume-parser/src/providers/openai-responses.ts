/**
 * iter30 WS1 — OpenAI Responses API provider (structured output).
 *
 * Single tier-call entry. The router (router.ts) wraps multiple instances
 * of this for the 3-tier fallback chain. The OpenAI SDK's own retry config
 * (`maxRetries`) handles Layer A retries — we just configure it here.
 */

import { NonRetryableError } from "../retry.js"

export type OpenAIResponsesArgs = {
  apiKey: string
  baseURL?: string
  model: string
  systemPrompt: string
  userText: string
  schemaName: string
  schema: Record<string, unknown>
  /** Forwarded to the OpenAI SDK `maxRetries` constructor option. */
  maxRetries?: number
  /** Override the OpenAI client (test seam). May return sync or async. */
  clientFactory?: (init: {
    apiKey: string
    baseURL?: string
    maxRetries?: number
  }) => OpenAIResponsesClient | Promise<OpenAIResponsesClient>
  /** Optional override for `strict`. Defaults to true. */
  strict?: boolean
}

export type OpenAIResponsesClient = {
  responses: {
    create: (req: Record<string, unknown>) => Promise<{
      output_text?: string
      output?: Array<{ content?: Array<{ text?: string }> }>
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
    }>
  }
}

export type OpenAIResponsesResult = {
  rawJson: string
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
}

/**
 * Default factory: lazy-imports `openai` and returns a real client. Lazy
 * import keeps cold-start cheap when the parser path isn't hit.
 */
// PER-REQUEST TIMEOUT (Adam 2026-06-06 "why is résumé parse taking minutes?"): the OpenAI SDK default
// request timeout is ~10 min, so a slow/overloaded gpt-5.4-nano request HANGS for minutes (× maxRetries
// × the 3-tier chain → up to ~30 min worst case) before falling through — the live 3-min résumé-parse
// stall. Cap a single attempt at 30s so a hung tier fails FAST and the router moves to the next tier;
// a normal tier-1 success (~15s) is unaffected. Overridable via args.timeoutMs.
const DEFAULT_OPENAI_TIMEOUT_MS = 30_000

async function defaultClientFactory(init: {
  apiKey: string
  baseURL?: string
  maxRetries?: number
  timeoutMs?: number
}): Promise<OpenAIResponsesClient> {
  const mod = (await import("openai")) as unknown as {
    default: new (init: {
      apiKey: string
      baseURL?: string
      maxRetries?: number
      timeout?: number
    }) => OpenAIResponsesClient
  }
  return new mod.default({
    apiKey: init.apiKey,
    baseURL: init.baseURL,
    maxRetries: init.maxRetries,
    timeout: init.timeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS,
  })
}

export async function callOpenAIResponses(
  args: OpenAIResponsesArgs
): Promise<OpenAIResponsesResult> {
  if (!args.apiKey) {
    throw new NonRetryableError("missing_api_key")
  }
  const factory = args.clientFactory
  // Both shapes (sync/async) are tolerated — `await` on a sync return is a no-op.
  const client: OpenAIResponsesClient = factory
    ? await factory({ apiKey: args.apiKey, baseURL: args.baseURL, maxRetries: args.maxRetries })
    : await defaultClientFactory({
        apiKey: args.apiKey,
        baseURL: args.baseURL,
        maxRetries: args.maxRetries,
      })

  const resp = await client.responses.create({
    model: args.model,
    input: [
      { role: "system", content: args.systemPrompt },
      { role: "user", content: args.userText },
    ],
    text: {
      format: {
        type: "json_schema",
        name: args.schemaName,
        schema: args.schema,
        strict: args.strict ?? true,
      },
    },
  })

  // Defensive output-text extraction — Responses API exposes the structured
  // payload either at `output_text` (newer SDKs) or in `output[0].content[0].text`.
  const outputText =
    typeof resp.output_text === "string" && resp.output_text.length > 0
      ? resp.output_text
      : Array.isArray(resp.output) && resp.output[0]?.content?.[0]?.text
        ? resp.output[0]!.content![0]!.text!
        : ""

  if (!outputText) {
    throw new Error("empty_llm_output")
  }
  return { rawJson: outputText, usage: resp.usage }
}
