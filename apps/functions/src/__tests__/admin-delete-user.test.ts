/**
 * Tests for the COMPLETE-delete-user admin capability, exercised via the pure
 * `runAdminDeleteUser` + `resolveDeleteTarget` + `authorizeWekruitAdmin` with an
 * injected fake Firestore (no live backend). The onCall wrapper is a thin shim
 * over these, so testing the pure handlers covers the real decision logic.
 *
 * Coverage:
 *  - resolve-by-phone (single match)
 *  - multi-doc phone disambiguation → ambiguous (requires explicit userId)
 *  - confirm-mismatch rejects
 *  - happy-path deletes ALL keyed collections + subcollections + mem0
 *  - idempotent on an already-deleted user (zero counts, no throw)
 *  - server auth gate: @wekruit.com passes, others rejected
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { HttpsError } from "firebase-functions/v2/https"
import {
  runAdminDeleteUser,
  resolveDeleteTarget,
  authorizeWekruitAdmin,
  USER_SCOPED_BY_USER_ID,
  USER_SCOPED_BY_CANDIDATE_ID,
  type AdminDeleteUserDeps,
} from "../admin-delete-user.js"

// ---------------------------------------------------------------------------
// Fake Firestore — supports collection().doc(), where().get(), collection().get(),
// nested subcollections, batch().delete()/commit(), and doc().delete().
// ---------------------------------------------------------------------------

interface FakeDoc {
  data: Record<string, unknown>
  subcollections: Map<string, Map<string, FakeDoc>>
}

class FakeStore {
  // collectionName -> docId -> FakeDoc
  cols = new Map<string, Map<string, FakeDoc>>()
  private auto = 1

  col(name: string): Map<string, FakeDoc> {
    if (!this.cols.has(name)) this.cols.set(name, new Map())
    return this.cols.get(name)!
  }

  seed(name: string, id: string, data: Record<string, unknown>): void {
    this.col(name).set(id, { data, subcollections: new Map() })
  }

  seedSub(name: string, id: string, sub: string, subId: string, data: Record<string, unknown>): void {
    if (!this.col(name).has(id)) this.col(name).set(id, { data: {}, subcollections: new Map() })
    const parent = this.col(name).get(id)!
    if (!parent.subcollections.has(sub)) parent.subcollections.set(sub, new Map())
    parent.subcollections.get(sub)!.set(subId, { data, subcollections: new Map() })
  }

  nextAutoId(): string {
    return `auto_${this.auto++}`
  }

  totalDocs(): number {
    let n = 0
    for (const col of this.cols.values()) {
      for (const doc of col.values()) {
        n += 1
        for (const sub of doc.subcollections.values()) n += sub.size
      }
    }
    return n
  }
}

// Loosely-typed fake refs — `any` here intentionally avoids the recursive
// implicit-return-type inference that `this`/nested makeDocRef trigger; the
// production code under test is fully typed.
/* eslint-disable @typescript-eslint/no-explicit-any */
type FakeDocRef = any
type FakeSnapshot = any

