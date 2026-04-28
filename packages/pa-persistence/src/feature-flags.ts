/**
 * Phase 24.5 — `pa_feature_flags` SDK (P9-Infra)
 *
 * Single entry point: `getFlag(key, ctx)`. Backed by Firestore at
 * `pa_feature_flags/{key}`, fronted by a 30s TTL in-process Map cache.
 *
 * Emergency override: `process.env[key] === "1"` (or `"true"`) short-circuits
 * to legacy `true` BEFORE Firestore read — gives Adam a hot kill switch that
 * does not depend on dashboard / network. Caller passes `{ env }` explicitly
 * in CF code paths so we don't read `process.env` from a shared SDK by stealth.
 *
 * perUser resolution (when scope === "perUser"):
 *   blocklist beats allowlist beats default value (CONTEXT.md success #6).
 *
 * Audit: `setFlag` / `revertFlag` write a `pa_audit_events` row in the same
 * transaction as the flag write. `getFlag` does NOT audit reads.
 *
 * Cache contract (CONTEXT.md ADR):
 *   - 30s TTL (NOT 5min — kill-switch can't wait).
 *   - Cache key includes ctx hash so perUser values don't bleed between users.
 *   - Cache hit-rate ≥95% measured over 1000 calls (unit-tested).
 *   - `_clearFeatureFlagCache()` exported for tests only.
 */

import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"

const COLLECTION = "pa_feature_flags"
const AUDIT_COLLECTION = "pa_audit_events"

export const DEFAULT_TTL_MS = 30_000

export type FlagValue = boolean | string | number | Record<string, unknown>
export type FlagType = "bool" | "string" | "number" | "json"
export type FlagScope = "global" | "perEnv" | "perUser"

export interface FlagDoc {
  key: string
  value: FlagValue
  type: FlagType
  scope: FlagScope
  allowlist?: string[]
  blocklist?: string[]
  updatedAt?: string
  updatedBy?: string
  reason?: string
  version?: number
}

export interface FlagContext {
  userId?: string
  /**
   * Caller-injected env (typically `process.env`). When set and the var name
   * matches the flag key with value "1"/"true", returns `true` immediately
   * without touching Firestore — the emergency override.
   */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
}

interface CacheEntry {
  value: FlagValue
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
let cacheStats = { hits: 0, misses: 0 }

function ctxHash(ctx: FlagContext | undefined): string {
  if (!ctx?.userId) return "_"
  return createHash("sha1").update(ctx.userId).digest("hex").slice(0, 12)
}

function cacheKey(key: string, ctx: FlagContext | undefined): string {
  return `${key}::${ctxHash(ctx)}`
}

function isEnvOverride(env: FlagContext["env"], key: string): boolean {
  if (!env) return false
  const raw = env[key]
  if (raw == null) return false
  const v = String(raw).trim().toLowerCase()
  return v === "1" || v === "true"
}

function resolvePerUser(doc: FlagDoc, userId: string | undefined): FlagValue {
  // blocklist > allowlist > default. Only meaningful for bool perUser flags
  // in v1; for non-bool we fall through to doc.value (lists ignored).
  if (doc.scope !== "perUser" || !userId || doc.type !== "bool") return doc.value
  const block = doc.blocklist ?? []
  const allow = doc.allowlist ?? []
  if (block.includes(userId)) return false
  if (allow.includes(userId)) return true
  return doc.value
}

/**
 * Read a flag value. Returns `defaultValue` if doc absent. Honors env
 * emergency override and 30s TTL cache.
 */
export async function getFlag(
  db: Firestore,
  key: string,
  ctx: FlagContext = {},
  defaultValue: FlagValue = false,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<FlagValue> {
  // Emergency env override — bypasses cache + Firestore.
  if (isEnvOverride(ctx.env, key)) return true

  const ck = cacheKey(key, ctx)
  const now = Date.now()
  const cached = cache.get(ck)
  if (cached && cached.expiresAt > now) {
    cacheStats.hits += 1
    return cached.value
  }
  cacheStats.misses += 1

  const snap = await db.collection(COLLECTION).doc(key).get()
  let value: FlagValue
  if (!snap.exists) {
    value = defaultValue
  } else {
    const doc = snap.data() as FlagDoc
    value = resolvePerUser(doc, ctx.userId)
  }
  cache.set(ck, { value, expiresAt: now + ttlMs })
  return value
}

/**
 * Write a flag + audit row in a single transaction. Caller supplies actor
 * (dashboard email) and reason (free text). Bumps `version` monotonically.
 */
export async function setFlag(
  db: Firestore,
  key: string,
  next: { value: FlagValue; type: FlagType; scope: FlagScope; allowlist?: string[]; blocklist?: string[] },
  opts: { actor: string; reason: string }
): Promise<void> {
  const flagRef = db.collection(COLLECTION).doc(key)
  const auditRef = db.collection(AUDIT_COLLECTION).doc()
  const nowIso = new Date().toISOString()
  await db.runTransaction(async (t) => {
    const cur = await t.get(flagRef)
    const prev = cur.exists ? (cur.data() as FlagDoc) : null
    const version = (prev?.version ?? 0) + 1
    const action: "flag.create" | "flag.update" = prev ? "flag.update" : "flag.create"
    const doc: FlagDoc = {
      key,
      value: next.value,
      type: next.type,
      scope: next.scope,
      allowlist: next.allowlist ?? prev?.allowlist ?? [],
      blocklist: next.blocklist ?? prev?.blocklist ?? [],
      updatedAt: nowIso,
      updatedBy: opts.actor,
      reason: opts.reason,
      version,
    }
    t.set(flagRef, doc)
    t.set(auditRef, {
      actor: opts.actor,
      action,
      key,
      oldValue: prev?.value ?? null,
      newValue: next.value,
      reason: opts.reason,
      ts: nowIso,
    })
  })
  // Invalidate every cache entry for this key (perUser hash variants too).
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith(`${key}::`)) cache.delete(k)
  }
}

