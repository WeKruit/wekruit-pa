import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const shellCss = readFileSync(resolve(import.meta.dirname, "../../console-shell.css"), "utf8")
const pageSource = readFileSync(resolve(import.meta.dirname, "../RecruiterSubmissions.tsx"), "utf8")

describe("Recruiter submissions master-detail layout", () => {
  it("uses the full admin canvas instead of the capped page width", () => {
    assert.match(
      shellCss,
      /\.sub-masterdetail\s*\{[\s\S]*width: calc\(100vw - 240px - 64px\);[\s\S]*max-width: calc\(100vw - 240px - 64px\);[\s\S]*grid-template-columns: minmax\(640px, 0\.9fr\) minmax\(640px, 1\.1fr\);/,
    )
  })

  it("falls back to normal page width when the detail panel stacks", () => {
    assert.match(
      shellCss,
      /@media \(max-width: 1100px\) \{[\s\S]*\.sub-masterdetail\s*\{[\s\S]*width: 100%;[\s\S]*max-width: 100%;[\s\S]*grid-template-columns: minmax\(0, 1fr\);/,
    )
  })

  it("keeps resume links and recruiter chat visible in submission detail", () => {
    assert.match(pageSource, /candidate\.resumeUrl/)
    assert.match(pageSource, /Open resume/)
    assert.match(pageSource, /function SubmissionConversationPanel\(/)
    assert.match(pageSource, /"pa-recruiter-submissions", row\.id, "comments"/)
    assert.match(pageSource, /sendRecruiterSubmissionComment\(\{ submissionId: row\.id, message \}\)/)
    assert.match(pageSource, /Recruiter-specific chat/)
    assert.match(pageSource, /Stored on this recruiter submission/)
    assert.match(pageSource, /start this recruiter conversation/)
  })
})
