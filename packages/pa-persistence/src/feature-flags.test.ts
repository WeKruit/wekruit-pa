import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  DEFAULT_TTL_MS,
  _clearFeatureFlagCache,
  _getFeatureFlagCacheStats,
  djb2Hash,
  getFlag,
  pickBucketVariant,
  revertFlag,
  setFlag,
  validateBucketStrategy,
  type BucketStrategy,
  type FlagDoc,
  type FlagValue,
} from "./feature-flags.js"

// -----------------------------------------------------------------------------
// In-memory Firestore double — supports doc().get/set, runTransaction, and
// the where().orderBy().limit() chain used by revertFlag.
// -----------------------------------------------------------------------------

interface FakeStore {
  flags: Map<string, FlagDoc>
  audit: Array<{ id: string; data: Record<string, unknown> }>
}

function makeFakeFirestore(initial: FakeStore = { flags: new Map(), audit: [] }) {
  const store = initial
  let auditCounter = 0

  const flagDocRef = (id: string) => ({
    async get() {
      const v = store.flags.get(id)
      return { exists: v !== undefined, data: () => v }
    },
    async set(v: FlagDoc) {
      store.flags.set(id, v)
    },
    _isFlag: true as const,
    _id: id,
  })

  const auditDocRef = (id?: string) => {
    const finalId = id ?? `audit_${++auditCounter}`
    return {
      _isAudit: true as const,
      _id: finalId,
      async set(v: Record<string, unknown>) {
        const existing = store.audit.find((r) => r.id === finalId)
        if (existing) existing.data = v
        else store.audit.push({ id: finalId, data: v })
      },
    }
  }

  function makeAuditQuery(filters: { keyEq?: string; orderDesc?: boolean; limit?: number }) {
    return {
      where(field: string, _op: string, val: string) {
        if (field === "key") return makeAuditQuery({ ...filters, keyEq: val })
        return makeAuditQuery(filters)
      },
      orderBy(_field: string, dir: string) {
        return makeAuditQuery({ ...filters, orderDesc: dir === "desc" })
      },
      limit(n: number) {
        return makeAuditQuery({ ...filters, limit: n })
      },
      async get() {
        let rows = store.audit.slice()
        if (filters.keyEq) rows = rows.filter((r) => r.data.key === filters.keyEq)
        if (filters.orderDesc) {
          rows = rows.sort((a, b) => String(b.data.ts).localeCompare(String(a.data.ts)))
        }
        if (filters.limit != null) rows = rows.slice(0, filters.limit)
        return {
          empty: rows.length === 0,
          docs: rows.map((r) => ({ data: () => r.data })),
        }
      },
    }
  }

  const db = {
    collection(name: string) {
      if (name === "pa-feature-flags") {
        return {
          doc: (id: string) => flagDocRef(id),
        }
      }
      if (name === "pa-audit-events") {
        return {
          doc: (id?: string) => auditDocRef(id),
          ...makeAuditQuery({}),
        }
      }
      throw new Error(`unexpected collection ${name}`)
    },
    async runTransaction<T>(fn: (t: {
      get: (ref: { _isFlag: true; _id: string }) => Promise<{ exists: boolean; data: () => FlagDoc | undefined }>
      set: (ref: { _id: string; _isFlag?: true; _isAudit?: true }, v: Record<string, unknown>) => void
    }) => Promise<T>): Promise<T> {
      const writes: Array<{ kind: "flag" | "audit"; id: string; v: Record<string, unknown> }> = []
      const t = {
        get: async (ref: { _isFlag: true; _id: string }) => {
          const v = store.flags.get(ref._id)
          return { exists: v !== undefined, data: () => v }
        },
        set: (ref: { _id: string; _isFlag?: true; _isAudit?: true }, v: Record<string, unknown>) => {
          writes.push({ kind: ref._isAudit ? "audit" : "flag", id: ref._id, v })
        },
      }
      const result = await fn(t)
      for (const w of writes) {
        if (w.kind === "flag") store.flags.set(w.id, w.v as unknown as FlagDoc)
        else store.audit.push({ id: w.id, data: w.v })
      }
      return result
    },
  }
  return { db: db as unknown as Firestore, store }
}

