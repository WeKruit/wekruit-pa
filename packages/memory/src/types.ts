import type { MemoryMode } from "@pa/core-types"

export type Mem0DegradedReason = "no_api_key" | "search_failed"

export type LoadContextInput = {
  userId: string
  /**
   * Mem0/Qdrant partition key. Caller MUST resolve via
   * `resolveMem0PartitionKey(user)` from `@pa/memory` before passing — never
   * read `User.mem0UserId` directly (the resolver normalizes empty/undefined).
   *
   * Phase 11.3 read-path: when env `PA_MEM0_USE_PARTITION_KEY=true`, this
   * value is used as the Mem0/Qdrant partition. When unset / `false` /
   * `mem0UserId` is missing, falls back to `userId` (legacy behavior).
   * Drift (resolved key !== userId) emits `pa_audit_events` row
   * `kind="memory.identity_drift", surface="orchestrator_turn"`.
   */
  mem0UserId?: string
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
  /**
   * Mem0/Qdrant writeback partition. See `LoadContextInput.mem0UserId`.
   * MUST match the read-path partition or recall misses on the next turn.
   * Drift emits `surface="after_turn"`.
   */
  mem0UserId?: string
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
