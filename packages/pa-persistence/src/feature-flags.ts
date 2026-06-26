/**
 * Phase 24.5 — `pa-feature-flags` SDK (P9-Infra)
 *
 * Single entry point: `getFlag(key, ctx)`. Backed by Firestore at
 * `pa-feature-flags/{key}`, fronted by a 30s TTL in-process Map cache.
 *
 * Emergency override: `process.env[key] === "1"` (or `"true"`) short-circuits
 * to legacy `true` BEFORE Firestore read — gives Adam a hot kill switch that
 * does not depend on dashboard / network. Caller passes `{ env }` explicitly
 * in CF code paths so we don't read `process.env` from a shared SDK by stealth.
 *
 * perUser resolution (when scope === "perUser"):
 *   blocklist beats allowlist beats default value (CONTEXT.md success #6).
 *
 * Audit: `setFlag` / `revertFlag` write a `pa-audit-events` row in the same
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

const COLLECTION = "pa-feature-flags"
const AUDIT_COLLECTION = "pa-audit-events"

export const DEFAULT_TTL_MS = 30_000

export type FlagValue = boolean | string | number | Record<string, unknown>
export type FlagType = "bool" | "string" | "number" | "json"
export type FlagScope = "global" | "perEnv" | "perUser"

/**
 * A/B bucket strategy (P8 24.5/AB extension — additive, optional).
 *
 * When `bucketStrategy` is present on a flag doc and the caller is neither
 * blocklisted nor allowlisted, `getFlag()` chooses a variant by either:
 *   - "userIdHash": deterministic djb2 hash of `userId + "::" + key` modulo 100
 *   - "random": `Math.random() * 100`
 *
 * Variant weights MUST sum to 100 at write time (validated in `setFlag`).
 * Readers tolerate weight drift via cumulative-weight clamping (last variant
 * absorbs any rounding gap). If `userIdHash` is selected but no `userId` is
 * supplied in `ctx`, the SDK falls through to the flag's `value` default.
 */
export interface BucketVariant {
  name: string
  weight: number // 0..100
  value: FlagValue
}

export interface BucketStrategy {
  method: "userIdHash" | "random"
  variants: BucketVariant[]
}

export interface FlagDoc {
  key: string
  value: FlagValue
  type: FlagType
  scope: FlagScope
  allowlist?: string[]
  blocklist?: string[]
  bucketStrategy?: BucketStrategy | null
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
  return createHash("sha256").update(ctx.userId).digest("hex").slice(0, 12)
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

function resolvePerUser(doc: FlagDoc, userId: string | undefined): { hit: boolean; value: FlagValue } {
  // blocklist > allowlist > default. Only meaningful for bool perUser flags
  // in v1; for non-bool we fall through to doc.value (lists ignored).
  if (doc.scope !== "perUser" || !userId || doc.type !== "bool") {
    return { hit: false, value: doc.value }
  }
  const block = doc.blocklist ?? []
  const allow = doc.allowlist ?? []
  if (block.includes(userId)) return { hit: true, value: false }
  if (allow.includes(userId)) return { hit: true, value: true }
  return { hit: false, value: doc.value }
}

/**
 * djb2 string hash — deterministic, no crypto dep, 32-bit positive int.
 * Same (userId, flagKey) pair always returns the same number → same variant.
 */
export function djb2Hash(input: string): number {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    // (h << 5) + h === h * 33; XOR with charCode is djb2-xor variant
    h = (Math.imul(h, 33) ^ input.charCodeAt(i)) | 0
  }
  // Force positive 32-bit unsigned
  return h >>> 0
}

/**
 * Pick a bucket variant by cumulative weight. Tolerates sum != 100 by
 * clamping pick to last variant (defensive — saveFlag enforces sum=100).
 * Returns `null` if variants array is empty.
 */
export function pickBucketVariant(
  strategy: BucketStrategy,
  pick: number // 0..100 (or 0..99.999 for hash)
): BucketVariant | null {
  if (!strategy.variants || strategy.variants.length === 0) return null
  let cumulative = 0
  for (const v of strategy.variants) {
    cumulative += Math.max(0, v.weight)
    if (pick < cumulative) return v
  }
  // pick fell past total weight (sum < 100): last variant absorbs.
  return strategy.variants[strategy.variants.length - 1] ?? null
}

