import assert from "node:assert/strict"
import test from "node:test"

import { __test_verifyPartnerKey, __test_PARTNER_KEY_RE } from "../partner-users-api.js"

const KEYS_CSV = "key_layoffhedge_abc123def456,key_layoffheaven_xyz789"

test("verifyPartnerKey rejects missing api key", () => {
  const res = __test_verifyPartnerKey(undefined, undefined, KEYS_CSV, "*")
  assert.deepEqual(res, { ok: false, reason: "missing_api_key" })
})

test("verifyPartnerKey rejects malformed key shape", () => {
  const res = __test_verifyPartnerKey("not_a_key", undefined, KEYS_CSV, "*")
  assert.deepEqual(res, { ok: false, reason: "invalid_api_key_format" })
})

test("verifyPartnerKey rejects key not in CSV", () => {
  const res = __test_verifyPartnerKey("key_layoffhedge_wrongtail", undefined, KEYS_CSV, "*")
  assert.deepEqual(res, { ok: false, reason: "invalid_api_key" })
})

test("verifyPartnerKey rejects key whose prefix is not a PaUserSource", () => {
  // Add a key whose source slug isn't in PA_USER_SOURCES enum.
  const csv = "key_unknownpartner_abc123"
  const res = __test_verifyPartnerKey("key_unknownpartner_abc123", undefined, csv, "*")
  assert.deepEqual(res, { ok: false, reason: "key_partner_mismatch" })
})

test("verifyPartnerKey accepts valid layoffhedge key and returns partnerSource", () => {
  const res = __test_verifyPartnerKey("key_layoffhedge_abc123def456", undefined, KEYS_CSV, "*")
  assert.deepEqual(res, { ok: true, partnerSource: "layoffhedge" })
})

test("verifyPartnerKey enforces origin allowlist when set", () => {
  const allowlist = "https://layoffhedge.com,https://staging.layoffhedge.com"
  const ok = __test_verifyPartnerKey(
    "key_layoffhedge_abc123def456",
    "https://layoffhedge.com",
    KEYS_CSV,
    allowlist,
  )
  assert.deepEqual(ok, { ok: true, partnerSource: "layoffhedge" })

  const blocked = __test_verifyPartnerKey(
    "key_layoffhedge_abc123def456",
    "https://evil.example",
    KEYS_CSV,
    allowlist,
  )
  assert.deepEqual(blocked, { ok: false, reason: "origin_not_allowed" })
})

test("verifyPartnerKey server-to-server (no Origin) accepted on key alone", () => {
  const allowlist = "https://layoffhedge.com"
  const res = __test_verifyPartnerKey(
    "key_layoffhedge_abc123def456",
    undefined, // no Origin header
    KEYS_CSV,
    allowlist,
  )
  assert.deepEqual(res, { ok: true, partnerSource: "layoffhedge" })
})

test("PARTNER_KEY_RE captures multi-word slugs", () => {
  // Future partner with underscore in slug, e.g. `external_supply`
  const match = __test_PARTNER_KEY_RE.exec("key_external_supply_abc123")
  assert.ok(match)
  assert.equal(match![1], "external_supply")
})

import {
  __test_fetchPartnerUsers,
  type PartnerUsersFetchArgs,
  type PartnerUsersResponse,
} from "../partner-users-api.js"

// Minimal FakeFirestore mimicking the surface fetchPartnerUsers uses.
interface FakeDoc { id: string; data: Record<string, unknown> }
interface FakeStore { [collection: string]: FakeDoc[] }

