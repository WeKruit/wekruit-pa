/**
 * iter30 WS2 — Zod schemas for the 3 canonical-tag collections.
 *
 * Source spec: `.planning/iter30/ws-2-7-detail.md` §2.
 *
 * Constraints (Adam-locked):
 *  - English-only `displayName` (no {zh, en} split)
 *  - `mutexGroup` present on canonical + entity-tag for write-time
 *    mutual exclusion
 *  - sha256-derived idempotency key on every event
 *  - schemaVersion: "v1" so cross-repo bumps are explicit
 */

import { z } from "zod"
import {
  TAG_TYPES,
  TAG_EVENT_SOURCES,
  ENTITY_KINDS,
  TAG_EVENT_SCHEMA_VERSION,
} from "./types.js"

// ─────────────────────────────────────────────────────────────────
// Common building blocks
// ─────────────────────────────────────────────────────────────────

export const TagTypeSchema = z.enum(TAG_TYPES)
export const TagEventSourceSchema = z.enum(TAG_EVENT_SOURCES)
export const EntityKindSchema = z.enum(ENTITY_KINDS)

/** Lowercase kebab-case, 2..64 chars. Stable doc ID for canonical tags. */
export const CanonicalKeySchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, "canonicalKey must be lowercase kebab-case")
  .min(2)
  .max(64)

/** Idempotency key: 32-hex-char prefix of sha256. */
export const TagEventIdSchema = z
  .string()
  .regex(/^[a-f0-9]{32}$/, "eventId must be 32-char lowercase hex")

export const EntityRefSchema = z.object({
  kind: EntityKindSchema,
  id: z.string().min(1).max(200),
})

export const SchemaVersionSchema = z.literal(TAG_EVENT_SCHEMA_VERSION)

// ─────────────────────────────────────────────────────────────────
// 1. pa-canonical-tags/{canonicalKey}
// ─────────────────────────────────────────────────────────────────

export const CanonicalEvidenceSchema = z.object({
  source: TagEventSourceSchema,
  sourceDocId: z.string().min(1).max(200),
  sourceField: z.string().min(1).max(200),
  rawText: z.string().min(1).max(500),
  observedAt: z.string(),
})
export type CanonicalEvidence = z.infer<typeof CanonicalEvidenceSchema>

export const ApprovalStatusSchema = z.enum([
  "proposed",
  "auto-approved",
  "human-approved",
  "rejected",
])
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>

