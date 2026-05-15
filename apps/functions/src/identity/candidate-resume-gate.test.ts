import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"
import { runCandidateResumeGateStatus } from "./candidate-resume-gate.js"

function baseDeps(overrides: Partial<Parameters<typeof runCandidateResumeGateStatus>[2]> = {}) {
  return {
    db: {} as Firestore,
    claimCandidateProfile: async () => ({
      candidateId: "cand-1",
      authMapping: {
        firebaseUid: "firebase-1",
        candidateId: "cand-1",
        createdAt: "2026-05-14T00:00:00.000Z",
      },
      emailHandle: {
        handleId: "email_hash",
        candidateId: "cand-1",
        kind: "email" as const,
        handleHash: "hashhashhashhash",
        source: "candidate" as const,
        createdAt: "2026-05-14T00:00:00.000Z",
      },
      claimedEventId: "ident_claimed",
      idempotent: false,
      selfProfile: {
        candidateId: "cand-1",
        lifecycleState: "claimed" as const,
        handles: [{ kind: "email" as const, source: "candidate" as const }],
        createdAt: "2026-05-14T00:00:00.000Z",
      },
    }),
    loadCandidateAuthMapping: async () => null,
    loadCandidateUser: async () => ({}),
    loadCandidateSelfProfile: async () => ({}),
    loadLatestResumeArtifact: async () => null,
    loadLatestParsedResume: async () => null,
    ...overrides,
  }
}

test("runCandidateResumeGateStatus blocks signed-in candidates without a resume", async () => {
  const calls: Array<Record<string, unknown>> = []
  const result = await runCandidateResumeGateStatus(
    { browserUid: "browser-1" },
    { uid: "firebase-1", token: { email: "Person@Example.COM", email_verified: true } },
    baseDeps({
      claimCandidateProfile: async (_db, input) => {
        calls.push({ ...input })
        return (await baseDeps().claimCandidateProfile(_db, input)) as Awaited<
          ReturnType<NonNullable<Parameters<typeof runCandidateResumeGateStatus>[2]["claimCandidateProfile"]>>
        >
      },
    })
  )

  assert.equal(result.ok, true)
  assert.equal(result.status, "needs_resume_upload")
  assert.equal(result.candidateId, "cand-1")
  assert.deepEqual(calls[0], {
    firebaseUid: "firebase-1",
    email: "person@example.com",
    browserUid: "browser-1",
    displayName: null,
  })
})

test("runCandidateResumeGateStatus waits while a resume exists but labels are not ready", async () => {
  const result = await runCandidateResumeGateStatus(
    {},
    { uid: "firebase-1", token: { email: "person@example.com", email_verified: true } },
    baseDeps({
      loadLatestResumeArtifact: async () => ({ resumeId: "artifact-1", status: "parsed" }),
      loadLatestParsedResume: async () => ({ id: "resume-1", data: { userId: "cand-1" } }),
    })
  )

  assert.equal(result.status, "resume_processing")
  assert.equal(result.hasResume, true)
  assert.equal(result.labelsReady, false)
})

test("runCandidateResumeGateStatus unlocks only after parsed resume labels are present", async () => {
  const result = await runCandidateResumeGateStatus(
    {},
    { uid: "firebase-1", token: { email: "person@example.com", email_verified: true } },
    baseDeps({
      loadLatestParsedResume: async () => ({
        id: "resume-1",
        data: {
          userId: "cand-1",
          topSkills: ["product design"],
          industryTags: ["ai_ml"],
        },
      }),
    })
  )

  assert.equal(result.status, "ready")
  assert.equal(result.parsedResumeId, "resume-1")
  assert.equal(result.labelsReady, true)
})

test("runCandidateResumeGateStatus accepts LinkedIn custom-token email claims", async () => {
  const calls: Array<Record<string, unknown>> = []
  await runCandidateResumeGateStatus(
    {},
    {
      uid: "li_123",
      token: {
        provider: "linkedin.com",
        linkedinEmail: "LiUser@Example.com",
        linkedinName: "LinkedIn User",
      },
    },
    baseDeps({
      claimCandidateProfile: async (_db, input) => {
        calls.push({ ...input })
        return (await baseDeps().claimCandidateProfile(_db, input)) as Awaited<
          ReturnType<NonNullable<Parameters<typeof runCandidateResumeGateStatus>[2]["claimCandidateProfile"]>>
        >
      },
    })
  )

  assert.equal(calls[0]?.email, "liuser@example.com")
  assert.equal(calls[0]?.displayName, "LinkedIn User")
})

test("runCandidateResumeGateStatus reuses existing auth mapping instead of reclaiming profile", async () => {
  let claimCalled = false
  const result = await runCandidateResumeGateStatus(
    {},
    { uid: "firebase-1", token: { email: "person@example.com", email_verified: true } },
    baseDeps({
      loadCandidateAuthMapping: async () => ({ candidateId: "cand-existing" }),
      claimCandidateProfile: async () => {
        claimCalled = true
        return baseDeps().claimCandidateProfile({} as Firestore, {
          firebaseUid: "firebase-1",
          email: "person@example.com",
        })
      },
      loadLatestParsedResume: async () => ({
        id: "resume-1",
        data: { topSkills: ["react"], industryTags: ["tech_software"] },
      }),
    })
  )

  assert.equal(claimCalled, false)
  assert.equal(result.candidateId, "cand-existing")
  assert.equal(result.status, "ready")
})

test("runCandidateResumeGateStatus requires auth", async () => {
  await assert.rejects(
    () => runCandidateResumeGateStatus({}, undefined, baseDeps()),
    (err) => err instanceof HttpsError && err.code === "unauthenticated"
  )
})

test("runCandidateResumeGateStatus rejects internal operator emails", async () => {
  await assert.rejects(
    () =>
      runCandidateResumeGateStatus(
        {},
        { uid: "firebase-1", token: { email: "admin@wekruit.com", email_verified: true } },
        baseDeps()
      ),
    (err) => err instanceof HttpsError && err.code === "failed-precondition"
  )
})
