/**
 * iter30 WS3 — `loadTurnContext`: 4-tier batched Firestore read at turn entry.
 *
 * Replaces the 14+ point reads enumerated in `ws-3-6-detail.md` §4 with a
 * single `Promise.all` per tier, plus per-tier LRU+TTL caches sized for a
 * warm Cloud Functions instance (5-15 min lifetime under steady traffic).
 *
 * Latency budget (cold path, p99): 290ms
 *   Tier 1 (always-read): ~80ms — pa-users + history + mem0PartitionKey
 *   Tier 2 (cached, 30-60s TTL): ~5ms hit / ~60ms cold — flags + handbook + agent + weights
 *   Tier 3 (depends on flags): ~200ms — Mem0 search + memory facts
 *   Tier 4 (placeholder until WS7): ~30ms — entity-tag preferences
 *
 * Backward-compat: existing index.ts code paths are NOT yet refactored to
 * consume `ctx`. Wave 2 (day 8+) ports those 28 call sites; this loader
 * runs alongside today's reads behind a flag until the cutover.
 */

import { performance } from "node:perf_hooks"
import type { Firestore } from "firebase-admin/firestore"
import type { ChatMessage, MemoryFact, AgentDef } from "@pa/core-types"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  ClaireContextSchema,
  FeatureFlagsSchema,
  type ClaireContext,
  type FeatureFlags,
  type HandbookSlot,
  type PreferenceTag,
  type WeightRow,
} from "./run-context.js"

// ============================================================================
// Public input + dependency-injection surface (test-friendly).
// ============================================================================

export interface TurnLoaderEvent {
  id: string
  userId: string
  sessionId: string
  body: string
}

export interface TurnLoaderStore {
  loadHistory(sessionId: string, limit: number): Promise<ChatMessage[]>
  listMemoryFacts(userId: string): Promise<MemoryFact[]>
  getMem0UserId(userId: string): Promise<string | undefined>
  loadPersonalizationContext(
    agent: AgentDef,
    args: {
      userId: string
      mem0UserId: string
      sessionId: string
      userMessage: string
      memoryMode: AgentDef["memoryMode"]
    },
    history: ChatMessage[]
  ): Promise<{ memoryBlock: string | null; mem0Degraded: boolean }>
  log(evt: string, payload?: Record<string, unknown>): void
}

/**
 * Tier-2 / Tier-4 dependency injection. Defaults read Firestore directly
 * via the standard collections; tests pass mocks that record call counts.
 */
export interface TurnLoaderDeps {
  loadHandbook?: (
    db: Firestore,
    slug: string
  ) => Promise<HandbookSlot | null>
  loadFeatureFlags?: (
    db: Firestore,
    userId: string
  ) => Promise<FeatureFlags>
  loadAgentDef?: (db: Firestore, agentId: string) => Promise<AgentDef | null>
  loadWeightTables?: (
    db: Firestore
  ) => Promise<Record<string, WeightRow[]>>
  loadEntityTagPreferences?: (
    db: Firestore,
    userId: string
  ) => Promise<PreferenceTag[]>
  detectLocale?: (body: string) => ClaireContext["locale"]
  resolveMem0PartitionKey?: (input: {
    id: string
    mem0UserId: string | undefined
  }) => string
  /** Deterministic now-stamp for tests. */
  now?: () => number
}

export interface LoadTurnInput {
  db: Firestore
  event: TurnLoaderEvent
  agent: AgentDef
  store: TurnLoaderStore
  turnId: string
  /** History truncation limit. Mirrors orchestrator HISTORY_LIMIT (10). */
  historyLimit?: number
  deps?: TurnLoaderDeps
}

// ============================================================================
// Per-tier LRU + TTL caches (module-level — survive across warm CF invocations).
// ============================================================================

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

class LruTtlCache<T> {
  private readonly map = new Map<string, CacheEntry<T>>()
  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number
  ) {}
  get(key: string, now: number): T | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= now) {
      this.map.delete(key)
      return undefined
    }
    // LRU touch — re-insert to move to tail.
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }
  set(key: string, value: T, now: number): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, expiresAt: now + this.ttlMs })
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }
  invalidate(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
  size(): number {
    return this.map.size
  }
  keys(): IterableIterator<string> {
    return this.map.keys()
  }
}

// TTL tiers per detail-plan §3 cache table. Sizes are conservative for a
// single warm CF instance (≤500 active sessions ≈ 50KB total RAM).
const TTL_HANDBOOK_MS = 30_000
const TTL_FLAGS_MS = 60_000
const TTL_AGENT_MS = 30_000
const TTL_WEIGHTS_MS = 30_000
const TTL_ENTITY_TAGS_MS = 15_000

const handbookCache = new LruTtlCache<HandbookSlot | null>(16, TTL_HANDBOOK_MS)
const flagsCache = new LruTtlCache<FeatureFlags>(512, TTL_FLAGS_MS)
const agentCache = new LruTtlCache<AgentDef | null>(16, TTL_AGENT_MS)
const weightsCache = new LruTtlCache<Record<string, WeightRow[]>>(
  4,
  TTL_WEIGHTS_MS
)
const entityTagsCache = new LruTtlCache<PreferenceTag[]>(512, TTL_ENTITY_TAGS_MS)

