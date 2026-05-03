/**
 * iter30 WS2 — recordTagEvent + schema round-trip tests.
 *
 * Run via: `npm --workspace=@wekruit/shared-tags run test`
 *
 * Acceptance gates exercised here:
 *   - idempotency: same input → same eventId, no duplicate write
 *   - validation: missing both userId+jobId → throw
 *   - schema: rawTag length cap, source enum
 *   - Zod parse round-trip for all 3 schemas
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  recordTagEvent,
  recordTagEventWithEntityRef,
  computeEventId,
  buildIdempotencyInput,
  resolveEntityRef,
  type FirestoreLike,
  type RecordTagEventArgs,
} from "../record-tag-event.js"
import {
  CanonicalTagSchema,
  TagEventSchema,
  EntityTagsRootSchema,
  EntityTagAssignmentSchema,
  RecordTagEventInputSchema,
} from "../schemas.js"
import { TAG_EVENT_SCHEMA_VERSION, SHARED_TAG_COLLECTIONS } from "../types.js"

// ─────────────────────────────────────────────────────────────────
// In-memory Firestore fake (only what we need for record-tag-event)
// ─────────────────────────────────────────────────────────────────

interface FakeWrite {
  collection: string
  docId: string
  data: Record<string, unknown>
}

class AlreadyExistsError extends Error {
  code = 6
  constructor(docId: string) {
    super(`Document already exists: ${docId}`)
  }
}

function makeFakeFirestore(): {
  fs: FirestoreLike
  writes: FakeWrite[]
  store: Map<string, Record<string, unknown>>
} {
  const writes: FakeWrite[] = []
  const store = new Map<string, Record<string, unknown>>()

  const fs: FirestoreLike = {
    collection(name: string) {
      return {
        doc(id: string) {
          const key = `${name}/${id}`
          return {
            async create(data: Record<string, unknown>) {
              if (store.has(key)) {
                throw new AlreadyExistsError(key)
              }
              store.set(key, data)
              writes.push({ collection: name, docId: id, data })
              return undefined
            },
          }
        },
      }
    },
  }
  return { fs, writes, store }
}

const FIXED_NOW = "2026-05-03T12:00:00.000Z"

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("computeEventId / buildIdempotencyInput", () => {
  it("is deterministic across calls", () => {
    const a = computeEventId({
      source: "pa-realtime-tagger",
      sourceDocId: "msg-1",
      rawText: "ML",
      entityRef: { kind: "pa-user", id: "usr-abc" },
    })
    const b = computeEventId({
      source: "pa-realtime-tagger",
      sourceDocId: "msg-1",
      rawText: "ML",
      entityRef: { kind: "pa-user", id: "usr-abc" },
    })
    assert.equal(a, b)
    assert.match(a, /^[a-f0-9]{32}$/)
  })

  it("collapses case + whitespace in rawText", () => {
    const a = computeEventId({
      source: "pa-realtime-tagger",
      sourceDocId: "msg-1",
      rawText: "ML",
      entityRef: { kind: "pa-user", id: "usr-abc" },
    })
    const b = computeEventId({
      source: "pa-realtime-tagger",
      sourceDocId: "msg-1",
      rawText: "  ml  ",
      entityRef: { kind: "pa-user", id: "usr-abc" },
    })
    assert.equal(a, b, "lowercase + trim should collapse")
  })

  it("differs when source / docId / entity changes", () => {
    const base = {
      source: "pa-realtime-tagger" as const,
      sourceDocId: "msg-1",
      rawText: "ML",
      entityRef: { kind: "pa-user" as const, id: "usr-abc" },
    }
    const baseId = computeEventId(base)
    assert.notEqual(
      baseId,
      computeEventId({ ...base, source: "pa-cv-ingest" }),
      "different source → different id",
    )
    assert.notEqual(
      baseId,
      computeEventId({ ...base, sourceDocId: "msg-2" }),
      "different sourceDocId → different id",
    )
    assert.notEqual(
      baseId,
      computeEventId({ ...base, entityRef: { kind: "pa-user", id: "usr-xyz" } }),
      "different entity → different id",
    )
  })

  it("buildIdempotencyInput uses pipe separator (Python-port parity)", () => {
    const s = buildIdempotencyInput({
      source: "pa-realtime-tagger",
      sourceDocId: "msg-1",
      rawText: "ML",
      entityRef: { kind: "pa-user", id: "usr-abc" },
    })
    assert.equal(s, "pa-realtime-tagger|msg-1|ml|pa-user|usr-abc")
  })
})

describe("resolveEntityRef", () => {
  it("accepts userId xor jobId", () => {
    assert.deepEqual(resolveEntityRef({ userId: "u1" }), {
      kind: "pa-user",
      id: "u1",
    })
    assert.deepEqual(resolveEntityRef({ jobId: "j1" }), {
      kind: "pa-job",
      id: "j1",
    })
  })
  it("throws if both set", () => {
    assert.throws(
      () => resolveEntityRef({ userId: "u1", jobId: "j1" }),
      /exactly one/,
    )
  })
  it("throws if neither set", () => {
    assert.throws(() => resolveEntityRef({}), /exactly one/)
  })
})

describe("recordTagEvent — idempotency", () => {
  it("same input → same eventId, only one Firestore write", async () => {
    const { fs, writes } = makeFakeFirestore()
    const args: RecordTagEventArgs = {
      userId: "usr-abc",
      rawTag: "Machine Learning",
      source: "pa-realtime-tagger",
      sourceDocId: "msg-1",
      type: "skill",
    }
    const r1 = await recordTagEvent(args, { firestore: fs, now: () => FIXED_NOW })
    const r2 = await recordTagEvent(args, { firestore: fs, now: () => FIXED_NOW })

    assert.equal(r1.eventId, r2.eventId, "eventId must be stable")
    assert.equal(r1.created, true, "first write creates")
    assert.equal(r2.created, false, "second write is duplicate")
    assert.equal(r2.idempotent, true)
    assert.equal(r2.reason, "duplicate")
    assert.equal(writes.length, 1, "exactly one Firestore .create() landed")
    assert.equal(writes[0].collection, SHARED_TAG_COLLECTIONS.tagEvents)
    assert.equal(writes[0].docId, r1.eventId)
  })

  it("case-only difference still collapses to one event", async () => {
    const { fs, writes } = makeFakeFirestore()
    const base: RecordTagEventArgs = {
      userId: "usr-abc",
      rawTag: "ML",
      source: "pa-realtime-tagger",
      sourceDocId: "msg-1",
      type: "skill",
    }
    await recordTagEvent(base, { firestore: fs, now: () => FIXED_NOW })
    await recordTagEvent(
      { ...base, rawTag: "  ml  " },
      { firestore: fs, now: () => FIXED_NOW },
    )
    assert.equal(writes.length, 1)
  })

  it("different source for same rawTag/entity → different events", async () => {
    const { fs, writes } = makeFakeFirestore()
    await recordTagEvent(
      {
        userId: "usr-abc",
        rawTag: "ML",
        source: "pa-realtime-tagger",
        sourceDocId: "msg-1",
        type: "skill",
      },
      { firestore: fs, now: () => FIXED_NOW },
    )
    await recordTagEvent(
      {
        userId: "usr-abc",
        rawTag: "ML",
        source: "pa-cv-ingest",
        sourceDocId: "cv-1",
        type: "skill",
      },
      { firestore: fs, now: () => FIXED_NOW },
    )
    assert.equal(writes.length, 2, "different source → two events")
  })
})

describe("recordTagEvent — validation", () => {
  it("throws when neither userId nor jobId is set", async () => {
    const { fs } = makeFakeFirestore()
    await assert.rejects(
      recordTagEvent(
        {
          rawTag: "ML",
          source: "pa-realtime-tagger",
          sourceDocId: "msg-1",
        } as unknown as RecordTagEventArgs,
        { firestore: fs },
      ),
      /exactly one/,
    )
  })

  it("throws when both userId and jobId are set", async () => {
    const { fs } = makeFakeFirestore()
    await assert.rejects(
      recordTagEvent(
        {
          userId: "u1",
          jobId: "j1",
          rawTag: "ML",
          source: "pa-realtime-tagger",
          sourceDocId: "msg-1",
        },
        { firestore: fs },
      ),
      /exactly one/,
    )
  })

  it("throws when rawTag is empty", async () => {
    const { fs } = makeFakeFirestore()
    await assert.rejects(
      recordTagEvent(
        {
          userId: "u1",
          rawTag: "   ",
          source: "pa-realtime-tagger",
        },
        { firestore: fs },
      ),
      /rawTag/,
    )
  })

  it("rawTag > 500 chars is truncated, not rejected", async () => {
    const { fs, writes } = makeFakeFirestore()
    const long = "x".repeat(900)
    const r = await recordTagEvent(
      {
        userId: "u1",
        rawTag: long,
        source: "pa-realtime-tagger",
        sourceDocId: "msg-1",
        type: "skill",
      },
      { firestore: fs, now: () => FIXED_NOW },
    )
    assert.equal(r.created, true)
    assert.equal(r.truncated, true)
    assert.equal(writes.length, 1)
    const stored = writes[0].data as { rawText: string }
    assert.equal(stored.rawText.length, 500)
  })

  it("Zod input rejects unknown source", () => {
    const result = RecordTagEventInputSchema.safeParse({
      source: "unknown-source",
      sourceDocId: "msg-1",
      sourceField: "rawTag",
      rawText: "ML",
      type: "skill",
      entityRef: { kind: "pa-user", id: "usr-abc" },
    })
    assert.equal(result.success, false)
  })

  it("Zod input rejects empty entityRef.id", () => {
    const result = RecordTagEventInputSchema.safeParse({
      source: "pa-realtime-tagger",
      sourceDocId: "msg-1",
      sourceField: "rawTag",
      rawText: "ML",
      type: "skill",
      entityRef: { kind: "pa-user", id: "" },
    })
    assert.equal(result.success, false)
  })
})

describe("recordTagEventWithEntityRef — cross-repo path", () => {
  it("writes a normalized TagEvent doc with schemaVersion v1", async () => {
    const { fs, writes } = makeFakeFirestore()
    const r = await recordTagEventWithEntityRef(
      {
        source: "scraping-github",
        sourceDocId: "openai/swarm",
        sourceField: "topics[0]",
        rawText: "agent-orchestration",
        type: "topic",
        entityRef: { kind: "scraping-github-repo", id: "openai/swarm" },
      },
      { firestore: fs, now: () => FIXED_NOW },
    )
    assert.equal(r.created, true)
    const stored = writes[0].data as Record<string, unknown>
    assert.equal(stored.schemaVersion, TAG_EVENT_SCHEMA_VERSION)
    assert.equal(stored.status, "pending")
    assert.equal(stored.normalizedTo, null)
    assert.equal(stored.decision, null)
    assert.equal(stored.id, r.eventId)
  })
})

// ─────────────────────────────────────────────────────────────────
// Schema round-trip
// ─────────────────────────────────────────────────────────────────

describe("Zod schema round-trip", () => {
  it("CanonicalTagSchema parses a fully populated doc", () => {
    const doc = {
      canonicalKey: "machine-learning",
      type: "skill" as const,
      displayName: "Machine Learning",
      aliases: ["ml", "machine learning"],
      embedding: Array.from({ length: 1024 }, () => 0),
      confidence: 0.92,
      evidence: [
        {
          source: "pa-cv-ingest" as const,
          sourceDocId: "cv-1",
          sourceField: "skills[3]",
          rawText: "Machine Learning",
          observedAt: FIXED_NOW,
        },
      ],
      approvalStatus: "human-approved" as const,
      mutexGroup: "machine-learning",
      schemaVersion: TAG_EVENT_SCHEMA_VERSION,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    }
    const parsed = CanonicalTagSchema.parse(doc)
    assert.equal(parsed.canonicalKey, "machine-learning")
    assert.equal(parsed.aliases.length, 2)
  })

  it("CanonicalTagSchema rejects bad canonicalKey (uppercase)", () => {
    const r = CanonicalTagSchema.safeParse({
      canonicalKey: "MachineLearning",
      type: "skill",
      displayName: "Machine Learning",
      aliases: [],
      confidence: 0.5,
      evidence: [],
      approvalStatus: "proposed",
      schemaVersion: TAG_EVENT_SCHEMA_VERSION,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    })
    assert.equal(r.success, false)
  })

  it("CanonicalTagSchema rejects embedding with wrong length", () => {
    const r = CanonicalTagSchema.safeParse({
      canonicalKey: "ml",
      type: "skill",
      displayName: "ML",
      aliases: [],
      embedding: [0, 0, 0],
      confidence: 0.5,
      evidence: [],
      approvalStatus: "proposed",
      schemaVersion: TAG_EVENT_SCHEMA_VERSION,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    })
    assert.equal(r.success, false)
  })

  it("TagEventSchema parses a pending event", () => {
    const id = computeEventId({
      source: "pa-realtime-tagger",
      sourceDocId: "msg-1",
      rawText: "ML",
      entityRef: { kind: "pa-user", id: "usr-abc" },
    })
    const r = TagEventSchema.parse({
      id,
      source: "pa-realtime-tagger",
      sourceDocId: "msg-1",
      sourceField: "body",
      rawText: "ML",
      type: "skill",
      entityRef: { kind: "pa-user", id: "usr-abc" },
      status: "pending",
      normalizedTo: null,
      decision: null,
      workerConfidence: null,
      schemaVersion: TAG_EVENT_SCHEMA_VERSION,
      createdAt: FIXED_NOW,
      processedAt: null,
      processingDurationMs: null,
    })
    assert.equal(r.id, id)
  })

  it("EntityTagsRootSchema + EntityTagAssignmentSchema parse together", () => {
    const root = EntityTagsRootSchema.parse({
      entityKey: "pa-user:usr-abc",
      tagCount: 1,
      schemaVersion: TAG_EVENT_SCHEMA_VERSION,
      updatedAt: FIXED_NOW,
    })
    assert.equal(root.tagCount, 1)
    const item = EntityTagAssignmentSchema.parse({
      canonicalKey: "machine-learning",
      type: "skill",
      mutexGroup: "machine-learning",
      confidence: 0.9,
      firstSeen: FIXED_NOW,
      lastReinforced: FIXED_NOW,
      count: 3,
      sources: [
        {
          source: "pa-cv-ingest",
          weight: 1.0,
          firstAt: FIXED_NOW,
          lastAt: FIXED_NOW,
          count: 2,
        },
      ],
      decayHalfLifeDays: 0,
      schemaVersion: TAG_EVENT_SCHEMA_VERSION,
    })
    assert.equal(item.canonicalKey, "machine-learning")
    assert.equal(item.sources[0].count, 2)
  })
})
