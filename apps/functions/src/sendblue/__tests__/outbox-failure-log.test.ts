/**
 * Stream H4 D4 — structured pa.outbound.failed log test.
 *
 * Verifies that when paSendblueOutboxHandler flips a row to status="failed"
 * (in this case via the user-not-found path), it emits a structured
 * Cloud Logging event "pa.outbound.failed" with severity ERROR and the
 * fields that the alert metric (scripts/setup-failure-alert.sh) consumes.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { paSendblueOutboxHandler } from "../outbox.js"

type DocData = Record<string, unknown>

function makeFakeDb(initial: Record<string, DocData> = {}, users: Record<string, DocData> = {}) {
  const outbound = new Map<string, DocData>(Object.entries(initial))
  const usersMap = new Map<string, DocData>(Object.entries(users))
  const flags = new Map<string, DocData>()
  const outboundDaily = new Map<string, DocData>()

  function pickStore(coll: string): Map<string, DocData> {
    switch (coll) {
      case "pa-outbound": return outbound
      case "pa-feature-flags": return flags
      case "pa-outbound-daily": return outboundDaily
      default: return usersMap
    }
  }

  function makeDocRef(coll: string, id: string) {
    const store = pickStore(coll)
    return {
      _store: store,
      _id: id,
      async get() {
        const data = store.get(id)
        return { exists: data !== undefined, data: () => data, id }
      },
      async set(data: DocData, opts?: { merge?: boolean }) {
        if (opts?.merge) store.set(id, { ...(store.get(id) ?? {}), ...data })
        else store.set(id, { ...data })
      },
      async update(data: DocData) {
        store.set(id, { ...(store.get(id) ?? {}), ...data })
      },
    }
  }

  const db = {
    collection(name: string) {
      return {
        doc: (id: string) => makeDocRef(name, id),
        add() { return Promise.resolve({ id: "x" }) },
        where() { return this },
        limit() { return this },
        async get() { return { empty: true, docs: [], size: 0 } },
      }
    },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const tx = {
        async get(ref: { get(): Promise<{ exists: boolean; data: () => DocData | undefined; id: string }> }) {
          return ref.get()
        },
        update(ref: { _store?: Map<string, DocData>; _id?: string }, data: DocData) {
          if (ref._store && ref._id) ref._store.set(ref._id, { ...(ref._store.get(ref._id) ?? {}), ...data })
        },
        set(ref: { _store?: Map<string, DocData>; _id?: string }, data: DocData) {
          if (ref._store && ref._id) ref._store.set(ref._id, { ...data })
        },
      }
      return fn(tx)
    },
  }
  return { db, outbound, users: usersMap }
}

function makeEvent(docId: string, data: DocData) {
  return { params: { docId }, data: { data: () => data, id: docId } }
}

describe("pa.outbound.failed structured log (Stream H4 D4)", () => {
  it("user-not-found path emits pa.outbound.failed with required fields", async () => {
    // Setup an in-flight pending row
    const baseRow: DocData = {
      status: "pending",
      userId: "u-missing",
      toE164: "+15551234567",
      body: "this should fail because user does not exist",
      idempotencyKey: "out-test-failure-log",
      createdAt: new Date().toISOString(),
      attemptCount: 2,
      runtimeApproved: true,
    }
    const { db } = makeFakeDb({ "doc-fail-1": baseRow })

    const events: Array<{ event: string; payload: unknown }> = []
    const log: (...args: unknown[]) => void = (...args: unknown[]) => {
      events.push({ event: String(args[0] ?? ""), payload: args[1] })
    }

    // Disable allowlist so the test reaches user-not-found path.
    // useDmAllowlist() default-enables unless DM_ALLOWLIST="0".
    const prevAllowlist = process.env.IMESSAGE_DM_ALLOWLIST
    process.env.IMESSAGE_DM_ALLOWLIST = "0"

    try {
      await paSendblueOutboxHandler(makeEvent("doc-fail-1", baseRow) as never, {
        db: db as never,
        sendblueClient: {
          sendImessage: async () => { throw new Error("should not be called") },
          sendTypingIndicator: async () => {},
        },
        now: () => new Date("2026-05-01T22:00:00.000Z"),
        log,
        getUser: async () => null, // user not found
        getOrCreateSession: async () => ({ id: "s-1" } as never),
        appendMessage: async () => {},
      })
    } finally {
      if (prevAllowlist != null) process.env.IMESSAGE_DM_ALLOWLIST = prevAllowlist
      else delete process.env.IMESSAGE_DM_ALLOWLIST
    }

    const failureEvents = events.filter((e) => e.event === "pa.outbound.failed")
    assert.equal(failureEvents.length, 1, "exactly one pa.outbound.failed log emitted")
    const payload = failureEvents[0].payload as Record<string, unknown>
    assert.equal(payload.severity, "ERROR")
    assert.equal(payload.docId, "doc-fail-1")
    assert.equal(payload.userId, "u-missing")
    assert.equal(payload.idempotencyKey, "out-test-failure-log")
    assert.equal(payload.lastError, "user not found")
    assert.equal(payload.attempts, 2, "attemptCount preserved in log")
    assert.equal(payload.terminalStatus, "failed")
    assert.match(String(payload.body_preview ?? ""), /user does not exist/)
  })
})
