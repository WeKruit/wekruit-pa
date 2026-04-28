import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  VOICE_REVIEW_TAGS,
  listAssistantTurnsForReview,
  listVoiceReviews,
  writeVoiceReview,
  type VoiceReviewDoc,
} from "./voice-reviews.js"

// -----------------------------------------------------------------------------
// In-memory Firestore double — supports doc().get/set + where/orderBy/limit/
// startAfter chains used by listVoiceReviews and listAssistantTurnsForReview.
// -----------------------------------------------------------------------------

interface Stored {
  voiceReviews: Map<string, Record<string, unknown>>
  messages: Map<string, Record<string, unknown>>
}

function makeFakeFirestore(initial?: Partial<Stored>) {
  const store: Stored = {
    voiceReviews: initial?.voiceReviews ?? new Map(),
    messages: initial?.messages ?? new Map(),
  }

  function makeQuery(
    collectionName: string,
    filters: Array<{ field: string; op: string; val: unknown }> = [],
    order?: { field: string; dir: "asc" | "desc" },
    cursor?: unknown,
    limitN?: number
  ) {
    const q = {
      where(field: string, op: string, val: unknown) {
        return makeQuery(collectionName, [...filters, { field, op, val }], order, cursor, limitN)
      },
      orderBy(field: string, dir: "asc" | "desc" = "asc") {
        return makeQuery(collectionName, filters, { field, dir }, cursor, limitN)
      },
      startAfter(val: unknown) {
        return makeQuery(collectionName, filters, order, val, limitN)
      },
      limit(n: number) {
        return makeQuery(collectionName, filters, order, cursor, n)
      },
      async get() {
        const source =
          collectionName === "pa-voice-reviews" ? store.voiceReviews : store.messages
        let rows = Array.from(source.entries()).map(([id, data]) => ({ id, data }))
        for (const f of filters) {
          rows = rows.filter((r) => {
            const v = r.data[f.field]
            switch (f.op) {
              case "==":
                return v === f.val
              case "<=":
                return typeof v === "number" && typeof f.val === "number" && v <= f.val
              case ">=":
                return typeof v === "number" && typeof f.val === "number"
                  ? v >= f.val
                  : String(v) >= String(f.val)
              case "<":
                return String(v) < String(f.val)
              case ">":
                return String(v) > String(f.val)
              default:
                return true
            }
          })
        }
        if (order) {
          rows = rows.sort((a, b) => {
            const va = a.data[order.field]
            const vb = b.data[order.field]
            const sa = String(va ?? "")
            const sb = String(vb ?? "")
            const cmp = sa < sb ? -1 : sa > sb ? 1 : 0
            return order.dir === "desc" ? -cmp : cmp
          })
        }
        if (cursor !== undefined && order) {
          const idx = rows.findIndex((r) => r.data[order.field] === cursor)
          if (idx >= 0) rows = rows.slice(idx + 1)
        }
        if (limitN != null) rows = rows.slice(0, limitN)
        return {
          docs: rows.map((r) => ({ id: r.id, data: () => r.data })),
        }
      },
    }
    return q
  }

  function docRef(collectionName: string, id: string) {
    const source =
      collectionName === "pa-voice-reviews" ? store.voiceReviews : store.messages
    return {
      async get() {
        const data = source.get(id)
        return {
          exists: data !== undefined,
          id,
          data: () => data,
        }
      },
      async set(value: Record<string, unknown>) {
        // Resolve serverTimestamp sentinel for tests.
        const resolved = { ...value }
        if (resolved.createdAt && typeof resolved.createdAt === "object") {
          // FieldValue.serverTimestamp() — replace with deterministic ts so
          // ordering tests work.
          if (
            (resolved.createdAt as { _isServerTimestamp?: boolean })._isServerTimestamp ||
            // firebase-admin sentinel has no public marker; fallback: any object
            // value here is treated as serverTimestamp in this fake.
            true
          ) {
            resolved.createdAt = new Date().toISOString()
          }
        }
        source.set(id, resolved)
      },
    }
  }

  const db = {
    collection(name: string) {
      const base = makeQuery(name)
      return {
        ...base,
        doc: (id: string) => docRef(name, id),
      }
    },
  }
  return { db: db as unknown as Firestore, store }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test("writeVoiceReview: writes all 6 fields + createdAt to pa-voice-reviews/{messageId}", async () => {
  const { db, store } = makeFakeFirestore()
  await writeVoiceReview(db, {
    messageId: "msg_001",
    rating: 4,
    tags: ["probe", "ok"],
    comment: "good probe",
    reviewerId: "developers@wekruit.com",
    agentSnapshot: { bibleVersion: "v7.0", modelId: "gpt-5.4-nano" },
  })
  const doc = store.voiceReviews.get("msg_001") as unknown as VoiceReviewDoc & { createdAt: string }
  assert.ok(doc, "doc should exist")
  // Schema: all 6 fields + createdAt
  assert.equal(doc.messageId, "msg_001")
  assert.equal(doc.rating, 4)
  assert.deepEqual(doc.tags, ["probe", "ok"])
  assert.equal(doc.comment, "good probe")
  assert.equal(doc.reviewerId, "developers@wekruit.com")
  assert.equal(doc.agentSnapshot.bibleVersion, "v7.0")
  assert.equal(doc.agentSnapshot.modelId, "gpt-5.4-nano")
  assert.ok(doc.createdAt, "createdAt should be populated by serverTimestamp resolution")
})

test("writeVoiceReview: enforces rating 1..5", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      writeVoiceReview(db, {
        messageId: "x",
        // @ts-expect-error testing invalid rating
        rating: 0,
        tags: [],
        comment: "",
        reviewerId: "u",
        agentSnapshot: { bibleVersion: "v7", modelId: "m" },
      }),
    /rating must be 1..5/
  )
  await assert.rejects(
    () =>
      writeVoiceReview(db, {
        messageId: "x",
        // @ts-expect-error testing invalid rating
        rating: 6,
        tags: [],
        comment: "",
        reviewerId: "u",
        agentSnapshot: { bibleVersion: "v7", modelId: "m" },
      }),
    /rating must be 1..5/
  )
})

