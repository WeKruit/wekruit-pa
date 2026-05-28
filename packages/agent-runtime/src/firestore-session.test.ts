import assert from "node:assert/strict"
import test from "node:test"
import { deriveSessionMessageIdempotencyKey, FirestoreSession } from "./firestore-session.js"
import type { ChatMessage } from "@pa/core-types"

/**
 * Lightweight in-memory Firestore stub. Models the surface FirestoreSession
 * actually touches: collection().where().limit().get() + collection().doc()
 * .set(...) + .ref.set(merge:true).
 */
type Row = ChatMessage & Record<string, unknown>

function makeFakeDb(initialRows: Row[] = []) {
  // Phase 23+ kebab-case migration. Old snake-case key kept as alias for
  // any stale code path during transition.
  const rows = [...initialRows]
  const rowsByCollection: Record<string, Row[]> = {
    "pa-messages": rows,
    pa_messages: rows,
  }
  let lastWrite: { collection: string; id: string; data: unknown; merge: boolean } | null = null

  const makeQuery = (collectionName: string, filters: Array<[string, string, unknown]>, capLimit?: number) => ({
    where(field: string, op: string, value: unknown) {
      return makeQuery(collectionName, [...filters, [field, op, value]], capLimit)
    },
    limit(n: number) {
      return makeQuery(collectionName, filters, n)
    },
    async get() {
      const rows = rowsByCollection[collectionName] ?? []
      const matched = rows.filter((row) =>
        filters.every(([field, op, value]) => {
          if (op !== "==") throw new Error(`fake firestore only supports == (got ${op})`)
          return (row as Record<string, unknown>)[field] === value
        })
      )
      const limited = capLimit !== undefined ? matched.slice(0, capLimit) : matched
      return {
        empty: limited.length === 0,
        docs: limited.map((data) => ({
          data: () => data,
          ref: {
            async set(patch: Record<string, unknown>, opts?: { merge?: boolean }) {
              const merge = opts?.merge === true
              const idx = (rowsByCollection[collectionName] ?? []).findIndex((r) => r.id === data.id)
              if (idx >= 0) {
                rowsByCollection[collectionName]![idx] = merge
                  ? ({ ...rowsByCollection[collectionName]![idx]!, ...patch } as Row)
                  : ({ ...patch, id: data.id } as Row)
              }
              lastWrite = { collection: collectionName, id: data.id, data: patch, merge }
            },
          },
        })),
      }
    },
  })

  const db = {
    collection(name: string) {
      return {
        ...makeQuery(name, [], undefined),
        doc(id: string) {
          return {
            async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
              const merge = opts?.merge === true
              const target = rowsByCollection[name] ?? (rowsByCollection[name] = [])
              const idx = target.findIndex((r) => r.id === id)
              if (idx >= 0 && merge) target[idx] = { ...target[idx]!, ...data } as Row
              else if (idx >= 0) target[idx] = { ...(data as Row) }
              else target.push({ ...(data as Row) })
              lastWrite = { collection: name, id, data, merge }
            },
          }
        },
      }
    },
  }

  return {
    db: db as unknown as Parameters<typeof makeSession>[0]["db"],
    rows: () => rowsByCollection["pa-messages"] ?? [],
    lastWrite: () => lastWrite,
  }
}

function makeSession(deps: {
  db: ConstructorParameters<typeof FirestoreSession>[0]["db"]
  sessionId?: string
  userId?: string
  historyLimit?: number
  nowIso?: () => string
}) {
  return new FirestoreSession({
    db: deps.db,
    sessionId: deps.sessionId ?? "s-test",
    userId: deps.userId ?? "u-test",
    historyLimit: deps.historyLimit,
    nowIso: deps.nowIso ?? (() => "2026-04-26T12:00:00.000Z"),
  })
}

function row(overrides: Partial<Row>): Row {
  return {
    id: "m1",
    sessionId: "s-test",
    userId: "u-test",
    role: "user",
    body: "hello",
    createdAt: "2026-04-26T11:00:00.000Z",
    ...overrides,
  } as Row
}

test("getSessionId returns the configured id", async () => {
  const fake = makeFakeDb()
  const session = makeSession({ db: fake.db, sessionId: "s-abc" })
  assert.equal(await session.getSessionId(), "s-abc")
})

test("getItems returns an empty array for an empty session", async () => {
  const fake = makeFakeDb([])
  const session = makeSession({ db: fake.db })
  const items = await session.getItems()
  assert.deepEqual(items, [])
})

test("getItems returns user/assistant items in chronological order", async () => {
  const fake = makeFakeDb([
    row({ id: "m1", role: "user", body: "first", createdAt: "2026-04-26T10:00:00.000Z" }),
    row({ id: "m3", role: "assistant", body: "third", createdAt: "2026-04-26T10:00:02.000Z" }),
    row({ id: "m2", role: "user", body: "second", createdAt: "2026-04-26T10:00:01.000Z" }),
  ])
  const session = makeSession({ db: fake.db })
  const items = (await session.getItems()) as Array<{ role: string; content: unknown }>
  assert.equal(items.length, 3)
  assert.equal(items[0]!.role, "user")
  assert.equal(items[0]!.content, "first")
  assert.equal(items[1]!.role, "user")
  assert.equal(items[1]!.content, "second")
  assert.equal(items[2]!.role, "assistant")
  assert.deepEqual(items[2]!.content, [{ type: "output_text", text: "third" }])
})

test("getItems(limit=1) returns only the most recent message", async () => {
  const fake = makeFakeDb([
    row({ id: "m1", body: "old", createdAt: "2026-04-26T10:00:00.000Z" }),
    row({ id: "m2", body: "new", createdAt: "2026-04-26T11:00:00.000Z" }),
  ])
  const session = makeSession({ db: fake.db })
  const items = (await session.getItems(1)) as Array<{ content: unknown }>
  assert.equal(items.length, 1)
  assert.equal(items[0]!.content, "new")
})

