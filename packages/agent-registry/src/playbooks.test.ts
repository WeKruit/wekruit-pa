import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  PLAYBOOKS_COLLECTION,
  composePlaybooks,
  compileTriggers,
  getPlaybook,
  listPlaybooks,
  matchPlaybooks,
  revertPlaybook,
  seedDefaultPlaybooks,
  upsertPlaybook,
  type Playbook,
} from "./playbooks.js"

// ---------------------------------------------------------------------------
// Test fake Firestore — same shape as handbook.test.ts (where/orderBy/limit
// supported, db.batch() supported).
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

test("upsertPlaybook writes doc + audit and bumps version", async () => {
  const { db, store } = fakeFirestore()
  const saved = await upsertPlaybook(
    db,
    "headhunter",
    {
      name: "Headhunter",
      description: "job-search",
      regexTriggers: ["想换", "offer"],
      addendum: "# PLAYBOOK MODE",
      enabled: true,
    },
    { actor: "tester@wekruit.com", reason: "initial seed" }
  )
  assert.equal(saved.version, 1)
  assert.deepEqual(saved.regexTriggers, ["想换", "offer"])

  const stored = store.get(PLAYBOOKS_COLLECTION)?.get("headhunter")
  assert.ok(stored)
  assert.equal(stored?.version, 1)

  const audit = [...(store.get(PA_COLLECTIONS.auditEvents)?.values() ?? [])]
  assert.equal(audit.length, 1)
  assert.equal((audit[0] as { action: string }).action, "playbook.create")

  // Second save bumps to v2
  const updated = await upsertPlaybook(
    db,
    "headhunter",
    { addendum: "# new body" },
    { actor: "tester", reason: "tweak" }
  )
  assert.equal(updated.version, 2)
  assert.equal(updated.regexTriggers.length, 2) // preserved from prev
  assert.equal(updated.addendum, "# new body")
})

test("upsertPlaybook rejects empty reason", async () => {
  const { db } = fakeFirestore()
  await assert.rejects(
    () =>
      upsertPlaybook(
        db,
        "x",
        { name: "x", regexTriggers: [], addendum: "" },
        { actor: "t", reason: "" }
      ),
    /reason is required/
  )
})

test("compileTriggers compiles valid regex and skips invalid", () => {
  const compiled = compileTriggers(["想换", "(invalid", "offer"])
  assert.equal(compiled.length, 2)
  assert.ok(compiled[0]!.test("想换工作"))
  assert.ok(compiled[1]!.test("got an offer"))
})

test("matchPlaybooks returns matched playbooks; disabled excluded", () => {
  const playbooks: Playbook[] = [
    {
      playbookKey: "headhunter",
      name: "Headhunter",
      description: "",
      regexTriggers: ["想换", "offer"],
      addendum: "addendum-headhunter",
      enabled: true,
      version: 1,
      updatedAt: null,
      updatedBy: "",
      reason: "",
    },
    {
      playbookKey: "celebrate",
      name: "Celebrate",
      description: "",
      regexTriggers: ["promo", "升职"],
      addendum: "addendum-celebrate",
      enabled: false, // disabled — should not match even if regex hits
      version: 1,
      updatedAt: null,
      updatedBy: "",
      reason: "",
    },
  ]
  const matched1 = matchPlaybooks("我想换工作", playbooks)
  assert.equal(matched1.length, 1)
  assert.equal(matched1[0]!.playbookKey, "headhunter")

  // Disabled doesn't match
  const matched2 = matchPlaybooks("got promo", playbooks)
  assert.equal(matched2.length, 0)

  // Benign message
  const matched3 = matchPlaybooks("今天天气不错", playbooks)
  assert.equal(matched3.length, 0)
})

