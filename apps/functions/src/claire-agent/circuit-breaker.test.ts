/**
 * circuit-breaker.test.ts — 2026-06-10 trust audit (fix 6).
 *
 * (a) per-instance breaker: 3 run failures within 60s → fast-fail (no LLM)
 *     until the window passes. Module/instance-local by design.
 * (b) per-user escalation: a user whose PREVIOUS turn also hiccupped gets the
 *     honest "give me a few minutes" copy instead of identical retry-bait.
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import {
  noteClaireRunFailure,
  isClaireCircuitOpen,
  resetClaireRunFailures,
  resolveHiccupFallbackCopy,
  CLAIRE_HICCUP_COPY,
  CLAIRE_HICCUP_ESCALATED_COPY,
} from "./agent.js"

const T0 = Date.parse("2026-06-10T12:00:00Z")

beforeEach(() => resetClaireRunFailures())

describe("fix 6a — per-instance LLM-failure circuit breaker", () => {
  it("stays CLOSED below 3 failures", () => {
    noteClaireRunFailure(T0)
    noteClaireRunFailure(T0 + 1000)
    assert.equal(isClaireCircuitOpen(T0 + 2000), false)
  })

  it("OPENS at 3 failures within 60s", () => {
    noteClaireRunFailure(T0)
    noteClaireRunFailure(T0 + 5_000)
    noteClaireRunFailure(T0 + 10_000)
    assert.equal(isClaireCircuitOpen(T0 + 11_000), true)
  })

  it("CLOSES again once the 60s window passes", () => {
    noteClaireRunFailure(T0)
    noteClaireRunFailure(T0 + 5_000)
    noteClaireRunFailure(T0 + 10_000)
    assert.equal(isClaireCircuitOpen(T0 + 30_000), true, "still open mid-window")
    assert.equal(isClaireCircuitOpen(T0 + 71_000), false, "window passed → closed")
  })

  it("failures spread WIDER than 60s never open it", () => {
    noteClaireRunFailure(T0)
    noteClaireRunFailure(T0 + 40_000)
    noteClaireRunFailure(T0 + 80_000)
    assert.equal(isClaireCircuitOpen(T0 + 81_000), false)
  })
})

describe("fix 6b — per-user escalating hiccup copy", () => {
  function fakeDb(initialUser: Record<string, unknown> | null, opts?: { throwOnGet?: boolean }) {
    const store = new Map<string, Record<string, unknown>>()
    if (initialUser) store.set("u1", initialUser)
    const db = {
      collection: () => ({
        doc: (id: string) => ({
          async get() {
            if (opts?.throwOnGet) throw new Error("read down")
            const data = store.get(id)
            return { exists: data !== undefined, data: () => data }
          },
          async set(data: Record<string, unknown>, o?: { merge?: boolean }) {
            store.set(id, o?.merge ? { ...(store.get(id) ?? {}), ...data } : { ...data })
          },
        }),
      }),
    } as unknown as Firestore
    return { db, store }
  }

  it("FIRST hiccup → base copy, and the stamp is persisted", async () => {
    const { db, store } = fakeDb({ id: "u1" })
    const copy = await resolveHiccupFallbackCopy(db, "u1", T0, () => {})
    assert.equal(copy, CLAIRE_HICCUP_COPY)
    const hiccup = store.get("u1")!.claireHiccup as { lastAt: string; count: number }
    assert.equal(hiccup.lastAt, new Date(T0).toISOString())
    assert.equal(hiccup.count, 1)
  })

  it("previous turn ALSO hiccupped (within 10min) → escalated copy + count bumped", async () => {
    const { db, store } = fakeDb({
      id: "u1",
      claireHiccup: { lastAt: new Date(T0 - 2 * 60_000).toISOString(), count: 1 },
    })
    const copy = await resolveHiccupFallbackCopy(db, "u1", T0, () => {})
    assert.equal(copy, CLAIRE_HICCUP_ESCALATED_COPY)
    assert.equal((store.get("u1")!.claireHiccup as { count: number }).count, 2)
  })

  it("an OLD hiccup (outside the window) → base copy again", async () => {
    const { db } = fakeDb({
      id: "u1",
      claireHiccup: { lastAt: new Date(T0 - 60 * 60_000).toISOString(), count: 4 },
    })
    const copy = await resolveHiccupFallbackCopy(db, "u1", T0, () => {})
    assert.equal(copy, CLAIRE_HICCUP_COPY)
  })

  it("NEVER throws — db read error degrades to base copy + logs", async () => {
    const { db } = fakeDb(null, { throwOnGet: true })
    const events: string[] = []
    const copy = await resolveHiccupFallbackCopy(db, "u1", T0, (e) => events.push(e))
    assert.equal(copy, CLAIRE_HICCUP_COPY)
    assert.deepEqual(events, ["claire_hiccup_stamp_failed"])
  })

  it("the escalated copy is the locked honest line (no identical retry-bait)", () => {
    assert.equal(
      CLAIRE_HICCUP_ESCALATED_COPY,
      "i'm having trouble on my end right now — give me a few minutes and try again? i'll be here.",
    )
    assert.notEqual(CLAIRE_HICCUP_COPY, CLAIRE_HICCUP_ESCALATED_COPY)
  })
})
