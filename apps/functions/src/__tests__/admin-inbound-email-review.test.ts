/**
 * Tests for the inbound-email HITL runners: drafts list, approve/dismiss, and
 * the unmatched queue. In-memory Firestore fake with orderBy/startAfter/limit.
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  runAdminInboundEmailDrafts,
  runAdminInboundUnmatchedList,
  runAdminSendInboundEmailDraft,
} from "../admin-inbound-email-review.js"

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
  let auto = 0
  function makeQuery(name: string) {
    return {
      orderBy(_field: string, _dir?: string) {
        return makeQuery(name)
      },
      startAfter(_cursor: unknown) {
        return makeQuery(name)
      },
      limit(_n: number) {
        return makeQuery(name)
      },
      async get() {
        const col = colOf(name)
        const docs = [...col.entries()].map(([id, data]) => ({ id, data: () => data }))
        return { docs, empty: docs.length === 0 }
      },
    }
  }
  return {
    collection(name: string) {
      return {
        doc(id?: string) {
          const docId = id ?? `auto-${++auto}`
          return {
            id: docId,
            async get() {
              const data = colOf(name).get(docId)
              return { exists: data !== undefined, data: () => data }
            },
            async set(data: Doc, opts?: { merge?: boolean }) {
              const prev = opts?.merge ? colOf(name).get(docId) ?? {} : {}
              colOf(name).set(docId, { ...prev, ...data })
            },
          }
        },
        orderBy(field: string, dir?: string) {
          return makeQuery(name).orderBy(field, dir)
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

test("drafts list returns only pending_review by default + counts", async () => {
  const store: Store = new Map()
  seed(store, "pa-inbound-email-drafts", "d1", {
    status: "pending_review",
    candidateEmail: "a@x.com",
    replyBody: "hello",
    createdAt: "2026-06-01T10:00:00.000Z",
  })
  seed(store, "pa-inbound-email-drafts", "d2", { status: "sent", candidateEmail: "b@x.com", createdAt: "2026-06-01T09:00:00.000Z" })
  const res = await runAdminInboundEmailDrafts({}, { db: makeDb(store) })
  assert.equal(res.rows.length, 1)
  assert.equal(res.rows[0]!.id, "d1")
  assert.equal(res.counts.pending_review, 1)
  assert.equal(res.counts.sent, 1)
  assert.equal(res.counts.total, 2)
})

test("dismiss a draft → status dismissed, no send", async () => {
  const store: Store = new Map()
  seed(store, "pa-inbound-email-drafts", "d1", {
    status: "pending_review",
    candidateEmail: "a@x.com",
    replyBody: "hi",
    createdAt: "2026-06-01T10:00:00.000Z",
  })
  const res = await runAdminSendInboundEmailDraft(
    { draftId: "d1", action: "dismiss" },
    { db: makeDb(store), now: () => "2026-06-26T00:00:00.000Z", actorEmail: "op@wekruit.com" },
  )
  assert.equal(res.action, "dismiss")
  assert.equal(res.status, "dismissed")
  const d = store.get("pa-inbound-email-drafts")!.get("d1")!
  assert.equal(d.status, "dismissed")
  assert.equal((d.adminDecision as Doc).by, "op@wekruit.com")
})

test("approve_send with no mailgun config → send_failed (never throws)", async () => {
  const prevKey = process.env.MAILGUN_API_KEY
  const prevDomain = process.env.MAILGUN_DOMAIN
  delete process.env.MAILGUN_API_KEY
  delete process.env.MAILGUN_DOMAIN
  try {
    const store: Store = new Map()
    seed(store, "pa-inbound-email-drafts", "d1", {
      status: "pending_review",
      candidateEmail: "a@x.com",
      replyBody: "hi",
      replySubject: "Re: x",
      convToken: "tok1",
      createdAt: "2026-06-01T10:00:00.000Z",
    })
    const res = await runAdminSendInboundEmailDraft(
      { draftId: "d1", action: "approve_send" },
      { db: makeDb(store), now: () => "2026-06-26T00:00:00.000Z" },
    )
    assert.equal(res.action, "approve_send")
    assert.equal((res as { sent?: boolean }).sent, false)
    assert.equal(res.status, "send_failed")
  } finally {
    if (prevKey !== undefined) process.env.MAILGUN_API_KEY = prevKey
    if (prevDomain !== undefined) process.env.MAILGUN_DOMAIN = prevDomain
  }
})

test("approve_send is idempotent on already-sent draft", async () => {
  const store: Store = new Map()
  seed(store, "pa-inbound-email-drafts", "d1", {
    status: "sent",
    candidateEmail: "a@x.com",
    replyBody: "hi",
    createdAt: "2026-06-01T10:00:00.000Z",
  })
  const res = await runAdminSendInboundEmailDraft({ draftId: "d1", action: "approve_send" }, { db: makeDb(store) })
  assert.equal((res as { sent?: boolean }).sent, true)
  assert.equal(res.status, "sent")
})

test("unmatched list groups by reason", async () => {
  const store: Store = new Map()
  seed(store, "pa-inbound-emails-unmatched", "x1", {
    reason: "sensitive_topic_hitl",
    sender: "a@x.com",
    createdAt: "2026-06-01T10:00:00.000Z",
  })
  seed(store, "pa-inbound-emails-unmatched", "x2", {
    reason: "thread_not_found",
    sender: "b@x.com",
    createdAt: "2026-06-01T09:00:00.000Z",
  })
  const res = await runAdminInboundUnmatchedList({}, { db: makeDb(store) })
  assert.equal(res.rows.length, 2)
  assert.equal(res.counts.sensitive_topic_hitl, 1)
  assert.equal(res.counts.thread_not_found, 1)
  assert.equal(res.counts.total, 2)
})