function makeDb(store: FakeStore): Firestore {
  function makeCollectionRef(map: Map<string, FakeDoc>, colName: string): any {
    function makeDocRef(docId: string): FakeDocRef {
      return {
        id: docId,
        get ref(): FakeDocRef {
          return this
        },
        async get(): Promise<FakeSnapshot> {
          const doc = map.get(docId)
          return {
            exists: doc !== undefined,
            id: docId,
            data: () => doc?.data,
            ref: makeDocRef(docId),
          }
        },
        async set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void> {
          const cur = map.get(docId)
          const base = opts?.merge && cur ? cur.data : {}
          map.set(docId, { data: { ...base, ...data }, subcollections: cur?.subcollections ?? new Map() })
        },
        async delete(): Promise<void> {
          map.delete(docId)
        },
        collection(sub: string): any {
          if (!map.has(docId)) map.set(docId, { data: {}, subcollections: new Map() })
          const parent = map.get(docId)!
          if (!parent.subcollections.has(sub)) parent.subcollections.set(sub, new Map())
          return makeCollectionRef(parent.subcollections.get(sub)!, `${colName}/${docId}/${sub}`)
        },
      }
    }
    function queryDocs(predicate?: (data: Record<string, unknown>) => boolean): FakeSnapshot {
      const docs = [...map.entries()]
        .filter(([, doc]) => (predicate ? predicate(doc.data) : true))
        .map(([id]) => makeDocRef(id))
      return {
        empty: docs.length === 0,
        size: docs.length,
        docs: docs.map((ref: FakeDocRef) => ({ id: ref.id, ref, data: () => map.get(ref.id)?.data })),
        forEach(cb: (d: { id: string; data: () => unknown }) => void) {
          for (const ref of docs) cb({ id: ref.id, data: () => map.get(ref.id)?.data })
        },
      }
    }
    return {
      doc: (id?: string) => makeDocRef(id ?? store.nextAutoId()),
      async add(data: Record<string, unknown>): Promise<FakeDocRef> {
        const id = store.nextAutoId()
        map.set(id, { data, subcollections: new Map() })
        return makeDocRef(id)
      },
      where(field: string, _op: string, value: unknown): any {
        const self = {
          limit: (_n: number) => self,
          async get(): Promise<FakeSnapshot> {
            return queryDocs((data) => data[field] === value)
          },
        }
        return self
      },
      async get(): Promise<FakeSnapshot> {
        return queryDocs()
      },
    }
  }

  const db = {
    collection(name: string) {
      return makeCollectionRef(store.col(name), name)
    },
    batch() {
      const ops: Array<() => void> = []
      return {
        delete(ref: { id: string; delete: () => Promise<void> }) {
          ops.push(() => void ref.delete())
        },
        async commit() {
          for (const op of ops) op()
        },
      }
    },
  } as unknown as Firestore
  return db
}

function makeDeps(store: FakeStore, overrides: Partial<AdminDeleteUserDeps> = {}): {
  deps: AdminDeleteUserDeps
  memCalls: Array<{ uid: string; partitionKey?: string }>
} {
  const memCalls: Array<{ uid: string; partitionKey?: string }> = []
  const deps: AdminDeleteUserDeps = {
    db: makeDb(store),
    clearMemory: async (uid, partitionKey) => {
      memCalls.push({ uid, partitionKey })
    },
    now: () => "2026-06-03T00:00:00.000Z",
    actor: "admin1@wekruit.com",
    log: () => {},
    ...overrides,
  }
  return { deps, memCalls }
}

const UID = "U7AwKT8nLDRa35DkuBxq"
const PHONE = "+14243201960"

/** Seed one fully-populated candidate across many keyed collections + subdocs. */
function seedFullCandidate(store: FakeStore): void {
  store.seed("pa-users", UID, { id: UID, phoneE164: PHONE, displayName: "Ada", email: "ada@x.com", createdAt: "2026-01-01" })
  // userId-keyed rows (a couple of distinct collections + multi-row).
  store.seed("pa-messages", "m1", { userId: UID, body: "hi" })
  store.seed("pa-messages", "m2", { userId: UID, body: "again" })
  store.seed("pa-messages", "other", { userId: "SOMEONE_ELSE", body: "keep me" })
  store.seed("pa-sessions", "s1", { userId: UID })
  store.seed("pa-prescreen-sessions", "ps1", { userId: UID })
  store.seed("pa-linkedin-connect-tokens", "tok1", { userId: UID, token: "tok1" })
  store.seed("pa-cv-upload-tokens", "up1", { userId: UID, token: "up1" })
  store.seed("parsedCandidateResumes", "r-by-user", { userId: UID })
  store.seed("parsedCandidateResumes", "r-by-cand", { candidateId: UID })
  // candidateId-keyed rows.
  store.seed("pa-candidate-handles", "h1", { candidateId: UID, kind: "phone" })
  store.seed("pa-candidate-handles", "h2", { candidateId: UID, kind: "email" })
  store.seed("pa-candidate-job-states", "js1", { candidateId: UID, jobId: "j1" })
  store.seed("pa-employer-visible-profiles", "ev1", { candidateId: UID })
  store.seed("pa-candidate-auth", "fbuid1", { firebaseUid: "fbuid1", candidateId: UID })
  store.seed("pa-connect-phone-codes", "cpc1", { webFirebaseUid: "fbuid1", phoneCandidateId: UID })
  // doc-id-keyed singletons.
  store.seed("pa-candidate-self-profiles", UID, { candidateId: UID })
  // entity-tags root + items subcollection.
  store.seedSub("pa-entity-tags", `pa-user:${UID}`, "items", "tag1", { value: "swe" })
  store.seedSub("pa-entity-tags", `pa-user:${UID}`, "items", "tag2", { value: "react" })
  // job-recs root + jobs subcollection.
  store.seedSub("pa-user-job-recommendations", UID, "jobs", "jrec1", { jobId: "j1" })
}