function resolveBucket(
  doc: FlagDoc,
  key: string,
  userId: string | undefined
): { hit: boolean; value: FlagValue } {
  const strat = doc.bucketStrategy
  if (!strat || !strat.variants || strat.variants.length === 0) {
    return { hit: false, value: doc.value }
  }
  let pick: number
  if (strat.method === "userIdHash") {
    if (!userId) return { hit: false, value: doc.value }
    pick = djb2Hash(`${userId}::${key}`) % 100
  } else {
    // "random"
    pick = Math.random() * 100
  }
  const variant = pickBucketVariant(strat, pick)
  if (!variant) return { hit: false, value: doc.value }
  return { hit: true, value: variant.value }
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
  let cacheable = true
  if (!snap.exists) {
    value = defaultValue
  } else {
    const doc = snap.data() as FlagDoc
    // 1. perUser blocklist/allowlist (definitive — short-circuits bucket).
    const perUser = resolvePerUser(doc, ctx.userId)
    if (perUser.hit) {
      value = perUser.value
    } else {
      // 2. A/B bucket strategy (if configured).
      const bucket = resolveBucket(doc, key, ctx.userId)
      if (bucket.hit) {
        value = bucket.value
        // "random" is non-deterministic — never cache it (would freeze the
        // first roll for the whole TTL window). userIdHash IS deterministic
        // and ctx-keyed, so caching is safe and desirable.
        if (doc.bucketStrategy?.method === "random") cacheable = false
      } else {
        // 3. Default doc.value
        value = doc.value
      }
    }
  }
  if (cacheable) cache.set(ck, { value, expiresAt: now + ttlMs })
  return value
}

/**
 * Allowlist-ONLY membership check for a perUser bool flag. Unlike {@link getFlag},
 * this DELIBERATELY ignores the global `value`, the env emergency override, and any
 * bucket strategy — it returns true ONLY when `userId` is explicitly in the doc's
 * `allowlist` (and not in `blocklist`).
 *
 * Use this for gates that must ramp PER-CANDIDATE ONLY and never globally (locked
 * rule c — e.g. the scheduling gate): a single global `value:true` flip or env var
 * must NOT widen the gate to the whole fleet. Returns false if the doc is absent or
 * the flag isn't a perUser bool. Not cached — allowlist edits take effect at once.
 */
export async function isUserAllowlisted(
  db: Firestore,
  key: string,
  userId: string | null | undefined,
): Promise<boolean> {
  if (typeof userId !== "string" || userId.length === 0) return false
  const snap = await db.collection(COLLECTION).doc(key).get()
  if (!snap.exists) return false
  const doc = snap.data() as FlagDoc
  if (doc.scope !== "perUser" || doc.type !== "bool") return false
  const block = doc.blocklist ?? []
  const allow = doc.allowlist ?? []
  if (block.includes(userId)) return false
  return allow.includes(userId)
}

/**
 * Write a flag + audit row in a single transaction. Caller supplies actor
 * (dashboard email) and reason (free text). Bumps `version` monotonically.
 */
export function validateBucketStrategy(strategy: BucketStrategy | null | undefined): void {
  if (!strategy) return
  if (strategy.method !== "userIdHash" && strategy.method !== "random") {
    throw new Error(`bucketStrategy.method must be "userIdHash" or "random", got "${String(strategy.method)}"`)
  }
  if (!Array.isArray(strategy.variants) || strategy.variants.length === 0) {
    throw new Error("bucketStrategy.variants must be a non-empty array")
  }
  let sum = 0
  for (const v of strategy.variants) {
    if (typeof v.name !== "string" || v.name.length === 0) {
      throw new Error("bucketStrategy.variants[].name must be a non-empty string")
    }
    if (typeof v.weight !== "number" || !Number.isFinite(v.weight) || v.weight < 0 || v.weight > 100) {
      throw new Error(`bucketStrategy.variants[${v.name}].weight must be a finite number in [0,100]`)
    }
    sum += v.weight
  }
  // Allow tiny floating-point drift (±0.01) — UI uses integer sliders but JSON
  // round-trips can introduce 99.99999 noise.
  if (Math.abs(sum - 100) > 0.01) {
    throw new Error(`bucketStrategy variant weights must sum to 100, got ${sum}`)
  }
}

