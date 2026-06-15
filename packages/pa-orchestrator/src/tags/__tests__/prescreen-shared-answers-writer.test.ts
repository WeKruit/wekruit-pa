/**
 * Tests for the cross-session prescreen shared-answer sole-writer (SPEC §5b/§6/§10).
 *
 * Covers: dotted-path write of the SPECIFIC key (no whole-map deep-merge clobber),
 * last-write-wins per key, recency guard, schema validation, fail-open, and the
 * fail-soft read path.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  mergeUserPrescreenSharedAnswers,
  readUserPrescreenSharedAnswers,
  type PrescreenSharedAnswer,
} from "../prescreen-shared-answers-writer.js"

// ── A tiny Firestore double that records set() calls + serves a seeded doc. ──
function makeDb(seed?: Record<string, unknown>) {
  const writes: Array<{ data: Record<string, unknown>; opts: unknown }> = []
  const docState: Record<string, unknown> = seed ? { ...seed } : {}
  let throwOnSet = false
  const db = {
    collection() {
      return {
        doc() {
          return {
            async get() {
              return {
                exists: Object.keys(docState).length > 0,
                data: () => docState,
              }
            },
            async set(data: Record<string, unknown>, opts: unknown) {
              if (throwOnSet) throw new Error("boom")
              writes.push({ data, opts })
            },
          }
        },
      }
    },
  }
  return {
    db: db as unknown as import("firebase-admin/firestore").Firestore,
    writes,
    setThrow: (v: boolean) => {
      throwOnSet = v
    },
  }
}

const baseAnswer: PrescreenSharedAnswer = {
  sharedKey: "ai_usage",
  reply: "I use Cursor + Claude daily to scaffold tests and review PRs.",
  finalS: 0.8,
  sourceSessionId: "sess_A",
  sourceJobId: "job_A",
  answeredAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z",
}

test("writes the SPECIFIC dotted path (no whole-map clobber) with merge:true", async () => {
  const { db, writes } = makeDb()
  const res = await mergeUserPrescreenSharedAnswers(db, "user1", baseAnswer)
  assert.equal(res.ok, true)
  assert.equal(res.sharedKey, "ai_usage")
  assert.equal(writes.length, 1)
  // The write must target the dotted key, NOT the whole map.
  assert.deepEqual(Object.keys(writes[0]!.data), ["prescreenSharedAnswers.ai_usage"])
  assert.deepEqual(writes[0]!.opts, { merge: true })
  const written = (writes[0]!.data as Record<string, PrescreenSharedAnswer>)[
    "prescreenSharedAnswers.ai_usage"
  ]
  assert.equal(written!.reply, baseAnswer.reply)
  assert.equal(written!.sourceJobId, "job_A")
})

test("last-write-wins: a NEWER updatedAt overwrites", async () => {
  const { db, writes } = makeDb({
    prescreenSharedAnswers: { ai_usage: { ...baseAnswer } },
  })
  const newer: PrescreenSharedAnswer = {
    ...baseAnswer,
    reply: "Now I also use coding agents for refactors.",
    sourceSessionId: "sess_B",
    sourceJobId: "job_B",
    updatedAt: "2026-06-15T00:00:00.000Z",
    answeredAt: "2026-06-15T00:00:00.000Z",
  }
  const res = await mergeUserPrescreenSharedAnswers(db, "user1", newer)
  assert.equal(res.ok, true)
  assert.equal(writes.length, 1)
  const written = (writes[0]!.data as Record<string, PrescreenSharedAnswer>)[
    "prescreenSharedAnswers.ai_usage"
  ]
  assert.equal(written!.sourceJobId, "job_B")
})

test("recency guard: an OLDER updatedAt is skipped (no write)", async () => {
  const { db, writes } = makeDb({
    prescreenSharedAnswers: {
      ai_usage: { ...baseAnswer, updatedAt: "2026-06-20T00:00:00.000Z" },
    },
  })
  const stale: PrescreenSharedAnswer = {
    ...baseAnswer,
    reply: "older answer",
    updatedAt: "2026-06-14T00:00:00.000Z",
  }
  const res = await mergeUserPrescreenSharedAnswers(db, "user1", stale)
  assert.equal(res.ok, true) // no-op success
  assert.equal(writes.length, 0)
})

test("invalid record (empty reply) → rejected, no write", async () => {
  const { db, writes } = makeDb()
  const bad = { ...baseAnswer, reply: "" } as PrescreenSharedAnswer
  const res = await mergeUserPrescreenSharedAnswers(db, "user1", bad)
  assert.equal(res.ok, false)
  assert.equal(res.error, "invalid_answer")
  assert.equal(writes.length, 0)
})

test("missing userId → skip", async () => {
  const { db, writes } = makeDb()
  const res = await mergeUserPrescreenSharedAnswers(db, "", baseAnswer)
  assert.equal(res.ok, false)
  assert.equal(writes.length, 0)
})

test("fail-open: a Firestore set() throw returns {ok:false} not a throw", async () => {
  const { db, setThrow } = makeDb()
  setThrow(true)
  const res = await mergeUserPrescreenSharedAnswers(db, "user1", baseAnswer)
  assert.equal(res.ok, false)
  assert.ok(res.error)
})

test("backfills missing answeredAt/updatedAt from nowIso", async () => {
  const { db, writes } = makeDb()
  const partial = {
    sharedKey: "ai_usage",
    reply: "uses AI",
    sourceSessionId: "s",
    sourceJobId: "j",
    answeredAt: "",
    updatedAt: "",
  } as unknown as PrescreenSharedAnswer
  const res = await mergeUserPrescreenSharedAnswers(db, "user1", partial, {
    nowIso: "2026-06-14T12:00:00.000Z",
  })
  assert.equal(res.ok, true)
  const written = (writes[0]!.data as Record<string, PrescreenSharedAnswer>)[
    "prescreenSharedAnswers.ai_usage"
  ]
  assert.equal(written!.updatedAt, "2026-06-14T12:00:00.000Z")
  assert.equal(written!.answeredAt, "2026-06-14T12:00:00.000Z")
})

test("read: returns the stored map, dropping malformed entries", async () => {
  const { db } = makeDb({
    prescreenSharedAnswers: {
      ai_usage: { ...baseAnswer },
      junk: { reply: 123 }, // malformed → dropped
    },
  })
  const map = await readUserPrescreenSharedAnswers(db, "user1")
  assert.deepEqual(Object.keys(map), ["ai_usage"])
  assert.equal(map.ai_usage!.reply, baseAnswer.reply)
})

test("read: absent field → {} (dormant-safe)", async () => {
  const { db } = makeDb({ tags: { skills: [] } })
  const map = await readUserPrescreenSharedAnswers(db, "user1")
  assert.deepEqual(map, {})
})
