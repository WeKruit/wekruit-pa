/**
 * Tests for runAdminCandidateComms — the unified SMS + email comms timeline.
 * Uses an in-memory Firestore fake supporting where()/limit()/get() and getAll.
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { runAdminCandidateComms } from "../admin-candidate-comms.js"

type Doc = Record<string, unknown>
type Store = Map<string, Map<string, Doc>>

function makeDb(store: Store): Firestore {
  const colOf = (name: string) => {
    let c = store.get(name)
    if (!c) {
      c = new Map()
      store.set(name, c)
    }
    return c
  }
  function makeQuery(name: string, preds: Array<[string, unknown]>) {
    return {
      where(field: string, _op: string, value: unknown) {
        return makeQuery(name, [...preds, [field, value]])
      },
      limit(_n: number) {
        return makeQuery(name, preds)
      },
      async get() {
        const col = colOf(name)
        const docs = [...col.entries()]
          .filter(([, data]) => preds.every(([f, v]) => (data as Doc)[f] === v))
          .map(([id, data]) => ({ id, data: () => data }))
        return { docs, empty: docs.length === 0 }
      },
    }
  }
  return {
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            async get() {
              const data = colOf(name).get(id)
              return { exists: data !== undefined, data: () => data }
            },
          }
        },
        where(field: string, op: string, value: unknown) {
          return makeQuery(name, [[field, value]])
        },
        limit(_n: number) {
          return makeQuery(name, [])
        },
      }
    },
  } as unknown as Firestore
}

function seed(store: Store, col: string, id: string, data: Doc) {
  let c = store.get(col)
  if (!c) {
    c = new Map()
    store.set(col, c)
  }
  c.set(id, data)
}

test("merges SMS + email into one time-ordered timeline keyed by userId", async () => {
  const store: Store = new Map()
  seed(store, "pa-users", "u1", { email: "Cand@Example.com" })
  // SMS
  seed(store, "pa-messages", "m1", {
    userId: "u1",
    role: "user",
    body: "hey",
    createdAt: "2026-06-01T10:00:00.000Z",
  })
  seed(store, "pa-messages", "m2", {
    userId: "u1",
    role: "assistant",
    body: "hi there",
    createdAt: "2026-06-01T10:01:00.000Z",
  })
  seed(store, "pa-messages", "sys", {
    userId: "u1",
    role: "system",
    body: "internal",
    createdAt: "2026-06-01T09:00:00.000Z",
  })
  // Outbound email — keyed only by candidateEmail (headhunter send_email path).
  seed(store, "pa-headhunter-emails", "e1", {
    to: "cand@example.com",
    subject: "Interview times",
    body: "pick a slot",
    status: "sent",
    convToken: "tok1",
    createdAt: "2026-06-01T11:00:00.000Z",
  })
  // Inbound email reply.
  seed(store, "pa-email-inbound", "i1", {
    userId: "u1",
    candidateEmail: "cand@example.com",
    subject: "Re: Interview times",
    strippedText: "none of those work",
    convToken: "tok1",
    createdAt: "2026-06-01T12:00:00.000Z",
  })

  const res = await runAdminCandidateComms({ userId: "u1" }, { db: makeDb(store), now: () => "2026-06-26T00:00:00.000Z" })

  assert.equal(res.candidateEmail, "cand@example.com")
  // 2 SMS (system filtered out) + 1 outbound email + 1 inbound email = 4
  assert.equal(res.rows.length, 4)
  assert.equal(res.counts.sms, 2)
  assert.equal(res.counts.email, 2)
  // ascending by ts
  assert.deepEqual(
    res.rows.map((r) => r.id),
    ["m1", "m2", "e1", "i1"],
  )
  const inbound = res.rows.find((r) => r.id === "i1")!
  assert.equal(inbound.channel, "email")
  assert.equal(inbound.direction, "inbound")
  assert.equal(inbound.subject, "Re: Interview times")
  const out = res.rows.find((r) => r.id === "e1")!
  assert.equal(out.direction, "outbound")
  assert.equal(out.status, "sent")
})

test("de-dupes a headhunter email matched by both userId and candidateEmail", async () => {
  const store: Store = new Map()
  seed(store, "pa-users", "u1", { normalizedEmail: "cand@example.com" })
  seed(store, "pa-headhunter-emails", "e1", {
    userId: "u1",
    to: "cand@example.com",
    subject: "Offer",
    body: "congrats",
    status: "sent",
    createdAt: "2026-06-01T11:00:00.000Z",
  })
  const res = await runAdminCandidateComms({ userId: "u1" }, { db: makeDb(store) })
  assert.equal(res.rows.length, 1)
  assert.equal(res.rows[0]!.id, "e1")
})

test("empty when no comms", async () => {
  const store: Store = new Map()
  seed(store, "pa-users", "u1", {})
  const res = await runAdminCandidateComms({ userId: "u1" }, { db: makeDb(store) })
  assert.equal(res.rows.length, 0)
  assert.equal(res.counts.total, 0)
})
