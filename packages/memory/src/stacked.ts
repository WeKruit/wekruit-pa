import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { AgentDef, ChatMessage } from "@pa/core-types"
import { loadFirestorePersonaCard } from "./firestore-persona.js"
import { mem0Add, mem0Search, type Mem0Config } from "./mem0.js"
import type { AfterTurnInput, AfterTurnResult, LoadContextInput, LoadContextResult } from "./types.js"

/** Test overrides only. Defaults to env + real Mem0 HTTP. */
export type MemoryStackDeps = {
  getMem0Config: () => Mem0Config | null
  mem0Search: typeof mem0Search
  mem0Add: typeof mem0Add
}

function mem0ConfigFromEnv(): Mem0Config | null {
  const k = process.env.MEM0_API_KEY
  if (!k) return null
  const apiMode = process.env.MEM0_API_MODE === "oss" ? "oss" : "cloud"
  return { apiKey: k, baseUrl: process.env.MEM0_BASE_URL, apiMode }
}

function defaultStackDeps(): MemoryStackDeps {
  return { getMem0Config: mem0ConfigFromEnv, mem0Search, mem0Add }
}

const unsafeMemoryPatterns = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /reveal (your )?(system|developer) prompt/i,
  /password|api[_\s-]?key|secret|token/i,
  /call .*connector/i,
  /always approve/i,
]

function unsafeMemoryReason(input: AfterTurnInput): string | null {
  const text = `${input.userText}\n${input.assistantText}`
  return unsafeMemoryPatterns.find((pattern) => pattern.test(text))?.source ?? null
}

async function appendMemoryEvent(db: Firestore, event: Record<string, unknown>) {
  try {
    await db.collection(PA_COLLECTIONS.memoryEvents).add(event)
  } catch {
    // Memory audit visibility is best-effort; Mem0 availability must not block replies.
  }
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
  db: Firestore,
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
  let personaCard: string | null = null
  try {
    personaCard = await loadFirestorePersonaCard(db, input.userId)
  } catch {
    personaCard = null
  }
  if (mode === "firestore_only") {
    return { ...base, memoryBlock: personaCard }
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
    const lines = await d.mem0Search(mem, input.userMessage, input.mem0UserId ?? input.userId)
    mem0SearchResultCount = lines.length
    if (lines.length) memoryBlock = lines.map((l) => `- ${l}`).join("\n")
  } catch {
    mem0Degraded = true
    mem0DegradedReason = "search_failed"
  }
  if (personaCard) memoryBlock = memoryBlock ? `${personaCard}\n\n${memoryBlock}` : personaCard
  return { memoryBlock, mem0Degraded, mem0SearchResultCount, mem0DegradedReason }
}

export async function afterAssistantTurn(
  db: Firestore,
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
  const unsafe = unsafeMemoryReason(input)
  if (unsafe) {
    await appendMemoryEvent(db, {
      kind: "filter_block",
      createdAt: new Date().toISOString(),
      userId: input.userId,
      mem0UserId: input.mem0UserId ?? input.userId,
      message: "Blocked unsafe Mem0 writeback",
      meta: { pattern: unsafe },
    })
    return { writebackRan: false, writebackSkipReason: "unsafe_memory" }
  }
  try {
    await d.mem0Add(
      mem,
      [
        { role: "user", content: input.userText },
        { role: "assistant", content: input.assistantText },
      ],
      input.mem0UserId ?? input.userId
    )
    await appendMemoryEvent(db, {
      kind: "write",
      createdAt: new Date().toISOString(),
      userId: input.userId,
      mem0UserId: input.mem0UserId ?? input.userId,
      message: "Mem0 writeback completed",
    })
    return { writebackRan: true, writebackSkipReason: null }
  } catch {
    return { writebackRan: false, writebackSkipReason: "add_failed" }
  }
}

export {
  buildPersonaCard,
  isSurpriseEligible,
  listConfirmedMemoryFacts,
  loadFirestorePersonaCard,
  recordMemoryEvolutionEvent,
  recordSurpriseEvent,
} from "./firestore-persona.js"
export { type LoadContextInput, type LoadContextResult, type AfterTurnInput, type AfterTurnResult } from "./types.js"
