import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { HttpsError } from "firebase-functions/v2/https"
import { PA_COLLECTIONS } from "@pa/core-types"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import { runCandidateFlywheelCorrection } from "../flywheel-candidate-correction.js"

const now = "2026-05-14T12:00:00.000Z"

function json(value: unknown): string {
  return JSON.stringify(value)
}

describe("runCandidateFlywheelCorrection", () => {
  it("requires candidate auth", async () => {
    const mfs = new MockFirestore()
    await assert.rejects(
      () => runCandidateFlywheelCorrection({ correctionText: "I prefer product roles" }, undefined, {
        db: asFirestore(mfs),
        now: () => now,
      }),
      (err) => err instanceof HttpsError && err.code === "unauthenticated",
    )
  })

  it("writes candidate actor correction and eval artifact without artifact raw free text", async () => {
    const mfs = new MockFirestore()
    await mfs.collection(PA_COLLECTIONS.candidateAuth).doc("firebase-1").set({ candidateId: "cand-1" })
    await mfs.collection(PA_COLLECTIONS.candidateSelfProfiles).doc("cand-1").set({
      candidateId: "cand-1",
      lifecycleState: "claimed",
      emailMasked: "c***@example.com",
      globalTags: {
        roleFunction: ["software_engineering"],
      },
      createdAt: now,
    })

    const result = await runCandidateFlywheelCorrection(
      {
        correctionText: "My email is candidate@example.com. The transcript says raw sensitive text. I want AI product roles.",
        sourceSurface: "me_profile",
        targetType: "candidate_profile",
        targetId: "cand-1",
        structuredFields: {
          targetRoleFunction: ["software_engineering"],
        },
        after: {
          storageUrl: "gs://bucket/private-resume.pdf",
          prompt: "raw prompt should not go to artifact",
        },
        jobId: "job-1",
      },
      { uid: "firebase-1" },
      { db: asFirestore(mfs), now: () => now },
    )

    assert.equal(result.ok, true)
    assert.equal(result.candidateId, "cand-1")
    assert.equal(result.selfProfile.candidateId, "cand-1")
    assert.deepEqual(result.appliedKeys, ["targetRoleFunction"])
    const correction = mfs.store.get(PA_COLLECTIONS.correctionEvents)!.get(result.correctionEventId)!
    const artifact = mfs.store.get(PA_COLLECTIONS.evalArtifacts)!.get(result.artifactId)!

    assert.equal(correction.actor, "candidate")
    assert.equal(correction.candidateId, "cand-1")
    assert.equal(correction.jobId, "job-1")
    assert.equal(correction.reason, "candidate_submitted_profile_correction")
    assert.equal(artifact.createdBy, "candidate")
    assert.deepEqual(artifact.sourceCorrectionEventIds, [result.correctionEventId])
    assert.doesNotMatch(json(correction), /candidate@example\.com|raw sensitive text|gs:\/\/|raw prompt|prompt|correctionText/)
    assert.doesNotMatch(json(artifact), /candidate@example\.com|raw sensitive text|gs:\/\/|raw prompt|prompt|correctionText/)
    assert.equal(mfs.store.get(PA_COLLECTIONS.outbound)?.size ?? 0, 0)
    assert.equal(mfs.writeLog.some((write) => write.path === PA_COLLECTIONS.outbound), false)
  })
})
