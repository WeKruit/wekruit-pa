/**
 * Phase 32 W3 — 30s in-memory playbook cache.
 *
 * Mirrors the feature-flag SDK cache pattern (see
 * `packages/pa-persistence/src/feature-flags.ts`): every Firestore read
 * is fronted by a 30s TTL Map so the orchestrator hot path doesn't pay
 * one round-trip per inbound message.
 *
 * The cache key is constant (`"all"`) — playbooks are global, no per-user
 * resolution needed (regex match runs against the message body locally).
 *
 * Test helper `_clearPlaybookCache()` is exported for unit tests.
 */
import type { Firestore } from "firebase-admin/firestore"
import {
  listPlaybooks,
  matchPlaybooks,
  type Playbook,
} from "@pa/agent-registry"

export const PLAYBOOK_CACHE_TTL_MS = 30_000

interface CacheEntry {
  playbooks: Playbook[]
  expiresAt: number
}

let cache: CacheEntry | null = null

/**
 * Load playbooks via the cache. Returns the cached list when fresh, else
 * refreshes from Firestore and stores under the global cache slot.
 *
 * Errors are propagated — callers should catch them and fall back to the
 * inline regex (zero-downtime contract). The cache is NOT poisoned on
 * error: a failed refresh leaves the previous entry alone if it exists.
 */
export async function getCachedPlaybooks(
  db: Firestore,
  ttlMs: number = PLAYBOOK_CACHE_TTL_MS
): Promise<Playbook[]> {
  const now = Date.now()
  if (cache && cache.expiresAt > now) {
    return cache.playbooks
  }
  const playbooks = await listPlaybooks(db)
  cache = { playbooks, expiresAt: now + ttlMs }
  return playbooks
}

/**
 * Convenience wrapper used by the orchestrator: load playbooks via cache,
 * match against `messageBody`, return matched playbooks + concatenated
 * addenda. Mirrors `composePlaybooks` from @pa/agent-registry but goes
 * through the 30s cache.
 *
 * Returns an empty result on any failure (so the orchestrator can fall
 * back to the inline regex without crashing the turn).
 */
export async function matchCachedPlaybooks(
  db: Firestore,
  messageBody: string,
  ttlMs: number = PLAYBOOK_CACHE_TTL_MS
): Promise<{ matched: Playbook[]; addendum: string }> {
  try {
    const playbooks = await getCachedPlaybooks(db, ttlMs)
    const matched = matchPlaybooks(messageBody, playbooks)
    const addendum = matched
      .map((p) => p.addendum)
      .filter((s) => typeof s === "string" && s.trim().length > 0)
      .join("\n\n")
    return { matched, addendum }
  } catch {
    return { matched: [], addendum: "" }
  }
}

/** Test-only: drop the cache. Not part of the public API. */
export function _clearPlaybookCache(): void {
  cache = null
}
