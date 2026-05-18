import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { enqueueOutbound, outboundMessageDocId } from "./outbound-queue.js"

function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>()
  const db = {
    collection(collectionName: string) {
      assert.equal(collectionName, PA_COLLECTIONS.outbound)
      return {
        doc(id: string) {
          return {
            async create(data: Record<string, unknown>) {
              if (docs.has(id)) {
                const error = new Error("already exists") as Error & { code?: number }
                error.code = 6
                throw error
              }
              docs.set(id, { ...data })
            },
          }
        },
      }
    },
  }
  return { db: db as unknown as Firestore, docs }
}

test("enqueueOutbound uses deterministic doc id and treats duplicate idempotencyKey as existing row", async () => {
  const { db, docs } = fakeFirestore()
  const input = {
    userId: "u_1",
    toE164: "+15555550123",
    body: "hello",
    idempotencyKey: "candidate:u_1:job:j_1:outreach",
    runtimeApproved: true as const,
    runtimeSource: "test_runtime",
  }

  const expectedId = outboundMessageDocId(input.idempotencyKey)

  assert.equal(outboundMessageDocId(input.idempotencyKey), expectedId)
  assert.match(expectedId, /^out_[0-9a-f]{40}$/)
  assert.deepEqual(await enqueueOutbound(db, input), { id: expectedId, created: true })
  assert.deepEqual(await enqueueOutbound(db, input), { id: expectedId, created: false })
  assert.equal(docs.size, 1)
  assert.equal(docs.get(expectedId)?.id, expectedId)
  assert.equal(docs.get(expectedId)?.idempotencyKey, input.idempotencyKey)
  assert.equal(docs.get(expectedId)?.runtimeApproved, true)
})

test("enqueueOutbound blocks legacy callers without runtime approval", async () => {
  const { db } = fakeFirestore()
  await assert.rejects(
    enqueueOutbound(db, {
      userId: "u_1",
      toE164: "+15555550123",
      body: "hello",
      idempotencyKey: "legacy",
    }),
    /outbound_requires_runtime_approval/
  )
})

test("enqueueOutbound blocks callers that self-stamp runtime approval with an unapproved source", async () => {
  const { db } = fakeFirestore()
  await assert.rejects(
    enqueueOutbound(db, {
      userId: "u_1",
      toE164: "+15555550123",
      body: "hello",
      idempotencyKey: "legacy-source",
      runtimeApproved: true,
      runtimeSource: "cv_ingest",
    }),
    /outbound_requires_approved_runtime_source/
  )
})

test("enqueueOutbound blocks retired proactive direct-send source", async () => {
  const { db } = fakeFirestore()
  await assert.rejects(
    enqueueOutbound(db, {
      userId: "u_1",
      toE164: "+15555550123",
      body: "legacy proactive text",
      idempotencyKey: "legacy-proactive",
      runtimeApproved: true,
      runtimeSource: "pa_proactive_turn",
    }),
    /outbound_requires_approved_runtime_source/
  )
})
