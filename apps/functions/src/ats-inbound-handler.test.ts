/**
 * v1.9 Phase 86 — ats-inbound-handler tests.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { handleAtsInbound } from "./ats-inbound-handler.js"
import type { CanonicalApplicant } from "./ats-adapters/types.js"

interface FakeDocState {
  exists: boolean
  data: Record<string, unknown>
}

function makeFakeDb() {
  const docs = new Map<string, FakeDocState>()
  const queryResults = new Map<string, Array<{ id: string; data: Record<string, unknown> }>>()
  const writes: Array<{ path: string; data: Record<string, unknown>; op: string }> = []
  let nextDocId = 1

  const fakeDb = {
    collection(coll: string) {
      return {
        doc(id?: string) {
          const docId = id ?? `auto_${nextDocId++}`
          const path = `${coll}/${docId}`
          return {
            id: docId,
            async get() {
              const st = docs.get(path) ?? { exists: false, data: {} }
              return {
                exists: st.exists,
                data: () => (st.exists ? st.data : undefined),
              }
            },
            async set(data: Record<string, unknown>) {
              docs.set(path, { exists: true, data })
              writes.push({ path, data, op: "set" })
            },
          }
        },
        where(field: string, _op: string, value: unknown) {
          const key = `${coll}|${field}=${value}`
          return {
            limit() {
              return {
                async get() {
                  const list = queryResults.get(key) ?? []
                  return {
                    empty: list.length === 0,
                    docs: list.map((d) => ({ id: d.id, data: () => d.data })),
                  }
                },
              }
            },
          }
        },
        async add(data: Record<string, unknown>) {
          const id = `add_${nextDocId++}`
          docs.set(`${coll}/${id}`, { exists: true, data })
          writes.push({ path: `${coll}/${id}`, data, op: "add" })
          return { id }
        },
      }
    },
  }
  return { db: fakeDb as never, docs, queryResults, writes }
}

const baseApplicant: CanonicalApplicant = {
  applicantId: "hs_app_1",
  jobIdExternal: "hs_job_1",
  name: "Alex Lee",
  email: "alex@school.edu",
  phone: "+14155550199",
  source: "handshake",
}

describe("handleAtsInbound — happy path (new user)", () => {
  it("creates user, resolves jobId, sends invite, stamps idempotency", async () => {
    const { db, docs, writes } = makeFakeDb()
    docs.set(`pa-jobs-external-mapping/handshake_hs_job_1`, {
      exists: true,
      data: { jobIdInternal: "job_internal_99" },
    })
    docs.set(`pa-jobs/job_internal_99`, {
      exists: true,
      data: { prescreenConfig: { jobTitle: "Senior FE", company: "Acme" } },
    })
    const audit: Array<Record<string, unknown>> = []
    const sent: Array<{ to: string; content: string }> = []
    const r = await handleAtsInbound(baseApplicant, {
      db,
      sendInvite: async (a) => {
        sent.push({ to: a.to, content: a.content })
        return { ok: true }
      },
      audit: async (e) => {
        audit.push(e)
      },
      now: () => 1_700_000_000_000,
    })
    assert.equal(r.kind, "ok")
    if (r.kind !== "ok") return
    assert.equal(r.jobIdInternal, "job_internal_99")
    assert.equal(sent.length, 1)
    assert.match(sent[0].content, /WeKruit/)
    assert.match(sent[0].content, /Senior FE/)
    assert.match(sent[0].content, /Acme/)
    assert.ok(writes.some((w) => w.path.startsWith("pa-ats-invite-idempotency/")))
    assert.ok(audit.some((a) => a.kind === "ats_inbound.invited"))
  })
})

describe("handleAtsInbound — 7d idempotency", () => {
  it("dedupes when prior invite within 7d", async () => {
    const { db, docs } = makeFakeDb()
    docs.set(`pa-jobs-external-mapping/handshake_hs_job_1`, {
      exists: true,
      data: { jobIdInternal: "job_internal_99" },
    })
    docs.set(`pa-ats-invite-idempotency/handshake_hs_job_1_hs_app_1`, {
      exists: true,
      data: { lastFiredMs: 1_700_000_000_000 - 3 * 24 * 60 * 60 * 1000 },
    })
    let sendCalled = false
    const r = await handleAtsInbound(baseApplicant, {
      db,
      sendInvite: async () => {
        sendCalled = true
        return { ok: true }
      },
      audit: async () => undefined,
      now: () => 1_700_000_000_000,
    })
    assert.equal(r.kind, "deduped")
    assert.equal(sendCalled, false)
  })
})

describe("handleAtsInbound — missing mapping", () => {
  it("returns no_internal_job when external→internal mapping absent", async () => {
    const { db } = makeFakeDb()
    const r = await handleAtsInbound(baseApplicant, {
      db,
      sendInvite: async () => ({ ok: true }),
      audit: async () => undefined,
    })
    assert.equal(r.kind, "no_internal_job")
  })
})

describe("handleAtsInbound — no phone", () => {
  it("rejects when phone is missing", async () => {
    const { db, docs } = makeFakeDb()
    docs.set(`pa-jobs-external-mapping/handshake_hs_job_1`, {
      exists: true,
      data: { jobIdInternal: "j99" },
    })
    docs.set(`pa-jobs/j99`, { exists: true, data: { prescreenConfig: {} } })
    const r = await handleAtsInbound(
      { ...baseApplicant, phone: undefined },
      {
        db,
        sendInvite: async () => ({ ok: true }),
        audit: async () => undefined,
        now: () => 1_700_000_000_000,
      }
    )
    assert.equal(r.kind, "rejected")
  })
})
