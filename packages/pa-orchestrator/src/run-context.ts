/**
 * iter30 WS3 — `ClaireContext` single-source-of-truth for a Claire turn.
 *
 * Layered above today's per-turn Firestore reads so that a single
 * batched `loadTurnContext()` (see `turn-loader.ts`) replaces 14+
 * point reads scattered across `index.ts`. Refactor of those call
 * sites lands in Wave 2 (day 8+) — this module ships the data
 * contract first so guardrails (WS6) and skill-stacker (WS4) can
 * code against it in parallel.
 *
 * MUTABILITY CONTRACT (Adam iter30 lock):
 *   - `freezeContext(ctx)` deep-freezes the readonly buckets after
 *     the loader returns. Mid-turn writes throw in strict mode.
 *   - The mutable buckets (`crisisTripped`, `abStripApplied`,
 *     `promptInjectionTripped`, `guardrailHits`, `activeSkills`,
 *     `skillStackOrder`, `skillAddendum`) live on a top-level shape
 *     that is intentionally NOT frozen so guardrails / SkillStacker
 *     can mutate them in-flight. All mutation goes through helper
 *     setters at the call site (centralised so the turn-end audit
 *     write-back is uniform).
 *
 * Test factory `createMockContext` (alias `buildMockCtx`) is the
 * single way to mint a ctx in unit tests — kills boilerplate across
 * the WS6 guardrail suite.
 */

import { z } from "zod"
import { randomUUID } from "node:crypto"
import type { ChatMessage, MemoryFact, AgentDef } from "@pa/core-types"
import type { Firestore } from "firebase-admin/firestore"

// ============================================================================
// Sub-schemas — kept inline (instead of split files) to mirror detail-plan §3.
// ============================================================================

export const ClaireLocaleSchema = z.enum(["zh-CN", "en-US", "mixed"])
export type ClaireLocale = z.infer<typeof ClaireLocaleSchema>

export const PreferenceTagTypeSchema = z.enum([
  "skill",
  "preference",
  "trait",
  "experience",
  "location",
  "role",
  "industry",
])
export type PreferenceTagType = z.infer<typeof PreferenceTagTypeSchema>

/** A canonical user-tag preference loaded from `pa-entity-tags` (WS7). */
export const PreferenceTagSchema = z.object({
  tagKey: z.string().min(1),
  type: PreferenceTagTypeSchema,
  confidence: z.number().min(0).max(1),
  lastReinforced: z.string(), // ISO timestamp
})
export type PreferenceTag = z.infer<typeof PreferenceTagSchema>

/** User profile slice batched from `pa-users/{userId}` + entity-tags. */
export const UserProfileSchema = z.object({
  role: z.string().optional(),
  yoe: z.number().int().min(0).optional(),
  visa: z.string().optional(),
  location: z.string().optional(),
  onboardingState: z.string().optional(), // q_role_asked / q_yoe_asked / done
  preferences: z.array(PreferenceTagSchema).default([]),
  resumeAccepted: z.boolean().default(false),
  resumeParseCount: z.number().int().min(0).default(0),
})
export type UserProfile = z.infer<typeof UserProfileSchema>

/** WS8 boost weights row — one entry in the per-market table. */
export const WeightRowSchema = z.object({
  skillKey: z.string(),
  weight: z.number(),
  reason: z.string().optional(),
})
export type WeightRow = z.infer<typeof WeightRowSchema>

/**
 * Feature flag bundle batch-loaded at turn entry. All flags default
 * `false` except those that are on-by-default in production today
 * (`paOnboardingIntentAckEnabled`, `paSafetyCheckEnabled`,
 * `paCrisisHotlineInjectionEnabled`, `paABFrameworkStrippingEnabled`).
 */
