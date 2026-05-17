import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { WEKRUIT_LAYOFF_SOURCE } from "@pa/pa-orchestrator"
import { runLayoffSmsStart } from "../layoff-sms-start.js"

type FakeDocState = { exists: boolean; data: Record<string, unknown> }

function mergeFirestoreLike(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key]
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = mergeFirestoreLike(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      )
    } else {
      out[key] = value
    }
  }
  return out
}

function makeFakeDb(docs: Map<string, FakeDocState>) {
  const writes: Array<{ path: string; data: Record<string, unknown> }> = []
  function doc(path: string) {
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
          data: opts?.merge ? mergeFirestoreLike(state.data, data) : data,
        })
        writes.push({ path, data })
      },
      async update(data: Record<string, unknown>) {
        const state = docs.get(path) ?? { exists: true, data: {} }
        docs.set(path, {
          exists: true,
          data: { ...state.data, ...data },
        })
        writes.push({ path, data })
      },
    }
  }
  const db = {
    doc,
    collection(coll: string) {
      return {
        doc(id: string) {
          return doc(`${coll}/${id}`)
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
            workSession: {
              kind: "layoff_onboarding",
              status: "ended",
              endedAt: "old-ended-at",
              currentState: "complete",
            },
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
    const user = docs.get("pa-users/u1")!.data
    assert.deepEqual(user.workSession, {
      kind: "layoff_onboarding",
      status: "active",
      startedAt: (user.workSession as Record<string, unknown>).startedAt,
      boundary: "WeKruit_LAID_OFF",
    })
    assert.equal("endedAt" in (user.workSession as Record<string, unknown>), false)
    assert.equal("currentState" in (user.workSession as Record<string, unknown>), false)
    const phoneIndex = docs.get("layoff_phone_index/p_1juq7qe")?.data
    assert.equal(phoneIndex?.candidateId, "u1")
    assert.equal(phoneIndex?.phoneHash, "p_1juq7qe")
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
