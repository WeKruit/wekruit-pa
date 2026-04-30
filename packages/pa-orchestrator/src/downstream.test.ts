import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  TRIGGERS_COLLECTION,
  TRIGGER_FIRES_COLLECTION,
  _clearFeatureFlagCache,
  saveTrigger,
  setFlag,
  type Trigger,
} from "@pa/pa-persistence"

// Test-local copy of the audit collection constant — pa-persistence does
// not re-export it (intentional: the AUDIT_COLLECTION is shared across many
// helpers and exposing it package-wide would invite drift).
const AUDIT_COLLECTION = "pa-audit-events"
const FLAGS_COLLECTION = "pa-feature-flags"
import { runDownstreamConnector, withSoftBudget, EVAL_CONNECTORS_FLAG } from "./downstream.js"

// ---------------------------------------------------------------------------
// In-memory Firestore double — same shape as triggers.test.ts.
// ---------------------------------------------------------------------------

interface Row {
  id: string
  data: Record<string, unknown>
}
interface FakeStore {
  triggers: Map<string, Row>
  fires: Map<string, Row>
  audit: Map<string, Row>
  flags: Map<string, Row>
}

function makeFirestore(): { db: Firestore; store: FakeStore } {
  const store: FakeStore = {
    triggers: new Map(),
    fires: new Map(),
    audit: new Map(),
    flags: new Map(),
  }
  let counter = 0
  function getMap(name: string): Map<string, Row> {
    if (name === TRIGGERS_COLLECTION) return store.triggers
    if (name === TRIGGER_FIRES_COLLECTION) return store.fires
    if (name === AUDIT_COLLECTION) return store.audit
    if (name === FLAGS_COLLECTION) return store.flags
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
        return { exists: v !== undefined, id, data: () => (v ? v.data : undefined) }
      },
      async set(v: Record<string, unknown>, opts?: { merge?: boolean }) {
        const cur = map.get(id)
        if (cur && opts?.merge) map.set(id, { id, data: { ...cur.data, ...v } })
        else map.set(id, { id, data: v })
      },
      async delete() {
        map.delete(id)
      },
    }
  }
  function makeQuery(
    name: string,
    filters: Array<{ field: string; op: string; val: unknown }> = [],
    lim?: number
  ) {
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
          rows = rows.filter((r) => (f.op === "==" ? r.data[f.field] === f.val : true))
        }
        if (lim != null) rows = rows.slice(0, lim)
        return { empty: rows.length === 0, docs: rows.map((r) => ({ id: r.id, data: () => r.data })) }
      },
    }
  }
  function makeCollection(name: string) {
    return {
      doc(id?: string) {
        return makeDocRef(name, id ?? `${name}_auto_${++counter}`)
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

/**
 * Pre-existing connector tests below were written before the master kill
 * switch existed; pass `SKIP` in their options so they continue to exercise
 * the underlying pipeline without depending on flag state. The kill-switch
 * specific behavior is covered by dedicated tests at the bottom of the file.
 */
const SKIP = { skipFlagCheck: true } as const

/**
 * Enable the master kill switch via setFlag (covers the prod-shape path).
 */
async function enableConnector(db: Firestore): Promise<void> {
  _clearFeatureFlagCache()
  await setFlag(
    db,
    EVAL_CONNECTORS_FLAG,
    { value: true, type: "bool", scope: "global" },
    { actor: "test", reason: "enable for unit test" }
  )
}

function trig(over: Partial<Trigger> = {}): Trigger {
  return {
    triggerId: over.triggerId ?? "trig_a",
    name: over.name ?? "Test",
    enabled: over.enabled ?? true,
    condition: over.condition ?? {
      kind: "keyword",
      config: { pattern: "bytedance|字节", flags: "i" },
    },
    endpoint: over.endpoint ?? { url: "https://example.invalid/hook" },
    payloadTemplate: over.payloadTemplate ?? '{"u":"{{userId}}","t":"{{lastUserTurn}}"}',
    cooldownSec: over.cooldownSec ?? 60,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("runDownstreamConnector: matched trigger fires HTTP POST + records fire", async () => {
  const { db, store } = makeFirestore()
  await saveTrigger(db, trig(), { actor: "x" })

  let captured: { url?: string; init?: RequestInit } = {}
  const fakeFetch = (async (url: string, init: RequestInit) => {
    captured = { url, init }
    return { ok: true, status: 200 } as Response
  }) as unknown as typeof fetch

  const res = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "I want to leave for ByteDance", lastAssistantTurn: "OK" },
    { fetchImpl: fakeFetch, ...SKIP }
  )
  assert.equal(res.matched, 1)
  assert.equal(res.fired, 1)
  assert.equal(captured.url, "https://example.invalid/hook")
  assert.match(String(captured.init?.body), /u1/)
  // Fire row persisted
  assert.equal(store.fires.size, 1)
})

test("runDownstreamConnector: cooldown blocks repeat within window", async () => {
  const { db } = makeFirestore()
  await saveTrigger(db, trig({ cooldownSec: 60 }), { actor: "x" })
  const fakeFetch = (async () => ({ ok: true, status: 200 } as Response)) as unknown as typeof fetch

  const r1 = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "ByteDance", lastAssistantTurn: "" },
    { fetchImpl: fakeFetch, ...SKIP }
  )
  assert.equal(r1.fired, 1)

  const r2 = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "ByteDance again", lastAssistantTurn: "" },
    { fetchImpl: fakeFetch, ...SKIP }
  )
  assert.equal(r2.fired, 0)
  assert.equal(r2.records[0]?.reason, "cooldown")
})

