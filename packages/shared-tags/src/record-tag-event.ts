/**
 * iter30 WS2 — `recordTagEvent()` idempotent write contract.
 *
 * Spec: `.planning/iter30/ws-2-7-detail.md` §3 (Option C: TS+Python port).
 *
 * Design points:
 *  - Idempotency key: sha256(source|sourceDocId|rawText|kind|id).slice(0,32).
 *    Same content from same source for same entity → same eventId; the
 *    second create raises `ALREADY_EXISTS` and we return `created:false`.
 *  - Validation: missing both `userId` and `jobId` (when caller uses the
 *    PA-shorthand input shape) → throw. Empty `entityRef.id` → throw.
 *  - rawText > 500 chars → truncated, with a `truncated:true` debug flag
 *    on the result. This mirrors detail-plan §3.3.
 *  - Firestore write uses `.create()` so two concurrent writers for the
 *    same key collide deterministically; no read-then-write race.
 *
 * Wave-1 surface: this module ships the shape + idempotency contract.
 * Wave-2 will add JSON-Schema emit + GH Packages publish; Phase-2 ships
 * the worker that consumes events.
 */

import type {
  RecordTagEventInput,
  TagEvent,
} from "./schemas.js"
import {
  RecordTagEventInputSchema,
  TagEventSchema,
} from "./schemas.js"
import {
  TAG_EVENT_SCHEMA_VERSION,
  SHARED_TAG_COLLECTIONS,
  type TagEventSource,
  type TagType,
  type EntityRef,
  type EntityKind,
} from "./types.js"
import { sha256Hex } from "./sha256.js"

// ─────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────

/**
 * PA-shorthand input shape from the Day-1 brief. Either `userId` or
 * `jobId` must be set (xor); resolves to an `EntityRef`. Callers that
 * need the richer cross-repo shape (e.g. `scraping-github-repo:foo/bar`)
 * use `recordTagEventWithEntityRef()` directly.
 */
export interface RecordTagEventArgs {
  userId?: string
  jobId?: string
  rawTag: string
  source: TagEventSource
  /** Source-specific dot-path for audit. Defaults to "rawTag" if omitted. */
  sourceField?: string
  /** Source doc id; defaults to userId or jobId when omitted. */
  sourceDocId?: string
  type?: TagType
  evidence?: string
}

export interface RecordTagEventResult {
  eventId: string
  /** True if the doc was created by this call. False on duplicate. */
  created: boolean
  /** Compatibility alias for callers that prefer `idempotent` semantics. */
  idempotent: boolean
  reason?: "duplicate" | "validation-error" | "truncated"
  /** True if rawTag was truncated to fit the 500-char cap. */
  truncated?: boolean
}

/**
 * Minimal Firestore surface we depend on. Kept narrow so this package can
 * accept either `firebase-admin/firestore.Firestore` or the modular
 * `@google-cloud/firestore` client without pulling either as a hard dep.
 */
export interface FirestoreLike {
  collection(name: string): FirestoreCollectionLike
}
export interface FirestoreCollectionLike {
  doc(id: string): FirestoreDocLike
}
export interface FirestoreDocLike {
  create(data: Record<string, unknown>): Promise<unknown>
}

export interface RecordTagEventDeps {
  firestore: FirestoreLike
  /** Override for tests. Defaults to `() => new Date().toISOString()`. */
  now?: () => string
}

// ─────────────────────────────────────────────────────────────────
// Idempotency key
// ─────────────────────────────────────────────────────────────────

/**
 * Build the canonical idempotency input. Lowercased + trimmed `rawText`
 * collapses "ML"/"ml"/" ML " to one event. Exported for the Python port
 * + parity tests.
 */
export function buildIdempotencyInput(args: {
  source: TagEventSource
  sourceDocId: string
  rawText: string
  entityRef: EntityRef
}): string {
  return [
    args.source,
    args.sourceDocId,
    args.rawText.toLowerCase().trim(),
    args.entityRef.kind,
    args.entityRef.id,
  ].join("|")
}

