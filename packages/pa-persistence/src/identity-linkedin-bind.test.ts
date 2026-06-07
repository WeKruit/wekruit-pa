import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { candidateHasLinkedinBind } from "./identity.js"

/**
 * Focused unit coverage for candidateHasLinkedinBind — the re-login recognition
 * predicate that suppresses a duplicate LinkedIn connect offer / double-pitch.
 *
 * Covers all three branches:
 *   1. TRUE via a durable pa-candidate-handles {kind:"linkedin"} row.
 *   2. TRUE via the pa-users.linkedinOauthLinked === true flag (handle absent).
 *   3. FALSE fail-soft when the read throws (defensive default — must keep the
 *      first-time offer intact, never claim "already bound" on a transient error).
 */

type Store = Map<string, Map<string, Record<string, unknown>>>

function makeStore(): Store {
  return new Map(Object.values(PA_COLLECTIONS).map((name) => [name, new Map()]))
}

/** Minimal fake Firestore supporting collection().where().limit().get() + doc().get(). */
function makeFakeFirestore(opts?: { throwOnHandlesQuery?: boolean }): { db: Firestore; store: Store } {
  const store = makeStore()
  function col(name: string): Map<string, Record<string, unknown>> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }
  function collection(collectionName: string) {
    return {
      doc(id: string) {
        return {
          async get() {
            const data = col(collectionName).get(id)
            return { exists: data !== undefined, id, data: () => data }
          },
        }
      },
      where(field: string, _op: string, value: unknown) {
        return {
          limit(_n: number) {
            return {
              async get() {
                if (opts?.throwOnHandlesQuery) throw new Error("firestore_unavailable")
                const docs = Array.from(col(collectionName).entries())
                  .filter(([, data]) => data[field] === value)
                  .map(([id, data]) => ({ id, data: () => data }))
                return { empty: docs.length === 0, docs }
              },
            }
          },
        }
      },
    }
  }
  return { db: { collection } as unknown as Firestore, store }
}

test("candidateHasLinkedinBind → true when a linkedin handle row exists", async () => {
  const { db, store } = makeFakeFirestore()
  store.get(PA_COLLECTIONS.candidateHandles)!.set("h_li_1", {
    candidateId: "cand-1",
    kind: "linkedin",
  })
  assert.equal(await candidateHasLinkedinBind(db, "cand-1"), true)
})

test("candidateHasLinkedinBind → true via linkedinOauthLinked flag when no handle row", async () => {
  const { db, store } = makeFakeFirestore()
  store.get(PA_COLLECTIONS.users)!.set("cand-2", {
    linkedinOauthLinked: true,
  })
  assert.equal(await candidateHasLinkedinBind(db, "cand-2"), true)
})

test("candidateHasLinkedinBind → false when neither signal is present", async () => {
  const { db, store } = makeFakeFirestore()
  // A non-linkedin handle and a user doc WITHOUT the flag must not count as bound.
  store.get(PA_COLLECTIONS.candidateHandles)!.set("h_email_1", {
    candidateId: "cand-3",
    kind: "email",
  })
  store.get(PA_COLLECTIONS.users)!.set("cand-3", { linkedinOauthLinked: false })
  assert.equal(await candidateHasLinkedinBind(db, "cand-3"), false)
})

test("candidateHasLinkedinBind → false (fail-soft) when the handles read throws", async () => {
  const { db } = makeFakeFirestore({ throwOnHandlesQuery: true })
  assert.equal(await candidateHasLinkedinBind(db, "cand-err"), false)
})
