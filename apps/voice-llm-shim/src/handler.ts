import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunAgentTurnStream } from "./runtime/contract.js";
import {
  encodeSseEvent,
  makeContentChunk,
  makeFinishChunk,
  makeRoleChunk,
  newChatCompletionId,
  SSE_DONE,
} from "./sse.js";
import { validateChatCompletionRequest } from "./validate.js";

export interface ChatCompletionsHandlerDeps {
  runAgentTurnStream: RunAgentTurnStream;
  defaultModel?: string;
  /** Override id generator for deterministic tests. */
  newId?: () => string;
  /** Override clock (seconds since epoch) for deterministic tests. */
  now?: () => number;
}

const MAX_BODY_BYTES = 1_000_000; // 1MB safety cap

export function createChatCompletionsHandler(deps: ChatCompletionsHandlerDeps) {
  const newId = deps.newId ?? newChatCompletionId;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const defaultModel = deps.defaultModel ?? "wekruit-prescreen-v1";

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let raw: unknown;
    try {
      raw = await readJsonBody(req, MAX_BODY_BYTES);
    } catch (err) {
      writeJsonError(res, 400, {
        message: err instanceof Error ? err.message : "Failed to read body.",
        type: "invalid_request_error",
      });
      return;
    }

    const validated = validateChatCompletionRequest(raw, { defaultModel });
    if (!validated.ok) {
      writeJsonError(
        res,
        validated.failure.status,
        validated.failure.body.error,
      );
      return;
    }

    const { model, messages } = validated.value;
    const ctx = { id: newId(), created: now(), model };

    // Start SSE response.
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // CORS: openai SDK clients run server-side, but be permissive for dev.
    res.setHeader("Access-Control-Allow-Origin", "*");

    // First chunk: role.
    res.write(encodeSseEvent(makeRoleChunk(ctx)));

    let finishReason: "stop" | "length" | null = null;
    let aborted = false;

    const onAbort = () => {
      aborted = true;
    };
    req.on("aborted", onAbort);
    res.on("close", onAbort);

    try {
      for await (const chunk of deps.runAgentTurnStream({ messages, model })) {
        if (aborted) break;
        if (chunk.delta && chunk.delta.length > 0) {
          res.write(encodeSseEvent(makeContentChunk(ctx, chunk.delta)));
        }
        if (chunk.finishReason) {
          finishReason = chunk.finishReason;
          break;
        }
      }
      if (!aborted) {
        res.write(encodeSseEvent(makeFinishChunk(ctx, finishReason ?? "stop")));
        res.write(SSE_DONE);
        res.end();
      } else {
        res.end();
      }
    } catch (err) {
      // Mid-stream errors: OpenAI signals via an `error` field on a chunk.
      // We send a final chunk with finish_reason="stop" + a synthetic
      // error event (data: { error: ... }) followed by [DONE].
      const errJson = JSON.stringify({
        error: {
          message: err instanceof Error ? err.message : "runtime error",
          type: "server_error",
        },
      });
      try {
        res.write(`data: ${errJson}\n\n`);
        res.write(SSE_DONE);
      } finally {
        res.end();
      }
    }
  };
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c instanceof Buffer ? c : Buffer.from(c);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

function writeJsonError(
  res: ServerResponse,
  status: number,
  error: { message: string; type: string; param?: string; code?: string },
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error }));
}
