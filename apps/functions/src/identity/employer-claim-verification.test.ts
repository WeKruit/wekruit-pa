import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"
import { runEmployerClaimVerification } from "./employer-claim-verification.js"

type FakeState = Map<string, Record<string, unknown>>

function fakeDb(seed: Record<string, Record<string, unknown>>) {
  const state: FakeState = new Map(Object.entries(seed))
  const db = {
    collection(coll: string) {
      return {
        doc(id: string) {
          const path = `${coll}/${id}`
          return {
            async get() {
              const data = state.get(path)
              return {
                exists: Boolean(data),
                data: () => data,
              }
            },
            async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
              const existing = state.get(path) ?? {}
              state.set(path, opts?.merge ? { ...existing, ...data } : data)
            },
          }
        },
        where(field: string, op: string, value: unknown) {
          assert.equal(op, "==")
          return {
            limit() {
              return {
                async get() {
                  const docs = Array.from(state.entries())
                    .filter(([path, data]) => path.startsWith(`${coll}/`) && data[field] === value)
                    .map(([path, data]) => ({
                      id: path.split("/")[1],
                      data: () => data,
                    }))
                  return { docs }
                },
              }
            },
          }
        },
      }
    },
  }
  return { db: db as never as Firestore, state }
}

test("runEmployerClaimVerification requires a verified signed-in email", async () => {
  await assert.rejects(
    () => runEmployerClaimVerification({}, undefined, { db: {} as Firestore }),
    (err) => err instanceof HttpsError && err.code === "unauthenticated",
  )
  await assert.rejects(
    () =>
      runEmployerClaimVerification(
        {},
        { uid: "uid-1", token: { email: "buyer@example.com", email_verified: false } },
        { db: {} as Firestore },
      ),
    (err) => err instanceof HttpsError && err.code === "failed-precondition",
  )
})

test("runEmployerClaimVerification verifies the matching employer registration by id", async () => {
  const { db, state } = fakeDb({
    "layoff_employers/emp-1": {
      companyName: "Acme",
      workEmail: "Buyer@Example.com",
      verificationStatus: "pending",
    },
  })

  const result = await runEmployerClaimVerification(
    { employerId: "emp-1" },
    { uid: "firebase-1", token: { email: "buyer@example.com", email_verified: true } },
    { db, now: () => "2026-05-15T00:00:00.000Z" },
  )

  assert.deepEqual(result, {
    ok: true,
    employerId: "emp-1",
    verificationStatus: "verified",
  })
  assert.deepEqual(state.get("layoff_employers/emp-1"), {
    companyName: "Acme",
    workEmail: "Buyer@Example.com",
    verificationStatus: "verified",
    verifiedAt: "2026-05-15T00:00:00.000Z",
    verifiedByUid: "firebase-1",
    verifiedEmail: "buyer@example.com",
    updatedAt: "2026-05-15T00:00:00.000Z",
  })
})

test("runEmployerClaimVerification can find the employer by normalized email", async () => {
  const { db } = fakeDb({
    "layoff_employers/emp-2": {
      companyName: "Acme",
      workEmailLower: "buyer@example.com",
      verificationStatus: "pending",
    },
  })

  const result = await runEmployerClaimVerification(
    {},
    { uid: "firebase-1", token: { email: "Buyer@Example.com", email_verified: true } },
    { db, now: () => "2026-05-15T00:00:00.000Z" },
  )

  assert.equal(result.employerId, "emp-2")
})

test("runEmployerClaimVerification rejects a mismatched signed-in email", async () => {
  const { db } = fakeDb({
    "layoff_employers/emp-1": {
      workEmailLower: "buyer@example.com",
      verificationStatus: "pending",
    },
  })

  await assert.rejects(
    () =>
      runEmployerClaimVerification(
        { employerId: "emp-1" },
        { uid: "firebase-1", token: { email: "other@example.com", email_verified: true } },
        { db },
      ),
    (err) => err instanceof HttpsError && err.code === "permission-denied",
  )
})
