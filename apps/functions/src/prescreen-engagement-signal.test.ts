import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { runPrescreenEngagementSignal } from "./prescreen-engagement-signal.js"

const NOW = "2026-06-15T12:00:00.000Z"
type Doc = Record<string, unknown>

/** Mock Firestore supporting session get/set(merge) + a turns subcollection. */
function makeDb(seed: { session?: Doc; turns?: Array<{ reply?: unknown; ts: string }> }): {
  db: Firestore
  read: () => Doc | undefined
} {
  const sessions = new Map<string, Doc>()
  if (seed.session) sessions.set("ps-1", seed.session)
  const turns = (seed.turns ?? []).map((t, i) => ({ id: `t${i}`, data: () => t }))
  function sessionDoc() {
    return {
      async get() {
        const d = sessions.get("ps-1")
        return { exists: d !== undefined, data: () => d }
      },
      async set(v: Doc, o?: { merge?: boolean }) {
        const prev = (sessions.get("ps-1") ?? {}) as Doc
        if (o?.merge) {
          const merged: Doc = { ...prev, ...v }
          if (prev.review && (v as Doc).review) merged.review = { ...(prev.review as Doc), ...((v as Doc).review as Doc) }
          sessions.set("ps-1", merged)
        } else sessions.set("ps-1", { ...v })
      },
      collection() {
        return { orderBy() { return { async get() { return { docs: turns } } } } }
      },
    }
  }
  const db = { collection() { return { doc() { return sessionDoc() } } } } as unknown as Firestore
  return { db, read: () => sessions.get("ps-1") }
}

describe("runPrescreenEngagementSignal", () => {
  it("writes a low signal for one-word replies", async () => {
    const { db, read } = makeDb({
      session: { sessionId: "ps-1", review: {} },
      turns: [
        { reply: "yes", ts: "2026-06-15T11:00:00Z" },
        { reply: "idk", ts: "2026-06-15T11:01:00Z" },
      ],
    })
    const res = await runPrescreenEngagementSignal("ps-1", { db, now: () => NOW })
    assert.equal(res.status, "written")
    assert.equal(res.signal?.level, "low")
    const stored = (read()?.review as Doc)?.engagementSignal as Doc
    assert.equal(stored.level, "low")
    assert.equal(stored.computedAt, NOW)
    assert.equal(stored.answeredCount, 2)
  })

  it("writes a high signal for several detailed replies", async () => {
    const long = (n: number) =>
      `Answer ${n}: ` + "I owned the project end to end and shipped it to production with measurable results ".repeat(2)
    const { db, read } = makeDb({
      session: { sessionId: "ps-1", review: {} },
      turns: [
        { reply: long(1), ts: "2026-06-15T11:00:00Z" },
        { reply: long(2), ts: "2026-06-15T11:01:00Z" },
        { reply: long(3), ts: "2026-06-15T11:02:00Z" },
      ],
    })
    const res = await runPrescreenEngagementSignal("ps-1", { db, now: () => NOW })
    assert.equal(res.status, "written")
    assert.equal(res.signal?.level, "high")
    assert.equal(((read()?.review as Doc)?.engagementSignal as Doc).level, "high")
  })

  it("is idempotent — skips when a current-version signal already exists", async () => {
    const { db } = makeDb({
      session: { sessionId: "ps-1", review: { engagementSignal: { level: "high", version: "engagement-v1" } } },
      turns: [{ reply: "yes", ts: "2026-06-15T11:00:00Z" }],
    })
    const res = await runPrescreenEngagementSignal("ps-1", { db, now: () => NOW })
    assert.equal(res.status, "skipped_existing")
    assert.equal(res.signal?.level, "high") // untouched
  })

  it("re-computes with --force even if a signal exists", async () => {
    const { db } = makeDb({
      session: { sessionId: "ps-1", review: { engagementSignal: { level: "high", version: "engagement-v1" } } },
      turns: [{ reply: "no", ts: "2026-06-15T11:00:00Z" }],
    })
    const res = await runPrescreenEngagementSignal("ps-1", { db, now: () => NOW }, { force: true })
    assert.equal(res.status, "written")
    assert.equal(res.signal?.level, "low")
  })

  it("missing session → skipped, never throws", async () => {
    const { db } = makeDb({})
    const res = await runPrescreenEngagementSignal("ps-1", { db, now: () => NOW })
    assert.equal(res.status, "skipped_no_session")
  })
})