/** Test-only: drop every cache. Not part of the public contract. */
export function _clearTurnLoaderCaches(): void {
  handbookCache.clear()
  flagsCache.clear()
  agentCache.clear()
  weightsCache.clear()
  entityTagsCache.clear()
}

/** Cache-stat surface for `latency-budget` tests. */
export function _turnLoaderCacheSizes(): Record<string, number> {
  return {
    handbook: handbookCache.size(),
    flags: flagsCache.size(),
    agent: agentCache.size(),
    weights: weightsCache.size(),
    entityTags: entityTagsCache.size(),
  }
}

// ============================================================================
// Default loader implementations (Firestore direct reads).
// ============================================================================

const defaultDeps: Required<
  Pick<
    TurnLoaderDeps,
    | "loadHandbook"
    | "loadFeatureFlags"
    | "loadAgentDef"
    | "loadWeightTables"
    | "loadEntityTagPreferences"
    | "detectLocale"
    | "resolveMem0PartitionKey"
    | "now"
  >
> = {
  async loadHandbook(_db, _slug) {
    // Wave 2 wires this through `@pa/agent-registry.loadHandbook`. Returning
    // `null` triggers the legacy handbook fallback path in index.ts.
    return null
  },
  async loadFeatureFlags(_db, _userId) {
    // Wave 2 batch-reads `pa-feature-flags/*` and merges per-user overrides.
    // For Wave 1 we return schema defaults so guardrails compile against
    // the typed shape.
    return FeatureFlagsSchema.parse({})
  },
  async loadAgentDef(_db, _agentId) {
    return null
  },
  async loadWeightTables(_db) {
    return {}
  },
  async loadEntityTagPreferences(_db, _userId) {
    return []
  },
  detectLocale(body) {
    if (!body) return undefined
    const hasZh = /[\u4e00-\u9fff]/.test(body)
    const hasEn = /[A-Za-z]/.test(body)
    if (hasZh && hasEn) return "mixed"
    if (hasZh) return "zh-CN"
    if (hasEn) return "en-US"
    return undefined
  },
  resolveMem0PartitionKey({ id, mem0UserId }) {
    return mem0UserId && mem0UserId.length > 0 ? mem0UserId : id
  },
  now() {
    return Date.now()
  },
}

// ============================================================================
// Cached-loader wrappers — single-flight per warm-instance is good enough;
// Adam's WS3 acceptance gate is wall-clock parity, not concurrency hardening.
// ============================================================================

async function cachedHandbookLoad(
  db: Firestore,
  slug: string,
  deps: TurnLoaderDeps,
  now: number
): Promise<HandbookSlot | null> {
  const hit = handbookCache.get(slug, now)
  if (hit !== undefined) return hit
  const fresh = await (deps.loadHandbook ?? defaultDeps.loadHandbook)(db, slug)
  handbookCache.set(slug, fresh, now)
  return fresh
}

async function cachedFlagsLoad(
  db: Firestore,
  userId: string,
  deps: TurnLoaderDeps,
  now: number
): Promise<FeatureFlags> {
  // Bucketed by 60s window — limits cache fragmentation for ramped flags.
  const bucket = Math.floor(now / TTL_FLAGS_MS)
  const key = `${userId}:${bucket}`
  const hit = flagsCache.get(key, now)
  if (hit !== undefined) return hit
  const fresh = await (deps.loadFeatureFlags ?? defaultDeps.loadFeatureFlags)(
    db,
    userId
  )
  flagsCache.set(key, fresh, now)
  return fresh
}

async function cachedAgentLoad(
  db: Firestore,
  agentId: string,
  deps: TurnLoaderDeps,
  now: number
): Promise<AgentDef | null> {
  const hit = agentCache.get(agentId, now)
  if (hit !== undefined) return hit
  const fresh = await (deps.loadAgentDef ?? defaultDeps.loadAgentDef)(
    db,
    agentId
  )
  agentCache.set(agentId, fresh, now)
  return fresh
}

async function cachedWeightTablesLoad(
  db: Firestore,
  deps: TurnLoaderDeps,
  now: number
): Promise<Record<string, WeightRow[]>> {
  const key = "__all__"
  const hit = weightsCache.get(key, now)
  if (hit !== undefined) return hit
  const fresh = await (deps.loadWeightTables ?? defaultDeps.loadWeightTables)(
    db
  )
  weightsCache.set(key, fresh, now)
  return fresh
}

async function cachedEntityTagPrefsLoad(
  db: Firestore,
  userId: string,
  deps: TurnLoaderDeps,
  now: number
): Promise<PreferenceTag[]> {
  const hit = entityTagsCache.get(userId, now)
  if (hit !== undefined) return hit
  const loader =
    deps.loadEntityTagPreferences ?? defaultDeps.loadEntityTagPreferences
  // WS7 placeholder — fail-OPEN so a missing collection never blocks a turn.
  const fresh = await loader(db, userId).catch(() => [])
  entityTagsCache.set(userId, fresh, now)
  return fresh
}