function makeFakeDb(store: FakeStore): unknown {
  const queryFor = (path: string) => {
    type Filter = (doc: FakeDoc) => boolean
    type OrderEntry = { field: string; dir: "asc" | "desc" }
    const filters: Filter[] = []
    const orders: OrderEntry[] = []
    let lim: number | undefined
    let startAfterTuple: unknown[] | undefined

    const compare = (a: FakeDoc, b: FakeDoc): number => {
      for (const { field, dir } of orders) {
        const av = field === "__name__" ? a.id : (a.data[field] as number | string)
        const bv = field === "__name__" ? b.id : (b.data[field] as number | string)
        const cmp = av === bv ? 0 : av < bv ? -1 : 1
        if (cmp !== 0) return dir === "asc" ? cmp : -cmp
      }
      return 0
    }

    const obj: any = {
      where(field: string, op: string, value: unknown) {
        if (op === "==") filters.push((d) => d.data[field] === value)
        else if (op === ">") filters.push((d) => (d.data[field] as number) > (value as number))
        else throw new Error(`unsupported op ${op}`)
        return obj
      },
      orderBy(field: string, dir: "asc" | "desc" = "asc") {
        orders.push({ field, dir })
        return obj
      },
      limit(n: number) {
        lim = n
        return obj
      },
      startAfter(...vals: unknown[]) {
        startAfterTuple = vals
        return obj
      },
      async get() {
        let rows = (store[path] ?? []).filter((d) => filters.every((f) => f(d)))
        rows = rows.sort(compare)
        if (startAfterTuple) {
          rows = rows.filter((d) => {
            for (let i = 0; i < orders.length; i++) {
              const { field, dir } = orders[i]!
              const dv = field === "__name__" ? d.id : (d.data[field] as number | string)
              const sv = startAfterTuple![i] as number | string
              if (dv === sv) continue
              return dir === "desc" ? dv < sv : dv > sv
            }
            return false
          })
        }
        if (lim !== undefined) rows = rows.slice(0, lim)
        return { docs: rows.map((d) => ({ id: d.id, data: () => d.data })) }
      },
    }
    return obj
  }

  return {
    collection(path: string) {
      const base = queryFor(path)
      return {
        ...base,
        doc(id: string) {
          return {
            async get() {
              const d = (store[path] ?? []).find((x) => x.id === id)
              return { id, exists: !!d, data: () => d?.data ?? {} }
            },
          }
        },
      }
    },
  }
}

test("fetchPartnerUsers returns only users matching partnerSource", async () => {
  const store: FakeStore = {
    "pa-users": [
      { id: "uA", data: { source: "layoffhedge", email: "a@x.com", displayName: "A", createdAt: "2026-05-27T12:00:00Z", createdAtMs: 1779915600000 } },
      { id: "uB", data: { source: "candidate", email: "b@x.com", displayName: "B", createdAt: "2026-05-27T11:00:00Z", createdAtMs: 1779912000000 } },
      { id: "uC", data: { source: "layoffhedge", email: "c@x.com", displayName: "C", createdAt: "2026-05-27T10:00:00Z", createdAtMs: 1779908400000 } },
    ],
    "pa-candidate-job-states": [],
    "pa-jobs": [],
    "pa-prescreen-sessions": [],
  }
  const db = makeFakeDb(store) as Firestore
  const res = await __test_fetchPartnerUsers({
    db,
    partnerSource: "layoffhedge",
    limit: 50,
  })
  assert.equal(res.users.length, 2)
  assert.deepEqual(res.users.map((u) => u.wekruitUserId).sort(), ["uA", "uC"])
})

test("fetchPartnerUsers embeds jobs[] with state + jobTitle", async () => {
  const store: FakeStore = {
    "pa-users": [
      { id: "uA", data: { source: "layoffhedge", email: "a@x.com", displayName: "A", createdAt: "2026-05-27T12:00:00Z", createdAtMs: 1779915600000 } },
    ],
    "pa-candidate-job-states": [
      { id: "uA__hs-1", data: { candidateId: "uA", jobId: "hs-1", state: "prescreen_started", stateUpdatedAt: "2026-05-28T09:00:00Z", stateUpdatedAtMs: 1779984000000 } },
    ],
    "pa-jobs": [
      { id: "hs-1", data: { title: "Senior PM", company: "Invoko" } },
    ],
    "pa-prescreen-sessions": [
      { id: "pss_1", data: { candidateId: "uA", jobId: "hs-1", updatedAt: "2026-05-28T09:05:00Z", updatedAtMs: 1779984300000 } },
    ],
  }
  const db = makeFakeDb(store) as Firestore
  const res = await __test_fetchPartnerUsers({
    db,
    partnerSource: "layoffhedge",
    limit: 50,
  })
  assert.equal(res.users.length, 1)
  const u = res.users[0]!
  assert.equal(u.email, "a@x.com")
  assert.equal(u.name, "A")
  assert.equal(u.jobs.length, 1)
  const j = u.jobs[0]!
  assert.equal(j.jobId, "hs-1")
  assert.equal(j.state, "prescreen_started")
  assert.equal(j.jobTitle, "Senior PM")
  assert.equal(j.company, "Invoko")
  assert.equal(j.prescreenSessionId, "pss_1")
  assert.equal(j.wekruitJobUrl, "https://wekruit.com/j/hs-1")
})

