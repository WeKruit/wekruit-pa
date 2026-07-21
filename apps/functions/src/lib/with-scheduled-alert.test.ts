/**
 * with-scheduled-alert.ts unit tests.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { withScheduledAlert } from "./with-scheduled-alert.js"

function fakeNotify() {
  const calls: Array<{ level: string; title: string }> = []
  const notify = (async (input: { level: string; title: string }) => {
    calls.push({ level: input.level, title: input.title })
    return { slack: { posted: false, reason: "skipped" as const }, email: { ok: false, status: 0, reason: "test" }, deduped: false, anyDelivered: false }
  }) as never
  return { calls, notify }
}

/** Fake Firestore for the consecutive-fail counter. */
function fakeDb() {
  const store = new Map<string, { count?: number }>()
  const db = {
    collection() {
      return {
        doc(id: string) {
          return {
            id,
            async set(data: { count?: number }, _opts?: unknown) {
              store.set(id, { ...(store.get(id) ?? {}), ...data })
            },
          }
        },
      }
    },
    async runTransaction(fn: (tx: unknown) => Promise<number>) {
      const tx = {
        async get(ref: { id: string }) {
          const d = store.get(ref.id)
          return { exists: d !== undefined, data: () => d }
        },
        set(ref: { id: string }, data: { count?: number }) {
          store.set(ref.id, { ...(store.get(ref.id) ?? {}), ...data })
        },
      }
      return fn(tx)
    },
  } as unknown as import("firebase-admin/firestore").Firestore
  return { db, store }
}

describe("withScheduledAlert", () => {
  it("success → no alert, returns the result", async () => {
    const { calls, notify } = fakeNotify()
    const wrapped = withScheduledAlert("ok-job", async () => 42, { notify })
    assert.equal(await wrapped(), 42)
    assert.equal(calls.length, 0)
  })

  it("throw → error alert + RETHROW", async () => {
    const { calls, notify } = fakeNotify()
    const wrapped = withScheduledAlert("boom-job", async () => { throw new Error("kaboom") }, { notify })
    await assert.rejects(wrapped(), /kaboom/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].level, "error")
    assert.match(calls[0].title, /boom-job/)
  })

  it("partial-failure batch (resultErrors > 0) → warn alert, no throw", async () => {
    const { calls, notify } = fakeNotify()
    const wrapped = withScheduledAlert(
      "batch-job",
      async () => ({ processed: 100, errors: 7 }),
      { notify, resultErrors: (r) => r.errors },
    )
    const r = await wrapped()
    assert.equal(r.errors, 7)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].level, "warn")
  })

  it("consecutiveFailThreshold: alerts only on the Nth consecutive failure", async () => {
    const { calls, notify } = fakeNotify()
    const { db } = fakeDb()
    let attempt = 0
    const wrapped = withScheduledAlert(
      "flaky-job",
      async () => { attempt++; throw new Error(`fail-${attempt}`) },
      { notify, db, consecutiveFailThreshold: 3 },
    )
    await assert.rejects(wrapped()) // 1
    await assert.rejects(wrapped()) // 2
    assert.equal(calls.length, 0, "no alert below threshold")
    await assert.rejects(wrapped()) // 3 → alert
    assert.equal(calls.length, 1)
    assert.equal(calls[0].level, "error")
    assert.match(calls[0].title, /flaky-job/)
  })

  it("a success resets the consecutive-fail counter", async () => {
    const { calls, notify } = fakeNotify()
    const { db } = fakeDb()
    let mode: "fail" | "ok" = "fail"
    const wrapped = withScheduledAlert(
      "reset-job",
      async () => { if (mode === "fail") throw new Error("x"); return 1 },
      { notify, db, consecutiveFailThreshold: 2 },
    )
    await assert.rejects(wrapped()) // 1 (no alert)
    mode = "ok"
    await wrapped() // success → reset
    mode = "fail"
    await assert.rejects(wrapped()) // 1 again (counter reset → no alert)
    assert.equal(calls.length, 0)
  })
})
