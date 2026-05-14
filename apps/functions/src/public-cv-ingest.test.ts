import assert from "node:assert/strict"
import test from "node:test"
import {
  buildCandidateUploadResumeArtifactWrites,
  buildPublicCvIngestInput,
} from "./public-cv-ingest.js"

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

test("buildPublicCvIngestInput keeps signed-in public uploads on the profile userId", () => {
  const input = buildPublicCvIngestInput({
    userId: "candidate-1",
    mediaUrl: "inline://Resume.pdf",
    body: {
      userId: "candidate-1",
      browserUid: "browser-1",
      resumeName: "Resume.pdf",
      source: "public_job_page",
    },
  })

  assert.equal(input.userId, "candidate-1")
  assert.equal(input.mediaUrl, "inline://Resume.pdf")
  assert.equal(input.browserUid, undefined)
  assert.equal(input.identitySource, undefined)
  assert.equal(input.employerEmailHint, undefined)
  assert.equal(input.atsApplicantId, undefined)
})

test("buildPublicCvIngestInput preserves ATS identity hints for external intake", () => {
  const input = buildPublicCvIngestInput({
    userId: "hint-user",
    mediaUrl: "https://example.com/resume.pdf",
    body: {
      userId: "hint-user",
      browserUid: "browser-1",
      employerEmailHint: "person@example.com",
      atsApplicantId: "ats-1",
      source: "ats:greenhouse",
    },
  })

  assert.equal(input.userId, "hint-user")
  assert.equal(input.browserUid, "browser-1")
  assert.equal(input.identitySource, "ats")
  assert.equal(input.employerEmailHint, "person@example.com")
  assert.equal(input.atsApplicantId, "ats-1")
})
