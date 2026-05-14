import assert from "node:assert/strict"
import test from "node:test"
import { buildCandidateUploadResumeArtifactWrites } from "./public-cv-ingest.js"

test("buildCandidateUploadResumeArtifactWrites creates parsed candidate-upload artifact patches", () => {
  const writes = buildCandidateUploadResumeArtifactWrites({
    candidateId: "cand-1",
    parsedCandidateResumeId: "parsed-1",
    fileName: "Resume.pdf",
    sha256: "a".repeat(64),
    candidateProfileSummary: "Product designer profile summary",
    now: "2026-05-14T12:00:00.000Z",
  })

  assert.equal(writes.artifact.resumeId, `candidate_upload_cand-1_${"a".repeat(32)}`)
  assert.equal(writes.artifact.candidateId, "cand-1")
  assert.equal(writes.artifact.status, "parsed")
  assert.equal(writes.artifact.source, "candidate_upload")
  assert.equal(writes.artifact.parsedCandidateResumeId, "parsed-1")
  assert.equal(writes.userPatch.latestResumeArtifactId, writes.artifact.resumeId)
  assert.equal(writes.selfProfilePatch.resumeStatus, "parsed")
  assert.equal(writes.selfProfilePatch.profileSummary, "Product designer profile summary")
})
