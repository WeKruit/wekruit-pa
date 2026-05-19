import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  SHARED_ONBOARDING_SLANG_PICK_CAP,
  extractRecentSlangPicks,
  persistSharedOnboardingSlangPicks,
} from "../shared-onboarding-outbound.js"

describe("extractRecentSlangPicks", () => {
  it("returns [] for null / undefined user", () => {
    assert.deepEqual(extractRecentSlangPicks(null), [])
    assert.deepEqual(extractRecentSlangPicks({ sharedOnboarding: null }), [])
  })

  it("returns [] when sharedOnboarding.voice is missing or non-object", () => {
    assert.deepEqual(extractRecentSlangPicks({ sharedOnboarding: {} }), [])
    assert.deepEqual(
      extractRecentSlangPicks({ sharedOnboarding: { voice: "bogus" as unknown as Record<string, unknown> } }),
      [],
    )
  })

  it("returns [] when recentSlangPicks is missing or not an array", () => {
    assert.deepEqual(
      extractRecentSlangPicks({ sharedOnboarding: { voice: {} } }),
      [],
    )
    assert.deepEqual(
      extractRecentSlangPicks({
        sharedOnboarding: { voice: { recentSlangPicks: "deadass" } },
      }),
      [],
    )
  })

  it("returns string entries in order, dropping non-strings / empties / cap overflow", () => {
    const mixed = [
      "deadass",
      "",
      42,
      "no cap",
      null,
      "fr",
      undefined,
      "lowkey",
      "wild",
      "vibes",
      "slaps",
      "bet",
      "based",
      "valid",
      "lit",
      "rizz",
      "side eye", // 13th — beyond cap, must drop
    ]
    const out = extractRecentSlangPicks({
      sharedOnboarding: { voice: { recentSlangPicks: mixed } },
    })
    assert.equal(out.length, SHARED_ONBOARDING_SLANG_PICK_CAP)
    assert.equal(out[0], "deadass")
    assert.equal(out.at(-1), "rizz")
    assert.ok(!out.includes("side eye"))
  })
})

describe("persistSharedOnboardingSlangPicks", () => {
  it("returns merged list and writes merge payload", async () => {
    const writes: Array<{ docPath: string; payload: Record<string, unknown>; merge: boolean }> = []
    const db = makeFakeDb(writes)

    const next = await persistSharedOnboardingSlangPicks({
      db,
      userId: "u1",
      priorPicks: ["deadass", "no cap"],
      newPicks: ["fr", "lowkey"],
      nowIso: "2026-05-19T20:00:00.000Z",
    })

    assert.deepEqual(next, ["deadass", "no cap", "fr", "lowkey"])
    assert.equal(writes.length, 1)
    assert.equal(writes[0].docPath, "pa-users/u1")
    assert.equal(writes[0].merge, true)
    const so = writes[0].payload.sharedOnboarding as Record<string, unknown>
    const voice = so.voice as Record<string, unknown>
    assert.deepEqual(voice.recentSlangPicks, ["deadass", "no cap", "fr", "lowkey"])
    assert.equal(voice.updatedAt, "2026-05-19T20:00:00.000Z")
  })

  it("dedupes overlapping picks while preserving order", async () => {
    const writes: Array<{ docPath: string; payload: Record<string, unknown>; merge: boolean }> = []
    const db = makeFakeDb(writes)

    const next = await persistSharedOnboardingSlangPicks({
      db,
      userId: "u1",
      priorPicks: ["deadass", "no cap"],
      newPicks: ["no cap", "fr"], // "no cap" repeats — must not duplicate
      nowIso: "2026-05-19T20:00:00.000Z",
    })

    assert.deepEqual(next, ["deadass", "no cap", "fr"])
    assert.equal(writes.length, 1)
  })

  it("FIFO-caps at 12, dropping oldest entries when overflow occurs", async () => {
    const writes: Array<{ docPath: string; payload: Record<string, unknown>; merge: boolean }> = []
    const db = makeFakeDb(writes)

    const prior = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"] // 11
    const fresh = ["l", "m", "n"] // pushes to 14 before cap

    const next = await persistSharedOnboardingSlangPicks({
      db,
      userId: "u1",
      priorPicks: prior,
      newPicks: fresh,
      nowIso: "2026-05-19T20:00:00.000Z",
    })

    assert.equal(next.length, SHARED_ONBOARDING_SLANG_PICK_CAP)
    assert.equal(next[0], "c") // "a" and "b" dropped
    assert.equal(next.at(-1), "n")
  })

  it("returns [] and does not write when there are no picks at all", async () => {
    const writes: Array<{ docPath: string; payload: Record<string, unknown>; merge: boolean }> = []
    const db = makeFakeDb(writes)

    const next = await persistSharedOnboardingSlangPicks({
      db,
      userId: "u1",
      priorPicks: [],
      newPicks: [],
      nowIso: "2026-05-19T20:00:00.000Z",
    })

    assert.deepEqual(next, [])
    assert.equal(writes.length, 0)
  })

  it("skips write when merged list is identical to prior list (no-op)", async () => {
    const writes: Array<{ docPath: string; payload: Record<string, unknown>; merge: boolean }> = []
    const db = makeFakeDb(writes)

    const next = await persistSharedOnboardingSlangPicks({
      db,
      userId: "u1",
      priorPicks: ["deadass", "no cap"],
      newPicks: ["deadass", "no cap"], // both already in FIFO — nothing new
      nowIso: "2026-05-19T20:00:00.000Z",
    })

    assert.deepEqual(next, ["deadass", "no cap"])
    assert.equal(writes.length, 0)
  })

  it("returns merged list and logs but does not throw when db.set() fails", async () => {
    const logs: Array<{ name: string; payload?: Record<string, unknown> }> = []
    const db = {
      collection: () => ({
        doc: () => ({
          set: async () => {
            throw new Error("simulated firestore outage")
          },
        }),
      }),
    } as unknown as Parameters<typeof persistSharedOnboardingSlangPicks>[0]["db"]

    const next = await persistSharedOnboardingSlangPicks({
      db,
      userId: "u1",
      priorPicks: [],
      newPicks: ["deadass"],
      nowIso: "2026-05-19T20:00:00.000Z",
      log: (name, payload) => logs.push({ name, payload }),
    })

    assert.deepEqual(next, ["deadass"])
    assert.equal(logs.length, 1)
    assert.equal(logs[0].name, "pa.shared_onboarding.voice.persist_failed")
    assert.equal(logs[0].payload?.userId, "u1")
  })

  it("returns merged list (no write) when db is undefined", async () => {
    const next = await persistSharedOnboardingSlangPicks({
      db: undefined,
      userId: "u1",
      priorPicks: ["deadass"],
      newPicks: ["fr"],
      nowIso: "2026-05-19T20:00:00.000Z",
    })

    assert.deepEqual(next, ["deadass", "fr"])
  })
})

function makeFakeDb(writes: Array<{ docPath: string; payload: Record<string, unknown>; merge: boolean }>) {
  return {
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            async set(payload: Record<string, unknown>, opts?: { merge?: boolean }) {
              writes.push({ docPath: `${name}/${id}`, payload, merge: opts?.merge === true })
            },
          }
        },
      }
    },
  } as unknown as Parameters<typeof persistSharedOnboardingSlangPicks>[0]["db"]
}
