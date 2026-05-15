/**
 * Phase B3 — downstream-connector tag-side-effects integration tests.
 *
 * Verifies that when a matched downstream trigger fires, the corresponding
 * tag write lands on `pa-users/{userId}.tags`:
 *   - `mentioned_layoff` → `urgentlySeeking = true`
 *   - `mentioned_negative_company` → append `companyNegativeList`
 *   - `mentioned_positive_company` → append `companyPositiveList` + seed
 *                                    `targetCompanyTags`
 *
 * Also exercises idempotency (no duplicate entries on repeat snippet) and
 * the 30-entry cap (newest candidate dropped, oldest preserved).
 *
 * Mirrors the in-memory Firestore double from `downstream.test.ts` and
 * extends it with a `users` collection so writes via `applyPartialUserTags`
 * (the sole writer) can be asserted.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  TRIGGERS_COLLECTION,
  TRIGGER_FIRES_COLLECTION,
  saveTrigger,
  type Trigger,
} from "@pa/pa-persistence"
import { runDownstreamConnector } from "../downstream.js"
import {
  appendCompanyList,
  TAG_LIST_CAP,
  extractCompanyNames,
} from "../tag-side-effects.js"

const USERS_COLLECTION = "pa-users"
const AUDIT_COLLECTION = "pa-audit-events"
const FLAGS_COLLECTION = "pa-feature-flags"

interface Row {
  id: string
  data: Record<string, unknown>
}
interface FakeStore {
  triggers: Map<string, Row>
  fires: Map<string, Row>
  audit: Map<string, Row>
  flags: Map<string, Row>
  users: Map<string, Row>
}

function makeFirestore(): { db: Firestore; store: FakeStore } {
  const store: FakeStore = {
    triggers: new Map(),
    fires: new Map(),
    audit: new Map(),
    flags: new Map(),
    users: new Map(),
  }
  let counter = 0
  function getMap(name: string): Map<string, Row> {
    if (name === TRIGGERS_COLLECTION) return store.triggers
    if (name === TRIGGER_FIRES_COLLECTION) return store.fires
    if (name === AUDIT_COLLECTION) return store.audit
    if (name === FLAGS_COLLECTION) return store.flags
    if (name === USERS_COLLECTION) return store.users
    throw new Error(`unexpected collection ${name}`)
  }
  function deepMerge(
    cur: Record<string, unknown>,
    upd: Record<string, unknown>
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...cur }
    for (const [k, v] of Object.entries(upd)) {
      if (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        cur[k] &&
        typeof cur[k] === "object" &&
        !Array.isArray(cur[k])
      ) {
        out[k] = deepMerge(
          cur[k] as Record<string, unknown>,
          v as Record<string, unknown>
        )
      } else {
        out[k] = v
      }
    }
    return out
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
        if (cur && opts?.merge) map.set(id, { id, data: deepMerge(cur.data, v) })
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

const SKIP = { skipFlagCheck: true } as const
const okFetch = (async () => ({ ok: true, status: 200 } as Response)) as unknown as typeof fetch

function layoffTrigger(): Trigger {
  return {
    triggerId: "mentioned_layoff",
    name: "Mentioned layoff",
    enabled: true,
    condition: {
      kind: "llm-judge",
      config: { judgePrompt: "Did the user mention layoff?" },
    },
    endpoint: { url: "https://example.invalid/layoff" },
    payloadTemplate: '{"u":"{{userId}}"}',
    cooldownSec: 60,
  }
}

function negCompanyTrigger(): Trigger {
  return {
    triggerId: "mentioned_negative_company",
    name: "Mentioned negative company",
    enabled: true,
    condition: {
      kind: "llm-judge",
      config: { judgePrompt: "Did the user reject a company?" },
    },
    endpoint: { url: "https://example.invalid/neg" },
    payloadTemplate: '{"u":"{{userId}}"}',
    cooldownSec: 60,
  }
}

function posCompanyTrigger(): Trigger {
  return {
    triggerId: "mentioned_positive_company",
    name: "Mentioned positive company",
    enabled: true,
    condition: {
      kind: "llm-judge",
      config: { judgePrompt: "Did the user love a company?" },
    },
    endpoint: { url: "https://example.invalid/pos" },
    payloadTemplate: '{"u":"{{userId}}"}',
    cooldownSec: 60,
  }
}

function getUserTags(store: FakeStore, userId: string): Record<string, unknown> {
  const row = store.users.get(userId)
  if (!row) return {}
  const tags = (row.data as Record<string, unknown>).tags
  return (tags as Record<string, unknown>) ?? {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("mentioned_layoff: matched trigger writes urgentlySeeking=true", async () => {
  const { db, store } = makeFirestore()
  await saveTrigger(db, layoffTrigger(), { actor: "x" })

  const res = await runDownstreamConnector(
    db,
    { userId: "u-layoff", lastUserTurn: "I just got laid off last week", lastAssistantTurn: "" },
    { fetchImpl: okFetch, llmJudge: async () => "yes", ...SKIP }
  )
  assert.equal(res.fired, 1)
  const tags = getUserTags(store, "u-layoff")
  assert.equal(tags.urgentlySeeking, true)
})

test("mentioned_negative_company: appends 'walgreens' to companyNegativeList", async () => {
  const { db, store } = makeFirestore()
  await saveTrigger(db, negCompanyTrigger(), { actor: "x" })

  const res = await runDownstreamConnector(
    db,
    { userId: "u-neg", lastUserTurn: "I don't want Walgreens.", lastAssistantTurn: "" },
    { fetchImpl: okFetch, llmJudge: async () => "yes", ...SKIP }
  )
  assert.equal(res.fired, 1)
  const tags = getUserTags(store, "u-neg")
  assert.ok(Array.isArray(tags.companyNegativeList))
  assert.deepEqual(tags.companyNegativeList, ["walgreens"])
})

test("mentioned_positive_company: appends to positive list + seeds targetCompanyTags", async () => {
  const { db, store } = makeFirestore()
  await saveTrigger(db, posCompanyTrigger(), { actor: "x" })

  const res = await runDownstreamConnector(
    db,
    { userId: "u-pos", lastUserTurn: "I love Anthropic so much", lastAssistantTurn: "" },
    { fetchImpl: okFetch, llmJudge: async () => "yes", ...SKIP }
  )
  assert.equal(res.fired, 1)
  const tags = getUserTags(store, "u-pos")
  assert.deepEqual(tags.companyPositiveList, ["anthropic"])
  // Anthropic → ai_native via KNOWN_COMPANY_TAG
  assert.ok(Array.isArray(tags.targetCompanyTags))
  assert.ok((tags.targetCompanyTags as string[]).includes("ai_native"))
})

test("mentioned_positive_company: category keyword 'fintech' seeds targetCompanyTags", async () => {
  const { db, store } = makeFirestore()
  await saveTrigger(db, posCompanyTrigger(), { actor: "x" })

  const res = await runDownstreamConnector(
    db,
    { userId: "u-fintech", lastUserTurn: "I'm interested in fintech roles", lastAssistantTurn: "" },
    { fetchImpl: okFetch, llmJudge: async () => "yes", ...SKIP }
  )
  assert.equal(res.fired, 1)
  const tags = getUserTags(store, "u-fintech")
  assert.ok(Array.isArray(tags.targetCompanyTags))
  assert.ok((tags.targetCompanyTags as string[]).includes("fintech_unicorn"))
})

test("idempotency: appending same names twice does not duplicate entries", async () => {
  const { db, store } = makeFirestore()
  // Call the helper twice with the same payload to assert in-helper idempotency.
  await appendCompanyList(db, "u-idem", "companyNegativeList", ["Walgreens"])
  await appendCompanyList(db, "u-idem", "companyNegativeList", ["Walgreens", "walgreens"])

  const tags = getUserTags(store, "u-idem")
  assert.deepEqual(tags.companyNegativeList, ["walgreens"])
})

test("cap: companyNegativeList capped at 30, oldest preserved", async () => {
  const { db, store } = makeFirestore()
  // Pre-seed user with 30 existing entries.
  const existing = Array.from({ length: TAG_LIST_CAP }, (_, i) => `co-${i}`)
  await db
    .collection(USERS_COLLECTION)
    .doc("u-cap")
    .set({ tags: { companyNegativeList: existing } })

  // Append a new name — should be DROPPED because the list is at cap and
  // we preserve oldest.
  await appendCompanyList(db, "u-cap", "companyNegativeList", ["Walgreens"])

  const tags = getUserTags(store, "u-cap")
  const list = tags.companyNegativeList as string[]
  assert.equal(list.length, TAG_LIST_CAP)
  // Oldest (co-0) preserved; newest candidate (walgreens) NOT present.
  assert.equal(list[0], "co-0")
  assert.ok(!list.includes("walgreens"))
  // ensure store remains accessible (compile-time use)
  void store
})

test("extractCompanyNames: extracts capitalized multi-letter spans", () => {
  assert.deepEqual(extractCompanyNames("I don't want Walgreens."), ["Walgreens"])
  assert.deepEqual(extractCompanyNames("I love Anthropic and OpenAI"), ["Anthropic", "OpenAI"])
  // Stop words filtered.
  assert.deepEqual(extractCompanyNames("I am happy"), [])
  // Empty / non-string.
  assert.deepEqual(extractCompanyNames(""), [])
})