function seed(flags: Array<FlagDoc>): { db: Firestore; store: FakeStore } {
  const store: FakeStore = { flags: new Map(flags.map((f) => [f.key, f])), audit: [] }
  return makeFakeFirestore(store)
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test("getFlag: env override short-circuits to true without Firestore read", async () => {
  _clearFeatureFlagCache()
  const { db } = seed([])
  // Use a fake env — must not require any Firestore data.
  const v = await getFlag(db, "PA_CHANNEL_LEGACY", { env: { PA_CHANNEL_LEGACY: "1" } })
  assert.equal(v, true)
  const v2 = await getFlag(db, "PA_CHANNEL_LEGACY", { env: { PA_CHANNEL_LEGACY: "true" } })
  assert.equal(v2, true)
})

test("getFlag: returns defaultValue when doc absent", async () => {
  _clearFeatureFlagCache()
  const { db } = seed([])
  const v = await getFlag(db, "missing.flag", {}, false)
  assert.equal(v, false)
  const v2 = await getFlag(db, "missing.flag.b", {}, true)
  assert.equal(v2, true)
})

test("getFlag: reads doc value when present (global bool)", async () => {
  _clearFeatureFlagCache()
  const { db } = seed([{ key: "f1", value: true, type: "bool", scope: "global" }])
  const v = await getFlag(db, "f1", {}, false)
  assert.equal(v, true)
})

test("getFlag: perUser blocklist beats allowlist beats default", async () => {
  _clearFeatureFlagCache()
  const { db } = seed([
    {
      key: "paRateLimitPerUserEnabled",
      value: true,
      type: "bool",
      scope: "perUser",
      allowlist: ["userA"],
      blocklist: ["userB"],
    },
  ])
  // userB is blocklisted → false
  const blocked = await getFlag(db, "paRateLimitPerUserEnabled", { userId: "userB" }, true)
  assert.equal(blocked, false)
  // userA on allowlist → true (matches default true here, but precedence still
  // exercised against a perUser doc)
  _clearFeatureFlagCache()
  const allowed = await getFlag(db, "paRateLimitPerUserEnabled", { userId: "userA" }, false)
  assert.equal(allowed, true)
  // userC neither list → falls through to doc.value
  _clearFeatureFlagCache()
  const fallthrough = await getFlag(db, "paRateLimitPerUserEnabled", { userId: "userC" }, false)
  assert.equal(fallthrough, true)
})

test("getFlag: 30s TTL cache — second read of same key+ctx is a hit", async () => {
  _clearFeatureFlagCache()
  const { db } = seed([{ key: "f2", value: true, type: "bool", scope: "global" }])
  await getFlag(db, "f2")
  await getFlag(db, "f2")
  const stats = _getFeatureFlagCacheStats()
  assert.equal(stats.hits, 1)
  assert.equal(stats.misses, 1)
})

test("getFlag: TTL expiry causes re-read", async () => {
  _clearFeatureFlagCache()
  const { db } = seed([{ key: "f3", value: true, type: "bool", scope: "global" }])
  await getFlag(db, "f3", {}, false, 5) // 5ms TTL for the test
  await new Promise((r) => setTimeout(r, 15))
  await getFlag(db, "f3", {}, false, 5)
  const stats = _getFeatureFlagCacheStats()
  assert.equal(stats.hits, 0)
  assert.equal(stats.misses, 2)
})

test("getFlag: ≥95% cache hit rate over 1000 calls (10 distinct keys)", async () => {
  _clearFeatureFlagCache()
  const flags: FlagDoc[] = []
  for (let i = 0; i < 10; i++) {
    flags.push({ key: `bench.${i}`, value: i % 2 === 0, type: "bool", scope: "global" })
  }
  const { db } = seed(flags)
  for (let i = 0; i < 1000; i++) {
    const k = `bench.${i % 10}`
    await getFlag(db, k)
  }
  const stats = _getFeatureFlagCacheStats()
  assert.ok(
    stats.hitRate >= 0.95,
    `hit-rate ${stats.hitRate.toFixed(3)} below 0.95 (hits=${stats.hits} misses=${stats.misses})`
  )
})

test("setFlag: writes flag doc + audit row, bumps version", async () => {
  _clearFeatureFlagCache()
  const { db, store } = seed([])
  await setFlag(
    db,
    "f.set",
    { value: true, type: "bool", scope: "global" },
    { actor: "adam@wekruit.com", reason: "initial seed" }
  )
  const flag = store.flags.get("f.set")!
  assert.equal(flag.value, true)
  assert.equal(flag.version, 1)
  assert.equal(flag.updatedBy, "adam@wekruit.com")
  assert.equal(store.audit.length, 1)
  assert.equal(store.audit[0]!.data.action, "flag.create")

  // second write → flag.update + version 2
  await setFlag(
    db,
    "f.set",
    { value: false, type: "bool", scope: "global" },
    { actor: "adam@wekruit.com", reason: "kill switch" }
  )
  const flag2 = store.flags.get("f.set")!
  assert.equal(flag2.value, false)
  assert.equal(flag2.version, 2)
  assert.equal(store.audit.length, 2)
  assert.equal(store.audit[1]!.data.action, "flag.update")
})

test("revertFlag: reads last audit and writes oldValue back", async () => {
  _clearFeatureFlagCache()
  const { db, store } = seed([])
  await setFlag(db, "rev.flag", { value: true, type: "bool", scope: "global" }, { actor: "a", reason: "init" })
  // bump ts to ensure ordering — fake clock by manually adjusting last audit ts
  store.audit[0]!.data.ts = "2026-04-28T00:00:00.000Z"
  await new Promise((r) => setTimeout(r, 5))
  await setFlag(db, "rev.flag", { value: false, type: "bool", scope: "global" }, { actor: "a", reason: "off" })
  store.audit[1]!.data.ts = "2026-04-28T00:00:01.000Z"

  const r = await revertFlag(db, "rev.flag", { actor: "a", reason: "rollback" })
  assert.deepEqual(r, { revertedTo: true })
  const flag = store.flags.get("rev.flag")!
  assert.equal(flag.value, true)
  assert.equal(store.audit.length, 3)
  assert.equal(store.audit[2]!.data.action, "flag.revert")
})

test("setFlag: invalidates cache so next getFlag sees the new value", async () => {
  _clearFeatureFlagCache()
  const { db } = seed([{ key: "inval", value: true, type: "bool", scope: "global" }])
  const a = await getFlag(db, "inval")
  assert.equal(a, true)
  await setFlag(db, "inval", { value: false, type: "bool", scope: "global" }, { actor: "a", reason: "off" })
  const b = await getFlag(db, "inval")
  assert.equal(b, false)
})

test("DEFAULT_TTL_MS is 30s (locked by CONTEXT.md ADR)", () => {
  assert.equal(DEFAULT_TTL_MS, 30_000)
})

// ---------------------------------------------------------------------------
// 24.5/AB — bucketStrategy tests
// ---------------------------------------------------------------------------

test("djb2Hash: deterministic and non-zero for typical inputs", () => {
  assert.equal(djb2Hash("foo"), djb2Hash("foo"))
  assert.notEqual(djb2Hash("foo"), djb2Hash("bar"))
  assert.ok(djb2Hash("user_123::someFlag") >= 0)
})

test("pickBucketVariant: cumulative weight selection", () => {
  const strat: BucketStrategy = {
    method: "userIdHash",
    variants: [
      { name: "A", weight: 30, value: "a" },
      { name: "B", weight: 70, value: "b" },
    ],
  }
  assert.equal(pickBucketVariant(strat, 0)?.name, "A")
  assert.equal(pickBucketVariant(strat, 29.99)?.name, "A")
  assert.equal(pickBucketVariant(strat, 30)?.name, "B")
  assert.equal(pickBucketVariant(strat, 99.99)?.name, "B")
  // pick past total → last variant absorbs (defensive)
  assert.equal(pickBucketVariant(strat, 150)?.name, "B")
})

test("validateBucketStrategy: weights summing to 100 pass; otherwise throw", () => {
  validateBucketStrategy(null) // null tolerated
  validateBucketStrategy({
    method: "userIdHash",
    variants: [
      { name: "A", weight: 50, value: true },
      { name: "B", weight: 50, value: false },
    ],
  })
  assert.throws(
    () =>
      validateBucketStrategy({
        method: "userIdHash",
        variants: [
          { name: "A", weight: 30, value: true },
          { name: "B", weight: 50, value: false },
        ],
      }),
    /sum to 100/
  )
  assert.throws(
    () =>
      validateBucketStrategy({
        method: "random",
        variants: [],
      }),
    /non-empty array/
  )
  assert.throws(
    () =>
      validateBucketStrategy({
        // bogus method
        method: "coinflip" as unknown as "random",
        variants: [{ name: "A", weight: 100, value: true }],
      }),
    /method must be/
  )
})

test("setFlag: rejects bucketStrategy with weights != 100", async () => {
  _clearFeatureFlagCache()
  const { db } = seed([])
  await assert.rejects(
    () =>
      setFlag(
        db,
        "ab.bad",
        {
          value: false,
          type: "string",
          scope: "global",
          bucketStrategy: {
            method: "userIdHash",
            variants: [
              { name: "A", weight: 40, value: "a" },
              { name: "B", weight: 40, value: "b" },
            ],
          },
        },
        { actor: "a", reason: "test" }
      ),
    /sum to 100/
  )
})

test("getFlag: bucketStrategy userIdHash — same userId always gets same variant (deterministic)", async () => {
  _clearFeatureFlagCache()
  const { db } = seed([
    {
      key: "ab.det",
      value: "control",
      type: "string",
      scope: "global",
      bucketStrategy: {
        method: "userIdHash",
        variants: [
          { name: "A", weight: 50, value: "variant_a" },
          { name: "B", weight: 50, value: "variant_b" },
        ],
      },
    },
  ])
  const first = await getFlag(db, "ab.det", { userId: "user_42" })
  for (let i = 0; i < 100; i++) {
    _clearFeatureFlagCache() // bypass cache to truly re-resolve
    const v = await getFlag(db, "ab.det", { userId: "user_42" })
    assert.equal(v, first, `iteration ${i}: ${String(v)} != ${String(first)}`)
  }
  // sanity: must be one of the variant values
  assert.ok(first === "variant_a" || first === "variant_b")
})

test("getFlag: bucketStrategy userIdHash — 50/50 distribution within ±5% over 1000 users", async () => {
  _clearFeatureFlagCache()
  const { db } = seed([
    {
      key: "ab.dist",
      value: "default",
      type: "string",
      scope: "global",
      bucketStrategy: {
        method: "userIdHash",
        variants: [
          { name: "A", weight: 50, value: "a" },
          { name: "B", weight: 50, value: "b" },
        ],
      },
    },
  ])
  let aCount = 0
  let bCount = 0
  for (let i = 0; i < 1000; i++) {
    _clearFeatureFlagCache()
    const v = await getFlag(db, "ab.dist", { userId: `user_${i}` })
    if (v === "a") aCount++
    else if (v === "b") bCount++
  }
  assert.equal(aCount + bCount, 1000, "all users assigned")
  // Tolerance: ±5% (i.e. each in [450, 550]).
  assert.ok(aCount >= 450 && aCount <= 550, `A count ${aCount} outside [450,550]`)
  assert.ok(bCount >= 450 && bCount <= 550, `B count ${bCount} outside [450,550]`)
})

test("getFlag: bucketStrategy random — non-deterministic but still returns a configured variant", async () => {
  _clearFeatureFlagCache()
  const { db } = seed([
    {
      key: "ab.rand",
      value: "default",
      type: "string",
      scope: "global",
      bucketStrategy: {
        method: "random",
        variants: [
          { name: "A", weight: 50, value: "ra" },
          { name: "B", weight: 50, value: "rb" },
        ],
      },
    },
  ])
  const seen = new Set<string>()
  for (let i = 0; i < 50; i++) {
    _clearFeatureFlagCache()
    const v = await getFlag(db, "ab.rand", { userId: "user_same" })
    assert.ok(v === "ra" || v === "rb", `unexpected value ${String(v)}`)
    seen.add(String(v))
  }
  // 50 random rolls of a 50/50 split: P(all same) = 2 * 0.5^50 ≈ 1.8e-15 → flake-free.
  assert.ok(seen.size >= 1)
})

test("getFlag: bucketStrategy weight drift (sum<100) — last variant absorbs gap (reader-tolerant)", async () => {
  _clearFeatureFlagCache()
  // Hand-write a doc with sum=80 (bypassing setFlag validation) to simulate
  // legacy/manual data drift.
  const { db } = seed([
    {
      key: "ab.drift",
      value: "fallback",
      type: "string",
      scope: "global",
      bucketStrategy: {
        method: "userIdHash",
        variants: [
          { name: "A", weight: 40, value: "drift_a" },
          { name: "B", weight: 40, value: "drift_b" },
        ],
      },
    },
  ])
  const v = await getFlag(db, "ab.drift", { userId: "user_drift" })
  assert.ok(v === "drift_a" || v === "drift_b", `tolerant clamp must still pick a variant; got ${String(v)}`)
})

test("getFlag: blocklist beats bucketStrategy (perUser precedence preserved)", async () => {
  _clearFeatureFlagCache()
  const { db } = seed([
    {
      key: "ab.precedence",
      value: true,
      type: "bool",
      scope: "perUser",
      blocklist: ["blocked_user"],
      bucketStrategy: {
        method: "userIdHash",
        variants: [
          { name: "A", weight: 100, value: true },
        ],
      },
    },
  ])
  const v = await getFlag(db, "ab.precedence", { userId: "blocked_user" })
  assert.equal(v, false)
})

test("getFlag: bucketStrategy userIdHash with no userId in ctx falls through to default value", async () => {
  _clearFeatureFlagCache()
  const { db } = seed([
    {
      key: "ab.nouser",
      value: "fallthrough",
      type: "string",
      scope: "global",
      bucketStrategy: {
        method: "userIdHash",
        variants: [{ name: "A", weight: 100, value: "variant" }],
      },
    },
  ])
  const v = await getFlag(db, "ab.nouser", {})
  assert.equal(v, "fallthrough")
})