test("composePlaybooks loads from Firestore and concatenates addenda", async () => {
  const { db } = fakeFirestore()
  await upsertPlaybook(
    db,
    "headhunter",
    {
      name: "Headhunter",
      regexTriggers: ["想换"],
      addendum: "BODY-1",
      enabled: true,
    },
    { reason: "seed" }
  )
  await upsertPlaybook(
    db,
    "vent",
    {
      name: "Vent",
      regexTriggers: ["崩溃"],
      addendum: "BODY-2",
      enabled: true,
    },
    { reason: "seed" }
  )
  // Single-match
  const r1 = await composePlaybooks(db, "想换工作")
  assert.equal(r1.matched.length, 1)
  assert.equal(r1.addendum, "BODY-1")
  // Multi-match
  const r2 = await composePlaybooks(db, "我想换工作但快崩溃了")
  assert.equal(r2.matched.length, 2)
  assert.match(r2.addendum, /BODY-1/)
  assert.match(r2.addendum, /BODY-2/)
  // No match
  const r3 = await composePlaybooks(db, "天气真好")
  assert.equal(r3.matched.length, 0)
  assert.equal(r3.addendum, "")
})

test("seedDefaultPlaybooks is idempotent — creates all 6 then skips", async () => {
  const { db } = fakeFirestore()
  const r1 = await seedDefaultPlaybooks(db)
  // Adam iter 18 — added 5 playbooks (vent / motivation / jd_roast /
  // interview_prep / negotiation) on top of the original headhunter.
  assert.deepEqual(r1.created, [
    "headhunter",
    "vent_support",
    "motivation_nudge",
    "jd_roast",
    "interview_prep",
    "negotiation",
  ])
  assert.deepEqual(r1.skipped, [])

  const stored = await getPlaybook(db, "headhunter")
  assert.ok(stored)
  assert.ok(stored!.regexTriggers.includes("想换"))
  assert.match(stored!.addendum, /PLAYBOOK MODE: HEADHUNTER/)

  // Spot-check one of the new ones.
  const ventStored = await getPlaybook(db, "vent_support")
  assert.ok(ventStored)
  assert.ok(ventStored!.regexTriggers.some((p) => p.includes("崩溃")))
  assert.match(ventStored!.addendum, /PLAYBOOK MODE: VENT_SUPPORT/)

  const r2 = await seedDefaultPlaybooks(db)
  assert.deepEqual(r2.created, [])
  assert.deepEqual(r2.skipped, [
    "headhunter",
    "vent_support",
    "motivation_nudge",
    "jd_roast",
    "interview_prep",
    "negotiation",
  ])
})

test("listPlaybooks returns playbooks sorted by key", async () => {
  const { db } = fakeFirestore()
  await upsertPlaybook(db, "vent", { name: "v", regexTriggers: ["崩"], addendum: "" }, { reason: "s" })
  await upsertPlaybook(db, "headhunter", { name: "h", regexTriggers: ["想"], addendum: "" }, { reason: "s" })
  await upsertPlaybook(db, "celebrate", { name: "c", regexTriggers: ["升"], addendum: "" }, { reason: "s" })
  const rows = await listPlaybooks(db)
  assert.deepEqual(rows.map((r) => r.playbookKey), ["celebrate", "headhunter", "vent"])
})

test("revertPlaybook restores previous addendum via last non-revert audit row", async () => {
  const { db, store } = fakeFirestore()
  await upsertPlaybook(
    db,
    "headhunter",
    { name: "H", regexTriggers: ["想换"], addendum: "v1 body" },
    { actor: "t", reason: "seed" }
  )
  await upsertPlaybook(
    db,
    "headhunter",
    { addendum: "v2 body" },
    { actor: "t", reason: "edit" }
  )
  const auditMap = store.get(PA_COLLECTIONS.auditEvents)!
  const stamps = ["2026-04-28T00:00:00Z", "2026-04-28T00:00:01Z"]
  let i = 0
  for (const [, raw] of auditMap.entries()) {
    ;(raw as Record<string, unknown>).ts = stamps[i++] ?? "2026-04-28T00:00:99Z"
  }

  const reverted = await revertPlaybook(db, "headhunter", { actor: "t", reason: "rolling back" })
  assert.equal(reverted.addendum, "v1 body")
  assert.equal(reverted.version, 3)

  const events = [...auditMap.values()]
  const revertRow = events.find(
    (e) => (e as { reason?: string }).reason?.includes("playbook.revert")
  )
  assert.ok(revertRow, "revert audit row should be recorded")
})
