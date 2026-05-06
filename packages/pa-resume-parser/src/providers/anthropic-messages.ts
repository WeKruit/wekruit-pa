/**
 * Phase 53 (PARSE-02) — Anthropic Messages API provider (structured output via tool_use).
 *
 * Mirrors the OpenAI Responses provider interface so the router can swap
 * provider per tier. Uses Anthropic's `tool_use` API for structured output —
 * the model is forced to call a single tool whose `input_schema` matches the
 * JSON Schema we'd otherwise pass to OpenAI's strict mode. This is the
 * Anthropic-recommended pattern (raw JSON with messages.create has proven
 * brittle on long prompts).
 *
 * Graceful fallthrough: when ANTHROPIC_API_KEY is absent at runtime, we
 * throw a retryable error so the router moves to the next tier. This lets
 * cv-ingest deploys succeed even before the secret is provisioned.
 */

import { NonRetryableError } from "../retry.js"

/** Minimal Anthropic Messages API client surface used by this provider. */
export type AnthropicMessagesClient = {
  messages: {
    create(params: Record<string, unknown>): Promise<{
      content?: Array<{
        type?: string
        name?: string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input?: any
        text?: string
      }>
      usage?: {
        input_tokens?: number
        output_tokens?: number
      }
    }>
  }
}

export type AnthropicResult = {
  rawJson: string
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
}

export interface AnthropicCallArgs {
  /** Allow undefined for graceful fallthrough when the secret is not provisioned. */
  apiKey: string | undefined
  baseURL?: string
  model: string
  systemPrompt: string
  userText: string
  schemaName: string
  schema: Record<string, unknown>
  /** Forwarded to Anthropic SDK constructor `maxRetries`. */
  maxRetries: number
  /** Test seam — return a sync or async client. */
  clientFactory?: (init: {
    apiKey: string
    baseURL?: string
    maxRetries?: number
  }) => AnthropicMessagesClient | Promise<AnthropicMessagesClient>
  /** Reserved (unused at present — included for parity with OpenAI provider). */
  strict?: boolean
}

/**
 * Lazy SDK loader so cv-ingest cold-start stays cheap when the parser path
 * isn't hit AND the Anthropic tier isn't reached.
 */
async function defaultClientFactory(init: {
  apiKey: string
  baseURL?: string
  maxRetries?: number
}): Promise<AnthropicMessagesClient> {
  const mod = (await import("@anthropic-ai/sdk")) as unknown as {
    default: new (init: {
      apiKey: string
      baseURL?: string
      maxRetries?: number
    }) => AnthropicMessagesClient
  }
  return new mod.default({
    apiKey: init.apiKey,
    baseURL: init.baseURL,
    maxRetries: init.maxRetries,
  })
}

const ANTHROPIC_FALLTHROUGH_STATUS = 503

export async function callAnthropicMessages(
  args: AnthropicCallArgs
): Promise<AnthropicResult> {
  if (!args.apiKey || args.apiKey.length === 0) {
    // Throw retryable so router falls through to next tier rather than
    // failing the whole chain. (Distinct from `missing_api_key` which is
    // non-retryable for the OpenAI provider — for Anthropic, missing key
    // is expected during gradual rollout.)
    const err = new Error(
      "ANTHROPIC_API_KEY not configured — falling through to next tier"
    ) as Error & { status?: number }
    err.status = ANTHROPIC_FALLTHROUGH_STATUS
    throw err
  }

  const factory = args.clientFactory
  const client: AnthropicMessagesClient = factory
    ? await factory({
        apiKey: args.apiKey,
        baseURL: args.baseURL,
        maxRetries: args.maxRetries,
      })
    : await defaultClientFactory({
        apiKey: args.apiKey,
        baseURL: args.baseURL,
        maxRetries: args.maxRetries,
      })

  // Anthropic's tool_use pattern for structured output: define a single
  // tool with the desired schema, then force the model to call that tool.
  // The tool's `input` becomes our structured payload.
  const tool = {
    name: args.schemaName,
    description: `Return parsed result matching ${args.schemaName} schema. Always call this tool exactly once with the parsed values.`,
    input_schema: args.schema,
  }

  const response = await client.messages.create({
    model: args.model,
    max_tokens: 8192,
    system: args.systemPrompt,
    tools: [tool],
    tool_choice: { type: "tool", name: args.schemaName },
    messages: [{ role: "user", content: args.userText }],
  })

  if (!response || !Array.isArray(response.content)) {
    throw new Error("anthropic_response_malformed")
  }

  const toolUse = response.content.find(
    (c) => c?.type === "tool_use" && c?.name === args.schemaName
  )
  if (!toolUse) {
    // No tool_use block means the model declined to call our tool. With
    // tool_choice forced this should not happen; treat as non-retryable
    // since retrying with the same prompt is unlikely to recover.
    throw new NonRetryableError("anthropic_missing_tool_use_block")
  }
  if (toolUse.input == null) {
    throw new NonRetryableError("anthropic_tool_use_input_missing")
  }

  const inputTokens = response.usage?.input_tokens
  const outputTokens = response.usage?.output_tokens
  const totalTokens =
    typeof inputTokens === "number" && typeof outputTokens === "number"
      ? inputTokens + outputTokens
      : undefined

  return {
    rawJson: JSON.stringify(toolUse.input),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
    },
  }
}
