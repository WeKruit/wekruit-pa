import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  checkRateLimit,
  getTemplate,
  getTemplateByEventKind,
  listTemplates,
  saveTemplate,
  UPSTREAM_FIRES_COLLECTION,
  UPSTREAM_TEMPLATES_COLLECTION,
} from "./upstream-events.js"

// -----------------------------------------------------------------------------
// In-memory Firestore double — supports doc().get/set/update,
// where()/orderBy()/limit(), runTransaction, and collection().get().
// -----------------------------------------------------------------------------

type Store = Map<string, Map<string, Record<string, unknown>>>

function makeFakeFirestore(): Firestore {
  const store: Store = new Map()
  store.set(UPSTREAM_TEMPLATES_COLLECTION, new Map())
  store.set(UPSTREAM_FIRES_COLLECTION, new Map())

  function getCol(name: string): Map<string, Record<string, unknown>> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }

  const docRef = (col: string, id: string) => ({
    id,
    _col: col,
    _id: id,
    async get() {
      const data = getCol(col).get(id)
      return { exists: data !== undefined, data: () => data, id }
    },
    async set(data: Record<string, unknown>) {
      getCol(col).set(id, { ...data })
    },
    async update(data: Record<string, unknown>) {
      const cur = getCol(col).get(id) ?? {}
      getCol(col).set(id, { ...cur, ...data })
    },
  })

  function makeQuery(col: string, filters: { field?: string; val?: unknown }[] = [], lim?: number) {
    return {
      where(field: string, _op: string, val: unknown) {
        return makeQuery(col, [...filters, { field, val }], lim)
      },
      limit(n: number) {
        return makeQuery(col, filters, n)
      },
      async get() {
        const all = Array.from(getCol(col).entries())
        let rows = all.filter(([, data]) =>
          filters.every((f) => f.field == null || data[f.field] === f.val)
        )
        if (lim != null) rows = rows.slice(0, lim)
        return {
          empty: rows.length === 0,
          docs: rows.map(([id, data]) => ({ id, data: () => data })),
        }
      },
    }
  }

  const colRef = (name: string) => ({
    doc(id: string) {
      return docRef(name, id)
    },
    where(field: string, op: string, val: unknown) {
      return makeQuery(name).where(field, op, val)
    },
    limit(n: number) {
      return makeQuery(name).limit(n)
    },
    async get() {
      const rows = Array.from(getCol(name).entries())
      return { docs: rows.map(([id, data]) => ({ id, data: () => data })) }
    },
  })

  const fs = {
    collection: (name: string) => colRef(name),
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const t = {
        async get(ref: { _col: string; _id: string }) {
          const data = getCol(ref._col).get(ref._id)
          return { exists: data !== undefined, data: () => data }
        },
        set(ref: { _col: string; _id: string }, payload: Record<string, unknown>) {
          getCol(ref._col).set(ref._id, { ...payload })
        },
        update(ref: { _col: string; _id: string }, payload: Record<string, unknown>) {
          const cur = getCol(ref._col).get(ref._id) ?? {}
          getCol(ref._col).set(ref._id, { ...cur, ...payload })
        },
      }
      return await fn(t)
    },
  }
  return fs as unknown as Firestore
}

// -----------------------------------------------------------------------------
// saveTemplate / getTemplate / listTemplates / getTemplateByEventKind
// -----------------------------------------------------------------------------

test("saveTemplate creates doc with version=1", async () => {
  const db = makeFakeFirestore()
  const tpl = await saveTemplate(db, {
    templateId: "interview_scheduled",
    name: "Interview scheduled",
    eventKind: "interview_scheduled",
    updatedBy: "test@wekruit.com",
  })
  assert.equal(tpl.version, 1)
  assert.equal(tpl.channel, "imessage")
  assert.equal(tpl.rateLimitPerHour, 1)
  assert.equal(tpl.enabled, false)
})

