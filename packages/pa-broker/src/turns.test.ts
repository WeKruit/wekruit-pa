import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { createAgentTurn } from "./turns.js"

/**
 * Bug 1 invariant tests for createAgentTurn.
 *
 * The broker writes pa-agent-turns rows with `sessionId`, `userId`, etc.
 * Firestore rejects any field whose value is `undefined`, producing the
 * cryptic
 *   "Cannot use \"undefined\" as a Firestore value (found in field X)".
 * Catching the missing identifier at the function entry produces a clear
 * engineering error instead — see Bug 1 RCA in turns.ts comment.
 */

function fakeDb(): Firestore {
  // Minimal shape — these tests intentionally never reach `.create()` because
  // the invariant should fire BEFORE any Firestore write.
  return {
    collection() {
      return {
        doc() {
          return {
            async create() { throw new Error("createAgentTurn invariant did NOT fire — Firestore write was reached") },
            async get() { return { exists: false, data: () => undefined } },
          }
        },
      }
    },
  } as unknown as Firestore
}

test("createAgentTurn throws when sessionId is undefined (Bug 1 invariant)", async () => {
  const db = fakeDb()
  await assert.rejects(
    () =>
      createAgentTurn(db, {
        inboundEventId: "inb_test",
        userId: "u_test",
        // @ts-expect-error — deliberately violating the type to assert runtime guard
        sessionId: undefined,
        agentId: "agent_test",
        idempotencyKey: "key_test",
      }),
    /sessionId is required/
  )
})

test("createAgentTurn throws when sessionId is empty string (Bug 1 invariant)", async () => {
  const db = fakeDb()
  await assert.rejects(
    () =>
      createAgentTurn(db, {
        inboundEventId: "inb_test",
        userId: "u_test",
        sessionId: "",
        agentId: "agent_test",
        idempotencyKey: "key_test",
      }),
    /sessionId is required/
  )
})

test("createAgentTurn throws when userId is undefined (Bug 1 invariant)", async () => {
  const db = fakeDb()
  await assert.rejects(
    () =>
      createAgentTurn(db, {
        inboundEventId: "inb_test",
        // @ts-expect-error — deliberately violating the type to assert runtime guard
        userId: undefined,
        sessionId: "ses_test",
        agentId: "agent_test",
        idempotencyKey: "key_test",
      }),
    /userId is required/
  )
})

test("createAgentTurn proceeds when both sessionId and userId are provided", async () => {
  // Use a richer fake that actually accepts the create() call so we can
  // confirm the invariant does NOT trigger on valid input.
  const docs = new Map<string, Record<string, unknown>>()
  const db = {
    collection() {
      return {
        doc(id: string) {
          return {
            async create(data: Record<string, unknown>) {
              if (docs.has(id)) {
                const e: Error & { code?: number } = new Error("AE")
                e.code = 6
                throw e
              }
              docs.set(id, { ...data })
            },
            async get() {
              const d = docs.get(id)
              return { exists: d !== undefined, data: () => d }
            },
          }
        },
      }
    },
  } as unknown as Firestore

  const turn = await createAgentTurn(db, {
    inboundEventId: "inb_ok",
    userId: "u_ok",
    sessionId: "ses_ok",
    agentId: "agent_ok",
    idempotencyKey: "key_ok",
  })
  assert.equal(turn.id, "turn_inb_ok")
  assert.equal(turn.userId, "u_ok")
  assert.equal(turn.sessionId, "ses_ok")
})
