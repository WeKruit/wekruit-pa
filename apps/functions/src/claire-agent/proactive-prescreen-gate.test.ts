/**
 * proactive-prescreen-gate.test.ts — 2026-06-10 trust audit (fix 8).
 *
 * "Prescreen owns the thread": runProactiveTurn must hard-gate (no compose,
 * no send) when the user has an OPEN prescreen work session — live evidence
 * showed proactive rec batches burying a screen between its opener and Q1.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { runProactiveTurn } from "./proactive.js"
import type { ClaireTransport } from "./types.js"

const NOW = Date.parse("2026-06-10T12:00:00Z")

function makeDb(userDoc: Record<string, unknown>) {
  const stores = new Map<string, Map<string, Record<string, unknown>>>()
  stores.set("pa-users", new Map([["u1", userDoc]]))
  function bucket(coll: string) {
    if (!stores.has(coll)) stores.set(coll, new Map())
    return stores.get(coll)!
  }
  const db = {
    collection(coll: string) {
      return {
        doc(id: string) {
          return {
            async get() {
              const d = bucket(coll).get(id)
              return { exists: d !== undefined, data: () => d, id }
            },
            async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
              if (opts?.merge) bucket(coll).set(id, { ...(bucket(coll).get(id) ?? {}), ...data })
              else bucket(coll).set(id, { ...data })
            },
            collection(sub: string) {
              return {
                doc(subId: string) {
                  const key = `${coll}/${id}/${sub}/${subId}`
                  return {
                    async get() {
                      const d = bucket("__sub__").get(key)
                      return { exists: d !== undefined, data: () => d }
                    },
                    async set(data: Record<string, unknown>) {
                      bucket("__sub__").set(key, data)
                    },
                  }
                },
                async get() {
                  return { docs: [], empty: true }
                },
              }
            },
          }
        },
      }
    },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      return fn({
        async get(ref: { get(): Promise<unknown> }) {
          return ref.get()
        },
        set() {},
        update() {},
      })
    },
  } as unknown as Firestore
  return db
}

function makeTransport(): { transport: ClaireTransport; sent: string[] } {
  const sent: string[] = []
  const transport = {
    async sendText(text: string) {
      sent.push(text)
    },
    async sendStatus() {},
    async typing() {},
    async noReply() {},
    async react() {},
  } as unknown as ClaireTransport
  return { transport, sent }
}

describe("runProactiveTurn — active-prescreen gate (fix 8)", () => {
  it("an OPEN prescreen work session blocks the proactive send before compose", async () => {
    const db = makeDb({
      workSession: {
        kind: "job_prescreen",
        status: "active",
        startedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
      },
    })
    const { transport, sent } = makeTransport()
    let composed = 0
    const out = await runProactiveTurn("u1", "follow_up", {
      db,
      transport,
      nowMs: () => NOW,
      composeCopy: async () => {
        composed++
        return ["hey, still looking?"]
      },
      log: () => {},
    })
    assert.equal(out.sent, false)
    assert.equal(out.reason, "active_prescreen")
    assert.equal(out.outboundCount, 0)
    assert.equal(composed, 0, "the LLM composer is never invoked")
    assert.equal(sent.length, 0, "nothing reached the transport")
  })

  it("an ENDED prescreen work session does NOT block (happy path unchanged)", async () => {
    const db = makeDb({
      workSession: {
        kind: "job_prescreen",
        status: "ended",
        endedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
      },
    })
    const { transport, sent } = makeTransport()
    const out = await runProactiveTurn("u1", "follow_up", {
      db,
      transport,
      nowMs: () => NOW,
      composeCopy: async () => ["hey, still looking?"],
      log: () => {},
    })
    assert.equal(out.sent, true)
    assert.equal(out.reason, "sent")
    assert.deepEqual(sent, ["hey, still looking?"])
  })

  it("a STALE (>48h) active session no longer owns the thread", async () => {
    const db = makeDb({
      updatedAt: new Date(NOW - 80 * 60 * 60 * 1000).toISOString(),
      workSession: {
        kind: "job_prescreen",
        status: "active",
        startedAt: new Date(NOW - 80 * 60 * 60 * 1000).toISOString(),
      },
    })
    const { transport } = makeTransport()
    const out = await runProactiveTurn("u1", "follow_up", {
      db,
      transport,
      nowMs: () => NOW,
      composeCopy: async () => ["checking in"],
      log: () => {},
    })
    assert.equal(out.sent, true, "no forever-suppression from an abandoned screen")
  })
})