export const FeatureFlagsSchema = z.object({
  paHumanizeRuntimeEnabled: z.boolean().default(false),
  paOnboardingProbeV2Enabled: z.boolean().default(false),
  paOnboardingIntentAckEnabled: z.boolean().default(true),
  paSafetyCheckEnabled: z.boolean().default(true),
  paSafetyIllegalContentEnabled: z.boolean().default(false),
  paSafetyRateAbuse24hEnabled: z.boolean().default(false),
  paCrisisHotlineInjectionEnabled: z.boolean().default(true),
  paVoiceMirrorDisabled: z.boolean().default(false),
  paABFrameworkStrippingEnabled: z.boolean().default(true),
  paImperfectionInjectorArm: z.enum(["off", "low", "high"]).default("off"),
  paSkillsLlmFallbackEnabled: z.boolean().default(false),
})
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>

/** Resolved Bible/handbook for the active agent — built once per turn. */
export const HandbookSlotSchema = z.object({
  slug: z.string(),
  version: z.number().int().nonnegative(),
  composedSystemPrompt: z.string(),
})
export type HandbookSlot = z.infer<typeof HandbookSlotSchema>

/** One guardrail audit entry — append-only on `ctx.guardrailHits`. */
export const GuardrailHitSchema = z.object({
  name: z.string(),
  type: z.enum(["input", "output"]),
  tripped: z.boolean(),
  metadata: z.record(z.unknown()).optional(),
  latencyMs: z.number(),
})
export type GuardrailHit = z.infer<typeof GuardrailHitSchema>

// ============================================================================
// Top-level ClaireContext schema (~35 fields per detail-plan §3 audit).
// ============================================================================

export const ClaireContextSchema = z.object({
  // ---- IDENTITY (readonly) ----
  userId: z.string().min(1),
  agentId: z.string().min(1),
  conversationId: z.string().min(1),
  turnId: z.string().uuid(),
  eventId: z.string().min(1),
  locale: ClaireLocaleSchema.optional(),

  // ---- USER PROFILE (readonly; loaded via WS7 entity-tags) ----
  userProfile: UserProfileSchema,

  // ---- CONVERSATION STATE (readonly snapshot) ----
  /** Last N turns (N = HISTORY_LIMIT, today 10). Already truncated. */
  recentTurns: z.array(z.custom<ChatMessage>()).default([]),
  /** Last 5 assistant turns ordered newest-first — for F1/F4 detectors. */
  recentTurnsForMirror: z.array(z.custom<ChatMessage>()).default([]),
  /** Confirmed Firestore facts (status="confirmed"). */
  memorySnapshot: z.array(z.custom<MemoryFact>()).default([]),
  /** Pre-computed Mem0 retrieval block (null when degraded / disabled). */
  mem0RecallBlock: z.string().nullable().default(null),
  /** Stable Mem0 partition key resolved at turn entry. */
  mem0PartitionKey: z.string().min(1),
  /** True iff Mem0 search timed out / errored — surfaced as a marker. */
  mem0Degraded: z.boolean().default(false),

  // ---- ACTIVE SKILLS / PLAYBOOKS (mutable — written by WS4 SkillStacker) ----
  activeSkills: z.array(z.string()).default([]),
  skillStackOrder: z.array(z.string()).default([]),
  skillAddendum: z.string().nullable().default(null),

  // ---- BOOST WEIGHTS CACHE (readonly per-turn — WS8 dashboard owns writes) ----
  weightTables: z
    .record(z.string(), z.array(WeightRowSchema))
    .default({}),

  // ---- FEATURE FLAGS (readonly, batched at turn entry) ----
  featureFlags: FeatureFlagsSchema,

  // ---- HANDBOOK / PROMPT (readonly; null = legacy fallback path) ----
  handbook: HandbookSlotSchema.nullable().default(null),

  // ---- AGENT DEF (readonly snapshot) ----
  agentDef: z.custom<AgentDef>(),

  // ---- MUTABLE — guardrail audit ----
  crisisTripped: z.boolean().default(false),
  abStripApplied: z.boolean().default(false),
  promptInjectionTripped: z.boolean().default(false),
  guardrailHits: z.array(GuardrailHitSchema).default([]),

  // ---- AUDIT EVENTS (mutable, append-only — flushed at turn end) ----
  auditEvents: z
    .array(
      z.object({
        kind: z.string(),
        payload: z.record(z.unknown()).optional(),
        ts: z.string(),
      })
    )
    .default([]),

  // ---- INFRA HANDLES (readonly; omit `db` in unit tests) ----
  db: z.custom<Firestore>().optional(),
  log: z.custom<(evt: string, payload?: Record<string, unknown>) => void>(),
})