test("runDownstreamConnector: per-user cooldown — different user fires", async () => {
  const { db } = makeFirestore()
  await saveTrigger(db, trig({ cooldownSec: 60 }), { actor: "x" })
  const fakeFetch = (async () => ({ ok: true, status: 200 } as Response)) as unknown as typeof fetch

  const r1 = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "ByteDance", lastAssistantTurn: "" },
    { fetchImpl: fakeFetch, ...SKIP }
  )
  assert.equal(r1.fired, 1)
  const r2 = await runDownstreamConnector(
    db,
    { userId: "u2", lastUserTurn: "ByteDance", lastAssistantTurn: "" },
    { fetchImpl: fakeFetch, ...SKIP }
  )
  assert.equal(r2.fired, 1)
})

test("runDownstreamConnector: HMAC header injected when secret resolved", async () => {
  const { db } = makeFirestore()
  await saveTrigger(
    db,
    trig({ endpoint: { url: "https://example.invalid/hook", hmacSecretRef: "PA_TRIGGER_HMAC_TEST" } }),
    { actor: "x" }
  )
  let captured: { headers?: Record<string, string> } = {}
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    captured = { headers: init.headers as Record<string, string> }
    return { ok: true, status: 200 } as Response
  }) as unknown as typeof fetch

  const res = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "字节跳动", lastAssistantTurn: "" },
    { fetchImpl: fakeFetch, resolveSecret: async () => "shh", ...SKIP }
  )
  assert.equal(res.fired, 1)
  assert.match(captured.headers?.["x-hmac-sha256"] ?? "", /^[0-9a-f]{64}$/)
})

test("runDownstreamConnector: 5xx still records fire (cooldown opens)", async () => {
  const { db, store } = makeFirestore()
  await saveTrigger(db, trig(), { actor: "x" })
  const fakeFetch = (async () => ({ ok: false, status: 503 } as Response)) as unknown as typeof fetch

  const res = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "ByteDance", lastAssistantTurn: "" },
    { fetchImpl: fakeFetch, ...SKIP }
  )
  assert.equal(res.fired, 1)
  assert.equal(res.records[0]?.status, 503)
  assert.equal(store.fires.size, 1)
})

test("runDownstreamConnector: no match → no fire", async () => {
  const { db } = makeFirestore()
  await saveTrigger(db, trig(), { actor: "x" })
  const fakeFetch = (async () => ({ ok: true, status: 200 } as Response)) as unknown as typeof fetch
  const res = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "I'm doing fine", lastAssistantTurn: "Glad to hear" },
    { fetchImpl: fakeFetch, ...SKIP }
  )
  assert.equal(res.matched, 0)
  assert.equal(res.fired, 0)
})

test("runDownstreamConnector: never throws; surfaces error in records", async () => {
  const { db } = makeFirestore()
  await saveTrigger(db, trig(), { actor: "x" })
  const fakeFetch = (async () => {
    throw new Error("ECONNREFUSED")
  }) as unknown as typeof fetch
  const res = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "ByteDance", lastAssistantTurn: "" },
    { fetchImpl: fakeFetch, ...SKIP }
  )
  // firePostHook converts thrown errors to {ok:false, errorMsg}; recordFire still runs.
  assert.equal(res.records.length, 1)
  assert.equal(res.records[0]?.fired, true)
  assert.match(res.records[0]?.errorMsg ?? "", /ECONNREFUSED/)
})