test("fetchPartnerUsers paginates via cursor (createdAtMs + docId)", async () => {
  const users = Array.from({ length: 5 }, (_, i) => ({
    id: `u${i}`,
    data: { source: "layoffhedge", email: `u${i}@x.com`, displayName: `U${i}`, createdAt: `2026-05-27T1${i}:00:00Z`, createdAtMs: 1779900000000 + i * 1000 },
  }))
  const store: FakeStore = {
    "pa-users": users,
    "pa-candidate-job-states": [],
    "pa-jobs": [],
    "pa-prescreen-sessions": [],
  }
  const db = makeFakeDb(store) as Firestore
  const page1 = await __test_fetchPartnerUsers({ db, partnerSource: "layoffhedge", limit: 2 })
  assert.equal(page1.users.length, 2)
  assert.equal(page1.hasMore, true)
  assert.ok(page1.nextCursor)

  const page2 = await __test_fetchPartnerUsers({
    db,
    partnerSource: "layoffhedge",
    limit: 2,
    cursorOpaque: page1.nextCursor!,
  })
  assert.equal(page2.users.length, 2)
  assert.equal(page2.hasMore, true)

  const page3 = await __test_fetchPartnerUsers({
    db,
    partnerSource: "layoffhedge",
    limit: 2,
    cursorOpaque: page2.nextCursor!,
  })
  assert.equal(page3.users.length, 1)
  assert.equal(page3.hasMore, false)

  // All five distinct.
  const allIds = [...page1.users, ...page2.users, ...page3.users].map((u) => u.wekruitUserId)
  assert.deepEqual([...new Set(allIds)].sort(), ["u0", "u1", "u2", "u3", "u4"])
})

test("fetchPartnerUsers filters by status when provided", async () => {
  const store: FakeStore = {
    "pa-users": [
      { id: "uA", data: { source: "layoffhedge", email: "a@x.com", displayName: "A", createdAt: "2026-05-27T12:00:00Z", createdAtMs: 1779915600000 } },
      { id: "uB", data: { source: "layoffhedge", email: "b@x.com", displayName: "B", createdAt: "2026-05-27T11:00:00Z", createdAtMs: 1779912000000 } },
    ],
    "pa-candidate-job-states": [
      { id: "uA__hs-1", data: { candidateId: "uA", jobId: "hs-1", state: "passed", stateUpdatedAt: "2026-05-28T09:00:00Z", stateUpdatedAtMs: 1779984000000 } },
      { id: "uB__hs-2", data: { candidateId: "uB", jobId: "hs-2", state: "outbound_sent", stateUpdatedAt: "2026-05-28T09:00:00Z", stateUpdatedAtMs: 1779984000000 } },
    ],
    "pa-jobs": [
      { id: "hs-1", data: { title: "T1", company: "C1" } },
      { id: "hs-2", data: { title: "T2", company: "C2" } },
    ],
    "pa-prescreen-sessions": [],
  }
  const db = makeFakeDb(store) as Firestore
  const res = await __test_fetchPartnerUsers({
    db,
    partnerSource: "layoffhedge",
    limit: 50,
    status: ["passed"],
  })
  // Only uA appears because only uA has a job with state `passed`.
  assert.equal(res.users.length, 1)
  assert.equal(res.users[0]!.wekruitUserId, "uA")
})

test("fetchPartnerUsers cross-partner isolation: layoffhedge key cannot see candidate-bucket users", async () => {
  const store: FakeStore = {
    "pa-users": [
      { id: "uA", data: { source: "candidate", email: "a@x.com", displayName: "A", createdAt: "2026-05-27T12:00:00Z", createdAtMs: 1779915600000 } },
      { id: "uB", data: { source: "candidate", email: "b@x.com", displayName: "B", createdAt: "2026-05-27T11:00:00Z", createdAtMs: 1779912000000 } },
    ],
    "pa-candidate-job-states": [],
    "pa-jobs": [],
    "pa-prescreen-sessions": [],
  }
  const db = makeFakeDb(store) as Firestore
  const res = await __test_fetchPartnerUsers({
    db,
    partnerSource: "layoffhedge",
    limit: 50,
  })
  assert.equal(res.users.length, 0)
})
