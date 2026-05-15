import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { WEKRUIT_LAYOFF_SOURCE } from "@pa/pa-orchestrator"
import { runLayoffSmsStart } from "../layoff-sms-start.js"

type FakeDocState = { exists: boolean; data: Record<string, unknown> }

function makeFakeDb(docs: Map<string, FakeDocState>) {
  const writes: Array<{ path: string; data: Record<string, unknown> }> = []
  const db = {
    collection(coll: string) {
      return {
        doc(id: string) {
          const path = `${coll}/${id}`
          return {
            async get() {
              const state = docs.get(path) ?? { exists: false, data: {} }
              return {
                exists: state.exists,
                data: () => (state.exists ? state.data : undefined),
              }
            },
            async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
              const state = docs.get(path) ?? { exists: true, data: {} }
              docs.set(path, {
                exists: true,
                data: opts?.merge ? { ...state.data, ...data } : data,
              })
              writes.push({ path, data })
            },
          }
        },
      }
    },
  }
  return { db: db as never, writes, docs }
}

describe("runLayoffSmsStart", () => {
  it("updates the existing pa-user source and enqueues the shared Claire opener", async () => {
    const docs = new Map<string, FakeDocState>([
      [
        "pa-users/u1",
        {
          exists: true,
          data: {
            displayName: "Ada Lovelace",
            phoneE164: "+13054507715",
            layoffContext: { lastCompany: "Rain" },
          },
        },
      ],
    ])
    const { db, writes } = makeFakeDb(docs)
    const enqueued: Array<Record<string, unknown>> = []

    const result = await runLayoffSmsStart({
      db,
      userId: "u1",
      toE164: "+13054507715",
      enqueueOutbound: async (_db, input) => {
        enqueued.push(input)
        return { id: "out_layoff", created: true }
      },
    })

    assert.deepEqual(result, {
      ok: true,
      kickoffOutboundId: "out_layoff",
      kickoffCreated: true,
      sourceTag: WEKRUIT_LAYOFF_SOURCE,
    })
    assert.equal(enqueued[0].userId, "u1")
    assert.equal(enqueued[0].idempotencyKey, "wekruit_open_layoff:u1:kickoff")
    assert.match(String(enqueued[0].body), /Claire from WeKruit/)
    assert.equal(writes[0].path, "pa-users/u1")
    assert.equal(writes[0].data.source, WEKRUIT_LAYOFF_SOURCE)
    assert.equal((writes[0].data.layoffContext as Record<string, unknown>).phoneE164, "+13054507715")
  })

  it("does not create a user when no pa-user exists for the phone-resolved id", async () => {
    const { db, writes } = makeFakeDb(new Map())
    const result = await runLayoffSmsStart({
      db,
      userId: "missing",
      toE164: "+13054507715",
      enqueueOutbound: async () => {
        throw new Error("must not enqueue")
      },
    })

    assert.deepEqual(result, { ok: false, reason: "user_not_found" })
    assert.equal(writes.length, 0)
  })
})
