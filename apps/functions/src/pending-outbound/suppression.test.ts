/**
 * suppression.test.ts — proves isSuppressed() honors EVERY opt-out signal and
 * fails CLOSED for the recovery kind.
 *
 * Uses the same in-memory Firestore fake shape as queue.test.ts. Each signal is
 * seeded in isolation and proven to suppress; the clear-profile case proves a
 * fully reachable, opted-in candidate is NOT suppressed.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { isSuppressed } from "./suppression.js"

type Store = Map<string, Map<string, Record<string, unknown>>>

const NOW = new Date("2026-06-01T12:00:00.000Z")
const now = () => NOW

function makeStore(): Store {
  return new Map(Object.values(PA_COLLECTIONS).map((name) => [name, new Map()]))
}

/**
 * Minimal Firestore fake: doc get/set + collection.where(...).limit(...).get().
 * `where` chains support equality predicates (candidateId == userId).
 */
function makeFakeFirestore(store: Store = makeStore()): { db: Firestore; store: Store } {
  function col(name: string): Map<string, Record<string, unknown>> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }

  function docRef(collectionName: string, id: string) {
    return {
      id,
      async get() {
        const data = col(collectionName).get(id)
        return { exists: data !== undefined, id, data: () => data }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const current = col(collectionName).get(id)
        col(collectionName).set(id, opts?.merge && current ? { ...current, ...data } : { ...data })
      },
    }
  }

  function makeQuery(
    collectionName: string,
    predicate: (data: Record<string, unknown>) => boolean,
    limitN: number | null
  ) {
    return {
      where(field: string, _op: string, value: unknown) {
        return makeQuery(collectionName, (data) => predicate(data) && data[field] === value, limitN)
      },
      limit(n: number) {
        return makeQuery(collectionName, predicate, n)
      },
      async get() {
        let entries = Array.from(col(collectionName).entries()).filter(([, data]) => predicate(data))
        if (limitN !== null) entries = entries.slice(0, limitN)
        return {
          empty: entries.length === 0,
          docs: entries.map(([id, data]) => ({ id, data: () => data })),
        }
      },
    }
  }

  function collection(collectionName: string) {
    const base = makeQuery(collectionName, () => true, null)
    return {
      doc(id: string) {
        return docRef(collectionName, id)
      },
      where: base.where,
      limit: base.limit,
      get: base.get,
    }
  }

  return { db: { collection } as unknown as Firestore, store }
}

function seedUser(store: Store, userId: string, data: Record<string, unknown>): void {
  store.get(PA_COLLECTIONS.users)!.set(userId, data)
}

const reachable = { phoneE164: "+14243201960" }

// ---------------------------------------------------------------------------
// Clear path
// ---------------------------------------------------------------------------

test("reachable, opted-in candidate is NOT suppressed", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u-clear", {
    ...reachable,
    candidateLifecycleState: "claimed",
    dailyJobRecSubscribe: { optedIn: true },
  })
  const res = await isSuppressed(db, "u-clear", { now })
  assert.equal(res.suppressed, false)
  assert.equal(res.reason, "clear")
  assert.equal(res.failedClosed, false)
})

// ---------------------------------------------------------------------------
// Per-user opt-out signals
// ---------------------------------------------------------------------------

test("candidateLifecycleState=opted_out suppresses", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { ...reachable, candidateLifecycleState: "opted_out" })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "lifecycle_opted_out")
})

test("candidateLifecycleState=deleted suppresses", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { ...reachable, candidateLifecycleState: "deleted" })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "lifecycle_deleted")
})

test("candidateLifecycle.state alias=opted_out suppresses", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { ...reachable, candidateLifecycle: { state: "opted_out" } })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "lifecycle_opted_out")
})

test("outreach.status=opted_out suppresses", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { ...reachable, outreach: { status: "opted_out" } })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "outreach_status_opted_out")
})

test("outreach.status=paused suppresses", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { ...reachable, outreach: { status: "paused" } })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "outreach_status_paused")
})

test("doNotContact=true suppresses", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { ...reachable, doNotContact: true })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "do_not_contact")
})

test("outreachPaused=true suppresses", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { ...reachable, outreachPaused: true })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "outreach_paused_flag")
})

test("dailyJobRecSubscribe.optedIn=false suppresses", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { ...reachable, dailyJobRecSubscribe: { optedIn: false } })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "daily_unsubscribed")
})

// ---------------------------------------------------------------------------
// Global kill switch
// ---------------------------------------------------------------------------

test("global outreach stop control suppresses everyone", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { ...reachable, candidateLifecycleState: "claimed" })
  store.get(PA_COLLECTIONS.outreachStopControls)!.set("global", { scope: "global", paused: true })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "global_outreach_paused")
})