test("runDownstreamConnector: skips disabled triggers; honors enable flag", async () => {
  const { db } = makeFirestore()
  await saveTrigger(db, trig({ enabled: false }), { actor: "x" })
  const fakeFetch = (async () => ({ ok: true, status: 200 } as Response)) as unknown as typeof fetch
  const res = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "ByteDance", lastAssistantTurn: "" },
    { fetchImpl: fakeFetch, ...SKIP }
  )
  assert.equal(res.fired, 0)
})

test("runDownstreamConnector: llm-judge invokes provided judge function", async () => {
  const { db } = makeFirestore()
  await saveTrigger(
    db,
    trig({
      triggerId: "trig_layoff",
      condition: { kind: "llm-judge", config: { judgePrompt: "is layoff?" } },
    }),
    { actor: "x" }
  )
  let judgeCalled = false
  const fakeFetch = (async () => ({ ok: true, status: 200 } as Response)) as unknown as typeof fetch
  const res = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "I just got laid off", lastAssistantTurn: "" },
    {
      fetchImpl: fakeFetch,
      llmJudge: async () => {
        judgeCalled = true
        return "yes"
      },
      ...SKIP,
    }
  )
  assert.equal(judgeCalled, true)
  assert.equal(res.fired, 1)
})

// ---------------------------------------------------------------------------
// Master kill switch (Phase 30 — `evalConnectorsEnabled` flag)
// ---------------------------------------------------------------------------

test("kill switch OFF (no flag doc, default): connector exits without firing", async () => {
  _clearFeatureFlagCache()
  const { db, store } = makeFirestore()
  await saveTrigger(db, trig(), { actor: "x" })
  let fetchCalls = 0
  const fakeFetch = (async () => {
    fetchCalls += 1
    return { ok: true, status: 200 } as Response
  }) as unknown as typeof fetch
  const res = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "ByteDance", lastAssistantTurn: "" },
    { fetchImpl: fakeFetch }
  )
  assert.equal(res.matched, 0)
  assert.equal(res.fired, 0)
  assert.equal(fetchCalls, 0)
  assert.equal(store.fires.size, 0)
})

test("kill switch ON (flag=true via setFlag): connector fires normally", async () => {
  const { db, store } = makeFirestore()
  await enableConnector(db)
  await saveTrigger(db, trig(), { actor: "x" })
  const fakeFetch = (async () => ({ ok: true, status: 200 } as Response)) as unknown as typeof fetch
  const res = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "ByteDance", lastAssistantTurn: "" },
    { fetchImpl: fakeFetch }
  )
  assert.equal(res.fired, 1)
  assert.equal(store.fires.size, 1)
})

test("kill switch env override (evalConnectorsEnabled=1): bypasses Firestore flag", async () => {
  _clearFeatureFlagCache()
  const { db } = makeFirestore()
  await saveTrigger(db, trig(), { actor: "x" })
  const fakeFetch = (async () => ({ ok: true, status: 200 } as Response)) as unknown as typeof fetch
  const res = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "ByteDance", lastAssistantTurn: "" },
    { fetchImpl: fakeFetch, env: { [EVAL_CONNECTORS_FLAG]: "1" } }
  )
  assert.equal(res.fired, 1)
})

test("skipFlagCheck:true: bypass kill switch (admin debug endpoint)", async () => {
  _clearFeatureFlagCache()
  const { db } = makeFirestore()
  await saveTrigger(db, trig(), { actor: "x" })
  const fakeFetch = (async () => ({ ok: true, status: 200 } as Response)) as unknown as typeof fetch
  // No flag doc, no env override — only skipFlagCheck=true should let it run.
  const res = await runDownstreamConnector(
    db,
    { userId: "u1", lastUserTurn: "ByteDance", lastAssistantTurn: "" },
    { fetchImpl: fakeFetch, skipFlagCheck: true }
  )
  assert.equal(res.fired, 1)
})

test("withSoftBudget: returns work when work resolves before timeout", async () => {
  const r = await withSoftBudget(Promise.resolve("ok"), 1000, "fallback")
  assert.equal(r, "ok")
})

test("withSoftBudget: returns fallback after timeout (work continues in bg)", async () => {
  let bgFinished = false
  const slow = new Promise<string>((resolve) => {
    setTimeout(() => {
      bgFinished = true
      resolve("late")
    }, 50)
  })
  const r = await withSoftBudget(slow, 5, "fast-fallback")
  assert.equal(r, "fast-fallback")
  // Wait for bg to finish.
  await slow
  assert.equal(bgFinished, true)
})
