import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  detectsCvAsk,
  maybeOpenResumeGate,
} from "../post-turn-hooks/cv-gate-detector.js"

describe("detectsCvAsk (zh + en bank)", () => {
  it("matches zh send-resume phrasings", () => {
    assert.equal(detectsCvAsk("把简历发给我看一下"), true)
    assert.equal(detectsCvAsk("发份简历过来呗"), true)
    assert.equal(detectsCvAsk("你可以发我简历吗"), true)
    assert.equal(detectsCvAsk("把你简历发我"), true)
  })
  it("matches iter30 ask_q_resume Adam-locked phrase + variants", () => {
    // The exact phrase Q_PROMPTS.ask_q_resume.zh outputs at the end of the
    // 6Q chain. Without this, the cv-ingest gate stays closed even though
    // Claire just proactively asked.
    assert.equal(
      detectsCvAsk("对了, 简历方便发我一份不? 后面帮你看 JD / 内推都准多了"),
      true
    )
    assert.equal(detectsCvAsk("简历方便发给我吗"), true)
    assert.equal(detectsCvAsk("发我份简历看看"), true)
  })
  it("matches en send-resume phrasings", () => {
    assert.equal(detectsCvAsk("send me your resume"), true)
    assert.equal(detectsCvAsk("Can you send your CV?"), true)
    assert.equal(detectsCvAsk("share your resume with me"), true)
    assert.equal(detectsCvAsk("drop me your CV"), true)
  })
  it("returns false for unrelated phrasing", () => {
    assert.equal(detectsCvAsk("Hi how's it going?"), false)
    assert.equal(detectsCvAsk("聊聊你最近的项目"), false)
  })
  it("returns false for empty / non-string", () => {
    assert.equal(detectsCvAsk(""), false)
    assert.equal(detectsCvAsk(undefined as unknown as string), false)
  })
})

type DocLike = {
  set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => Promise<void>
}

function makeDb(captured: { writes: Array<Record<string, unknown>> }): {
  collection: (n: string) => { doc: (id: string) => DocLike }
} {
  return {
    collection: (_: string) => ({
      doc: (_id: string) => ({
        set: async (data: Record<string, unknown>) => {
          captured.writes.push(data)
        },
      }),
    }),
  }
}

describe("maybeOpenResumeGate", () => {
  it("opens gate + writes triggerHash on resume-ask match", async () => {
    const captured = { writes: [] as Array<Record<string, unknown>> }
    const db = makeDb(captured) as unknown as Parameters<typeof maybeOpenResumeGate>[0]["db"]
    const r = await maybeOpenResumeGate({
      db,
      userId: "u1",
      assistantText: "把简历发给我",
      nowIso: "2026-05-03T12:00:00.000Z",
    })
    assert.equal(r.opened, true)
    assert.equal(typeof r.triggerHash, "string")
    assert.equal(typeof r.expiresAt, "string")
    assert.equal(captured.writes.length, 1)
    const written = captured.writes[0]!
    const ra = written.resumeAccepted as { at: string; expiresAt: string; triggerHash: string }
    assert.equal(ra.at, "2026-05-03T12:00:00.000Z")
    assert.match(ra.triggerHash, /^[0-9a-f]{16}$/)
    assert.equal(written.lastAssistantTurnAskedResume, true)
  })

  it("writes lastAssistantTurnAt + askedResume=false on non-match (for grace window)", async () => {
    const captured = { writes: [] as Array<Record<string, unknown>> }
    const db = makeDb(captured) as unknown as Parameters<typeof maybeOpenResumeGate>[0]["db"]
    const r = await maybeOpenResumeGate({
      db,
      userId: "u1",
      assistantText: "Hi how's it going",
      nowIso: "2026-05-03T12:00:00.000Z",
    })
    assert.equal(r.opened, false)
    assert.equal(captured.writes.length, 1)
    assert.equal(captured.writes[0]!.lastAssistantTurnAskedResume, false)
    assert.equal(captured.writes[0]!.lastAssistantTurnAt, "2026-05-03T12:00:00.000Z")
  })

  it("never throws on Firestore failure (set rejects)", async () => {
    const db = {
      collection: () => ({
        doc: () => ({
          set: async () => {
            throw new Error("Firestore down")
          },
        }),
      }),
    } as unknown as Parameters<typeof maybeOpenResumeGate>[0]["db"]
    const r = await maybeOpenResumeGate({
      db,
      userId: "u1",
      assistantText: "send me your resume",
      nowIso: "2026-05-03T12:00:00.000Z",
    })
    // We treat this as "did not actually open" but no exception escapes.
    assert.equal(r.opened, false)
  })
})
