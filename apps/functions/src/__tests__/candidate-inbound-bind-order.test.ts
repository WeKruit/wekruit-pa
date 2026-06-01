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

  it("phone = unique key: opener token candidate ALREADY has a DIFFERENT phone → no cross-bind, no throw", async () => {
    // Adam policy 2026-05-29 — different phone = different entity. The opener
    // names cand-aaaa01 (who owns +14155550100) but arrives from +14155550999.
    // We must NOT bind the new number to cand-aaaa01 and must NOT throw (no
    // stuck `running` event). The texted phone has no owner → resolve null.
    const { db, store } = makeFakeDb({
      users: {
        "cand-aaaa01": { id: "cand-aaaa01", email: "a@example.com", phoneE164: "+14155550100" },
      },
    })

    const result = await resolveInboundUserId(db, "+14155550999", "Hello, WeKruit! cand-aaaa01")
    assert.equal(result, null, "different phone → not cross-bound; texted phone unowned → null")

    const userDoc = store.get("pa-users")!.get("cand-aaaa01")!
    assert.equal(
      userDoc.phoneE164,
      "+14155550100",
      "existing pa-users.phoneE164 unchanged — no cross-bind",
    )
  })

  it("malformed stored phone is replaceable by a Sendblue-confirmed opener phone", async () => {
    const { db, store } = makeFakeDb({
      users: {
        "cand-aaaa01": { id: "cand-aaaa01", email: "a@example.com", phoneE164: "+08149313759" },
      },
    })

    const result = await resolveInboundUserId(
      db,
      "+12693203158",
      "WeKruit_hs-11005308-paradigm-gtm-growth_cand-aaaa01_Job",
    )

    assert.equal(result, "cand-aaaa01")
    const userDoc = store.get("pa-users")!.get("cand-aaaa01")!
    assert.equal(userDoc.phoneE164, "+12693203158")
    const phoneHandles = [...store.get("pa-candidate-handles")!.values()].filter((h) => h.kind === "phone")
    assert.equal(phoneHandles.length, 1)
    assert.equal(phoneHandles[0]!.candidateId, "cand-aaaa01")
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

  it("phone = unique key: phone owned by A via handle, opener names B → resolve to A, never bind B, never throw", async () => {
    // Phone +14155550100 is already linked to cand-aaaa01 via the hashed phone
    // handle. A new inbound from that phone shows up with an opener naming
    // cand-bbbb02. Phone is the unique key → resolve to the phone owner A; do
    // NOT bind/steal the phone for B and do NOT throw (no stuck event). B stays
    // clean. (A is found via lookupUserByPhoneE164's handle-owner fallback.)
    const { hashCandidateHandle } = await import("@pa/pa-persistence")
    const { handleId } = hashCandidateHandle("phone", "+14155550100")
    const { db, store } = makeFakeDb({
      users: {
        "cand-bbbb02": { id: "cand-bbbb02", email: "b@example.com" },
        "cand-aaaa01": { id: "cand-aaaa01", email: "a@example.com", phoneE164: "+14155550100" },
      },
      handles: {
        [handleId]: {
          handleId,
          candidateId: "cand-aaaa01",
          kind: "phone",
          handleHash: "fake-hash-aaaaaaaaaaaaaaaa",
          normalizedValue: "+14155550100",
          source: "candidate",
          verifiedAt: null,
          deliverable: true,
          createdAt: "2026-05-20T00:00:00.000Z",
        },
      },
    })

    const result = await resolveInboundUserId(db, "+14155550100", "Hello, WeKruit! cand-bbbb02")
    assert.equal(result, "cand-aaaa01", "phone owner A wins, not opener-named B")

    const userDocB = store.get("pa-users")!.get("cand-bbbb02")!
    assert.equal(
      userDocB.phoneE164,
      undefined,
      "cand-bbbb02.phoneE164 untouched — phone never cross-bound to B",
    )
  })

  it("DEV_BYPASS_PHONE (+14243201960): opener for a new candidate releases prior owner + reassigns handle", async () => {
    // Adam's dev/test phone is the ONLY phone for which the opener may
    // override existing ownership. This relaxed path is unreachable for
    // any other E.164 number.
    const { hashCandidateHandle } = await import("@pa/pa-persistence")
    const { handleId } = hashCandidateHandle("phone", "+14243201960")
    const { db, store } = makeFakeDb({
      users: {
        "cand-bbbb02": { id: "cand-bbbb02", email: "b@example.com" },
        "cand-aaaa01": {
          id: "cand-aaaa01",
          email: "a@example.com",
          phoneE164: "+14243201960",
        },
      },
      handles: {
        [handleId]: {
          handleId,
          candidateId: "cand-aaaa01",
          kind: "phone",
          handleHash: "fake-hash-bbbbbbbbbbbbbbbb",
          normalizedValue: "+14243201960",
          source: "candidate",
          verifiedAt: null,
          deliverable: true,
          createdAt: "2026-05-20T00:00:00.000Z",
        },
      },
    })

    const result = await resolveInboundUserId(db, "+14243201960", "Hello, WeKruit! cand-bbbb02")
    assert.equal(result, "cand-bbbb02", "dev bypass: opener wins")

    // Prior owner released (phone field nulled on the dev-bypass path).
    const ownerDoc = store.get("pa-users")!.get("cand-aaaa01")!
    assert.equal(ownerDoc.phoneE164, null, "prior owner phoneE164 cleared")
    // New owner has the phone.
    const newOwnerDoc = store.get("pa-users")!.get("cand-bbbb02")!
    assert.equal(newOwnerDoc.phoneE164, "+14243201960", "new owner phoneE164 written")
    // Handle reassigned.
    const handleDoc = store.get("pa-candidate-handles")!.get(handleId)!
    assert.equal(handleDoc.candidateId, "cand-bbbb02", "phone handle reassigned to new candidate")
  })

  it("phone = unique key: same-phone duplicates (Yogesh) are merged into the oldest entity on opener", async () => {
    // Two profiles signed up with different emails but the SAME phone. The
    // candidate texts the opener FROM that phone. The resolver merges the dups
    // (oldest createdAt canonical) and recognizes the merged entity — keeping
    // both emails + both userIds. Phone is the unique identity key.
    const phone = "+18303265553"
    const canonicalId = "Uu3ZeLnEMyyIMBFHV3uM" // older
    const dupId = "ECyfCDNOCg2SEH8CzlRQ" // newer
    const { db, store } = makeFakeDb({
      users: {
        [canonicalId]: {
          id: canonicalId,
          email: "yogeshsavirigana@gmail.com",
          phoneE164: phone,
          createdAt: "2026-05-29T17:44:22.000Z",
          tags: { skills: ["python"] },
        },
        [dupId]: {
          id: dupId,
          email: "yogi.savirigana1996@gmail.com",
          phoneE164: phone,
          createdAt: "2026-05-29T17:46:11.000Z",
          tags: { skills: ["react"] },
        },
      },
    })

    const result = await resolveInboundUserId(db, phone, `Hello, WeKruit! ${canonicalId}`)
    assert.equal(result, canonicalId, "resolves to the oldest-createdAt canonical entity")

    const dupDoc = store.get("pa-users")!.get(dupId)!
    assert.equal(dupDoc.mergedInto, canonicalId, "duplicate tombstoned into canonical")
    const canonicalDoc = store.get("pa-users")!.get(canonicalId)!
    assert.deepEqual(
      (canonicalDoc.tags as Record<string, unknown>).skills,
      ["python", "react"],
      "tags unioned",
    )
    assert.deepEqual(canonicalDoc.altEmails, ["yogi.savirigana1996@gmail.com"], "both emails kept")
    assert.deepEqual(canonicalDoc.aliasUserIds, [dupId], "both userIds kept as aliases")
  })
})