test("getItems drops system rows and rows already cleared/popped", async () => {
  const fake = makeFakeDb([
    row({ id: "m1", body: "a", createdAt: "2026-04-26T10:00:00.000Z" }),
    row({ id: "m2", role: "system", body: "persona", createdAt: "2026-04-26T10:00:01.000Z" }),
    row({ id: "m3", body: "popped one", createdAt: "2026-04-26T10:00:02.000Z", popped: true }),
    row({
      id: "m4",
      role: "assistant",
      body: "wiped",
      createdAt: "2026-04-26T10:00:03.000Z",
      cleared: true,
    } as Partial<Row>),
  ])
  const session = makeSession({ db: fake.db })
  const items = (await session.getItems()) as Array<{ role: string; content: unknown }>
  assert.equal(items.length, 1)
  assert.equal(items[0]!.content, "a")
})

test("getItems strips a leading [ISO] timestamp prefix", async () => {
  const fake = makeFakeDb([
    row({ id: "m1", body: "[2026-04-26T10:00:00.000Z] hello there", createdAt: "2026-04-26T10:00:00.000Z" }),
  ])
  const session = makeSession({ db: fake.db })
  const items = (await session.getItems()) as Array<{ content: unknown }>
  assert.equal(items[0]!.content, "hello there")
})

test("addItems writes assistant rows only and is idempotent on retry", async () => {
  const fake = makeFakeDb()
  const session = makeSession({ db: fake.db })
  const items = [
    { type: "message", role: "user", content: "ping" },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "pong" }],
    },
  ] as unknown as Parameters<typeof session.addItems>[0]
  await session.addItems(items)
  assert.equal(fake.rows().length, 1)
  assert.equal(fake.rows()[0]!.role, "assistant")
  assert.equal(fake.rows()[0]!.body, "pong")
  // Second call with same content must not double-write.
  await session.addItems(items)
  assert.equal(fake.rows().length, 1)
  // Assistant row carries our SDK source meta.
  for (const r of fake.rows()) {
    const meta = r.rawMeta as Record<string, unknown> | undefined
    assert.equal(meta?.source, "agents_sdk_session")
    assert.equal(typeof r.idempotencyKey, "string")
  }
})

test("addItems skips synthetic user inputs so internal prompts do not become transcript memory", async () => {
  const fake = makeFakeDb()
  const session = makeSession({ db: fake.db })
  await session.addItems([
    {
      type: "message",
      role: "user",
      content: "[ONBOARDING CONTINUATION] The candidate just answered the previous onboarding slot.",
    },
  ] as unknown as Parameters<typeof session.addItems>[0])
  assert.equal(fake.rows().length, 0)
})

test("addItems short-circuits on idempotencyKey collision with orchestrator-written rows", async () => {
  // Simulate orchestrator already wrote `out-evt1` for the assistant turn.
  const sessionId = "s-test"
  // Compute the same hash the SDK would use.
  const body = "pong"
  const idempotencyKey = deriveSessionMessageIdempotencyKey(sessionId, "assistant", body)
  const fake = makeFakeDb([
    row({
      id: "out-evt1",
      role: "assistant",
      body,
      createdAt: "2026-04-26T10:00:00.000Z",
      idempotencyKey,
    }),
  ])
  const session = makeSession({ db: fake.db, sessionId })
  await session.addItems([
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: body }],
    },
  ] as unknown as Parameters<typeof session.addItems>[0])
  // Still only the one orchestrator-written row.
  assert.equal(fake.rows().length, 1)
  assert.equal(fake.rows()[0]!.id, "out-evt1")
})

test("addItems drops system items entirely", async () => {
  const fake = makeFakeDb()
  const session = makeSession({ db: fake.db })
  await session.addItems([
    { type: "message", role: "system", content: "persona block" },
  ] as unknown as Parameters<typeof session.addItems>[0])
  assert.equal(fake.rows().length, 0)
})

test("popItem returns undefined for an empty session", async () => {
  const fake = makeFakeDb([])
  const session = makeSession({ db: fake.db })
  assert.equal(await session.popItem(), undefined)
})

test("popItem returns the newest live row and tombstones it", async () => {
  const fake = makeFakeDb([
    row({ id: "m1", body: "first", createdAt: "2026-04-26T10:00:00.000Z" }),
    row({
      id: "m2",
      role: "assistant",
      body: "second",
      createdAt: "2026-04-26T10:00:01.000Z",
    }),
  ])
  const session = makeSession({ db: fake.db })
  const popped = (await session.popItem()) as { role: string; content: unknown } | undefined
  assert.ok(popped)
  assert.equal(popped!.role, "assistant")
  // Document is soft-deleted, not removed.
  const rows = fake.rows()
  const m2 = rows.find((r) => r.id === "m2")!
  assert.equal((m2 as Row).popped, true)
  assert.equal(rows.length, 2)
})

test("clearSession marks all rows cleared without hard-deleting", async () => {
  const fake = makeFakeDb([
    row({ id: "m1", body: "a", createdAt: "2026-04-26T10:00:00.000Z" }),
    row({ id: "m2", body: "b", createdAt: "2026-04-26T10:00:01.000Z" }),
  ])
  const session = makeSession({ db: fake.db })
  await session.clearSession()
  const rows = fake.rows()
  assert.equal(rows.length, 2)
  for (const r of rows) {
    assert.equal((r as Row).cleared, true)
    assert.ok((r as Row).clearedAt)
  }
  // After clearSession, getItems sees nothing.
  assert.deepEqual(await session.getItems(), [])
})
