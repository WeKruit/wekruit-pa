import type { AgentTurnFinishReason } from "./runtime/contract.js";

/**
 * OpenAI 2024 chat.completion.chunk shape (subset we emit).
 * Ref: https://platform.openai.com/docs/api-reference/chat-streaming
 */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
    };
    finish_reason: AgentTurnFinishReason;
    logprobs?: null;
  }>;
}

export interface ChunkContext {
  id: string;
  created: number;
  model: string;
}

/** First chunk OpenAI sends: announces the assistant role. No content yet. */
export function makeRoleChunk(ctx: ChunkContext): ChatCompletionChunk {
  return {
    id: ctx.id,
    object: "chat.completion.chunk",
    created: ctx.created,
    model: ctx.model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
}

/** Mid-stream content chunk. */
export function makeContentChunk(
  ctx: ChunkContext,
  content: string,
): ChatCompletionChunk {
  return {
    id: ctx.id,
    object: "chat.completion.chunk",
    created: ctx.created,
    model: ctx.model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
}

/** Terminal chunk: empty delta + finish_reason. */
export function makeFinishChunk(
  ctx: ChunkContext,
  finishReason: AgentTurnFinishReason,
): ChatCompletionChunk {
  return {
    id: ctx.id,
    object: "chat.completion.chunk",
    created: ctx.created,
    model: ctx.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason ?? "stop",
        logprobs: null,
      },
    ],
  };
}

/** Encode a chunk as a single SSE `data:` event terminated by `\n\n`. */
export function encodeSseEvent(chunk: ChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** Final SSE terminator OpenAI sends after the last chunk. */
export const SSE_DONE = "data: [DONE]\n\n";

/** Random-ish OpenAI-style id; not cryptographic. */
export function newChatCompletionId(): string {
  // OpenAI ids look like `chatcmpl-abc123def456...`
  const rand = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `chatcmpl-${rand.slice(0, 24)}`;
}
