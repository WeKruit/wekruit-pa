import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  HANDBOOK_DEFAULT_ORDER,
  HANDBOOK_SECTIONS_COLLECTION,
  composeSystemPrompt,
  loadHandbook,
  migrateBibleV7,
  parseBibleV7,
  revertSection,
  saveSection,
  type HandbookSection,
} from "./handbook.js"

// ---------------------------------------------------------------------------
// Test fake Firestore — supports doc/get/set, where/orderBy/limit/get,
// and `db.batch()`. Mirrors the lifecycle.test.ts pattern but adds
// `orderBy` so the audit-history revert path works.
// ---------------------------------------------------------------------------

type Filter = { field: string; op: string; value: unknown }
type Order = { field: string; dir: "asc" | "desc" }

function fakeFirestore(seed: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const store = new Map(
    Object.entries(seed).map(([name, docs]) => [name, new Map(Object.entries(docs))])
  )
  let counter = 0
  function genId() {
    counter++
    return `auto-${counter.toString(36)}-${Date.now().toString(36)}`
  }
  function colMap(name: string) {
    let rows = store.get(name)
    if (!rows) {
      rows = new Map()
      store.set(name, rows)
    }
    return rows
  }
  function makeDocRef(collectionName: string, id: string) {
    return {
      id,
      async get() {
        const data = colMap(collectionName).get(id)
        return { id, exists: data != null, data: () => data ?? {} }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const current = colMap(collectionName).get(id) ?? {}
        colMap(collectionName).set(
          id,
          opts?.merge ? { ...current, ...data } : { ...data }
        )
      },
    }
  }
  const db = {
    collection(collectionName: string) {
      const filters: Filter[] = []
      const orders: Order[] = []
      let max = Infinity
      const query = {
        where(field: string, op: string, value: unknown) {
          filters.push({ field, op, value })
          return query
        },
        orderBy(field: string, dir: "asc" | "desc" = "asc") {
          orders.push({ field, dir })
          return query
        },
        limit(n: number) {
          max = n
          return query
        },
        doc(id?: string) {
          return makeDocRef(collectionName, id ?? genId())
        },
        async get() {
          let rows = [...colMap(collectionName).entries()]
          for (const f of filters) {
            if (f.op !== "==") throw new Error(`unsupported op ${f.op}`)
            rows = rows.filter(([, data]) => data[f.field] === f.value)
          }
          for (const o of orders) {
            rows.sort(([, a], [, b]) => {
              const av = a[o.field] as string | number | undefined
              const bv = b[o.field] as string | number | undefined
              if (av === bv) return 0
              if (av === undefined) return 1
              if (bv === undefined) return -1
              return (av < bv ? -1 : 1) * (o.dir === "desc" ? -1 : 1)
            })
          }
          rows = rows.slice(0, max)
          return {
            empty: rows.length === 0,
            docs: rows.map(([id, data]) => ({ id, data: () => data })),
          }
        },
      }
      return query
    },
    batch() {
      const ops: Array<() => Promise<void>> = []
      const batch = {
        set(
          ref: { id: string } & {
            set: (d: Record<string, unknown>, o?: { merge?: boolean }) => Promise<void>
          },
          data: Record<string, unknown>,
          opts?: { merge?: boolean }
        ) {
          ops.push(async () => {
            await ref.set(data, opts)
          })
          return batch
        },
        async commit() {
          for (const op of ops) await op()
        },
      }
      return batch
    },
  }
  return { db: db as unknown as Firestore, store }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("composeSystemPrompt emits sections in order, skipping disabled", () => {
  const sections: HandbookSection[] = [
    {
      sectionKey: "identity",
      title: "IDENTITY",
      body: "Claire.",
      order: 0,
      version: 1,
      enabled: true,
      updatedAt: null,
      updatedBy: "",
      reason: "",
    },
    {
      sectionKey: "vocab",
      title: "VOCAB",
      body: "卷/摆烂",
      order: 8,
      version: 1,
      enabled: true,
      updatedAt: null,
      updatedBy: "",
      reason: "",
    },
    {
      sectionKey: "disabled",
      title: "DISABLED",
      body: "should not show",
      order: 5,
      version: 1,
      enabled: false,
      updatedAt: null,
      updatedBy: "",
      reason: "",
    },
  ]
  const out = composeSystemPrompt(sections)
  assert.match(out, /^# IDENTITY\nClaire\./)
  assert.match(out, /# VOCAB\n卷\/摆烂/)
  assert.doesNotMatch(out, /DISABLED/)
  // identity must come before vocab
  assert.ok(out.indexOf("IDENTITY") < out.indexOf("VOCAB"))
})

test("saveSection writes section + audit and bumps version", async () => {
  const { db, store } = fakeFirestore()
  const saved = await saveSection(
    db,
    "identity",
    { title: "IDENTITY", body: "Claire.", order: 0 },
    { actor: "tester@wekruit.com", reason: "initial seed" }
  )
  assert.equal(saved.version, 1)
  assert.equal(saved.body, "Claire.")
  assert.equal(saved.enabled, true)

  const stored = store.get(HANDBOOK_SECTIONS_COLLECTION)?.get("identity")
  assert.ok(stored)
  assert.equal(stored?.body, "Claire.")
  assert.equal(stored?.version, 1)

  const audit = [...(store.get(PA_COLLECTIONS.auditEvents)?.values() ?? [])]
  assert.equal(audit.length, 1)
  assert.equal(audit[0]?.action, "handbook.create")
  assert.equal(audit[0]?.key, "identity")
  assert.equal((audit[0] as { newValue: { body: string } }).newValue.body, "Claire.")

  // Second save bumps to v2 and records update.
  const updated = await saveSection(
    db,
    "identity",
    { body: "Claire revised." },
    { actor: "tester@wekruit.com", reason: "tweak" }
  )
  assert.equal(updated.version, 2)
  assert.equal(updated.title, "IDENTITY") // preserved from prev
  const auditAfter = [...(store.get(PA_COLLECTIONS.auditEvents)?.values() ?? [])]
  assert.equal(auditAfter.length, 2)
  const updateRow = auditAfter.find(
    (e) => (e as { action?: string }).action === "handbook.update"
  ) as { oldValue: { body: string }; newValue: { body: string } }
  assert.equal(updateRow.oldValue.body, "Claire.")
  assert.equal(updateRow.newValue.body, "Claire revised.")
})

test("saveSection rejects empty reason", async () => {
  const { db } = fakeFirestore()
  await assert.rejects(
    () =>
      saveSection(
        db,
        "identity",
        { body: "x" },
        { actor: "t", reason: "" }
      ),
    /reason is required/
  )
})

test("loadHandbook returns sections sorted by order then key", async () => {
  const { db } = fakeFirestore()
  await saveSection(db, "vocab", { title: "VOCAB", body: "v", order: 8 }, { reason: "seed" })
  await saveSection(db, "identity", { title: "IDENTITY", body: "i", order: 0 }, { reason: "seed" })
  await saveSection(db, "nevers", { title: "NEVERS", body: "n", order: 3 }, { reason: "seed" })
  const rows = await loadHandbook(db)
  assert.deepEqual(
    rows.map((r) => r.sectionKey),
    ["identity", "nevers", "vocab"]
  )
})

test("revertSection restores previous body via last non-revert audit row", async () => {
  const { db, store } = fakeFirestore()
  await saveSection(
    db,
    "identity",
    { title: "IDENTITY", body: "v1 body", order: 0 },
    { actor: "t", reason: "seed" }
  )
  await saveSection(
    db,
    "identity",
    { body: "v2 body" },
    { actor: "t", reason: "edit" }
  )
  // Stamp ts on each audit row so orderBy("ts","desc") works deterministically.
  const auditMap = store.get(PA_COLLECTIONS.auditEvents)!
  const stamps = ["2026-04-28T00:00:00Z", "2026-04-28T00:00:01Z"]
  let i = 0
  for (const [, raw] of auditMap.entries()) {
    ;(raw as Record<string, unknown>).ts = stamps[i++] ?? "2026-04-28T00:00:99Z"
  }

  const reverted = await revertSection(db, "identity", { actor: "t", reason: "rolling back" })
  assert.equal(reverted.body, "v1 body")
  assert.equal(reverted.version, 3) // bump on revert too

  // A fresh audit row with handbook.revert action should exist.
  const events = [...auditMap.values()]
  const revertRow = events.find(
    (e) => (e as { reason?: string }).reason?.includes("handbook.revert")
  )
  assert.ok(revertRow, "revert audit row should be recorded")
})

test("parseBibleV7 splits known headers into canonical sectionKeys", () => {
  const sample = `# IDENTITY
Claire (柯莱儿). EM.

# THE ONE RULE (every turn, no exceptions)
Be short.

# 5 NEVERs (global, override everything else)
1. NEVER PROBE
`
  const parsed = parseBibleV7(sample)
  const keys = parsed.map((s) => s.sectionKey)
  assert.deepEqual(keys, ["identity", "one-rule", "nevers"])
  assert.match(parsed[0]!.body, /Claire/)
  assert.match(parsed[2]!.body, /NEVER PROBE/)
})

test("migrateBibleV7 reads agent.systemPrompt and writes one section per header", async () => {
  const sample = `# IDENTITY
Claire.

# THE ONE RULE (every turn, no exceptions)
Be short.

# DEFAULT POSTURE (apply before any turn-mode flavor)
1. SHORT.

# 5 NEVERs (global, override everything else)
1. NEVER PROBE.

# ESCAPE HATCH — only one
explicit ask only.

# TONE FLAVORS (color, not new rulesets — base = THE ONE RULE)
celebrate / vent.

# HUMAN TELLS (sparingly, ≤ 1 per turn — stacking = AI fishing)
hesitate.

# CODE-SWITCH + EMOJI
match user.

# VOCAB (use, never name back)
卷/摆烂.

# ROOMMATE
roommate text.
`
  const { db, store } = fakeFirestore({
    [PA_COLLECTIONS.agents]: {
      default: { id: "default", systemPrompt: sample },
    },
  })
  const result = await migrateBibleV7(db)
  assert.equal(result.written, 10)
  // All 10 canonical keys present.
  for (const def of HANDBOOK_DEFAULT_ORDER) {
    const stored = store.get(HANDBOOK_SECTIONS_COLLECTION)?.get(def.sectionKey)
    assert.ok(stored, `expected section ${def.sectionKey} to be written`)
  }
  // Compose round-trips: order preserved (identity first, roommate last).
  const sections = await loadHandbook(db)
  const composed = composeSystemPrompt(sections)
  assert.ok(composed.indexOf("IDENTITY") < composed.indexOf("ROOMMATE"))
  assert.match(composed, /Claire\./)
  assert.match(composed, /roommate text\./)
})
