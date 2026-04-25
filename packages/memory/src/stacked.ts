import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { AgentDef, ChatMessage } from "@pa/core-types"
import { mem0Add, mem0Search, type Mem0Config } from "./mem0.js"
import type { AfterTurnInput, AfterTurnResult, LoadContextInput, LoadContextResult } from "./types.js"

/** Test overrides only. Defaults to env + real Mem0 HTTP. */
export type MemoryStackDeps = {
  getMem0Config: () => Mem0Config | null
  mem0Search: typeof mem0Search
  mem0Add: typeof mem0Add
}

function envTrim(key: string): string | undefined {
  const v = process.env[key]?.trim()
  return v && v.length > 0 ? v : undefined
}

function mem0ConfigFromEnv(): Mem0Config | null {
  // OSS stack requires SiliconFlow LLM/embedder + Qdrant. Legacy MEM0_API_KEY
  // path is dropped — fail closed to "no_api_key" if any required input is missing.
  const apiKey = envTrim("SILICONFLOW_API_KEY") || envTrim("MEM0_LLM_API_KEY")
  const qdrantUrl = envTrim("QDRANT_URL")
  const qdrantApiKey = envTrim("QDRANT_API_KEY")
  if (!apiKey || !qdrantUrl || !qdrantApiKey) return null
  // Keep Mem0 on the same OpenAI-compatible host as the chat client (CF sets OPENAI_BASE_URL).
  const baseFromMem0 = envTrim("MEM0_LLM_BASE_URL")
  const baseFromOpenAI = envTrim("OPENAI_BASE_URL")
  return {
    apiKey,
    baseUrl: baseFromMem0 ?? baseFromOpenAI,
    llmModel: envTrim("MEM0_LLM_MODEL"),
    embedModel: envTrim("MEM0_EMBED_MODEL"),
    embeddingDims: (() => {
      const d = envTrim("MEM0_EMBED_DIMS")
      if (!d) return undefined
      const n = Number(d)
      return Number.isFinite(n) ? n : undefined
    })(),
    qdrantUrl,
    qdrantApiKey,
    qdrantCollection: envTrim("MEM0_QDRANT_COLLECTION"),
  }
}

function defaultStackDeps(): MemoryStackDeps {
  return { getMem0Config: mem0ConfigFromEnv, mem0Search, mem0Add }
}

/** True when `MEM0_API_KEY` is set (Mem0 can be used for search/writeback when mode allows). */
export function isMem0EnvConfigured(): boolean {
  return mem0ConfigFromEnv() != null
}

export async function loadRecentMessages(
  db: Firestore,
  sessionId: string,
  limit: number
): Promise<ChatMessage[]> {
  const snap = await db
    .collection(PA_COLLECTIONS.messages)
    .where("sessionId", "==", sessionId)
    .limit(200)
    .get()
  const list = snap.docs
    .map((d) => d.data() as ChatMessage)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return list.slice(-limit)
}

/**
 * Injects a Mem0 memory block for `mem0` and `both` (when credentials and API succeed).
 * Transcript (recent `pa_messages`) is always loaded by the worker separately; `mem0` and
 * `both` both add this block when Mem0 is configured. `input.memoryMode` is the only mode switch.
 */
export async function loadPersonalizationContext(
  _db: Firestore,
  input: LoadContextInput,
  _recentMessages: ChatMessage[],
  depsArg?: MemoryStackDeps
): Promise<LoadContextResult> {
  const d = depsArg ?? defaultStackDeps()
  const mode = input.memoryMode
  const base: LoadContextResult = {
    memoryBlock: null,
    mem0Degraded: false,
    mem0SearchResultCount: 0,
    mem0DegradedReason: null,
  }
  if (mode === "firestore_only") {
    return base
  }
  const mem = d.getMem0Config()
  if (!mem) {
    return {
      ...base,
      mem0Degraded: true,
      mem0DegradedReason: "no_api_key",
    }
  }
  let memoryBlock: string | null = null
  let mem0Degraded = false
  let mem0DegradedReason: LoadContextResult["mem0DegradedReason"] = null
  let mem0SearchResultCount = 0
  try {
    const lines = await d.mem0Search(mem, input.userMessage, input.userId)
    mem0SearchResultCount = lines.length
    if (lines.length) memoryBlock = lines.map((l) => `- ${l}`).join("\n")
  } catch {
    mem0Degraded = true
    mem0DegradedReason = "search_failed"
  }
  return { memoryBlock, mem0Degraded, mem0SearchResultCount, mem0DegradedReason }
}

export async function afterAssistantTurn(
  _db: Firestore,
  _agent: AgentDef,
  input: AfterTurnInput,
  depsArg?: MemoryStackDeps
): Promise<AfterTurnResult> {
  const d = depsArg ?? defaultStackDeps()
  const mode = input.memoryMode
  if (mode === "firestore_only") {
    return { writebackRan: false, writebackSkipReason: "memory_mode" }
  }
  const mem = d.getMem0Config()
  if (!mem) {
    return { writebackRan: false, writebackSkipReason: "no_mem0_config" }
  }
  try {
    await d.mem0Add(
      mem,
      [
        { role: "user", content: input.userText },
        { role: "assistant", content: input.assistantText },
      ],
      input.userId
    )
    return { writebackRan: true, writebackSkipReason: null }
  } catch {
    return { writebackRan: false, writebackSkipReason: "add_failed" }
  }
}

export { type LoadContextInput, type LoadContextResult, type AfterTurnInput, type AfterTurnResult } from "./types.js"