export const CanonicalTagSchema = z.object({
  /** Stable Firestore doc ID. NEVER changes after first approve. */
  canonicalKey: CanonicalKeySchema,

  type: TagTypeSchema,

  /**
   * ENGLISH-ONLY (Adam-locked iter30 2026-05-03). Title-case display.
   * The bilingual `{zh, en}` shape from the research doc is superseded.
   */
  displayName: z.string().min(1).max(80),

  /** Free-text aliases, lowercased + whitespace-collapsed. Looked up via
   *  `array-contains` for Layer 1 hot path. */
  aliases: z.array(z.string().min(1).max(120)).max(500),

  /** 1024-dim BGE-M3 embedding. Optional during Wave-1 skeleton; the
   *  worker (Phase 2) will populate it. */
  embedding: z.array(z.number()).length(1024).optional(),

  /** 0..1, recomputed by worker on each evidence add. */
  confidence: z.number().min(0).max(1).default(0.5),

  /** Append-only, capped at 10 most recent. */
  evidence: z.array(CanonicalEvidenceSchema).max(10).default([]),

  approvalStatus: ApprovalStatusSchema.default("proposed"),

  parentKey: CanonicalKeySchema.nullable().optional(),

  /**
   * Mutual-exclusion group key (Adam-locked). Two canonical tags with the
   * same `mutexGroup` collapse to ONE entity-tag for any given entity.
   * Default mutex is `canonicalKey` itself (each canonical its own group);
   * the worker overrides when it decides two canonicals are aliases.
   */
  mutexGroup: CanonicalKeySchema.optional(),

  /** Marker for the schema/version that wrote this row. */
  schemaVersion: SchemaVersionSchema.default(TAG_EVENT_SCHEMA_VERSION),

  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CanonicalTag = z.infer<typeof CanonicalTagSchema>

// ─────────────────────────────────────────────────────────────────
// 2. pa-tag-events/{eventId}  (append-only)
// ─────────────────────────────────────────────────────────────────

export const TagEventStatusSchema = z.enum([
  "pending",
  "normalized",
  "rejected",
  "skipped",
  "needs-review",
])
export type TagEventStatus = z.infer<typeof TagEventStatusSchema>

export const TagEventDecisionSchema = z.enum([
  "hot-alias",
  "llm-match",
  "cosine-match",
  "new-canonical",
  "needs-review",
  "skipped-mutex",
])
export type TagEventDecision = z.infer<typeof TagEventDecisionSchema>

export const TagEventSchema = z
  .object({
    /** sha256(source|sourceDocId|rawText|kind|id).slice(0, 32) — see
     *  detail-plan §3.2. Doc ID == this `id`. */
    id: TagEventIdSchema,

    source: TagEventSourceSchema,
    sourceDocId: z.string().min(1).max(200),
    sourceField: z.string().min(1).max(200),
    rawText: z.string().min(1).max(500),
    type: TagTypeSchema,

    entityRef: EntityRefSchema,

    /** Optional surrounding-sentence context for LLM normalize. */
    context: z.string().max(500).optional(),

    status: TagEventStatusSchema.default("pending"),

    /** Set by worker on success. */
    normalizedTo: CanonicalKeySchema.nullable().default(null),

    decision: TagEventDecisionSchema.nullable().default(null),

    workerConfidence: z.number().min(0).max(1).nullable().default(null),

    schemaVersion: SchemaVersionSchema.default(TAG_EVENT_SCHEMA_VERSION),

    /** ISO-8601 timestamps; worker fills `processedAt` on commit. */
    createdAt: z.string(),
    processedAt: z.string().nullable().default(null),
    processingDurationMs: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null),
  })
  // Cross-field rule: `entityRef.id` is required and non-empty (already
  // enforced by EntityRefSchema). When status is `normalized`, the worker
  // MUST also set `normalizedTo` and `decision`. We enforce this only at
  // write time in the worker, not on the input shape (Wave 1 skeleton).
  .strict()
export type TagEvent = z.infer<typeof TagEventSchema>

/**
 * Caller-facing input shape for `recordTagEvent()`. Distinct from the
 * stored shape because the writer fills `id`, `createdAt`, `status`,
 * etc. — caller does not.
 */
export const RecordTagEventInputSchema = z
  .object({
    source: TagEventSourceSchema,
    sourceDocId: z.string().min(1).max(200),
    sourceField: z.string().min(1).max(200),
    rawText: z.string().min(1).max(500),
    type: TagTypeSchema,
    entityRef: EntityRefSchema,
    context: z.string().max(500).optional(),
  })
  .strict()
export type RecordTagEventInput = z.infer<typeof RecordTagEventInputSchema>

// ─────────────────────────────────────────────────────────────────
// 3. pa-entity-tags/{entityKey}  + items/{canonicalKey} subcollection
// ─────────────────────────────────────────────────────────────────

export const EntityTagsRootSchema = z.object({
  /** Flattened "{kind}:{id}". */
  entityKey: z.string().min(3).max(220),
  /** Total active (non-decayed) tag count, maintained by worker. */
  tagCount: z.number().int().nonnegative().default(0),
  schemaVersion: SchemaVersionSchema.default(TAG_EVENT_SCHEMA_VERSION),
  updatedAt: z.string(),
})
export type EntityTagsRoot = z.infer<typeof EntityTagsRootSchema>

export const EntityTagSourceAttributionSchema = z.object({
  source: TagEventSourceSchema,
  weight: z.number().min(0).max(1).default(1.0),
  firstAt: z.string(),
  lastAt: z.string(),
  count: z.number().int().positive().default(1),
})
export type EntityTagSourceAttribution = z.infer<
  typeof EntityTagSourceAttributionSchema
>

export const EntityTagAssignmentSchema = z.object({
  canonicalKey: CanonicalKeySchema,
  type: TagTypeSchema,
  /** Mutex group for write-time exclusion. */
  mutexGroup: CanonicalKeySchema,
  /** Raw at-write confidence; reader-side decay applied by WS7 loader. */
  confidence: z.number().min(0).max(1).default(0.5),
  firstSeen: z.string(),
  lastReinforced: z.string(),
  count: z.number().int().nonnegative().default(1),
  sources: z.array(EntityTagSourceAttributionSchema).max(20),
  /** Per-type half-life days. 0 = never decay. */
  decayHalfLifeDays: z.number().int().nonnegative().default(0),
  schemaVersion: SchemaVersionSchema.default(TAG_EVENT_SCHEMA_VERSION),
})
export type EntityTagAssignment = z.infer<typeof EntityTagAssignmentSchema>
