import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { MockFirestore, asFirestore } from "../mock-firestore.js"
import { sendImessage } from "../../tools/send-imessage.js"

const STUB_USER_DEPS = (phone: string) => ({
  getUser: async (_db: Firestore, userId: string) =>
    userId === "missing"
      ? null
      : { id: userId, phoneE164: phone, channels: { imessageHandle: phone } },
})

function sessionDocId(userId: string, channel: string, externalChatId: string): string {
  const h = createHash("sha256").update(`${userId}|${channel}|${externalChatId}`).digest("hex")
  return `ses_${h.slice(0, 32)}`
}

async function seedSession(mfs: MockFirestore, userId: string, phone: string, sessionId?: string) {
  const id = sessionId ?? sessionDocId(userId, "imessage", phone)
  await mfs.collection("pa-sessions").doc(id).set({
    id,
    userId,
    channel: "imessage",
    externalChatId: phone,
    createdAt: "2026-04-30T00:00:00Z",
  })
}

test("sendImessage: enqueues a runtime event, not pa-outbound", async () => {
  const mfs = new MockFirestore()
  await seedSession(mfs, "u1", "+15551234567")
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
  assert.equal(mfs.writeLog.filter((w) => w.path === "pa-outbound").length, 0)
  const writes = mfs.writeLog.filter((w) => w.path === "pa-inbound-events")
  assert.equal(writes.length, 1)
  const data = writes[0]?.data as Record<string, unknown>
  assert.equal(data.userId, "u1")
  assert.equal(data.from, "+15551234567")
  assert.match(String(data.body), /system-event:job_rec:send_imessage/)
  assert.match(String(data.body), /hello world/)
  assert.equal(data.status, "pending")
  assert.equal((data.rawMeta as Record<string, unknown>).runtimeEvent, true)
  assert.ok(typeof data.idempotencyKey === "string")
})

test("sendImessage: dedupes by idempotencyKey (returns prev handle)", async () => {
  const mfs = new MockFirestore()
  await seedSession(mfs, "u1", "+15551111111")
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
  // Only ONE pa-inbound-events write — the second was a dedup hit.
  const writes = mfs.writeLog.filter((w) => w.path === "pa-inbound-events")
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

test("sendImessage: passes sessionId through to the runtime event", async () => {
  const mfs = new MockFirestore()
  await seedSession(mfs, "u1", "+15551112222", "s-123")
  await sendImessage(
    { userId: "u1", content: "hi", sessionId: "s-123" },
    { db: asFirestore(mfs), ...STUB_USER_DEPS("+15551112222") }
  )
  const w = mfs.writeLog.filter((w) => w.path === "pa-inbound-events")[0]
  assert.equal(w?.data.sessionId, "s-123")
})

test("sendImessage: blocks runtime handoff when no prior session exists", async () => {
  const mfs = new MockFirestore()
  const out = await sendImessage(
    { userId: "u1", content: "hi" },
    { db: asFirestore(mfs), ...STUB_USER_DEPS("+15551112222") }
  )
  assert.equal(out.ok, false)
  assert.equal(mfs.writeLog.filter((w) => w.path === "pa-inbound-events").length, 0)
  assert.equal(mfs.writeLog.filter((w) => w.path === "pa-outbound").length, 0)
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
