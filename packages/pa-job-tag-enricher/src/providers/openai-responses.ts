/**
 * @pa/job-tag-enricher — OpenAI Responses API provider (structured output).
 *
 * Mirrors pa-resume-parser's provider verbatim. The Responses API doesn't
 * use `max_tokens` / `max_completion_tokens` — strict-mode JSON-schema
 * format handles model-family parameter differences server-side.
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
  maxRetries?: number
  clientFactory?: (init: {
    apiKey: string
    baseURL?: string
    maxRetries?: number
  }) => OpenAIResponsesClient | Promise<OpenAIResponsesClient>
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

async function defaultClientFactory(init: {
  apiKey: string
  baseURL?: string
  maxRetries?: number
}): Promise<OpenAIResponsesClient> {
  const mod = (await import("openai")) as unknown as {
    default: new (init: {
      apiKey: string
      baseURL?: string
      maxRetries?: number
    }) => OpenAIResponsesClient
  }
  return new mod.default({
    apiKey: init.apiKey,
    baseURL: init.baseURL,
    maxRetries: init.maxRetries,
  })
}

export async function callOpenAIResponses(
  args: OpenAIResponsesArgs
): Promise<OpenAIResponsesResult> {
  if (!args.apiKey) {
    throw new NonRetryableError("missing_api_key")
  }
  const factory = args.clientFactory
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