test("writeVoiceReview: tag enum strict — rejects unknown tag", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      writeVoiceReview(db, {
        messageId: "x",
        rating: 3,
        // @ts-expect-error testing invalid tag
        tags: ["probe", "bogus"],
        comment: "",
        reviewerId: "u",
        agentSnapshot: { bibleVersion: "v7", modelId: "m" },
      }),
    /invalid tag/
  )
})

test("writeVoiceReview: accepts every allowed tag", async () => {
  const { db, store } = makeFakeFirestore()
  await writeVoiceReview(db, {
    messageId: "all_tags",
    rating: 5,
    tags: [...VOICE_REVIEW_TAGS],
    comment: "",
    reviewerId: "u",
    agentSnapshot: { bibleVersion: "v7", modelId: "m" },
  })
  const doc = store.voiceReviews.get("all_tags") as unknown as VoiceReviewDoc
  assert.deepEqual(
    [...doc.tags].sort(),
    [...VOICE_REVIEW_TAGS].sort()
  )
  // Sanity: enum locked to exactly 6 values
  assert.equal(VOICE_REVIEW_TAGS.length, 6)
  assert.deepEqual(
    [...VOICE_REVIEW_TAGS].sort(),
    ["ai_speak", "diagnose", "ok", "probe", "tone", "too_long"]
  )
})

test("writeVoiceReview: requires agentSnapshot.bibleVersion + modelId", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      writeVoiceReview(db, {
        messageId: "x",
        rating: 3,
        tags: [],
        comment: "",
        reviewerId: "u",
        // @ts-expect-error missing bibleVersion
        agentSnapshot: { modelId: "m" },
      }),
    /bibleVersion required/
  )
  await assert.rejects(
    () =>
      writeVoiceReview(db, {
        messageId: "x",
        rating: 3,
        tags: [],
        comment: "",
        reviewerId: "u",
        // @ts-expect-error missing modelId
        agentSnapshot: { bibleVersion: "v7" },
      }),
    /modelId required/
  )
})

test("writeVoiceReview: dedupes duplicate tags", async () => {
  const { db, store } = makeFakeFirestore()
  await writeVoiceReview(db, {
    messageId: "dedup",
    rating: 3,
    tags: ["probe", "probe", "ok", "probe"],
    comment: "",
    reviewerId: "u",
    agentSnapshot: { bibleVersion: "v7", modelId: "m" },
  })
  const doc = store.voiceReviews.get("dedup") as unknown as VoiceReviewDoc
  assert.deepEqual(doc.tags, ["probe", "ok"])
})

