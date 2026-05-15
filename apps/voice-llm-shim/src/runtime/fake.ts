import type {
  AgentTurnStreamChunk,
  AgentTurnStreamRequest,
  RunAgentTurnStream,
} from "./contract.js";

/**
 * Default echo backend used for dev + tests until S1A merges
 * `runAgentTurnStream` into `@pa/pa-orchestrator`.
 *
 * Behavior: takes the last user message, splits it into roughly-token-sized
 * chunks, emits each as a `delta`, then emits a final chunk with
 * `finishReason: "stop"`.
 */
export function createFakeRunAgentTurnStream(opts?: {
  prefix?: string;
  chunkSize?: number;
  finishReason?: "stop" | "length";
}): RunAgentTurnStream {
  const prefix = opts?.prefix ?? "echo: ";
  const chunkSize = opts?.chunkSize ?? 4;
  const finishReason = opts?.finishReason ?? "stop";

  return async function* fake(
    req: AgentTurnStreamRequest,
  ): AsyncIterable<AgentTurnStreamChunk> {
    const lastUser = [...req.messages]
      .reverse()
      .find((m) => m.role === "user");
    const text = prefix + (lastUser?.content ?? "");
    for (let i = 0; i < text.length; i += chunkSize) {
      yield { delta: text.slice(i, i + chunkSize), finishReason: null };
    }
    yield { delta: "", finishReason };
  };
}

/** Backend that always produces the exact chunks supplied. Used in tests. */
export function createScriptedRunAgentTurnStream(
  chunks: AgentTurnStreamChunk[],
): RunAgentTurnStream {
  return async function* scripted(): AsyncIterable<AgentTurnStreamChunk> {
    for (const c of chunks) yield c;
  };
}