// ---------------------------------------------------------------------------
// Filed-but-unprocessed privacy request (the core capture gap)
// ---------------------------------------------------------------------------

test("submitted stop_outreach privacy request suppresses even when pa-users is clean", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { ...reachable, candidateLifecycleState: "claimed", dailyJobRecSubscribe: { optedIn: true } })
  store.get(PA_COLLECTIONS.privacyRequests)!.set("pr-1", {
    candidateId: "u",
    kind: "stop_outreach",
    status: "submitted",
  })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "privacy_request_stop_outreach")
})

test("submitted delete privacy request suppresses", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { ...reachable, candidateLifecycleState: "claimed" })
  store.get(PA_COLLECTIONS.privacyRequests)!.set("pr-1", {
    candidateId: "u",
    kind: "delete",
    status: "in_review",
  })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "privacy_request_delete")
})

test("rejected/cancelled privacy request does NOT suppress", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { ...reachable, candidateLifecycleState: "claimed", dailyJobRecSubscribe: { optedIn: true } })
  store.get(PA_COLLECTIONS.privacyRequests)!.set("pr-1", {
    candidateId: "u",
    kind: "stop_outreach",
    status: "rejected",
  })
  store.get(PA_COLLECTIONS.privacyRequests)!.set("pr-2", {
    candidateId: "other-user",
    kind: "stop_outreach",
    status: "submitted",
  })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, false)
  assert.equal(res.reason, "clear")
})

test("export privacy request does NOT suppress outreach", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { ...reachable, candidateLifecycleState: "claimed", dailyJobRecSubscribe: { optedIn: true } })
  store.get(PA_COLLECTIONS.privacyRequests)!.set("pr-1", {
    candidateId: "u",
    kind: "export",
    status: "submitted",
  })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, false)
})

// ---------------------------------------------------------------------------
// Reachability + missing profile (fail-closed for recovery)
// ---------------------------------------------------------------------------

test("recovery fails closed when user profile is missing", async () => {
  const { db } = makeFakeFirestore()
  const res = await isSuppressed(db, "ghost", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "user_profile_missing")
  assert.equal(res.failedClosed, true)
})

test("recovery suppresses an unreachable (no phone) candidate", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", { candidateLifecycleState: "claimed" }) // no phoneE164
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "unreachable_no_phone")
  assert.equal(res.failedClosed, true)
})

test("empty userId fails closed", async () => {
  const { db } = makeFakeFirestore()
  const res = await isSuppressed(db, "", { now })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "missing_user_id")
  assert.equal(res.failedClosed, true)
})

// ---------------------------------------------------------------------------
// Fail-closed on read error (recovery) vs fail-open (other kinds)
// ---------------------------------------------------------------------------

test("recovery fails closed when pa-users read throws", async () => {
  const throwingDb = {
    collection(name: string) {
      if (name === PA_COLLECTIONS.outreachStopControls) {
        return { doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) }
      }
      if (name === PA_COLLECTIONS.users) {
        return { doc: () => ({ get: async () => { throw new Error("firestore down") } }) }
      }
      return { doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) }
    },
  } as unknown as Firestore
  const res = await isSuppressed(throwingDb, "u", { now, kind: "recovery" })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "user_read_failed")
  assert.equal(res.failedClosed, true)
})

test("non-recovery kind fails OPEN when user profile is missing", async () => {
  const { db } = makeFakeFirestore()
  const res = await isSuppressed(db, "ghost", { now, kind: "nudge" })
  assert.equal(res.suppressed, false)
  assert.equal(res.reason, "user_profile_missing_allow")
})

// ---------------------------------------------------------------------------
// Cooldown reporting + opt-in enforcement
// ---------------------------------------------------------------------------

test("cooldown is reported but does not block recovery by default", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", {
    ...reachable,
    candidateLifecycleState: "claimed",
    dailyJobRecSubscribe: { optedIn: true },
    outreach: { status: "allowed", lastOutboundAt: "2026-05-30T12:00:00.000Z" }, // 2d ago
  })
  const res = await isSuppressed(db, "u", { now })
  assert.equal(res.suppressed, false)
  assert.ok(res.signals.includes("recent_outbound"))
})

test("enforceCooldown=true blocks on recent outbound", async () => {
  const { db, store } = makeFakeFirestore()
  seedUser(store, "u", {
    ...reachable,
    candidateLifecycleState: "claimed",
    dailyJobRecSubscribe: { optedIn: true },
    outreach: { status: "allowed", cooldownUntil: "2026-06-05T12:00:00.000Z" }, // future
  })
  const res = await isSuppressed(db, "u", { now, enforceCooldown: true })
  assert.equal(res.suppressed, true)
  assert.equal(res.reason, "cooldown_until_future")
})