// ---------------------------------------------------------------------------
// resolveDeleteTarget
// ---------------------------------------------------------------------------

describe("resolveDeleteTarget", () => {
  it("resolves by phone (single match) → resolved with userId + phone", async () => {
    const store = new FakeStore()
    store.seed("pa-users", UID, { phoneE164: PHONE })
    const out = await resolveDeleteTarget(makeDb(store), { phoneE164: PHONE })
    assert.equal(out.kind, "resolved")
    if (out.kind === "resolved") {
      assert.equal(out.userId, UID)
      assert.equal(out.phoneE164, PHONE)
    }
  })

  it("resolves by userId directly (no phone lookup)", async () => {
    const store = new FakeStore()
    store.seed("pa-users", UID, { phoneE164: PHONE })
    const out = await resolveDeleteTarget(makeDb(store), { userId: UID })
    assert.equal(out.kind, "resolved")
  })

  it("multi-doc phone → ambiguous with all matches (no guess)", async () => {
    const store = new FakeStore()
    store.seed("pa-users", "uidA", { phoneE164: PHONE, displayName: "A" })
    store.seed("pa-users", "uidB", { phoneE164: PHONE, displayName: "B" })
    const out = await resolveDeleteTarget(makeDb(store), { phoneE164: PHONE })
    assert.equal(out.kind, "ambiguous")
    if (out.kind === "ambiguous") {
      assert.equal(out.matches.length, 2)
      assert.deepEqual(out.matches.map((m) => m.userId).sort(), ["uidA", "uidB"])
    }
  })

  it("unknown phone / userId → not_found", async () => {
    const store = new FakeStore()
    const byPhone = await resolveDeleteTarget(makeDb(store), { phoneE164: "+10000000000" })
    assert.equal(byPhone.kind, "not_found")
    const byId = await resolveDeleteTarget(makeDb(store), { userId: "missing-uid-1234" })
    assert.equal(byId.kind, "not_found")
  })
})

// ---------------------------------------------------------------------------
// runAdminDeleteUser
// ---------------------------------------------------------------------------