// ============================================================================
// Main entry point.
// ============================================================================

const DEFAULT_HISTORY_LIMIT = 10

/**
 * Load every per-turn dependency through the 4-tier batch read path and
 * return a parsed `ClaireContext`. Throws on Zod parse failure so that
 * malformed Firestore docs surface immediately instead of silently leaking
 * `undefined` into guardrails.
 */
export async function loadTurnContext(
  input: LoadTurnInput
): Promise<ClaireContext> {
  const t0 = performance.now()
  const {
    db,
    event,
    agent,
    store,
    turnId,
    historyLimit = DEFAULT_HISTORY_LIMIT,
    deps = {},
  } = input
  const now = (deps.now ?? defaultDeps.now)()
  const userId = event.userId

  // ---- Tier 1: always-read, parallel — pa-users + history + mem0 partition.
  const [userSnap, history, mem0UserId] = await Promise.all([
    db
      .collection(PA_COLLECTIONS.users)
      .doc(userId)
      .get(),
    store.loadHistory(event.sessionId, historyLimit),
    store.getMem0UserId(userId),
  ])
  const userData = (userSnap.exists ? userSnap.data() : undefined) as
    | Record<string, unknown>
    | undefined

  // ---- Tier 2: cached batch — handbook + flags + agent + weight tables.
  const [handbook, flags, agentDefDoc, weightTables] = await Promise.all([
    cachedHandbookLoad(db, agent.id ?? "claire", deps, now),
    cachedFlagsLoad(db, userId, deps, now),
    cachedAgentLoad(db, agent.id, deps, now),
    cachedWeightTablesLoad(db, deps, now),
  ])

  // ---- Tier 3: depends on flags / Tier 1 — Mem0 search + memory facts.
  const partitionResolver =
    deps.resolveMem0PartitionKey ?? defaultDeps.resolveMem0PartitionKey
  const mem0PartitionKey = partitionResolver({
    id: userId,
    mem0UserId,
  })
  const [mem0Result, facts] = await Promise.all([
    store.loadPersonalizationContext(
      agent,
      {
        userId,
        mem0UserId: mem0PartitionKey,
        sessionId: event.sessionId,
        userMessage: event.body,
        memoryMode: agent.memoryMode,
      },
      history
    ),
    store.listMemoryFacts(userId),
  ])

  // ---- Tier 4: WS7 entity-tag preferences (fail-OPEN placeholder).
  const preferences = await cachedEntityTagPrefsLoad(db, userId, deps, now)

  // ---- Compose + parse. Zod validation is the single bottleneck — keep
  // schema flat to avoid the deep-rebuild cost on hot turns.
  const ctx = ClaireContextSchema.parse({
    userId,
    agentId: agent.id,
    conversationId: event.sessionId,
    turnId,
    eventId: event.id,
    locale: (deps.detectLocale ?? defaultDeps.detectLocale)(event.body),
    userProfile: {
      role: typeof userData?.role === "string" ? userData.role : undefined,
      yoe: typeof userData?.yoe === "number" ? userData.yoe : undefined,
      visa: typeof userData?.visa === "string" ? userData.visa : undefined,
      location:
        typeof userData?.location === "string" ? userData.location : undefined,
      onboardingState:
        typeof userData?.onboardingState === "string"
          ? userData.onboardingState
          : undefined,
      preferences,
      resumeAccepted: userData?.resumeAccepted === true,
      resumeParseCount:
        typeof userData?.resumeParseCount === "number"
          ? userData.resumeParseCount
          : 0,
    },
    recentTurns: history,
    recentTurnsForMirror: history
      .filter((m) => m.role === "assistant")
      .slice(-5)
      .reverse(),
    memorySnapshot: facts,
    mem0RecallBlock: mem0Result.memoryBlock,
    mem0PartitionKey,
    mem0Degraded: mem0Result.mem0Degraded,
    activeSkills: [],
    skillStackOrder: [],
    skillAddendum: null,
    weightTables,
    featureFlags: flags,
    handbook,
    // Prefer the freshly-cached agentDef when available; otherwise use the
    // caller-supplied `agent` so back-compat hands the loader a real def.
    agentDef: agentDefDoc ?? agent,
    crisisTripped: false,
    abStripApplied: false,
    promptInjectionTripped: false,
    guardrailHits: [],
    auditEvents: [],
    db,
    log: store.log.bind(store),
  })

  store.log("pa.ctx.loaded", {
    turnId,
    userId,
    latencyMs: performance.now() - t0,
  })
  return ctx
}

// Public re-export for cache invalidation hooks (dashboard write-through).
export const turnLoaderCaches = {
  invalidateHandbook(slug: string): void {
    handbookCache.invalidate(slug)
  },
  invalidateAgent(agentId: string): void {
    agentCache.invalidate(agentId)
  },
  invalidateWeights(): void {
    weightsCache.invalidate("__all__")
  },
  invalidateFlagsForUser(userId: string): void {
    // flush every bucket — exact key fragments aren't worth tracking.
    for (const k of [...flagsCache.keys()]) {
      if (k.startsWith(`${userId}:`)) flagsCache.invalidate(k)
    }
  },
}
