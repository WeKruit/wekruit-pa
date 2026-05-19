import assert from "node:assert/strict"
import test from "node:test"
import {
  buildCandidateUploadResumeArtifactWrites,
  buildPublicCvIngestInput,
} from "./public-cv-ingest.js"
import {
  detectResumeUploadKind,
  extractDocxText,
} from "./resume-upload-parser.js"

function u16(value: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(value)
  return b
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value >>> 0)
  return b
}

function makeStoredZip(fileName: string, content: string): Uint8Array {
  const name = Buffer.from(fileName)
  const data = Buffer.from(content)
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(data.length),
    u32(data.length),
    u16(name.length),
    u16(0),
    name,
    data,
  ])
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(data.length),
    u32(data.length),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    name,
  ])
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0),
  ])
  return Buffer.concat([local, central, eocd])
}

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
  assert.equal(writes.userPatch.source, "candidate")
  assert.equal(writes.selfProfilePatch.resumeStatus, "parsed")
  assert.equal(writes.selfProfilePatch.profileSummary, "Product designer profile summary")
})

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

test("detectResumeUploadKind accepts PDF and DOCX only", () => {
  assert.equal(detectResumeUploadKind(Buffer.from("%PDF-1.7\n"), "Resume.pdf"), "pdf")
  assert.equal(
    detectResumeUploadKind(makeStoredZip("word/document.xml", "<w:document />"), "Resume.docx"),
    "docx",
  )
  assert.equal(
    detectResumeUploadKind(makeStoredZip("word/document.xml", "<w:document />"), "Resume.zip"),
    null,
  )
  assert.equal(detectResumeUploadKind(Buffer.from("plain text"), "Resume.txt"), null)
})

test("extractDocxText reads visible text from word/document.xml", () => {
  const docx = makeStoredZip(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>Adam Yang</w:t></w:r></w:p>
        <w:p><w:r><w:t>Built React dashboards &amp; SQL reports</w:t></w:r></w:p>
      </w:body>
    </w:document>`,
  )

  assert.equal(extractDocxText(docx), "Adam Yang\nBuilt React dashboards & SQL reports")
})
