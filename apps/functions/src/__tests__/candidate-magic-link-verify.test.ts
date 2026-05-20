import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { runCandidateMagicLinkVerify } from "../candidate-magic-link-verify.js"

test("runCandidateMagicLinkVerify claims profile for verified email", async () => {
  const calls: Array<Record<string, unknown>> = []
  const { result, status } = await runCandidateMagicLinkVerify(
    {
      firebaseIdToken: "token-1",
      browserUid: "browser-1",
      displayName: "Candidate One",
    },
    undefined,
    {
      db: {} as Firestore,
      verifyIdToken: async () => ({
        uid: "firebase-1",
        email: "Person@Example.COM",
        email_verified: true,
        name: "Candidate One",
      }),
      claimProfile: async (_db, input) => {
        calls.push({ ...input })
        return {
          candidateId: "cand-1",
          authMapping: {
            firebaseUid: "firebase-1",
            candidateId: "cand-1",
            createdAt: "2026-05-20T00:00:00.000Z",
          },
          emailHandle: {
            handleId: "email_hash",
            candidateId: "cand-1",
            kind: "email" as const,
            handleHash: "hashhashhashhash",
            source: "candidate" as const,
            createdAt: "2026-05-20T00:00:00.000Z",
          },
          claimedEventId: "ident_claimed",
          idempotent: false,
          selfProfile: {
            candidateId: "cand-1",
            lifecycleState: "claimed" as const,
            handles: [{ kind: "email" as const, source: "candidate" as const }],
            createdAt: "2026-05-20T00:00:00.000Z",
          },
        }
      },
    }
  )

  assert.equal(status, 200)
  assert.deepEqual(result, { ok: true, candidateId: "cand-1", idempotent: false })
  assert.deepEqual(calls[0], {
    firebaseUid: "firebase-1",
    email: "person@example.com",
    browserUid: "browser-1",
    displayName: "Candidate One",
  })
})

test("runCandidateMagicLinkVerify allows wekruit.com workspace emails at public launch", async () => {
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-1" },
    undefined,
    {
      db: {} as Firestore,
      verifyIdToken: async () => ({
        uid: "firebase-admin",
        email: "admin1@wekruit.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-admin",
        authMapping: {
          firebaseUid: "firebase-admin",
          candidateId: "cand-admin",
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-admin",
          kind: "email" as const,
          handleHash: "hashhashhashhash",
          source: "candidate" as const,
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: true,
        selfProfile: {
          candidateId: "cand-admin",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-20T00:00:00.000Z",
        },
      }),
    }
  )

  assert.equal(status, 200)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.candidateId, "cand-admin")
    assert.equal(result.idempotent, true)
  }
})