describe("runAdminDeleteUser — happy path", () => {
  it("hard-deletes the pa-users doc + every keyed collection + subcollections + mem0", async () => {
    const store = new FakeStore()
    seedFullCandidate(store)
    const { deps, memCalls } = makeDeps(store)

    const result = await runAdminDeleteUser({ phoneE164: PHONE, confirm: PHONE }, deps)

    assert.equal(result.ok, true)
    assert.equal(result.userId, UID)
    assert.equal(result.phoneE164, PHONE)

    // pa-users doc gone.
    assert.equal(store.col("pa-users").has(UID), false, "pa-users doc hard-deleted")
    // Another user's message untouched.
    assert.equal(store.col("pa-messages").has("other"), true, "other user's row preserved")
    assert.equal(store.col("pa-messages").has("m1"), false)
    assert.equal(store.col("pa-messages").has("m2"), false)

    // userId-keyed counts.
    assert.equal(result.deleted["pa-messages"], 2)
    assert.equal(result.deleted["pa-sessions"], 1)
    assert.equal(result.deleted["pa-prescreen-sessions"], 1)
    assert.equal(result.deleted["pa-linkedin-connect-tokens"], 1)
    assert.equal(result.deleted["pa-cv-upload-tokens"], 1)
    // parsedCandidateResumes matched on BOTH userId and candidateId (2 distinct docs).
    assert.equal(result.deleted["parsedCandidateResumes"], 2)
    assert.equal(store.col("parsedCandidateResumes").size, 0)

    // candidateId-keyed counts.
    assert.equal(result.deleted["pa-candidate-handles"], 2)
    assert.equal(result.deleted["pa-candidate-job-states"], 1)
    assert.equal(result.deleted["pa-employer-visible-profiles"], 1)

    // auth + connect-phone (queried, not doc-id).
    assert.equal(result.deleted["pa-candidate-auth"], 1)
    assert.equal(store.col("pa-candidate-auth").has("fbuid1"), false)
    assert.equal(result.deleted["pa-connect-phone-codes"], 1)

    // doc-id singletons.
    assert.equal(result.deleted["pa-candidate-self-profiles"], 1)
    assert.equal(store.col("pa-candidate-self-profiles").has(UID), false)

    // entity-tags root + 2 items.
    assert.equal(result.deleted["pa-entity-tags"], 3)
    assert.equal(store.col("pa-entity-tags").has(`pa-user:${UID}`), false)

    // job-recs root + 1 job subdoc.
    assert.equal(result.deleted["pa-user-job-recommendations"], 2)
    assert.equal(store.col("pa-user-job-recommendations").has(UID), false)

    // mem0 cleared once for this uid.
    assert.equal(result.deleted["mem0/qdrant"], 1)
    assert.equal(memCalls.length, 1)
    assert.equal(memCalls[0].uid, UID)

    // Audit row written.
    assert.equal(store.col("pa-audit-events").size, 1)
    const audit = [...store.col("pa-audit-events").values()][0]!.data
    assert.equal(audit.action, "admin.delete_user")
    assert.equal(audit.userId, UID)
    assert.equal(audit.actor, "admin1@wekruit.com")
    // PII-light: only the phone tail is stored.
    assert.equal(audit.phoneTail, "1960")
  })

  it("resolving by userId also fully deletes", async () => {
    const store = new FakeStore()
    seedFullCandidate(store)
    const { deps } = makeDeps(store)
    const result = await runAdminDeleteUser({ userId: UID, confirm: PHONE }, deps)
    assert.equal(result.ok, true)
    assert.equal(store.col("pa-users").has(UID), false)
  })
})