export async function setFlag(
  db: Firestore,
  key: string,
  next: {
    value: FlagValue
    type: FlagType
    scope: FlagScope
    allowlist?: string[]
    blocklist?: string[]
    bucketStrategy?: BucketStrategy | null
  },
  opts: { actor: string; reason: string }
): Promise<void> {
  // Validation runs OUTSIDE the transaction so callers see a clean throw.
  if (next.bucketStrategy !== undefined) validateBucketStrategy(next.bucketStrategy)
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
      bucketStrategy:
        next.bucketStrategy !== undefined ? next.bucketStrategy : prev?.bucketStrategy ?? null,
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
// addUserToFlagAllowlist — atomic add + audit trail.
// Used by reset / new-user flows that must auto-enable a flag for the user
// (Adam directive 2026-05-05: "flag必须开, 只要是reset或者新用户都必须开").
//
// Idempotent: arrayUnion ensures repeated calls don't duplicate. If the flag
// doc doesn't exist, the call CREATES it with default value=false, scope=
// "perUser", and the user pre-populated in allowlist. This means the flag is
// "default off, this user is on". Other paths can later flip the global
// `value` to true once safe rollout is complete.
//
// Cache invalidation: clears every cache entry for this key (perUser hash
// variants too) since the allowlist changed.
// -----------------------------------------------------------------------------
export async function addUserToFlagAllowlist(
  db: Firestore,
  key: string,
  userId: string,
  opts: { actor: string; reason: string; defaultValue?: FlagValue; defaultType?: FlagType; defaultScope?: FlagScope }
): Promise<void> {
  const flagRef = db.collection(COLLECTION).doc(key)
  const auditRef = db.collection(AUDIT_COLLECTION).doc()
  const nowIso = new Date().toISOString()
  // We need FieldValue.arrayUnion. Import via dynamic import to avoid pulling
  // firebase-admin into module load when this helper isn't used.
  const { FieldValue } = await import("firebase-admin/firestore")

  await db.runTransaction(async (t) => {
    const cur = await t.get(flagRef)
    const prev = cur.exists ? (cur.data() as FlagDoc) : null
    const action = prev ? "flag.allowlist_add" : "flag.create"
    if (prev) {
      // Update only allowlist (preserve other fields).
      t.update(flagRef, {
        allowlist: FieldValue.arrayUnion(userId),
        updatedAt: nowIso,
        updatedBy: opts.actor,
        reason: opts.reason,
        version: (prev.version ?? 0) + 1,
      })
    } else {
      // Create the flag with this user pre-allowlisted + default off.
      const doc: FlagDoc = {
        key,
        value: opts.defaultValue ?? false,
        type: opts.defaultType ?? "bool",
        scope: opts.defaultScope ?? "perUser",
        allowlist: [userId],
        blocklist: [],
        bucketStrategy: null,
        updatedAt: nowIso,
        updatedBy: opts.actor,
        reason: opts.reason,
        version: 1,
      }
      t.set(flagRef, doc)
    }
    t.set(auditRef, {
      actor: opts.actor,
      action,
      key,
      userId,
      reason: opts.reason,
      ts: nowIso,
    })
  })

  // Invalidate every cache entry for this key (perUser hash variants too).
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith(`${key}::`)) cache.delete(k)
  }
}

// -----------------------------------------------------------------------------
// removeUserFromFlagAllowlist — atomic remove + audit trail. The arrayRemove
// sibling of addUserToFlagAllowlist, for operator-driven per-user DISABLE.
//
// Idempotent: arrayRemove is a no-op if the user isn't present. Touches ONLY
// the `allowlist` array (preserve other fields, including the global `value`);
// if the flag doc doesn't exist there is nothing to remove (no-op, no create).
// Writes a `pa-audit-events` row ("flag.allowlist_remove") and invalidates the
// in-memory cache for the key.
// -----------------------------------------------------------------------------
export async function removeUserFromFlagAllowlist(
  db: Firestore,
  key: string,
  userId: string,
  opts: { actor: string; reason: string }
): Promise<void> {
  const flagRef = db.collection(COLLECTION).doc(key)
  const auditRef = db.collection(AUDIT_COLLECTION).doc()
  const nowIso = new Date().toISOString()
  const { FieldValue } = await import("firebase-admin/firestore")

  await db.runTransaction(async (t) => {
    const cur = await t.get(flagRef)
    if (!cur.exists) return // nothing to remove — no doc create on disable.
    const prev = cur.data() as FlagDoc
    // Update only allowlist (preserve other fields, esp. global `value`).
    t.update(flagRef, {
      allowlist: FieldValue.arrayRemove(userId),
      updatedAt: nowIso,
      updatedBy: opts.actor,
      reason: opts.reason,
      version: (prev.version ?? 0) + 1,
    })
    t.set(auditRef, {
      actor: opts.actor,
      action: "flag.allowlist_remove",
      key,
      userId,
      reason: opts.reason,
      ts: nowIso,
    })
  })

  // Invalidate every cache entry for this key (perUser hash variants too).
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith(`${key}::`)) cache.delete(k)
  }
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
