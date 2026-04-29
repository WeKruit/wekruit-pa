import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  PERSONAS_COLLECTION,
  composePersonaPrompt,
  composePersonaPromptFromDoc,
  getPersona,
  listPersonas,
  revertPersona,
  seedDefaultPersonas,
  upsertPersona,
} from "./personas.js"

// Test fake Firestore — same as playbooks.test.ts
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

test("upsertPersona writes doc + audit and bumps version", async () => {
  const { db, store } = fakeFirestore()
  const saved = await upsertPersona(
    db,
    "anxious_grad",
    {
      name: "Anxious",
      description: "test",
      soul: "soul body",
      style: "style body",
      examples: "examples body",
      enabled: true,
    },
    { actor: "t", reason: "seed" }
  )
  assert.equal(saved.version, 1)
  assert.equal(saved.soul, "soul body")

  const stored = store.get(PERSONAS_COLLECTION)?.get("anxious_grad")
  assert.ok(stored)

  const audit = [...(store.get(PA_COLLECTIONS.auditEvents)?.values() ?? [])]
  assert.equal(audit.length, 1)
  assert.equal((audit[0] as { action: string }).action, "persona.create")

  const updated = await upsertPersona(
    db,
    "anxious_grad",
    { soul: "soul v2" },
    { actor: "t", reason: "tweak" }
  )
  assert.equal(updated.version, 2)
  assert.equal(updated.soul, "soul v2")
  assert.equal(updated.style, "style body") // preserved
})

test("upsertPersona rejects empty reason", async () => {
  const { db } = fakeFirestore()
  await assert.rejects(
    () =>
      upsertPersona(
        db,
        "x",
        { name: "x", soul: "", style: "", examples: "" },
        { actor: "t", reason: "" }
      ),
    /reason is required/
  )
})

test("composePersonaPromptFromDoc concatenates SOUL/STYLE/EXAMPLES with headers", () => {
  const composed = composePersonaPromptFromDoc({
    personaKey: "x",
    name: "x",
    description: "",
    soul: "soul-body",
    style: "style-body",
    examples: "examples-body",
    enabled: true,
    version: 1,
    updatedAt: null,
    updatedBy: "",
    reason: "",
  })
  assert.match(composed, /^# SOUL\nsoul-body/)
  assert.match(composed, /# STYLE\nstyle-body/)
  assert.match(composed, /# EXAMPLES\nexamples-body/)
  // SOUL comes before STYLE comes before EXAMPLES
  assert.ok(composed.indexOf("SOUL") < composed.indexOf("STYLE"))
  assert.ok(composed.indexOf("STYLE") < composed.indexOf("EXAMPLES"))
})

test("composePersonaPromptFromDoc skips empty sections", () => {
  const composed = composePersonaPromptFromDoc({
    personaKey: "x",
    name: "x",
    description: "",
    soul: "only-soul",
    style: "",
    examples: "",
    enabled: true,
    version: 1,
    updatedAt: null,
    updatedBy: "",
    reason: "",
  })
  assert.match(composed, /^# SOUL\nonly-soul$/)
  assert.doesNotMatch(composed, /# STYLE/)
  assert.doesNotMatch(composed, /# EXAMPLES/)
})

test("composePersonaPrompt returns null for missing or disabled persona", async () => {
  const { db } = fakeFirestore()
  // Missing
  assert.equal(await composePersonaPrompt(db, "missing"), null)
  // Disabled
  await upsertPersona(
    db,
    "disabled",
    { name: "d", soul: "x", style: "", examples: "", enabled: false },
    { reason: "s" }
  )
  assert.equal(await composePersonaPrompt(db, "disabled"), null)
  // Enabled
  await upsertPersona(
    db,
    "ok",
    { name: "ok", soul: "soul", style: "style", examples: "ex", enabled: true },
    { reason: "s" }
  )
  const composed = await composePersonaPrompt(db, "ok")
  assert.ok(composed && composed.includes("# SOUL"))
})

test("seedDefaultPersonas creates 3 personas idempotently", async () => {
  const { db } = fakeFirestore()
  const r1 = await seedDefaultPersonas(db)
  assert.equal(r1.created.length, 3)
  assert.deepEqual(r1.created.sort(), ["anxious_grad", "formal_em", "vent_seeker"])

  const list = await listPersonas(db)
  assert.equal(list.length, 3)
  for (const p of list) {
    assert.ok(p.soul.length > 0, `${p.personaKey} soul should be populated`)
    assert.ok(p.style.length > 0, `${p.personaKey} style should be populated`)
    assert.ok(p.examples.length > 0, `${p.personaKey} examples should be populated`)
  }

  const r2 = await seedDefaultPersonas(db)
  assert.equal(r2.created.length, 0)
  assert.equal(r2.skipped.length, 3)
})

test("revertPersona restores previous soul via last non-revert audit row", async () => {
  const { db, store } = fakeFirestore()
  await upsertPersona(
    db,
    "anxious_grad",
    { name: "A", soul: "v1 soul", style: "s", examples: "e" },
    { actor: "t", reason: "seed" }
  )
  await upsertPersona(
    db,
    "anxious_grad",
    { soul: "v2 soul" },
    { actor: "t", reason: "edit" }
  )
  const auditMap = store.get(PA_COLLECTIONS.auditEvents)!
  const stamps = ["2026-04-28T00:00:00Z", "2026-04-28T00:00:01Z"]
  let i = 0
  for (const [, raw] of auditMap.entries()) {
    ;(raw as Record<string, unknown>).ts = stamps[i++] ?? "2026-04-28T00:00:99Z"
  }

  const reverted = await revertPersona(db, "anxious_grad", { actor: "t", reason: "rolling back" })
  assert.equal(reverted.soul, "v1 soul")
  assert.equal(reverted.version, 3)

  const restored = await getPersona(db, "anxious_grad")
  assert.equal(restored?.soul, "v1 soul")
})
