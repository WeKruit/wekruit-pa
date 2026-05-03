/**
 * iter30 WS2 — TypeScript types for canonical-tag system.
 *
 * Adam-locked constraints:
 *  - English-only canonical (no zh/en split)
 *  - Mutex enforcement at write time
 *  - 3 collections: pa-canonical-tags, pa-tag-events, pa-entity-tags
 *
 * See `.planning/iter30/ws-2-7-detail.md` §2 for the full spec.
 */

/**
 * Tag taxonomy. Per detail-plan §2.1, full set is 10 entries; this Day-1
 * Wave-1 skeleton ships the 7 listed in the brief plus 3 additional from
 * the detail-plan (company / venue / topic). Worker (Phase 2) will reject
 * events with unknown types.
 */
export const TAG_TYPES = [
  "skill",
  "preference",
  "trait",
  "experience",
  "location",
  "role",
  "industry",
  "company",
  "venue",
  "topic",
] as const

export type TagType = (typeof TAG_TYPES)[number]

/**
 * Source pipelines that may emit events. Lock-step with Python port — any
 * additions must land in `wekruit_shared_tags` simultaneously to keep the
 * idempotency-key surface byte-identical.
 */
export const TAG_EVENT_SOURCES = [
  "pa-realtime-tagger",
  "pa-cv-ingest",
  "pa-onboarding",
  "scraping-github",
  "scraping-devpost",
  "scraping-researcher",
  "scraping-job",
  "manual-operator",
  "manual-backfill",
] as const

export type TagEventSource = (typeof TAG_EVENT_SOURCES)[number]

/**
 * Per-type decay half-life in days. 0 means "never decay". Read-time
 * decay is computed by the WS7 profile-loader; this map is shipped here
 * so worker + reader agree on a single source of truth.
 *
 * Adam open-question (detail-plan W7.5): values may be tuned post-launch.
 */
export const DECAY_HALF_LIFE_DAYS_BY_TYPE: Record<TagType, number> = {
  skill: 0,
  preference: 180,
  trait: 180,
  experience: 0,
  location: 365,
  role: 0,
  industry: 0,
  company: 0,
  venue: 0,
  topic: 365,
}

/**
 * Entity kinds — flattened key namespace shared between PA and scraping
 * repos. `entityKey = "{kind}:{id}"`.
 */
export const ENTITY_KINDS = [
  "pa-user",
  "pa-job",
  "scraping-job",
  "scraping-researcher",
  "scraping-github-repo",
  "scraping-devpost-project",
] as const

export type EntityKind = (typeof ENTITY_KINDS)[number]

export interface EntityRef {
  kind: EntityKind
  id: string
}

/** Schema version for forward-compat. Bump on breaking change. */
export const TAG_EVENT_SCHEMA_VERSION = "v1" as const
export type TagEventSchemaVersion = typeof TAG_EVENT_SCHEMA_VERSION

/** Firestore collection names. Single source of truth for both repos. */
export const SHARED_TAG_COLLECTIONS = {
  canonicalTags: "pa-canonical-tags",
  tagEvents: "pa-tag-events",
  entityTags: "pa-entity-tags",
  /** Subcollection name under entityTags/{entityKey}/items/{canonicalKey}. */
  entityTagItems: "items",
} as const
