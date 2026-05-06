/**
 * @pa/job-tag-enricher — Anthropic Messages API provider via tool_use
 * structured output. Mirrors pa-resume-parser's provider verbatim.
 *
 * Graceful fallthrough: when ANTHROPIC_API_KEY is absent, throws a
 * retryable 503-shaped error so the router moves to the next tier.
 */

import { NonRetryableError } from "../retry.js"

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
  apiKey: string | undefined
  baseURL?: string
  model: string
  systemPrompt: string
  userText: string
  schemaName: string
  schema: Record<string, unknown>
  maxRetries: number
  clientFactory?: (init: {
    apiKey: string
    baseURL?: string
    maxRetries?: number
  }) => AnthropicMessagesClient | Promise<AnthropicMessagesClient>
  strict?: boolean
}

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

  const tool = {
    name: args.schemaName,
    description: `Return enriched job tags matching the ${args.schemaName} schema. Always call this tool exactly once with the classified values.`,
    input_schema: args.schema,
  }

  const response = await client.messages.create({
    model: args.model,
    max_tokens: 4096,
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