export function computeEventId(args: {
  source: TagEventSource
  sourceDocId: string
  rawText: string
  entityRef: EntityRef
}): string {
  return sha256Hex(buildIdempotencyInput(args)).slice(0, 32)
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

const RAW_TEXT_MAX = 500

/**
 * Resolve PA-shorthand `{userId, jobId}` → `EntityRef`. Exactly one of
 * `userId` or `jobId` must be set.
 */
export function resolveEntityRef(args: {
  userId?: string
  jobId?: string
}): EntityRef {
  const hasUser = typeof args.userId === "string" && args.userId.length > 0
  const hasJob = typeof args.jobId === "string" && args.jobId.length > 0
  if (hasUser === hasJob) {
    throw new Error(
      "[shared-tags] recordTagEvent: exactly one of `userId` or `jobId` must be set",
    )
  }
  if (hasUser) {
    return { kind: "pa-user" satisfies EntityKind, id: args.userId! }
  }
  return { kind: "pa-job" satisfies EntityKind, id: args.jobId! }
}

function truncateRawText(input: string): { rawText: string; truncated: boolean } {
  if (input.length <= RAW_TEXT_MAX) return { rawText: input, truncated: false }
  return { rawText: input.slice(0, RAW_TEXT_MAX), truncated: true }
}

function isAlreadyExists(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  // firebase-admin/firestore: throws with `code === 6` (ALREADY_EXISTS gRPC)
  // or `code === "already-exists"` depending on transport.
  const e = err as { code?: number | string; message?: string }
  if (e.code === 6) return true
  if (e.code === "already-exists") return true
  if (e.code === "ALREADY_EXISTS") return true
  if (typeof e.message === "string" && /ALREADY_EXISTS|already exists/i.test(e.message)) {
    return true
  }
  return false
}

// ─────────────────────────────────────────────────────────────────
// Main entry: PA-shorthand
// ─────────────────────────────────────────────────────────────────

/**
 * Idempotent append to `pa-tag-events`. Returns the eventId; caller can
 * trust that two calls with byte-identical input always produce the same
 * eventId and at most one Firestore document.
 *
 * Validation errors (missing entity, empty rawTag, etc.) THROW — caller
 * is expected to wrap in fire-and-forget try/catch on hot paths
 * (realtime-tagger, cv-ingest), per detail-plan §3.3.
 */
export async function recordTagEvent(
  args: RecordTagEventArgs,
  deps: RecordTagEventDeps,
): Promise<RecordTagEventResult> {
  if (typeof args.rawTag !== "string" || args.rawTag.trim().length === 0) {
    throw new Error("[shared-tags] recordTagEvent: rawTag must be a non-empty string")
  }
  const entityRef = resolveEntityRef({
    userId: args.userId,
    jobId: args.jobId,
  })

  const { rawText, truncated } = truncateRawText(args.rawTag)
  const sourceDocId = args.sourceDocId ?? entityRef.id
  const sourceField = args.sourceField ?? "rawTag"
  const type: TagType = args.type ?? "skill"

  const input: RecordTagEventInput = {
    source: args.source,
    sourceDocId,
    sourceField,
    rawText,
    type,
    entityRef,
    context: args.evidence,
  }

  const parsed = RecordTagEventInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(
      `[shared-tags] recordTagEvent: validation failed — ${parsed.error.message}`,
    )
  }

  return await recordTagEventWithEntityRef(parsed.data, deps, { truncated })
}

// ─────────────────────────────────────────────────────────────────
// Cross-repo entry: explicit EntityRef
// ─────────────────────────────────────────────────────────────────

/**
 * Lower-level entry point used by scraping pipelines that emit tags for
 * non-PA entities (`scraping-github-repo:foo/bar`, etc.). The PA path
 * resolves through here as well after PA-shorthand expansion.
 */
export async function recordTagEventWithEntityRef(
  input: RecordTagEventInput,
  deps: RecordTagEventDeps,
  meta: { truncated?: boolean } = {},
): Promise<RecordTagEventResult> {
  const eventId = computeEventId({
    source: input.source,
    sourceDocId: input.sourceDocId,
    rawText: input.rawText,
    entityRef: input.entityRef,
  })

  const now = (deps.now ?? (() => new Date().toISOString()))()

  const event: TagEvent = TagEventSchema.parse({
    id: eventId,
    source: input.source,
    sourceDocId: input.sourceDocId,
    sourceField: input.sourceField,
    rawText: input.rawText,
    type: input.type,
    entityRef: input.entityRef,
    context: input.context,
    status: "pending",
    normalizedTo: null,
    decision: null,
    workerConfidence: null,
    schemaVersion: TAG_EVENT_SCHEMA_VERSION,
    createdAt: now,
    processedAt: null,
    processingDurationMs: null,
  })

  const ref = deps.firestore
    .collection(SHARED_TAG_COLLECTIONS.tagEvents)
    .doc(eventId)

  try {
    await ref.create(event as unknown as Record<string, unknown>)
    return {
      eventId,
      created: true,
      idempotent: false,
      ...(meta.truncated ? { truncated: true, reason: "truncated" as const } : {}),
    }
  } catch (err) {
    if (isAlreadyExists(err)) {
      return {
        eventId,
        created: false,
        idempotent: true,
        reason: "duplicate",
        ...(meta.truncated ? { truncated: true } : {}),
      }
    }
    throw err
  }
}
