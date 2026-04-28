/**
 * Phase 24.5 — admin-bootstrap.replayFixtures unit tests (P9-Voice-Data).
 *
 * Tests are pure-function unit tests against the exported `replayFixtures`
 * core; the Firebase `onRequest` wrapper is exercised in deploy/curl-smoke,
 * not here.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  checkAdminToken,
  extractUserMessageFromLine,
  replayFixtures,
  type ReplayDeps,
  type FixtureName,
} from "./admin-bootstrap.js"

type FakeDoc = { ref: FakeDocRef; data: Record<string, unknown> }
type FakeDocRef = {
  id: string
  set: (data: Record<string, unknown>) => Promise<void>
}
type FakeCollection = {
  name: string
  doc: (id: string) => FakeDocRef
  docs: FakeDoc[]
}

function makeFakeDb() {
  const collections = new Map<string, FakeCollection>()
  function getOrMake(name: string): FakeCollection {
    let c = collections.get(name)
    if (c) return c
    c = {
      name,
      docs: [],
      doc: (id: string) => {
        const ref: FakeDocRef = {
          id,
          set: async (data: Record<string, unknown>) => {
            // Replace if exists; else push.
            const existing = c!.docs.find((d) => d.ref.id === id)
            if (existing) existing.data = { ...data }
            else c!.docs.push({ ref, data: { ...data } })
          },
        }
        return ref
      },
    }
    collections.set(name, c)
    return c
  }
  const db = {
    collection: (name: string) => getOrMake(name),
  }
  return { db: db as unknown as ReplayDeps["db"], collections, getOrMake }
}

describe("checkAdminToken", () => {
  it("503 when env unset", () => {
    const original = process.env.PA_ADMIN_TOKEN
    delete process.env.PA_ADMIN_TOKEN
    try {
      const r = checkAdminToken("anything")
      assert.equal(r.ok, false)
      assert.equal(r.status, 503)
    } finally {
      if (original !== undefined) process.env.PA_ADMIN_TOKEN = original
    }
  })

  it("200 when match (with whitespace tolerance)", () => {
    const original = process.env.PA_ADMIN_TOKEN
    process.env.PA_ADMIN_TOKEN = "tok-123\n"
    try {
      const r = checkAdminToken("  tok-123  ")
      assert.equal(r.ok, true)
      assert.equal(r.status, 200)
    } finally {
      if (original === undefined) delete process.env.PA_ADMIN_TOKEN
      else process.env.PA_ADMIN_TOKEN = original
    }
  })
})

describe("extractUserMessageFromLine", () => {
  it("skips // comments and # comments", () => {
    assert.equal(extractUserMessageFromLine("// placeholder"), null)
    assert.equal(extractUserMessageFromLine("# header"), null)
    assert.equal(extractUserMessageFromLine(""), null)
    assert.equal(extractUserMessageFromLine("__SKIP__"), null)
  })
  it("extracts from {messages:[...]}", () => {
    const got = extractUserMessageFromLine(
      JSON.stringify({ messages: [{ role: "user", content: "hi there" }, { role: "assistant", content: "ok" }] })
    )
    assert.equal(got, "hi there")
  })
  it("extracts from {user: '...'}", () => {
    assert.equal(extractUserMessageFromLine(JSON.stringify({ user: "yo" })), "yo")
  })
  it("treats bare string as user msg", () => {
    assert.equal(extractUserMessageFromLine("just a question"), "just a question")
  })
})

describe("replayFixtures — dry run", () => {
  it("counts processed but does NOT write", async () => {
    const { db, getOrMake } = makeFakeDb()
    const orchCalls: string[] = []
    const result = await replayFixtures(
      { fixtures: ["synthetic-vent"], dryRun: true, limit: 5 },
      {
        db,
        loadFixture: async (_n: FixtureName) => ["msg one", "msg two", "msg three"],
        orchestrator: async ({ userText }) => {
          orchCalls.push(userText)
          return "echo: " + userText
        },
      }
    )
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, true)
    assert.equal(result.processed, 3)
    assert.equal(result.fixturesByName["synthetic-vent"], 3)
    assert.equal(orchCalls.length, 0, "orchestrator MUST NOT be called on dry-run")
    const messagesCol = getOrMake("pa_messages")
    assert.equal(messagesCol.docs.length, 0, "no Firestore writes on dry-run")
  })
})

describe("replayFixtures — real replay with mocked orchestrator", () => {
  it("calls orchestrator and writes user+assistant docs to pa_messages", async () => {
    const { db, getOrMake } = makeFakeDb()
    const orchCalls: { userText: string; sessionId: string; userId: string }[] = []
    const result = await replayFixtures(
      { fixtures: ["synthetic-cele"], dryRun: false, limit: 2 },
      {
        db,
        loadFixture: async (n: FixtureName) => {
          assert.equal(n, "synthetic-cele")
          return ["got the offer!", "promo passed!", "shipped it"]
        },
        orchestrator: async ({ userText, sessionId, userId }) => {
          orchCalls.push({ userText, sessionId, userId })
          return "🎉 awesome — " + userText
        },
        nowIso: () => "2026-04-28T00:00:00.000Z",
      }
    )
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, false)
    assert.equal(result.processed, 2, "limit=2 caps at first 2 user msgs")
    assert.equal(result.fixturesByName["synthetic-cele"], 2)
    assert.equal(orchCalls.length, 2)
    assert.equal(orchCalls[0]!.userId, "SYNTHETIC_REPLAY")
    assert.equal(orchCalls[0]!.sessionId, "sim-synthetic-cele-0")
    assert.equal(orchCalls[1]!.sessionId, "sim-synthetic-cele-1")
    const messagesCol = getOrMake("pa_messages")
    // 2 replays × 2 docs each (user + assistant) = 4
    assert.equal(messagesCol.docs.length, 4)
    const docIds = messagesCol.docs.map((d) => d.ref.id).sort()
    assert.deepEqual(docIds, [
      "sim-synthetic-cele-0-assistant",
      "sim-synthetic-cele-0-user",
      "sim-synthetic-cele-1-assistant",
      "sim-synthetic-cele-1-user",
    ])
    const userDoc = messagesCol.docs.find((d) => d.ref.id === "sim-synthetic-cele-0-user")!
    assert.equal(userDoc.data.role, "user")
    assert.equal(userDoc.data.body, "got the offer!")
    assert.equal(userDoc.data.userId, "SYNTHETIC_REPLAY")
    assert.equal(userDoc.data.sessionId, "sim-synthetic-cele-0")
    assert.equal(userDoc.data.source, "synthetic-replay")
    assert.equal(userDoc.data.createdAt, "2026-04-28T00:00:00.000Z")
    const asstDoc = messagesCol.docs.find((d) => d.ref.id === "sim-synthetic-cele-0-assistant")!
    assert.equal(asstDoc.data.role, "assistant")
    assert.equal(asstDoc.data.body, "🎉 awesome — got the offer!")
    assert.equal(asstDoc.data.fixture, "synthetic-cele")
  })

  it("skips empty / __SKIP__ / # lines without invoking orchestrator", async () => {
    const { db } = makeFakeDb()
    const orchCalls: string[] = []
    const result = await replayFixtures(
      { fixtures: ["synthetic-vent"], dryRun: false },
      {
        db,
        loadFixture: async () => ["real msg", "", "__SKIP__", "# comment line", "second real"],
        orchestrator: async ({ userText }) => {
          orchCalls.push(userText)
          return "ok"
        },
      }
    )
    assert.equal(result.processed, 2)
    assert.deepEqual(orchCalls, ["real msg", "second real"])
  })

  it("orchestrator timeout is recorded as error but doesn't crash batch", async () => {
    const { db } = makeFakeDb()
    let count = 0
    const result = await replayFixtures(
      { fixtures: ["synthetic-deflect"], dryRun: false },
      {
        db,
        loadFixture: async () => ["a", "b", "c"],
        orchestrator: async ({ signal }) =>
          new Promise<string>((resolve, reject) => {
            count++
            // First call hangs forever (until aborted) → timeout fires.
            // Second + third resolve fast.
            if (count === 1) {
              signal.addEventListener("abort", () => reject(new Error("aborted")))
              return
            }
            resolve("fast reply " + count)
          }),
        timeoutMs: 50,
      }
    )
    assert.equal(result.processed, 2, "first call timed out, last 2 succeeded")
    assert.ok(result.errors && result.errors.length === 1)
    assert.match(result.errors![0]!.error, /replay_timeout|aborted/)
  })

  it("rejects unknown fixture name", async () => {
    const { db } = makeFakeDb()
    const result = await replayFixtures(
      { fixtures: ["not-a-real-fixture"], dryRun: true },
      {
        db,
        loadFixture: async () => [],
        orchestrator: async () => "x",
      }
    )
    assert.equal(result.processed, 0)
    assert.ok(result.errors && result.errors.length === 1)
    assert.equal(result.errors![0]!.error, "unknown_fixture")
  })

  it("hard-caps limit at 200 even if caller asks for more", async () => {
    const { db } = makeFakeDb()
    const big = Array.from({ length: 500 }, (_, i) => `msg-${i}`)
    const result = await replayFixtures(
      { fixtures: ["synthetic-vent"], dryRun: true, limit: 1000 },
      {
        db,
        loadFixture: async () => big,
        orchestrator: async () => "x",
      }
    )
    assert.equal(result.processed, 200)
  })
})
