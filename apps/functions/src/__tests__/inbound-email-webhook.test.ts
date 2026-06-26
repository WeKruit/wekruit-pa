/**
 * Tests for the TWO-WAY inbound email webhook core (`handleInboundEmail`) and
 * the VERP thread-token helpers. Uses a tiny in-memory Firestore fake. The LLM
 * auto-reply path is NOT exercised live here — with no OpenAI key in the test
 * env, compose() no-ops and we assert the deterministic gating/recording paths.
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  handleInboundEmail,
  type InboundEmailDeps,
  type InboundEmailRequest,
  type InboundEmailResponse,
} from "../inbound-email-webhook.js"
import {
  EMAIL_THREADS_COLLECTION,
  extractConvTokenFromRecipient,
  generateConvToken,
  verpReplyToAddress,
} from "../email/email-thread.js"

// ---------------------------------------------------------------------------
// In-memory Firestore fake (collection → docId → data)
// ---------------------------------------------------------------------------

type Store = Map<string, Map<string, Record<string, unknown>>>

function ensureCol(store: Store, name: string): Map<string, Record<string, unknown>> {
  let c = store.get(name)
  if (!c) {
    c = new Map()
    store.set(name, c)
  }
  return c
}

function makeDb(store: Store): Firestore {
  let auto = 0
  return {
    collection(name: string) {
      const col = ensureCol(store, name)
      return {
        doc(id?: string) {
          const docId = id ?? `auto-${++auto}`
          return {
            id: docId,
            async get() {
              const data = col.get(docId)
              return { exists: data !== undefined, data: () => data }
            },
            async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
              const prev = opts?.merge ? col.get(docId) ?? {} : {}
              col.set(docId, { ...prev, ...data })
            },
          }
        },
        async add(data: Record<string, unknown>) {
          const docId = `auto-${++auto}`
          col.set(docId, data)
          return { id: docId }
        },
      }
    },
  } as unknown as Firestore
}

function makeRes(): { res: InboundEmailResponse; out: { code?: number; body?: unknown } } {
  const out: { code?: number; body?: unknown } = {}
  const res: InboundEmailResponse = {
    status(code: number) {
      out.code = code
      return {
        json: (b: unknown) => {
          out.body = b
        },
        send: (b: unknown) => {
          out.body = b
        },
      }
    },
  }
  return { res, out }
}

const baseDeps = (db: Firestore, over: Partial<InboundEmailDeps> = {}): InboundEmailDeps => ({
  db,
  autoReplyEnabled: false, // default: deterministic-only, no LLM in tests
  now: () => "2026-06-26T00:00:00.000Z",
  ...over,
})

function inboundReq(fields: Record<string, string>): InboundEmailRequest {
  return { method: "POST", body: fields }
}

// ---------------------------------------------------------------------------
// Helper unit tests
// ---------------------------------------------------------------------------

test("generateConvToken is hex and verpReplyToAddress round-trips", () => {
  const t = generateConvToken()
  assert.match(t, /^[a-f0-9]{32}$/)
  const addr = verpReplyToAddress(t)
  assert.equal(addr, `reply+${t}@mg.wekruit.com`)
  assert.equal(extractConvTokenFromRecipient(addr), t)
})

test("extractConvTokenFromRecipient handles display-name form and rejects junk", () => {
  const t = "deadbeefcafebabe0011223344556677"
  assert.equal(extractConvTokenFromRecipient(`Claire <reply+${t}@mg.wekruit.com>`), t)
  assert.equal(extractConvTokenFromRecipient("hello@example.com"), null)
  assert.equal(extractConvTokenFromRecipient("reply+@mg.wekruit.com"), null)
  assert.equal(extractConvTokenFromRecipient(undefined), null)
})

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

test("non-POST → 405", async () => {
  const store: Store = new Map()
  const { res, out } = makeRes()
  await handleInboundEmail({ method: "GET", body: {} }, res, baseDeps(makeDb(store)))
  assert.equal(out.code, 405)
})

test("no conv token → records unmatched + 200", async () => {
  const store: Store = new Map()
  const db = makeDb(store)
  const { res, out } = makeRes()
  await handleInboundEmail(
    inboundReq({
      recipient: "hello@mg.wekruit.com",
      sender: "candidate@example.com",
      subject: "hi",
      "stripped-text": "hello",
      "Message-Id": "<m1@example.com>",
    }),
    res,
    baseDeps(db),
  )
  assert.equal(out.code, 200)
  assert.equal((out.body as { unmatched?: string }).unmatched, "no_conv_token")
  assert.equal(ensureCol(store, "pa-inbound-emails-unmatched").size, 1)
})

test("token present but no thread doc → unmatched thread_not_found + 200", async () => {
  const store: Store = new Map()
  const db = makeDb(store)
  const token = generateConvToken()
  const { res, out } = makeRes()
  await handleInboundEmail(
    inboundReq({
      recipient: verpReplyToAddress(token),
      sender: "candidate@example.com",
      subject: "hi",
      "stripped-text": "hello",
      "Message-Id": "<m2@example.com>",
    }),
    res,
    baseDeps(db),
  )
  assert.equal(out.code, 200)
  assert.equal((out.body as { unmatched?: string }).unmatched, "thread_not_found")
})

test("happy path (autoreply off) records inbound + flips thread direction", async () => {
  const store: Store = new Map()
  const db = makeDb(store)
  const token = generateConvToken()
  ensureCol(store, EMAIL_THREADS_COLLECTION).set(token, {
    convToken: token,
    userId: "user-1",
    jobId: "job-1",
    candidateEmail: "candidate@example.com",
    subject: "Pick a time for your WeKruit interview",
    lastDirection: "outbound",
  })
  const { res, out } = makeRes()
  await handleInboundEmail(
    inboundReq({
      recipient: verpReplyToAddress(token),
      sender: "candidate@example.com",
      subject: "Re: Pick a time",
      "stripped-text": "None of those work, can we do next week?",
      "Message-Id": "<m3@example.com>",
    }),
    res,
    baseDeps(db),
  )
  assert.equal(out.code, 200)
  assert.equal((out.body as { action?: string }).action, "recorded_no_autoreply")
  const inbound = ensureCol(store, "pa-email-inbound")
  assert.equal(inbound.size, 1)
  const thread = ensureCol(store, EMAIL_THREADS_COLLECTION).get(token)!
  assert.equal(thread.lastDirection, "inbound")
})

test("loop guard: our own claire@ sender is ignored", async () => {
  const store: Store = new Map()
  const db = makeDb(store)
  const token = generateConvToken()
  ensureCol(store, EMAIL_THREADS_COLLECTION).set(token, {
    convToken: token,
    candidateEmail: "candidate@example.com",
    subject: "x",
    lastDirection: "outbound",
  })
  const { res, out } = makeRes()
  await handleInboundEmail(
    inboundReq({
      recipient: verpReplyToAddress(token),
      sender: "WeKruit Claire <claire@mg.wekruit.com>",
      subject: "Re: x",
      "stripped-text": "auto loop",
      "Message-Id": "<m4@example.com>",
    }),
    res,
    baseDeps(db, { autoReplyEnabled: true }),
  )
  assert.equal((out.body as { ignored?: string }).ignored, "own_sender")
})

test("STOP request records optOut, no reply", async () => {
  const store: Store = new Map()
  const db = makeDb(store)
  const token = generateConvToken()
  ensureCol(store, EMAIL_THREADS_COLLECTION).set(token, {
    convToken: token,
    candidateEmail: "candidate@example.com",
    subject: "x",
    lastDirection: "outbound",
  })
  const { res, out } = makeRes()
  await handleInboundEmail(
    inboundReq({
      recipient: verpReplyToAddress(token),
      sender: "candidate@example.com",
      subject: "Re: x",
      "stripped-text": "Please STOP emailing me, unsubscribe",
      "Message-Id": "<m5@example.com>",
    }),
    res,
    baseDeps(db, { autoReplyEnabled: true }),
  )
  assert.equal((out.body as { action?: string }).action, "stop_recorded")
  assert.equal(ensureCol(store, EMAIL_THREADS_COLLECTION).get(token)!.optOut, true)
})

test("sensitive topic (visa/salary) routes to HITL, no reply", async () => {
  const store: Store = new Map()
  const db = makeDb(store)
  const token = generateConvToken()
  ensureCol(store, EMAIL_THREADS_COLLECTION).set(token, {
    convToken: token,
    candidateEmail: "candidate@example.com",
    subject: "x",
    lastDirection: "outbound",
  })
  const { res, out } = makeRes()
  await handleInboundEmail(
    inboundReq({
      recipient: verpReplyToAddress(token),
      sender: "candidate@example.com",
      subject: "Re: x",
      "stripped-text": "What is the salary and do you sponsor H1B visa?",
      "Message-Id": "<m6@example.com>",
    }),
    res,
    baseDeps(db, { autoReplyEnabled: true }),
  )
  assert.equal((out.body as { action?: string }).action, "routed_to_hitl")
})

test("idempotent on Message-Id (redelivery)", async () => {
  const store: Store = new Map()
  const db = makeDb(store)
  const token = generateConvToken()
  ensureCol(store, EMAIL_THREADS_COLLECTION).set(token, {
    convToken: token,
    candidateEmail: "candidate@example.com",
    subject: "x",
    lastDirection: "outbound",
  })
  // Pre-seed the inbound doc as if a first delivery already landed.
  ensureCol(store, "pa-email-inbound").set(encodeURIComponent("<dup@example.com>"), { direction: "inbound" })
  const { res, out } = makeRes()
  await handleInboundEmail(
    inboundReq({
      recipient: verpReplyToAddress(token),
      sender: "candidate@example.com",
      subject: "Re: x",
      "stripped-text": "hello again",
      "Message-Id": "<dup@example.com>",
    }),
    res,
    baseDeps(db),
  )
  assert.equal((out.body as { idempotent?: boolean }).idempotent, true)
})

test("HMAC verify rejects bad signature when signingKey set", async () => {
  const store: Store = new Map()
  const db = makeDb(store)
  const { res, out } = makeRes()
  await handleInboundEmail(
    inboundReq({
      recipient: "reply+deadbeefdeadbeefdeadbeefdeadbeef@mg.wekruit.com",
      sender: "candidate@example.com",
      subject: "x",
      "stripped-text": "hi",
      "Message-Id": "<m7@example.com>",
      timestamp: "123",
      token: "tok",
      signature: "not-the-real-sig",
    }),
    res,
    baseDeps(db, { signingKey: "secret-key" }),
  )
  assert.equal(out.code, 401)
})
