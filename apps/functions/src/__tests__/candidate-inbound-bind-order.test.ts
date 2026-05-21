/**
 * Identity hardening 2026-05-21 — `bindPhoneToCandidate` ordering tests.
 *
 * Background: the previous implementation wrote `pa-users.phoneE164`
 * BEFORE running the handle conflict check, so when a phone was already
 * owned by another candidate, the conflict was raised AFTER pa-users had
 * been polluted with the conflicting phone. These tests lock in the new
 * order: (1) read existing pa-users.phoneE164 → reject on mismatch,
 * (2) linkCandidateHandle (throws identity_conflict on cross-candidate),
 * (3) ONLY then write pa-users.phoneE164.
 *
 * The invariant Adam locked 2026-05-21: one pa-users = one phone.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"

import { resolveInboundUserId } from "../candidate-inbound-resolve.js"

type DocData = Record<string, unknown>
type Store = Map<string, Map<string, DocData>>

function makeFakeDb(seed: { users?: Record<string, DocData>; handles?: Record<string, DocData> } = {}) {
  const store: Store = new Map()
  store.set("pa-users", new Map(Object.entries(seed.users ?? {})))
  store.set("pa-candidate-handles", new Map(Object.entries(seed.handles ?? {})))
  store.set("pa-identity-events", new Map())
  store.set("pa-identity-conflicts", new Map())

  function docRef(coll: string, id: string) {
    const map = store.get(coll) ?? new Map()
    if (!store.has(coll)) store.set(coll, map)
    return {
      async get() {
        const data = map.get(id)
        return { id, exists: data !== undefined, data: () => data }
      },
      async set(data: DocData, opts?: { merge?: boolean }) {
        const prev = map.get(id) ?? {}
        map.set(id, opts?.merge ? { ...prev, ...data } : { ...data })
      },
      async update(data: DocData) {
        map.set(id, { ...(map.get(id) ?? {}), ...data })
      },
      async delete() {
        map.delete(id)
      },
    }
  }
  function collection(coll: string) {
    const map = store.get(coll) ?? new Map()
    if (!store.has(coll)) store.set(coll, map)
    return {
      doc(id?: string) {
        return docRef(coll, id ?? `auto_${map.size + 1}`)
      },
      where(field: string, op: string, val: unknown) {
        return {
          limit(_n: number) { return this },
          async get() {
            const matches = [...map.entries()]
              .filter(([_, d]) => op === "==" && d[field] === val)
              .map(([id, d]) => ({ id, data: () => d }))
            return { docs: matches, empty: matches.length === 0 }
          },
        }
      },
    }
  }
  const db = {
    collection,
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      return fn({})
    },
  } as unknown as Firestore
  return { db, store }
}

describe("bindPhoneToCandidate ordering (identity hardening 2026-05-21)", () => {
  it("happy path: opener bind on candidate with no existing phone writes both handle + pa-users.phoneE164", async () => {
    const { db, store } = makeFakeDb({
      users: {
        "cand-aaaa01": { id: "cand-aaaa01", email: "a@example.com" },
      },
    })
    const result = await resolveInboundUserId(db, "+14155550100", "Hello, WeKruit! cand-aaaa01")

    assert.equal(result, "cand-aaaa01")
    const userDoc = store.get("pa-users")!.get("cand-aaaa01")!
    assert.equal(userDoc.phoneE164, "+14155550100", "pa-users.phoneE164 written")
    assert.ok(userDoc.updatedAt, "updatedAt stamped")
    const handlesColl = store.get("pa-candidate-handles")!
    const phoneHandles = [...handlesColl.values()].filter((h) => h.kind === "phone")
    assert.equal(phoneHandles.length, 1, "single phone handle linked")
    assert.equal(phoneHandles[0]!.candidateId, "cand-aaaa01")
  })

  it("guard G1: opener token candidate ALREADY has a different phone → reject WITHOUT polluting pa-users", async () => {
    const { db, store } = makeFakeDb({
      users: {
        "cand-aaaa01": { id: "cand-aaaa01", email: "a@example.com", phoneE164: "+14155550100" },
      },
    })

    await assert.rejects(
      async () => {
        await resolveInboundUserId(db, "+14155550999", "Hello, WeKruit! cand-aaaa01")
      },
      /identity_conflict:pa_users_phone_mismatch/,
    )

    const userDoc = store.get("pa-users")!.get("cand-aaaa01")!
    assert.equal(
      userDoc.phoneE164,
      "+14155550100",
      "existing pa-users.phoneE164 unchanged after rejected bind",
    )
  })

  it("guard G3: opener token candidate ALREADY has the SAME phone (re-text) → no error, no-op", async () => {
    const { db, store } = makeFakeDb({
      users: {
        "cand-aaaa01": { id: "cand-aaaa01", email: "a@example.com", phoneE164: "+14155550100" },
      },
    })

    const result = await resolveInboundUserId(db, "+14155550100", "Hello, WeKruit! cand-aaaa01")
    assert.equal(result, "cand-aaaa01", "lookup matches existing phone on pa-users (byPhone path)")
    assert.equal(
      store.get("pa-users")!.get("cand-aaaa01")!.phoneE164,
      "+14155550100",
      "phone unchanged",
    )
  })

  it("phone already linked to another candidate: lookupUserByPhoneE164 short-circuits to the OWNING candidate — opener is ignored, no cross-candidate pollution", async () => {
    // Phone is already linked to cand-aaaa01 via pa-candidate-handles
    // (e.g. a prior bind happened). A new inbound from the same phone
    // shows up with an opener token pointing at cand-bbbb02 (different
    // candidate). The phone handle is authoritative: the resolver MUST
    // return cand-aaaa01 (the existing owner) and not bind cand-bbbb02.
    // This preserves the "one phone = one candidate" invariant without
    // ever touching cand-bbbb02.
    const { hashCandidateHandle } = await import("@pa/pa-persistence")
    const { handleId } = hashCandidateHandle("phone", "+14155550100")
    const { db, store } = makeFakeDb({
      users: {
        "cand-bbbb02": { id: "cand-bbbb02", email: "b@example.com" },
        "cand-aaaa01": { id: "cand-aaaa01", email: "a@example.com" },
      },
      handles: {
        [handleId]: {
          handleId,
          candidateId: "cand-aaaa01",
          kind: "phone",
          handleHash: "fake-hash",
          normalizedValue: "+14155550100",
          source: "candidate",
          createdAt: "2026-05-20T00:00:00.000Z",
        },
      },
    })

    const result = await resolveInboundUserId(db, "+14155550100", "Hello, WeKruit! cand-bbbb02")
    assert.equal(result, "cand-aaaa01", "phone handle wins, opener token ignored")

    const userDocB = store.get("pa-users")!.get("cand-bbbb02")!
    assert.equal(
      userDocB.phoneE164,
      undefined,
      "cand-bbbb02.phoneE164 untouched — handle index already owns this phone",
    )
  })
})
