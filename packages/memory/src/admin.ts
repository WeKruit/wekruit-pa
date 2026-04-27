import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"

/**
 * Single source of truth for clearing all PA memory belonging to one user.
 * Consumed by:
 *   - `scripts/pa-clear-user.mjs` (CLI for harness re-runs)
 *   - `pa-orchestrator` (in-band magic-string trigger for test users)
 *   - Phase 3 Memory Admin dashboard (HTTP wrapper)
 *
 * Always clears: Qdrant `pa_memory` (semantic memory), `pa_memory_facts`,
 * `pa_memory_actions`, `pa_memory_events`. With `keepMessages: false`
 * (default) also clears `pa_messages`, `pa_agent_turns`, `pa_turns`.
 *
 * Never touches: `pa_users`, `pa_sessions`, `pa_inbound_events`,
 * `pa_outbound`. The user record + session id are preserved so the next
 * iMessage from the same handle reuses the same Firestore identity.
 */
export type ClearUserMemoryDeps = {
  db: Firestore
  qdrantUrl: string
  qdrantApiKey: string
  qdrantCollection?: string
  /** Override fetch (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch
  logger?: (...args: unknown[]) => void
}

export type ClearUserMemoryOptions = {
  /** When true, leave pa_messages and turn collections alone. */
  keepMessages?: boolean
  /** When true, count what would be deleted but write nothing. */
  dryRun?: boolean
  /**
   * Phase 11.3 — Mem0/Qdrant partition key. When supplied, the Qdrant
   * filter `user_id` uses this value instead of `userId`. Firestore
   * deletes ALWAYS scope on `userId` (Firestore is the canonical
   * `userId`-keyed surface; see 11-IDENTITY-CONTRACT.md §3.1).
   *
   * Pass `resolveMem0PartitionKey(user)` from `@pa/memory` — never read
   * `User.mem0UserId` directly.
   *
   * When omitted, behavior is byte-identical to pre-11.3
   * (`user_id == userId`), which is correct for backfilled users.
   */
  mem0PartitionKey?: string
}

export type ClearUserMemoryResult = {
  userId: string
  dryRun: boolean
  qdrant: { collection: string; matched: number; deleted: boolean }
  firestore: Record<string, number>
}

const DEFAULT_QDRANT_COLLECTION = "pa_memory"

function noop() {}

async function clearQdrantForUser(
  userId: string,
  deps: ClearUserMemoryDeps,
  dryRun: boolean,
  partitionKey?: string
): Promise<{ collection: string; matched: number; deleted: boolean }> {
  const collection = deps.qdrantCollection ?? DEFAULT_QDRANT_COLLECTION
  const url = deps.qdrantUrl.replace(/\/+$/, "")
  const fetchFn = deps.fetch ?? fetch
  // Phase 11.3: when caller supplies a non-empty partition key, use it for
  // the Qdrant filter. Otherwise fall back to userId (legacy / byte-identical).
  const qdrantKey =
    typeof partitionKey === "string" && partitionKey.trim().length > 0
      ? partitionKey.trim()
      : userId
  const filter = { must: [{ key: "user_id", match: { value: qdrantKey } }] }
  const headers = { "api-key": deps.qdrantApiKey, "content-type": "application/json" }

  const countResp = await fetchFn(`${url}/collections/${collection}/points/count`, {
    method: "POST",
    headers,
    body: JSON.stringify({ filter, exact: true }),
  })
  if (!countResp.ok) {
    throw new Error(`Qdrant count failed: ${countResp.status} ${await countResp.text()}`)
  }
  const countJson = (await countResp.json()) as { result?: { count?: number } }
  const matched = countJson.result?.count ?? 0
  if (dryRun || matched === 0) return { collection, matched, deleted: false }

  const delResp = await fetchFn(`${url}/collections/${collection}/points/delete?wait=true`, {
    method: "POST",
    headers,
    body: JSON.stringify({ filter }),
  })
  if (!delResp.ok) {
    throw new Error(`Qdrant delete failed: ${delResp.status} ${await delResp.text()}`)
  }
  return { collection, matched, deleted: true }
}

async function clearFirestoreCollection(
  db: Firestore,
  collection: string,
  userId: string,
  dryRun: boolean
): Promise<number> {
  const snap = await db.collection(collection).where("userId", "==", userId).get()
  if (dryRun || snap.empty) return snap.size
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch()
    for (const doc of snap.docs.slice(i, i + 400)) batch.delete(doc.ref)
    await batch.commit()
  }
  return snap.size
}

export async function clearUserMemory(
  userId: string,
  deps: ClearUserMemoryDeps,
  options: ClearUserMemoryOptions = {}
): Promise<ClearUserMemoryResult> {
  const log = deps.logger ?? noop
  const dryRun = options.dryRun === true
  const keepMessages = options.keepMessages === true
  log(`[clear-user] userId=${userId} dryRun=${dryRun} keepMessages=${keepMessages}`)

  const qdrant = await clearQdrantForUser(userId, deps, dryRun, options.mem0PartitionKey)
  log(`[clear-user] qdrant matched=${qdrant.matched} deleted=${qdrant.deleted}`)

  const firestore: Record<string, number> = {}
  const memoryCollections = [
    PA_COLLECTIONS.memoryFacts,
    PA_COLLECTIONS.memoryActions,
    PA_COLLECTIONS.memoryEvents,
  ]
  for (const c of memoryCollections) {
    firestore[c] = await clearFirestoreCollection(deps.db, c, userId, dryRun)
    log(`[clear-user] firestore ${c}: ${firestore[c]}`)
  }
  if (!keepMessages) {
    const transcriptCollections = [
      PA_COLLECTIONS.messages,
      PA_COLLECTIONS.agentTurns,
      PA_COLLECTIONS.turns,
    ]
    for (const c of transcriptCollections) {
      firestore[c] = await clearFirestoreCollection(deps.db, c, userId, dryRun)
      log(`[clear-user] firestore ${c}: ${firestore[c]}`)
    }
  }

  return { userId, dryRun, qdrant, firestore }
}

/**
 * Magic-string trigger detection. When a test user (user.testMode === true)
 * sends one of these patterns as their entire message, the orchestrator
 * should run `clearUserMemory` and reply with a confirmation instead of
 * routing to the LLM.
 *
 * Patterns are intentionally redundant: ASCII admin form, slash form, and
 * Chinese verbatim. Match is full-string after trim, case-insensitive for
 * the ASCII forms.
 */
export const RESET_PATTERNS = ["__PA_RESET__", "/pa-reset", "重置我的记忆"] as const

export function isResetCommand(body: string): boolean {
  const trimmed = body.trim()
  if (trimmed.length === 0) return false
  for (const p of RESET_PATTERNS) {
    if (trimmed === p) return true
    // ASCII patterns also accept upper-cased variants
    if (/^[\x00-\x7F]+$/.test(p) && trimmed.toLowerCase() === p.toLowerCase()) return true
  }
  return false
}

/** Operator-facing summary, included in the reply outbound. */
export function summarizeClearResult(r: ClearUserMemoryResult): string {
  const fsParts = Object.entries(r.firestore)
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${c}=${n}`)
    .join(", ")
  const fsBlock = fsParts.length > 0 ? fsParts : "all empty"
  const qd = `${r.qdrant.collection}=${r.qdrant.matched}`
  return r.dryRun
    ? `[DRY-RUN] would clear: qdrant ${qd}; firestore ${fsBlock}`
    : `✓ 测试记忆已清空 — qdrant ${qd}; firestore ${fsBlock}`
}
