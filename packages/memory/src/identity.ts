/**
 * Phase 11.3 — single source of truth for the Mem0/Qdrant partition key.
 *
 * The PA platform has exactly two identity surfaces (per
 * `.planning/phases/11-persona-identity-injection/11-IDENTITY-CONTRACT.md`):
 *   - `userId`     — Firestore canonical (pa_users.id), authoritative for
 *                    all `pa_*` collections + persona card scope.
 *   - `mem0UserId` — authoritative for the Qdrant payload `user_id`
 *                    partition on collection `pa-memory` (semantic memory
 *                    only). MAY differ from `userId` after an operator
 *                    rebind. When unset, falls back to `userId` and the
 *                    two surfaces are identical.
 *
 * `resolveMem0PartitionKey` is the ONLY supported way to compute the
 * partition. Direct access to `user.mem0UserId` outside this helper is a
 * lint-grade smell — it bypasses the empty-string defensive normalization
 * that Firestore snapshots sometimes return for cleared optional strings.
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { randomUUID } from "node:crypto"

/** Minimal user shape required to compute the partition key. */
export type ResolverUser = {
  id: string
  mem0UserId?: string | null
}

/**
 * Returns the Mem0/Qdrant partition key for `user`.
 *
 * Rules:
 *  - `mem0UserId` is treated as set ONLY when it's a non-empty string after
 *    `.trim()`. `undefined`, `null`, `""`, and whitespace-only all fall
 *    back to `user.id` (defensive — Firestore snapshots return `""` for
 *    cleared optional strings; `null` shows up in some test fixtures).
 *  - `user.id` is REQUIRED. Throws `TypeError` if missing or empty.
 *    A user with no canonical id is a corruption signal and must NOT be
 *    silently routed into Mem0.
 */
export function resolveMem0PartitionKey(user: ResolverUser): string {
  if (typeof user?.id !== "string" || user.id.trim().length === 0) {
    throw new TypeError(
      "resolveMem0PartitionKey: user.id is required (got " +
        JSON.stringify(user?.id) +
        ")"
    )
  }
  const raw = user.mem0UserId
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (trimmed.length > 0) return trimmed
  }
  return user.id
}

/** Surface tag for `recordDriftIfAny` — bounded enum, not free-form. */
export type DriftSurface = "orchestrator_turn" | "after_turn" | "memory_admin"

export type RecordDriftDeps = {
  /**
   * Optional. When omitted, drift logging is disabled and the helper
   * resolves immediately (used by unit tests / opt-out paths).
   */
  db?: Firestore | null
  /** Test override: defaults to `Date.now()`. */
  now?: () => number
  /**
   * Test override: defaults to a module-level LRU `Set`. Resetting per-test
   * avoids cross-test pollution and gives deterministic coverage.
   */
  seenCache?: Set<string>
  /**
   * Test override: defaults to console.log. drift telemetry MUST also be
   * structured-logged for Cloud Logging visibility even when Firestore
   * write succeeds.
   */
  logger?: (line: string) => void
}

export type RecordDriftInput = {
  userId: string
  /**
   * Resolved partition key. When equal to `userId` no drift exists and
   * the helper is a no-op.
   */
  mem0UserId: string
  surface: DriftSurface
}

/**
 * Per-process throttle. Each unique (userId, mem0UserId, surface) tuple
 * fires at most once per cold start. Drift is rare enough that this
 * collapses to one row per (rebound user, surface) per CF instance —
 * far below `pa-audit-events` write budget. Capped at 1024 entries to
 * bound memory; oldest entry is dropped when exceeded.
 */
const SEEN_CAP = 1024
const seenDriftKeys = new Set<string>()

function rememberSeen(cache: Set<string>, key: string): boolean {
  if (cache.has(key)) return false
  cache.add(key)
  if (cache.size > SEEN_CAP) {
    // Drop oldest insertion (Set preserves insertion order in V8).
    const firstKey = cache.values().next().value
    if (typeof firstKey === "string") cache.delete(firstKey)
  }
  return true
}

/**
 * Best-effort drift telemetry. NEVER throws. NEVER blocks the caller.
 *
 * Emits one `pa-audit-events` row + one structured `console.log` line
 * the first time a given (userId, mem0UserId, surface) tuple is seen
 * within this process. Subsequent sightings are silently skipped.
 *
 * MUST be wrapped at the call site with its own catch (defense in depth);
 * implementation also catches internally so a missing `db` or transient
 * Firestore failure cannot fail a turn.
 */
export async function recordDriftIfAny(
  input: RecordDriftInput,
  deps: RecordDriftDeps = {}
): Promise<void> {
  try {
    if (input.userId === input.mem0UserId) return
    const cache = deps.seenCache ?? seenDriftKeys
    const dedupeKey = `${input.userId}|${input.mem0UserId}|${input.surface}`
    if (!rememberSeen(cache, dedupeKey)) return
    const log = deps.logger ?? ((s) => console.log(s))
    const createdAt = new Date(deps.now ? deps.now() : Date.now()).toISOString()
    log(
      "[memory/drift] " +
        JSON.stringify({
          kind: "memory.identity_drift",
          userId: input.userId,
          mem0UserId: input.mem0UserId,
          surface: input.surface,
          createdAt,
        })
    )
    const db = deps.db
    if (!db) return
    const id = randomUUID()
    const row = {
      id,
      kind: "memory.identity_drift" as const,
      createdAt,
      actor: "system" as const,
      userId: input.userId,
      message: `mem0UserId differs from userId on surface=${input.surface}`,
      meta: {
        mem0UserId: input.mem0UserId,
        surface: input.surface,
      },
    }
    await db.collection(PA_COLLECTIONS.auditEvents).doc(id).set(row)
  } catch (err) {
    // Drift logging MUST NEVER fail a turn. Swallow and log.
    try {
      const log = deps.logger ?? ((s) => console.log(s))
      log(
        "[memory/drift] write_failed " +
          (err instanceof Error ? err.message : String(err))
      )
    } catch {
      // Last-resort: even logger threw. Give up silently.
    }
  }
}

/** Test-only: clear the module-level dedupe cache. NOT exported from index.ts. */
export function __resetDriftCacheForTests(): void {
  seenDriftKeys.clear()
}
