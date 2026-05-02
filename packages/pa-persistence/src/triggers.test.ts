import assert from "node:assert/strict"
import test from "node:test"
import { Timestamp, type Firestore } from "firebase-admin/firestore"
import {
  TRIGGERS_COLLECTION,
  TRIGGER_FIRES_COLLECTION,
  AUDIT_COLLECTION,
  checkCooldown,
  evaluateTriggers,
  firePostHook,
  hmacSign,
  listFiresForTrigger,
  listTriggers,
  recordFire,
  renderPayload,
  saveTrigger,
  deleteTrigger,
  getTrigger,
  newTriggerId,
  type Trigger,
} from "./triggers.js"

// ---------------------------------------------------------------------------
// In-memory Firestore double — supports doc().get/set/delete, where().limit().get(),
// runTransaction, and collection().get().
// ---------------------------------------------------------------------------

interface Row {
  id: string
  data: Record<string, unknown>
}

interface FakeStore {
  triggers: Map<string, Row>
  fires: Map<string, Row>
  audit: Map<string, Row>
}

function makeStore(): FakeStore {
  return { triggers: new Map(), fires: new Map(), audit: new Map() }
}

function makeFakeFirestore(store: FakeStore = makeStore()): { db: Firestore; store: FakeStore } {
  let auditCounter = 0
  function getMap(name: string): Map<string, Row> {
    if (name === TRIGGERS_COLLECTION) return store.triggers
    if (name === TRIGGER_FIRES_COLLECTION) return store.fires
    if (name === AUDIT_COLLECTION) return store.audit
    throw new Error(`unexpected collection ${name}`)
  }

  function makeDocRef(name: string, id: string) {
    const map = getMap(name)
    return {
      _name: name,
      _id: id,
      get id() {
        return id
      },
      async get() {
        const v = map.get(id)
        return {
          exists: v !== undefined,
          id,
          data: () => (v ? v.data : undefined),
        }
      },
      async set(v: Record<string, unknown>, opts?: { merge?: boolean }) {
        const cur = map.get(id)
        if (cur && opts?.merge) {
          map.set(id, { id, data: { ...cur.data, ...v } })
        } else {
          map.set(id, { id, data: v })
        }
      },
      async delete() {
        map.delete(id)
      },
    }
  }

  function makeQuery(name: string, filters: Array<{ field: string; op: string; val: unknown }> = [], lim?: number) {
    return {
      where(field: string, op: string, val: unknown) {
        return makeQuery(name, [...filters, { field, op, val }], lim)
      },
      limit(n: number) {
        return makeQuery(name, filters, n)
      },
      async get() {
        const map = getMap(name)
        let rows = Array.from(map.values())
        for (const f of filters) {
          rows = rows.filter((r) => {
            const v = r.data[f.field]
            if (f.op === "==") return v === f.val
            return true
          })
        }
        if (lim != null) rows = rows.slice(0, lim)
        return {
          empty: rows.length === 0,
          docs: rows.map((r) => ({ id: r.id, data: () => r.data })),
        }
      },
    }
  }

  function makeCollection(name: string) {
    return {
      doc(id?: string) {
        const finalId = id ?? `${name}_auto_${++auditCounter}`
        return makeDocRef(name, finalId)
      },
      ...makeQuery(name),
    }
  }

  const db = {
    collection(name: string) {
      return makeCollection(name)
    },
    async runTransaction<T>(fn: (t: {
      get: (ref: { _name: string; _id: string }) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>
      set: (ref: { _name: string; _id: string }, v: Record<string, unknown>) => void
      delete: (ref: { _name: string; _id: string }) => void
    }) => Promise<T>): Promise<T> {
      const writes: Array<{ kind: "set" | "delete"; name: string; id: string; v?: Record<string, unknown> }> = []
      const t = {
        async get(ref: { _name: string; _id: string }) {
          const v = getMap(ref._name).get(ref._id)
          return { exists: v !== undefined, data: () => (v ? v.data : undefined) }
        },
        set(ref: { _name: string; _id: string }, v: Record<string, unknown>) {
          writes.push({ kind: "set", name: ref._name, id: ref._id, v })
        },
        delete(ref: { _name: string; _id: string }) {
          writes.push({ kind: "delete", name: ref._name, id: ref._id })
        },
      }
      const result = await fn(t)
      for (const w of writes) {
        const map = getMap(w.name)
        if (w.kind === "set" && w.v) map.set(w.id, { id: w.id, data: w.v })
        else if (w.kind === "delete") map.delete(w.id)
      }
      return result
    },
  }
  return { db: db as unknown as Firestore, store }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrigger(over: Partial<Trigger> = {}): Trigger {
  return {
    triggerId: over.triggerId ?? "trig_test_001",
    name: over.name ?? "Test Trigger",
    enabled: over.enabled ?? true,
    condition: over.condition ?? {
      kind: "keyword",
      config: { pattern: "bytedance|字节", flags: "i" },
    },
    endpoint: over.endpoint ?? { url: "https://example.invalid/hook", method: "POST" },
    payloadTemplate: over.payloadTemplate ?? '{"u":"{{userId}}","t":"{{lastUserTurn}}"}',
    cooldownSec: over.cooldownSec ?? 60,
    description: over.description,
  }
}

// ---------------------------------------------------------------------------
// CRUD tests
// ---------------------------------------------------------------------------

test("saveTrigger: rejects missing name / non-https url / negative cooldown", async () => {
  const { db } = makeFakeFirestore()
  const t = makeTrigger()
  await assert.rejects(
    () => saveTrigger(db, { ...t, name: "" }, { actor: "test" }),
    /name required/
  )
  await assert.rejects(
    () => saveTrigger(db, { ...t, endpoint: { url: "http://nope.com" } }, { actor: "test" }),
    /https/
  )
  await assert.rejects(
    () => saveTrigger(db, { ...t, cooldownSec: -1 }, { actor: "test" }),
    /cooldownSec/
  )
})

test("saveTrigger: writes trigger doc + audit row, bumps version", async () => {
  const { db, store } = makeFakeFirestore()
  const trig = makeTrigger()
  await saveTrigger(db, trig, { actor: "adam@wekruit.com", reason: "smoke" })
  assert.equal(store.triggers.size, 1)
  const saved = store.triggers.get(trig.triggerId)!.data as unknown as Trigger
  assert.equal(saved.version, 1)
  assert.equal(saved.updatedBy, "adam@wekruit.com")
  // Audit
  assert.equal(store.audit.size, 1)
  const audit = Array.from(store.audit.values())[0]!.data as Record<string, unknown>
  assert.equal(audit.action, "trigger.create")

  // Update bumps version to 2 + emits trigger.update audit row.
  await saveTrigger(db, { ...trig, name: "Renamed" }, { actor: "adam@wekruit.com" })
  const saved2 = store.triggers.get(trig.triggerId)!.data as unknown as Trigger
  assert.equal(saved2.version, 2)
  assert.equal(saved2.name, "Renamed")
  assert.equal(store.audit.size, 2)
})

test("listTriggers + getTrigger return saved triggers", async () => {
  const { db } = makeFakeFirestore()
  await saveTrigger(db, makeTrigger({ triggerId: "a", name: "A" }), { actor: "x" })
  await saveTrigger(db, makeTrigger({ triggerId: "b", name: "B" }), { actor: "x" })
  const all = await listTriggers(db)
  assert.equal(all.length, 2)
  const a = await getTrigger(db, "a")
  assert.equal(a?.name, "A")
  const missing = await getTrigger(db, "nope")
  assert.equal(missing, null)
})

test("deleteTrigger: removes doc + writes audit", async () => {
  const { db, store } = makeFakeFirestore()
  await saveTrigger(db, makeTrigger(), { actor: "x" })
  await deleteTrigger(db, "trig_test_001", { actor: "x" })
  assert.equal(store.triggers.size, 0)
  const audits = Array.from(store.audit.values()).map((r) => r.data.action)
  assert.ok(audits.includes("trigger.delete"))
})

// ---------------------------------------------------------------------------
// evaluateTriggers
// ---------------------------------------------------------------------------

test("evaluateTriggers: keyword regex matches user/assistant text", async () => {
  const { db } = makeFakeFirestore()
  await saveTrigger(db, makeTrigger(), { actor: "x" })
  const matches = await evaluateTriggers(db, {
    userId: "u1",
    lastUserTurn: "I think I'll switch to ByteDance soon",
    lastAssistantTurn: "OK, tell me more.",
  })
  assert.equal(matches.length, 1)
  assert.match(matches[0]!.matchedSnippet, /ByteDance/i)
})

test("evaluateTriggers: skips disabled triggers", async () => {
  const { db } = makeFakeFirestore()
  await saveTrigger(db, makeTrigger({ enabled: false }), { actor: "x" })
  const matches = await evaluateTriggers(db, {
    userId: "u1",
    lastUserTurn: "字节跳动 hire me",
    lastAssistantTurn: "OK",
  })
  assert.equal(matches.length, 0)
})

test("evaluateTriggers: llm-judge matches when judge returns yes", async () => {
  const { db } = makeFakeFirestore()
  await saveTrigger(
    db,
    makeTrigger({
      triggerId: "j1",
      condition: { kind: "llm-judge", config: { judgePrompt: "is layoff?" } },
    }),
    { actor: "x" }
  )
  const matchesYes = await evaluateTriggers(db, {
    userId: "u1",
    lastUserTurn: "I just got laid off last week",
    lastAssistantTurn: "...",
    llmJudge: async () => "Yes — clear mention.",
  })
  assert.equal(matchesYes.length, 1)
  const matchesNo = await evaluateTriggers(db, {
    userId: "u1",
    lastUserTurn: "Doing fine",
    lastAssistantTurn: "...",
    llmJudge: async () => "no",
  })
  assert.equal(matchesNo.length, 0)
})

test("evaluateTriggers: errors in one trigger don't blow up others", async () => {
  const { db } = makeFakeFirestore()
  await saveTrigger(
    db,
    makeTrigger({
      triggerId: "bad",
      condition: { kind: "keyword", config: { pattern: "[invalid(regex" } },
    }),
    { actor: "x" }
  )
  await saveTrigger(db, makeTrigger({ triggerId: "good" }), { actor: "x" })
  const matches = await evaluateTriggers(db, {
    userId: "u1",
    lastUserTurn: "ByteDance",
    lastAssistantTurn: "",
  })
  // bad regex throws internally → swallowed; good one still matches.
  assert.equal(matches.length, 1)
  assert.equal(matches[0]!.trigger.triggerId, "good")
})

// ---------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------

test("checkCooldown + recordFire: blocks within window, allows after", async () => {
  const { db } = makeFakeFirestore()
  let now = 1_000_000_000_000
  const c1 = await checkCooldown(db, "trigA", "user1", 60, () => now)
  assert.equal(c1.allowed, true)
  await recordFire(db, {
    triggerId: "trigA",
    userId: "user1",
    firedAt: new Date(now).toISOString(),
    httpStatus: 200,
    errorMsg: null,
  })
  // Within cooldown window: blocked.
  now += 30_000
  const c2 = await checkCooldown(db, "trigA", "user1", 60, () => now)
  assert.equal(c2.allowed, false)
  // After cooldown: allowed.
  now += 31_000
  const c3 = await checkCooldown(db, "trigA", "user1", 60, () => now)
  assert.equal(c3.allowed, true)
})

test("recordFire: writes both fire row + audit row", async () => {
  const { db, store } = makeFakeFirestore()
  await recordFire(db, {
    triggerId: "t1",
    userId: "u1",
    firedAt: new Date().toISOString(),
    httpStatus: 200,
    errorMsg: null,
    conversationId: "c1",
  })
  assert.equal(store.fires.size, 1)
  const audits = Array.from(store.audit.values()).map((r) => r.data.action)
  assert.ok(audits.includes("trigger.fire"))
})

// Stream H9 TD1 — pa-trigger-fires TTL anchor must be a Timestamp.
test("recordFire: writes Timestamp-typed expiresAtTs (Stream H9 TD1)", async () => {
  const { db, store } = makeFakeFirestore()
  await recordFire(db, {
    triggerId: "tt1",
    userId: "uu1",
    firedAt: new Date().toISOString(),
    httpStatus: 200,
    errorMsg: null,
  })
  assert.equal(store.fires.size, 1)
  const fireRow = Array.from(store.fires.values())[0]!
  const ts = fireRow.data.expiresAtTs
  assert.ok(
    ts instanceof Timestamp,
    "expiresAtTs MUST be a Timestamp instance — Firestore TTL only fires on Timestamp"
  )
  // 30-day window per H9 brief
  const expected = Date.now() + 30 * 24 * 60 * 60 * 1000
  const ms = (ts as Timestamp).toMillis()
  assert.ok(Math.abs(ms - expected) < 5000, `expiresAtTs ${ms}ms diverges from expected ${expected}ms`)
})

test("listFiresForTrigger: filters by triggerId", async () => {
  const { db } = makeFakeFirestore()
  await recordFire(db, { triggerId: "a", userId: "u1", firedAt: "2025-01-01T00:00:00Z", httpStatus: 200, errorMsg: null })
  await recordFire(db, { triggerId: "a", userId: "u2", firedAt: "2025-01-01T00:00:01Z", httpStatus: 500, errorMsg: "boom" })
  await recordFire(db, { triggerId: "b", userId: "u3", firedAt: "2025-01-01T00:00:02Z", httpStatus: 200, errorMsg: null })
  const aRows = await listFiresForTrigger(db, "a")
  assert.equal(aRows.length, 2)
  const bRows = await listFiresForTrigger(db, "b")
  assert.equal(bRows.length, 1)
})

// ---------------------------------------------------------------------------
// renderPayload + HMAC + firePostHook
// ---------------------------------------------------------------------------

test("renderPayload: substitutes mustache-lite vars; unknown → empty", () => {
  const out = renderPayload('{"u":"{{userId}}","x":"{{missing}}"}', { userId: "abc" })
  assert.equal(out, '{"u":"abc","x":""}')
})

test("hmacSign: deterministic hex sha256", () => {
  const sig = hmacSign("hello", "secret")
  assert.equal(sig.length, 64)
  assert.equal(sig, hmacSign("hello", "secret"))
  assert.notEqual(sig, hmacSign("hello", "other"))
})

test("firePostHook: posts to url with hmac header; returns ok+status", async () => {
  let captured: { url?: string; init?: RequestInit } = {}
  const fakeFetch = (async (url: string, init: RequestInit) => {
    captured = { url, init }
    return {
      ok: true,
      status: 200,
    } as Response
  }) as unknown as typeof fetch
  const trig = makeTrigger()
  const res = await firePostHook(trig, '{"x":1}', "shh", { fetchImpl: fakeFetch })
  assert.equal(res.ok, true)
  assert.equal(res.status, 200)
  assert.equal(captured.url, "https://example.invalid/hook")
  const headers = (captured.init?.headers ?? {}) as Record<string, string>
  assert.equal(headers["x-hmac-sha256"], hmacSign('{"x":1}', "shh"))
})

test("firePostHook: returns error on network throw, no exception", async () => {
  const fakeFetch = (async () => {
    throw new Error("ECONNREFUSED")
  }) as unknown as typeof fetch
  const res = await firePostHook(makeTrigger(), "{}", null, { fetchImpl: fakeFetch })
  assert.equal(res.ok, false)
  assert.equal(res.status, null)
  assert.match(res.errorMsg ?? "", /ECONNREFUSED/)
})

test("firePostHook: marks 5xx as not-ok", async () => {
  const fakeFetch = (async () => ({ ok: false, status: 503 } as Response)) as unknown as typeof fetch
  const res = await firePostHook(makeTrigger(), "{}", null, { fetchImpl: fakeFetch })
  assert.equal(res.ok, false)
  assert.equal(res.status, 503)
  assert.equal(res.errorMsg, "http_503")
})

test("newTriggerId: prefixed + unique", () => {
  const a = newTriggerId()
  const b = newTriggerId()
  assert.match(a, /^trig_/)
  assert.notEqual(a, b)
})
