/**
 * prescreen-guard.test.ts — 2026-06-10 trust audit (fix 8, "prescreen owns the thread").
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import {
  hasOpenPrescreenWorkSession,
  userHasOpenPrescreen,
  OPEN_PRESCREEN_WINDOW_MS,
} from "../prescreen-guard.js"

const NOW = Date.parse("2026-06-10T12:00:00Z")
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

describe("hasOpenPrescreenWorkSession (pure)", () => {
  it("true for an active job_prescreen work session started within 48h", () => {
    const user = {
      workSession: { kind: "job_prescreen", status: "active", startedAt: iso(60 * 60 * 1000) },
    }
    assert.equal(hasOpenPrescreenWorkSession(user, NOW), true)
  })

  it("false when the work session ENDED (terminal fired)", () => {
    const user = {
      workSession: { kind: "job_prescreen", status: "ended", startedAt: iso(60 * 60 * 1000) },
    }
    assert.equal(hasOpenPrescreenWorkSession(user, NOW), false)
  })

  it("false for non-prescreen work sessions (shared_onboarding)", () => {
    const user = {
      workSession: { kind: "shared_onboarding", status: "active", startedAt: iso(1000) },
    }
    assert.equal(hasOpenPrescreenWorkSession(user, NOW), false)
  })

  it("false when the active session is STALE (>48h) — no forever-suppression", () => {
    const user = {
      workSession: {
        kind: "job_prescreen",
        status: "active",
        startedAt: iso(OPEN_PRESCREEN_WINDOW_MS + 60_000),
      },
      updatedAt: iso(OPEN_PRESCREEN_WINDOW_MS + 60_000),
    }
    assert.equal(hasOpenPrescreenWorkSession(user, NOW), false)
  })

  it("a fresh user-doc updatedAt keeps a long-running screen owning the thread", () => {
    const user = {
      workSession: {
        kind: "job_prescreen",
        status: "active",
        startedAt: iso(OPEN_PRESCREEN_WINDOW_MS + 60_000),
      },
      updatedAt: iso(30 * 60 * 1000),
    }
    assert.equal(hasOpenPrescreenWorkSession(user, NOW), true)
  })

  it("false for null/missing user or workSession", () => {
    assert.equal(hasOpenPrescreenWorkSession(null, NOW), false)
    assert.equal(hasOpenPrescreenWorkSession({}, NOW), false)
    assert.equal(
      hasOpenPrescreenWorkSession({ workSession: { kind: "job_prescreen", status: "active" } }, NOW),
      false,
      "no timestamps at all → cannot prove freshness → false",
    )
  })
})

describe("userHasOpenPrescreen (db wrapper)", () => {
  function fakeDb(doc: Record<string, unknown> | null, opts?: { throwOnGet?: boolean }) {
    return {
      collection: () => ({
        doc: () => ({
          async get() {
            if (opts?.throwOnGet) throw new Error("boom")
            return { exists: doc !== null, data: () => doc ?? undefined }
          },
        }),
      }),
    } as unknown as Firestore
  }

  it("true when the user doc carries a fresh active prescreen work session", async () => {
    const db = fakeDb({
      workSession: { kind: "job_prescreen", status: "active", startedAt: iso(1000) },
    })
    assert.equal(await userHasOpenPrescreen(db, "u1", NOW), true)
  })

  it("false for a missing user doc", async () => {
    assert.equal(await userHasOpenPrescreen(fakeDb(null), "u1", NOW), false)
  })

  it("FAIL-OPEN: read error returns false (send proceeds)", async () => {
    const events: string[] = []
    const db = fakeDb(null, { throwOnGet: true })
    const out = await userHasOpenPrescreen(db, "u1", NOW, (e) => events.push(e))
    assert.equal(out, false)
    assert.deepEqual(events, ["pa.prescreen_guard.read_failed"])
  })

  it("false for an empty userId without touching the db", async () => {
    const db = fakeDb(null, { throwOnGet: true })
    assert.equal(await userHasOpenPrescreen(db, "", NOW), false)
  })
})