describe("runAdminDeleteUser — guards", () => {
  it("confirm-mismatch (wrong phone typed) rejects, deletes NOTHING", async () => {
    const store = new FakeStore()
    seedFullCandidate(store)
    const before = store.totalDocs()
    const { deps } = makeDeps(store)
    await assert.rejects(
      () => runAdminDeleteUser({ phoneE164: PHONE, confirm: "+19999999999" }, deps),
      (err: unknown) => err instanceof HttpsError && err.code === "failed-precondition" && err.message === "confirm_mismatch",
    )
    assert.equal(store.totalDocs(), before, "no docs deleted on confirm mismatch")
    assert.equal(store.col("pa-users").has(UID), true)
  })

  it("ambiguous phone (>1 pa-users) throws failed-precondition with matches, deletes NOTHING", async () => {
    const store = new FakeStore()
    store.seed("pa-users", "uidA", { phoneE164: PHONE })
    store.seed("pa-users", "uidB", { phoneE164: PHONE })
    store.seed("pa-messages", "m1", { userId: "uidA" })
    const before = store.totalDocs()
    const { deps } = makeDeps(store)
    await assert.rejects(
      () => runAdminDeleteUser({ phoneE164: PHONE, confirm: PHONE }, deps),
      (err: unknown) => {
        if (!(err instanceof HttpsError)) return false
        assert.equal(err.code, "failed-precondition")
        assert.equal(err.message, "ambiguous_phone")
        const details = err.details as { matches?: unknown[] } | undefined
        assert.ok(Array.isArray(details?.matches) && details!.matches!.length === 2)
        return true
      },
    )
    assert.equal(store.totalDocs(), before, "ambiguous resolution deletes nothing")
  })

  it("idempotent: already-deleted (not_found) user → ok with zero counts, never throws", async () => {
    const store = new FakeStore()
    const { deps, memCalls } = makeDeps(store)
    const result = await runAdminDeleteUser({ userId: "ghost-uid-1234", confirm: "anything" }, deps)
    assert.equal(result.ok, true)
    // Every known collection key present, all zero.
    for (const c of USER_SCOPED_BY_USER_ID) assert.equal(result.deleted[c], 0)
    for (const c of USER_SCOPED_BY_CANDIDATE_ID) assert.equal(result.deleted[c], 0)
    assert.equal(result.deleted["mem0/qdrant"], 0)
    // Best-effort mem0 wipe still attempted for the (known) uid.
    assert.equal(memCalls.length, 1)
    assert.equal(memCalls[0].uid, "ghost-uid-1234")
  })

  it("not_found by phone (no uid known) → ok, no mem0 call (nothing to scope)", async () => {
    const store = new FakeStore()
    const { deps, memCalls } = makeDeps(store)
    const result = await runAdminDeleteUser({ phoneE164: "+10000000000", confirm: "x" }, deps)
    assert.equal(result.ok, true)
    assert.equal(result.userId, "")
    assert.equal(memCalls.length, 0)
  })

  it("mem0 wipe failure does NOT abort the Firestore hard delete", async () => {
    const store = new FakeStore()
    seedFullCandidate(store)
    const { deps } = makeDeps(store, {
      clearMemory: async () => {
        throw new Error("qdrant 503")
      },
    })
    const result = await runAdminDeleteUser({ phoneE164: PHONE, confirm: PHONE }, deps)
    assert.equal(result.ok, true)
    assert.equal(result.deleted["mem0/qdrant"], 0, "mem0 marked not-cleared")
    assert.equal(store.col("pa-users").has(UID), false, "Firestore delete still happened")
  })
})

// ---------------------------------------------------------------------------
// authorizeWekruitAdmin — server gate
// ---------------------------------------------------------------------------

describe("authorizeWekruitAdmin", () => {
  it("@wekruit.com verified email passes (actor = email)", () => {
    const out = authorizeWekruitAdmin({
      auth: { token: { email: "Admin1@WeKruit.com", email_verified: true } },
    })
    assert.equal(out.actor, "admin1@wekruit.com")
  })

  it("non-wekruit email is rejected (permission-denied)", () => {
    assert.throws(
      () => authorizeWekruitAdmin({ auth: { token: { email: "hacker@gmail.com", email_verified: true } } }),
      (err: unknown) => err instanceof HttpsError && err.code === "permission-denied" && err.message === "wekruit_admin_only",
    )
  })

  it("@wekruit.com but UNVERIFIED email is rejected", () => {
    assert.throws(
      () => authorizeWekruitAdmin({ auth: { token: { email: "x@wekruit.com", email_verified: false } } }),
      (err: unknown) => err instanceof HttpsError && err.code === "permission-denied",
    )
  })

  it("no auth at all is rejected", () => {
    assert.throws(
      () => authorizeWekruitAdmin({}),
      (err: unknown) => err instanceof HttpsError && err.code === "permission-denied",
    )
  })

  it("admin:true custom claim passes (scripted actor)", () => {
    const out = authorizeWekruitAdmin({ auth: { token: { admin: true }, uid: "svc-1" } })
    assert.equal(out.actor, "admin:svc-1")
  })

  it("PA_ADMIN_TOKEN fallback passes when env matches", () => {
    const prev = process.env.PA_ADMIN_TOKEN
    process.env.PA_ADMIN_TOKEN = "secret-token-xyz"
    try {
      const out = authorizeWekruitAdmin({ data: { adminToken: "secret-token-xyz" } })
      assert.equal(out.actor, "admin-token")
    } finally {
      if (prev === undefined) delete process.env.PA_ADMIN_TOKEN
      else process.env.PA_ADMIN_TOKEN = prev
    }
  })
})
