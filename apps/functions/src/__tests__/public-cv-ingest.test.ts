import assert from "node:assert/strict"
import test from "node:test"
import {
  buildCandidateUploadResumeArtifactWrites,
  __test_sourceForProfileCreate,
} from "../public-cv-ingest.js"

test("buildCandidateUploadResumeArtifactWrites preserves existing layoff source", () => {
  const writes = buildCandidateUploadResumeArtifactWrites({
    candidateId: "cand-1",
    parsedCandidateResumeId: "parsed-1",
    fileName: "Resume.pdf",
    existingUserSource: "WeKruit_Laid_Off",
    uploadSource: "candidate_signup",
    now: "2026-05-14T12:00:00.000Z",
  })

  assert.equal(writes.userPatch.latestResumeArtifactId, writes.artifact.resumeId)
  assert.equal("source" in writes.userPatch, false)
})

test("buildCandidateUploadResumeArtifactWrites stamps layoff source only for source-less layoff uploads", () => {
  const writes = buildCandidateUploadResumeArtifactWrites({
    candidateId: "cand-1",
    parsedCandidateResumeId: "parsed-1",
    fileName: "Resume.pdf",
    uploadSource: "layoff_signup",
    now: "2026-05-14T12:00:00.000Z",
  })

  assert.equal(writes.userPatch.source, "WeKruit_Laid_Off")
})

test("sourceForProfileCreate maps layoff_signup to WeKruit_Laid_Off", () => {
  assert.equal(__test_sourceForProfileCreate("layoff_signup"), "WeKruit_Laid_Off")
})

test("sourceForProfileCreate maps layoffhedge to layoffhedge", () => {
  assert.equal(__test_sourceForProfileCreate("layoffhedge"), "layoffhedge")
})

test("sourceForProfileCreate accepts any valid PaUserSource verbatim", () => {
  assert.equal(__test_sourceForProfileCreate("candidate"), "candidate")
  assert.equal(__test_sourceForProfileCreate("admin"), "admin")
  assert.equal(__test_sourceForProfileCreate("external_supply"), "external_supply")
})

test("sourceForProfileCreate falls back to candidate for unknown strings", () => {
  assert.equal(__test_sourceForProfileCreate("nonsense"), "candidate")
  assert.equal(__test_sourceForProfileCreate("public_job_page"), "candidate")
})

test("sourceForProfileCreate falls back to candidate for undefined", () => {
  assert.equal(__test_sourceForProfileCreate(undefined), "candidate")
})
