import assert from "node:assert/strict"
import test from "node:test"
import {
  bulkResumeStatusTone,
  canRetryBulkResumeItem,
  fileToResumeUploadPayload,
  maskEmailForDisplay,
  sanitizeResumeFileName,
  summarizeItems,
  summarizeProcessResults,
  validateResumeFile,
} from "../BulkResumes.helpers.js"

test("fileToResumeUploadPayload sanitizes resume name and emits base64", async () => {
  const file = new File(["%PDF-1.4\n"], "../Adam Resume.pdf", { type: "application/pdf" })

  const payload = await fileToResumeUploadPayload(file, "candidate@example.com")

  assert.equal(payload.fileName, "Adam Resume.pdf")
  assert.equal(payload.resumeBase64, "JVBERi0xLjQK")
  assert.equal(payload.employerEmailHint, "candidate@example.com")
})

test("validateResumeFile accepts PDF/DOCX and rejects other names or empty files", () => {
  assert.equal(validateResumeFile(new File(["x"], "resume.txt", { type: "text/plain" })), "PDF or DOCX only")
  assert.equal(validateResumeFile(new File([], "resume.pdf", { type: "application/pdf" })), "Empty file")
  assert.equal(validateResumeFile(new File(["x"], "resume.pdf", { type: "application/pdf" })), null)
  assert.equal(
    validateResumeFile(
      new File(["x"], "resume.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })
    ),
    null
  )
})

test("maskEmailForDisplay never returns the raw email", () => {
  assert.equal(maskEmailForDisplay("candidate@example.com"), "ca***@e***.com")
  assert.equal(maskEmailForDisplay("a@x.io"), "a***@*.io")
  assert.equal(maskEmailForDisplay("not-an-email"), "***")
  assert.equal(maskEmailForDisplay(""), "-")
})

test("bulk resume statuses drive tones, retry visibility, and count buckets", () => {
  assert.equal(bulkResumeStatusTone("parsed"), "ok")
  assert.equal(bulkResumeStatusTone("failed"), "warn")
  assert.equal(bulkResumeStatusTone("parsing"), "info")
  assert.equal(bulkResumeStatusTone(undefined), "muted")

  assert.equal(canRetryBulkResumeItem("missing_email_review"), true)
  assert.equal(canRetryBulkResumeItem("identity_conflict"), true)
  assert.equal(canRetryBulkResumeItem("parse_failed"), true)
  assert.equal(canRetryBulkResumeItem("failed"), true)
  assert.equal(canRetryBulkResumeItem("retry_ready"), false)
  assert.equal(canRetryBulkResumeItem("parsed"), false)

  assert.deepEqual(
    summarizeItems([
      { status: "queued" },
      { status: "parsing" },
      { status: "parsed" },
      { status: "missing_email_review" },
      { status: "identity_conflict" },
      { status: "parse_failed" },
      { status: "failed" },
      { status: "retry_ready" },
    ]),
    {
      total: 8,
      queued: 1,
      parsing: 1,
      parsed: 1,
      review: 2,
      failed: 2,
      retryReady: 1,
    }
  )
})

test("summarizeProcessResults is stable for empty and mixed batches", () => {
  assert.equal(summarizeProcessResults([]), "No results")
  assert.equal(
    summarizeProcessResults([
      { status: "parsed" },
      { status: "missing_email_review" },
      { status: "parse_failed" },
    ]),
    "1 completed / 1 review / 1 failed"
  )
})

test("sanitizeResumeFileName strips path fragments and control characters", () => {
  assert.equal(sanitizeResumeFileName("..\\nested/\u0000 Resume.pdf"), "Resume.pdf")
})
