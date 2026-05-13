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
  }

  const expectedId = outboundMessageDocId(input.idempotencyKey)

  assert.equal(outboundMessageDocId(input.idempotencyKey), expectedId)
  assert.match(expectedId, /^out_[0-9a-f]{40}$/)
  assert.deepEqual(await enqueueOutbound(db, input), { id: expectedId, created: true })
  assert.deepEqual(await enqueueOutbound(db, input), { id: expectedId, created: false })
  assert.equal(docs.size, 1)
  assert.equal(docs.get(expectedId)?.id, expectedId)
  assert.equal(docs.get(expectedId)?.idempotencyKey, input.idempotencyKey)
})
