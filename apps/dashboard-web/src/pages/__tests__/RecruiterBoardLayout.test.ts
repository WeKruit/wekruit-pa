import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "node:test"

const source = readFileSync(resolve(import.meta.dirname, "../RecruiterBoardOps.tsx"), "utf8")

describe("RecruiterBoardOps selected-review layout", () => {
  it("uses the unused right canvas for the candidate review rail", () => {
    assert.match(source, /const selectedReviewShellStyle: CSSProperties = \{[\s\S]*width: "calc\(100vw - 240px - 64px\)"/)
    assert.match(source, /gridTemplateColumns: "minmax\(620px, 1fr\) minmax\(520px, min\(640px, 34vw\)\)"/)
  })

  it("shrinks board tables while a candidate is open", () => {
    assert.match(source, /const selectedBoardTableStyle: CSSProperties = \{[\s\S]*minWidth: 620/)
    assert.match(source, /selectedSubmission \? selectedBoardTableStyle : boardTableStyle/)
  })

  it("keeps the selected role context readable", () => {
    assert.match(source, /const roleContextTextStyle: CSSProperties = \{[\s\S]*fontSize: 14,[\s\S]*lineHeight: 1\.55/)
    assert.match(source, /const reviewContextStyle: CSSProperties = \{[\s\S]*minHeight: 560,[\s\S]*maxHeight: "min\(720px, calc\(100vh - 120px\)\)"/)
    assert.match(source, /gridTemplateColumns: "repeat\(auto-fit, minmax\(220px, 1fr\)\)"/)
  })

  it("loads selected role context from every submission job identifier", () => {
    assert.match(source, /function jobLookupKeys\(submission: BoardSubmissionDoc\): string\[\]/)
    assert.match(source, /const jobIds = \[\.\.\.new Set\(loadedSubmissions\.flatMap\(jobLookupKeys\)\)\]/)
    assert.match(source, /const selectedJob = selectedSubmission \? findSubmissionJob\(jobDocs, selectedSubmission\) : undefined/)
  })
})