test("saveTemplate bumps version on existing doc", async () => {
  const db = makeFakeFirestore()
  await saveTemplate(db, {
    templateId: "x",
    name: "X",
    eventKind: "x",
    updatedBy: "u",
  })
  const second = await saveTemplate(db, {
    templateId: "x",
    name: "X v2",
    eventKind: "x",
    updatedBy: "u",
  })
  assert.equal(second.version, 2)
  assert.equal(second.name, "X v2")
})

test("getTemplate returns null when absent", async () => {
  const db = makeFakeFirestore()
  assert.equal(await getTemplate(db, "missing"), null)
})

test("getTemplate returns saved doc", async () => {
  const db = makeFakeFirestore()
  await saveTemplate(db, {
    templateId: "x",
    name: "X",
    eventKind: "x",
    updatedBy: "u",
  })
  const got = await getTemplate(db, "x")
  assert.ok(got)
  assert.equal(got!.templateId, "x")
})

test("getTemplateByEventKind returns enabled match", async () => {
  const db = makeFakeFirestore()
  await saveTemplate(db, {
    templateId: "tpl-a",
    name: "A",
    eventKind: "interview_scheduled",
    enabled: true,
    updatedBy: "u",
  })
  const got = await getTemplateByEventKind(db, "interview_scheduled")
  assert.ok(got)
  assert.equal(got!.templateId, "tpl-a")
})

test("getTemplateByEventKind skips disabled and returns null", async () => {
  const db = makeFakeFirestore()
  await saveTemplate(db, {
    templateId: "tpl-a",
    name: "A",
    eventKind: "k",
    enabled: false,
    updatedBy: "u",
  })
  const got = await getTemplateByEventKind(db, "k")
  assert.equal(got, null)
})

test("listTemplates returns all docs", async () => {
  const db = makeFakeFirestore()
  await saveTemplate(db, {
    templateId: "a",
    name: "A",
    eventKind: "ka",
    updatedBy: "u",
  })
  await saveTemplate(db, {
    templateId: "b",
    name: "B",
    eventKind: "kb",
    updatedBy: "u",
  })
  const list = await listTemplates(db)
  assert.equal(list.length, 2)
})

// -----------------------------------------------------------------------------
// checkRateLimit
// -----------------------------------------------------------------------------

test("checkRateLimit allows up to limit then blocks", async () => {
  const db = makeFakeFirestore()
  const now = 1_700_000_000_000 // fixed bucket
  const r1 = await checkRateLimit(db, "tpl", "u1", 2, now)
  assert.equal(r1.allowed, true)
  assert.equal(r1.remaining, 1)
  const r2 = await checkRateLimit(db, "tpl", "u1", 2, now)
  assert.equal(r2.allowed, true)
  assert.equal(r2.remaining, 0)
  const r3 = await checkRateLimit(db, "tpl", "u1", 2, now)
  assert.equal(r3.allowed, false)
})

test("checkRateLimit isolates buckets across users", async () => {
  const db = makeFakeFirestore()
  const now = 1_700_000_000_000
  const ra = await checkRateLimit(db, "tpl", "u1", 1, now)
  const rb = await checkRateLimit(db, "tpl", "u2", 1, now)
  assert.equal(ra.allowed, true)
  assert.equal(rb.allowed, true)
})

test("checkRateLimit isolates buckets across hours", async () => {
  const db = makeFakeFirestore()
  const t1 = 1_700_000_000_000
  const t2 = t1 + 60 * 60 * 1000 + 1 // next hour
  const r1 = await checkRateLimit(db, "tpl", "u1", 1, t1)
  const r2 = await checkRateLimit(db, "tpl", "u1", 1, t1)
  const r3 = await checkRateLimit(db, "tpl", "u1", 1, t2)
  assert.equal(r1.allowed, true)
  assert.equal(r2.allowed, false)
  assert.equal(r3.allowed, true)
})