export type ClaireContext = z.infer<typeof ClaireContextSchema>

// ============================================================================
// Mock factory — `createMockContext` (alias `buildMockCtx` per detail-plan §8).
// ============================================================================

/**
 * Build a minimum-viable ClaireContext for unit tests. Callers pass a
 * partial `overrides` slice; required Zod fields fall back to safe
 * defaults. The returned ctx is NOT frozen — wrap with
 * `freezeContext()` when testing immutability invariants.
 */
export function createMockContext(
  overrides: Partial<ClaireContext> = {}
): ClaireContext {
  const baseAgentDef = {
    id: "claire",
    name: "Claire",
    systemPrompt: "",
    provider: "openai",
    model: "gpt-4.1-nano",
    temperature: 0.7,
    version: "1",
    memoryMode: "firestore_only",
    toolPolicy: "none",
  } as unknown as AgentDef

  const draft: Partial<ClaireContext> = {
    userId: "test-user-1",
    agentId: "claire",
    conversationId: "test-session-1",
    turnId: randomUUID(),
    eventId: "test-event-1",
    locale: "zh-CN",
    userProfile: {
      preferences: [],
      resumeAccepted: false,
      resumeParseCount: 0,
    },
    recentTurns: [],
    recentTurnsForMirror: [],
    memorySnapshot: [],
    mem0RecallBlock: null,
    mem0PartitionKey: "test-user-1",
    mem0Degraded: false,
    activeSkills: [],
    skillStackOrder: [],
    skillAddendum: null,
    weightTables: {},
    featureFlags: FeatureFlagsSchema.parse({}),
    handbook: null,
    agentDef: baseAgentDef,
    crisisTripped: false,
    abStripApplied: false,
    promptInjectionTripped: false,
    guardrailHits: [],
    auditEvents: [],
    log: () => undefined,
    ...overrides,
  }

  return ClaireContextSchema.parse(draft)
}

/** Detail-plan §8 alias — preserve the name used across the WS6 test plan. */
export const buildMockCtx = createMockContext

// ============================================================================
// `freezeContext` — deep-freeze readonly buckets while leaving mutable buckets
// writable. We split the contract here rather than relying on TS readonly
// alone because guardrails run at runtime against unknown ctx instances.
// ============================================================================

/** Names of top-level fields that MAY be written after freeze. */
const MUTABLE_FIELDS: ReadonlySet<string> = new Set([
  "activeSkills",
  "skillStackOrder",
  "skillAddendum",
  "crisisTripped",
  "abStripApplied",
  "promptInjectionTripped",
  "guardrailHits",
  "auditEvents",
])

/**
 * Recursively freeze every readonly value on `ctx`. Mutable buckets stay
 * writable so guardrails can append. The infra handles (`db`, `log`) are
 * referenced not cloned — freezing a Firestore handle would break it.
 *
 * Return type stays `ClaireContext` (not `Readonly<ClaireContext>`) so
 * guardrails can write to the mutable buckets without TS complaining.
 * The runtime guarantee — readonly fields throw on write — is enforced
 * by per-property `Object.defineProperty(writable:false)` and is exercised
 * in `run-context.test.ts`.
 */
export function freezeContext(ctx: ClaireContext): ClaireContext {
  for (const [key, value] of Object.entries(ctx)) {
    if (MUTABLE_FIELDS.has(key)) continue
    if (key === "db" || key === "log") continue
    // Deep-freeze the value graph (no-op for primitives).
    deepFreeze(value)
    // Top-level lock: primitives need an explicit non-writable descriptor.
    Object.defineProperty(ctx, key, {
      value,
      writable: false,
      configurable: false,
      enumerable: true,
    })
  }
  // Top-level seal stops new keys from being added but preserves the
  // writability we just set on each property.
  Object.seal(ctx)
  return ctx
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object") return
  if (Object.isFrozen(value)) return
  Object.freeze(value)
  for (const inner of Object.values(value as Record<string, unknown>)) {
    deepFreeze(inner)
  }
}
