import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"
import { runCandidateClaimProfile } from "./claim-api.js"

test("runCandidateClaimProfile requires authenticated verified email", async () => {
  await assert.rejects(
    () => runCandidateClaimProfile({}, undefined, { db: {} as Firestore }),
    (err) => err instanceof HttpsError && err.code === "unauthenticated"
  )
  await assert.rejects(
    () =>
      runCandidateClaimProfile(
        {},
        { uid: "firebase-1", token: { email: "person@example.com", email_verified: false } },
        { db: {} as Firestore }
      ),
    (err) => err instanceof HttpsError && err.code === "failed-precondition"
  )
})

test("runCandidateClaimProfile rejects internal operator emails", async () => {
  await assert.rejects(
    () =>
      runCandidateClaimProfile(
        {},
        { uid: "firebase-1", token: { email: "admin@wekruit.com", email_verified: true } },
        { db: {} as Firestore }
      ),
    (err) => err instanceof HttpsError && err.code === "failed-precondition"
  )
})

test("runCandidateClaimProfile delegates to claim helper and returns redacted self profile", async () => {
  const calls: Array<Record<string, unknown>> = []
  const result = await runCandidateClaimProfile(
    { browserUid: "browser-1", displayName: "Candidate One" },
    { uid: "firebase-1", token: { email: "Person@Example.COM", email_verified: true } },
    {
      db: {} as Firestore,
      claimCandidateProfile: async (_db: Firestore, input: {
        firebaseUid: string
        email: string
        browserUid?: string | null
        displayName?: string | null
      }) => {
        calls.push(input)
        return {
          candidateId: "cand-1",
          authMapping: {
            firebaseUid: "firebase-1",
            candidateId: "cand-1",
            createdAt: "2026-05-13T00:00:00.000Z",
          },
          emailHandle: {
            handleId: "email__hash",
            candidateId: "cand-1",
            kind: "email",
            handleHash: "hashhashhashhash",
            source: "candidate",
            createdAt: "2026-05-13T00:00:00.000Z",
          },
          claimedEventId: "ident_claimed",
          idempotent: false,
          selfProfile: {
            candidateId: "cand-1",
            lifecycleState: "claimed",
            displayName: "Candidate One",
            emailMasked: "p***@example.com",
            handles: [{ kind: "email", verifiedAt: "2026-05-13T00:00:00.000Z", source: "candidate" }],
            createdAt: "2026-05-13T00:00:00.000Z",
            updatedAt: "2026-05-13T00:00:00.000Z",
          },
        }
      },
    }
  )

  assert.equal(result.ok, true)
  assert.equal(result.candidateId, "cand-1")
  assert.equal(result.selfProfile.emailMasked, "p***@example.com")
  assert.deepEqual(calls[0], {
    firebaseUid: "firebase-1",
    email: "person@example.com",
    browserUid: "browser-1",
    displayName: "Candidate One",
  })
})

test("runCandidateClaimProfile maps identity conflicts to failed-precondition", async () => {
  await assert.rejects(
    () =>
      runCandidateClaimProfile(
        {},
        { uid: "firebase-1", token: { email: "person@example.com", email_verified: true } },
        {
          db: {} as Firestore,
          claimCandidateProfile: async () => {
            throw new Error("identity_conflict:conflict_1")
          },
        }
      ),
    (err) => err instanceof HttpsError && err.code === "failed-precondition"
  )
})
