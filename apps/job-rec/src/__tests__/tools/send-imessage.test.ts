import test from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { MockFirestore, asFirestore } from "../mock-firestore.js"
import { sendImessage } from "../../tools/send-imessage.js"

const STUB_USER_DEPS = (phone: string) => ({
  getUser: async (_db: Firestore, userId: string) =>
    userId === "missing"
      ? null
      : { id: userId, phoneE164: phone, channels: { imessageHandle: phone } },
})

test("sendImessage: enqueues a pa-outbound doc with required fields", async () => {
  const mfs = new MockFirestore()
  const out = await sendImessage(
    { userId: "u1", content: "hello world" },
    {
      db: asFirestore(mfs),
      nowIso: () => "2026-04-30T00:00:00Z",
      ...STUB_USER_DEPS("+15551234567"),
    }
  )
  assert.equal(out.ok, true)
  assert.ok(out.messageHandle)
  const writes = mfs.writeLog.filter((w) => w.path === "pa-outbound")
  assert.equal(writes.length, 1)
  const data = writes[0]?.data as Record<string, unknown>
  assert.equal(data.userId, "u1")
  assert.equal(data.toE164, "+15551234567")
  assert.equal(data.body, "hello world")
  assert.equal(data.status, "pending")
  assert.equal(data.role, "assistant")
  assert.ok(typeof data.idempotencyKey === "string")
})

test("sendImessage: dedupes by idempotencyKey (returns prev handle)", async () => {
  const mfs = new MockFirestore()
  const args = {
    userId: "u1",
    content: "hi",
    idempotencyKey: "u1-20260430-batch",
  }
  const first = await sendImessage(args, {
    db: asFirestore(mfs),
    ...STUB_USER_DEPS("+15551111111"),
  })
  const second = await sendImessage(args, {
    db: asFirestore(mfs),
    ...STUB_USER_DEPS("+15551111111"),
  })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.messageHandle, first.messageHandle)
  // Only ONE pa-outbound write — the second was a dedup hit.
  const writes = mfs.writeLog.filter((w) => w.path === "pa-outbound")
  assert.equal(writes.length, 1)
})

test("sendImessage: returns ok=false when user lookup misses", async () => {
  const mfs = new MockFirestore()
  const out = await sendImessage(
    { userId: "missing", content: "x" },
    { db: asFirestore(mfs), ...STUB_USER_DEPS("+15550000000") }
  )
  assert.equal(out.ok, false)
  assert.equal(mfs.writeLog.length, 0)
})

test("sendImessage: returns ok=false when user has no phone", async () => {
  const mfs = new MockFirestore()
  const out = await sendImessage(
    { userId: "u1", content: "x" },
    {
      db: asFirestore(mfs),
      getUser: async () => ({ id: "u1", phoneE164: "", channels: undefined }),
    }
  )
  assert.equal(out.ok, false)
})

test("sendImessage: passes sessionId through to the outbound doc", async () => {
  const mfs = new MockFirestore()
  await sendImessage(
    { userId: "u1", content: "hi", sessionId: "s-123" },
    { db: asFirestore(mfs), ...STUB_USER_DEPS("+15551112222") }
  )
  const w = mfs.writeLog.filter((w) => w.path === "pa-outbound")[0]
  assert.equal(w?.data.sessionId, "s-123")
})

test("sendImessage: rejects content > 2000 chars (Zod)", async () => {
  const mfs = new MockFirestore()
  await assert.rejects(
    sendImessage(
      { userId: "u1", content: "x".repeat(2001) },
      { db: asFirestore(mfs), ...STUB_USER_DEPS("+15551112222") }
    )
  )
})
