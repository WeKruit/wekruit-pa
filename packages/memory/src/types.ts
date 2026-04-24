import type { MemoryMode } from "@pa/core-types"

export type Mem0DegradedReason = "no_api_key" | "search_failed"

export type LoadContextInput = {
  userId: string
  sessionId: string
  userMessage: string
  /**
   * From `pa_agents` / `AgentDef.memoryMode` — only mode switch.
   * `firestore_only`: no Mem0. `mem0` / `both`: Mem0 search + (after response) add when env is configured.
   * Durable messages live in Firestore; Mem0 is optional runtime long-term memory.
   */
  memoryMode: MemoryMode
  maxRecentMessages?: number
}

export type LoadContextResult = {
  /**
   * Mem0-derived block for the LLM system prompt. Transcript (recent `pa_messages`)
   * is always supplied separately by the runtime from Firestore, including when
   * `memoryMode` is `both`.
   */
  memoryBlock: string | null
  /** If Mem0 was expected (mem0|both) but could not return memories */
  mem0Degraded: boolean
  /** Mem0 search hits (0 if search did not run or API returned none) */
  mem0SearchResultCount: number
  /** Set when `mem0Degraded` is true */
  mem0DegradedReason: Mem0DegradedReason | null
}

export type AfterTurnInput = {
  userId: string
  sessionId: string
  userText: string
  assistantText: string
  memoryMode: MemoryMode
}

export type AfterTurnResult = {
  writebackRan: boolean
  /** When writeback did not persist to Mem0 */
  writebackSkipReason: "memory_mode" | "no_mem0_config" | "add_failed" | null
}