/**
 * Read the most-recent audit row for `key` and write its `oldValue` back as
 * the new value. Audited as `flag.revert`.
 */
export async function revertFlag(
  db: Firestore,
  key: string,
  opts: { actor: string; reason: string }
): Promise<{ revertedTo: FlagValue } | { revertedTo: null }> {
  const auditSnap = await db
    .collection(AUDIT_COLLECTION)
    .where("key", "==", key)
    .orderBy("ts", "desc")
    .limit(1)
    .get()
  if (auditSnap.empty) return { revertedTo: null }
  const last = auditSnap.docs[0]!.data() as { oldValue: FlagValue | null }
  if (last.oldValue == null) return { revertedTo: null }

  const flagRef = db.collection(COLLECTION).doc(key)
  const auditRef = db.collection(AUDIT_COLLECTION).doc()
  const nowIso = new Date().toISOString()
  await db.runTransaction(async (t) => {
    const cur = await t.get(flagRef)
    if (!cur.exists) return
    const prev = cur.data() as FlagDoc
    const next: FlagDoc = {
      ...prev,
      value: last.oldValue as FlagValue,
      updatedAt: nowIso,
      updatedBy: opts.actor,
      reason: opts.reason,
      version: (prev.version ?? 0) + 1,
    }
    t.set(flagRef, next)
    t.set(auditRef, {
      actor: opts.actor,
      action: "flag.revert",
      key,
      oldValue: prev.value,
      newValue: last.oldValue,
      reason: opts.reason,
      ts: nowIso,
    })
  })
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith(`${key}::`)) cache.delete(k)
  }
  return { revertedTo: last.oldValue as FlagValue }
}

// -----------------------------------------------------------------------------
// Test-only helpers (exported but not part of the public API contract).
// -----------------------------------------------------------------------------

export function _clearFeatureFlagCache(): void {
  cache.clear()
  cacheStats = { hits: 0, misses: 0 }
}

export function _getFeatureFlagCacheStats(): { hits: number; misses: number; hitRate: number } {
  const total = cacheStats.hits + cacheStats.misses
  const hitRate = total === 0 ? 0 : cacheStats.hits / total
  return { hits: cacheStats.hits, misses: cacheStats.misses, hitRate }
}
