import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { prescreenTurnRecordQId, runPrescreenTurnIfActive } from "./prescreen-turn-handler.js"

type FakeDoc = { exists: boolean; data: Record<string, unknown> }

function makeFakeDb(seed: Record<string, Record<string, unknown>>) {
  const docs = new Map<string, FakeDoc>()
  for (const [path, data] of Object.entries(seed)) docs.set(path, { exists: true, data })

  function docRef(collection: string, id: string) {
    const path = `${collection}/${id}`
    return {
      id,
      async get() {
        const doc = docs.get(path) ?? { exists: false, data: {} }
        return { exists: doc.exists, data: () => (doc.exists ? doc.data : undefined) }
      },
      async set(data: Record<string, unknown>, options?: unknown) {
        const prev = docs.get(path)
        const merge = Boolean((options as { merge?: boolean } | undefined)?.merge)
        docs.set(path, { exists: true, data: merge ? { ...(prev?.data ?? {}), ...data } : data })
      },
    }
  }

  const db = {
    collection(collection: string) {
      const filters: Array<{ field: string; value: unknown }> = []
      let limitCount = Number.POSITIVE_INFINITY
      const query = {
        where(field: string, _op: string, value: unknown) {
          filters.push({ field, value })
          return query
        },
        orderBy() {
          return query
        },
        limit(value: number) {
          limitCount = value
          return query
        },
        async get() {
          const out = []
          for (const [path, doc] of docs.entries()) {
            if (!path.startsWith(`${collection}/`) || !doc.exists) continue
            if (filters.every((f) => doc.data[f.field] === f.value)) {
              const id = path.slice(collection.length + 1)
              out.push({ id, data: () => doc.data, ref: docRef(collection, id) })
            }
          }
          return { empty: out.length === 0, docs: out.slice(0, limitCount) }
        },
      }
      return {
        doc(id: string) {
          return docRef(collection, id)
        },
        where: query.where,
      }
    },
  }

  return { db: db as never, docs }
}

describe("runPrescreenTurnIfActive session boundaries", () => {
  it("records a candidate reply against the question that was active before the turn", () => {
    assert.equal(prescreenTurnRecordQId({ kind: "clarify", qId: "role_fit", kAfter: 1 }, "role_fit"), "role_fit")
    assert.equal(
      prescreenTurnRecordQId({ kind: "advance", fromQId: "role_fit", toQId: "technical_depth" }, "role_fit"),
      "role_fit",
    )
    assert.equal(
      prescreenTurnRecordQId({ kind: "terminal", terminal: "HARD_STOP", reason: "type_gate_fail" }, "role_fit"),
      "role_fit",
    )
    assert.equal(prescreenTurnRecordQId({ kind: "error", reason: "session_not_found" }, null), "terminal")
  })

  it("expires idle prescreen sessions instead of routing a late reply into the old job", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_old": {
        sessionId: "ps_old",
        userId: "u1",
        jobId: "job-old",
        terminal: null,
        currentQId: "role_fit",
        createdAt: twoHoursAgo,
        updatedAt: twoHoursAgo,
        workSession: { kind: "job_prescreen", status: "active", startedAt: twoHoursAgo, boundary: "trigger" },
      },
    })

    const terminalCalls: Array<Record<string, unknown>> = []
    const sent: string[] = []

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "following up later",
      runTerminalAction: async (args) => {
        terminalCalls.push(args as unknown as Record<string, unknown>)
        return { alreadyFired: false, level1Sent: false, jobRecsFired: false }
      },
      sendSms: async (args) => {
        sent.push(args.content)
        return {
          status: "queued",
          from_number: null,
          number: args.to,
          content: args.content,
          service: "iMessage",
          is_outbound: true,
        }
      },
    })

    assert.equal(result.handled, true)
    assert.equal(result.terminal, "PAUSE")
    assert.equal(terminalCalls.length, 1)
    assert.equal(terminalCalls[0].terminal, "PAUSE")
    assert.equal(terminalCalls[0].jobId, "job-old")
    assert.equal(sent.length, 1)
    assert.match(sent[0], /paused this role screen/)
    const session = docs.get("pa-prescreen-sessions/ps_old")?.data
    assert.equal(session?.terminal, "PAUSE")
    assert.equal(session?.terminalReason, "expired_inactive_prescreen_session")
    assert.equal((session?.workSession as { boundary?: string }).boundary, "timeout")
  })
})