test("writeVoiceReview: idempotent overwrite — same messageId latest wins", async () => {
  const { db, store } = makeFakeFirestore()
  await writeVoiceReview(db, {
    messageId: "idem",
    rating: 2,
    tags: ["too_long"],
    comment: "first",
    reviewerId: "u",
    agentSnapshot: { bibleVersion: "v7", modelId: "m" },
  })
  await writeVoiceReview(db, {
    messageId: "idem",
    rating: 5,
    tags: ["ok"],
    comment: "second",
    reviewerId: "u",
    agentSnapshot: { bibleVersion: "v7", modelId: "m" },
  })
  const doc = store.voiceReviews.get("idem") as unknown as VoiceReviewDoc
  assert.equal(doc.rating, 5)
  assert.equal(doc.comment, "second")
})

test("listVoiceReviews: filter by ratingMax (Phase 27 contract)", async () => {
  const voiceReviews = new Map<string, Record<string, unknown>>()
  voiceReviews.set("a", {
    messageId: "a",
    rating: 1,
    tags: [],
    comment: "",
    reviewerId: "u",
    agentSnapshot: { bibleVersion: "v7", modelId: "m" },
    createdAt: "2026-04-28T00:00:01.000Z",
  })
  voiceReviews.set("b", {
    messageId: "b",
    rating: 4,
    tags: [],
    comment: "",
    reviewerId: "u",
    agentSnapshot: { bibleVersion: "v7", modelId: "m" },
    createdAt: "2026-04-28T00:00:02.000Z",
  })
  voiceReviews.set("c", {
    messageId: "c",
    rating: 2,
    tags: ["tone"],
    comment: "",
    reviewerId: "u",
    agentSnapshot: { bibleVersion: "v7", modelId: "m" },
    createdAt: "2026-04-28T00:00:03.000Z",
  })
  const { db } = makeFakeFirestore({ voiceReviews })
  const rows = await listVoiceReviews(db, { ratingMax: 2 })
  const ids = rows.map((r) => r.messageId).sort()
  assert.deepEqual(ids, ["a", "c"])
})

test("listAssistantTurnsForReview: joins reviewed/unreviewed + prior user turn", async () => {
  const messages = new Map<string, Record<string, unknown>>()
  messages.set("u1", {
    id: "u1",
    sessionId: "ses1",
    userId: "user1",
    role: "user",
    body: "hi",
    createdAt: "2026-04-28T00:00:00.000Z",
  })
  messages.set("a1", {
    id: "a1",
    sessionId: "ses1",
    userId: "user1",
    role: "assistant",
    body: "hello!",
    createdAt: "2026-04-28T00:00:01.000Z",
  })
  messages.set("u2", {
    id: "u2",
    sessionId: "ses1",
    userId: "user1",
    role: "user",
    body: "how are you",
    createdAt: "2026-04-28T00:00:02.000Z",
  })
  messages.set("a2", {
    id: "a2",
    sessionId: "ses1",
    userId: "user1",
    role: "assistant",
    body: "fine, thanks",
    createdAt: "2026-04-28T00:00:03.000Z",
  })
  const voiceReviews = new Map<string, Record<string, unknown>>()
  voiceReviews.set("a1", {
    messageId: "a1",
    rating: 4,
    tags: ["ok"],
    comment: "warm",
    reviewerId: "developers@wekruit.com",
    agentSnapshot: { bibleVersion: "v7.0", modelId: "gpt-5.4-nano" },
    createdAt: "2026-04-28T01:00:00.000Z",
  })
  const { db } = makeFakeFirestore({ messages, voiceReviews })

  const rows = await listAssistantTurnsForReview(db, { limit: 10 })
  assert.equal(rows.length, 2)
  // Newest first
  assert.equal(rows[0]!.messageId, "a2")
  assert.equal(rows[0]!.reviewed, false)
  assert.equal(rows[0]!.priorUserBody, "how are you")
  assert.equal(rows[1]!.messageId, "a1")
  assert.equal(rows[1]!.reviewed, true)
  assert.equal(rows[1]!.review?.rating, 4)
  assert.equal(rows[1]!.priorUserBody, "hi")
})
