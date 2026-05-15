/**
 * Contract between the LLM shim and the agent-runtime stream export
 * (S1A's `runAgentTurnStream`).
 *
 * S1C ships this interface BEFORE S1A merges. When S1A lands, its export
 * must satisfy `RunAgentTurnStream` so the orchestrator backend resolver
 * picks it up.
 */

export type AgentTurnChatMessage = {
  role: "system" | "user" | "assistant" | "tool" | string;
  content: string;
};

export type AgentTurnFinishReason = "stop" | "length" | null;

export interface AgentTurnStreamChunk {
  /** Additive token text since the last chunk. May be empty string. */
  delta: string;
  /**
   * Set on the final chunk. `null` while streaming, `"stop"` on natural
   * end, `"length"` if the runtime truncates.
   */
  finishReason?: AgentTurnFinishReason;
}

export interface AgentTurnStreamRequest {
  messages: AgentTurnChatMessage[];
  /** Pass-through; runtime decides whether to honor. */
  model?: string;
}

export type RunAgentTurnStream = (
  req: AgentTurnStreamRequest,
) => AsyncIterable<AgentTurnStreamChunk>;
