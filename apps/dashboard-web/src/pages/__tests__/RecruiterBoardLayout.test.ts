import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "node:test"

const source = readFileSync(resolve(import.meta.dirname, "../RecruiterBoardOps.tsx"), "utf8")

describe("RecruiterBoardOps selected-review layout", () => {
  it("uses the unused right canvas for the candidate review rail", () => {
    assert.match(source, /const selectedReviewShellStyle: CSSProperties = \{[\s\S]*width: "calc\(100vw - 240px - 64px\)"/)
    // Review rail is the dominant column now (room for a full-size inline résumé); the
    // board list is the secondary rail on the left.
    assert.match(source, /gridTemplateColumns: "minmax\(360px, 0\.6fr\) minmax\(720px, 1\.5fr\)"/)
  })

  it("shrinks board tables while a candidate is open", () => {
    assert.match(source, /const selectedBoardTableStyle: CSSProperties = \{[\s\S]*minWidth: 360/)
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

  it("defaults rejection decisions to quality tier 3 and allows an empty reason", () => {
    assert.match(source, /const DEFAULT_REJECTION_CATEGORY: RecruiterCandidateRejectionCategory = "quality"/)
    assert.match(source, /const DEFAULT_REJECTION_TIER: RecruiterCandidateTier = "tier_3"/)
    assert.match(source, /const rejectDisabled = blocked\b/)
    assert.doesNotMatch(source, /const rejectDisabled = blocked \|\| !rejectReason\.trim\(\)/)
  })

  it("exposes bulk selection and bulk rejection controls on the board", () => {
    assert.match(source, /function isBulkRejectSelectable\(submission: \{ status\?: string \}\): boolean/)
    assert.match(source, /const \[bulkSelectedIds, setBulkSelectedIds\] = useState<Set<string>>/)
    assert.match(source, /aria-label=\{`Select \$\{submission\.candidate\?\.name \?\? "candidate"\} for bulk rejection`\}/)
    assert.match(source, /Reject selected/)
    assert.match(source, /action: "reject",[\s\S]*rejection,/)
  })

  it("defaults the board table to pending submissions with an all-submissions toggle", () => {
    assert.match(source, /export type BoardSubmissionFilter = "pending" \| "all"/)
    assert.match(source, /function visibleBoardSubmissionsForFilter<T extends \{ status\?: string \}>/)
    assert.match(source, /const \[submissionFilter, setSubmissionFilter\] = useState<BoardSubmissionFilter>\("pending"\)/)
    assert.match(source, /Pending \{pendingTotal\}/)
    assert.match(source, /All \{submissions\.length\}/)
    assert.match(source, /visibleRecruiterGroups\.map\(renderGroup\)/)
  })
})
