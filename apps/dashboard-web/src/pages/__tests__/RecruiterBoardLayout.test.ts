import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "node:test"

const source = readFileSync(resolve(import.meta.dirname, "../RecruiterBoardOps.tsx"), "utf8")

describe("RecruiterBoardOps selected-review layout", () => {
  it("opens the candidate detail as the SAME dual-pane SideDrawer modal as prescreen", () => {
    // The recruiter candidate detail is now the same opening modal as the prescreen
    // review: SideDrawer (xl) + the shared .pa-eval-dualpane two-column grid + the
    // shared dual-pane style tokens — read-only LEFT, human-review RIGHT.
    assert.match(source, /import \{ SideDrawer \} from "\.\.\/components\/prescreen\/PrescreenReviewDrawers\.js"/)
    assert.match(source, /import \{ DUAL_PANE_COLLAPSE_CSS, dualPaneStyle, paneHeaderStyle \} from "\.\.\/components\/prescreen\/dual-pane\.js"/)
    assert.match(source, /<SideDrawer[\s\S]*?xl\s*\n?\s*>/)
    assert.match(source, /className="pa-eval-dualpane" style=\{dualPaneStyle\}/)
    assert.match(source, /<style>\{DUAL_PANE_COLLAPSE_CSS\}<\/style>/)
    // Both pane eyebrows use the shared paneHeaderStyle (read-only LEFT / human RIGHT).
    assert.match(source, /<div style=\{paneHeaderStyle\}>Candidate · AI evaluation — read-only<\/div>/)
    assert.match(source, /<div style=\{paneHeaderStyle\}>Human review<\/div>/)
  })

  it("renders the board list at full width while the modal overlays", () => {
    // The board list no longer shrinks into a side-by-side rail; the modal overlays it,
    // so the dead shrink/shell styles are gone and the table is always full width.
    assert.doesNotMatch(source, /selectedReviewShellStyle/)
    assert.doesNotMatch(source, /selectedBoardTableStyle/)
    assert.match(source, /<table style=\{boardTableStyle\}>/)
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

  it("loads enough recruiter submissions for admin-heavy days but renders each job page at 100 rows", () => {
    assert.match(source, /const BOARD_SUBMISSION_LOAD_LIMIT = 5_000/)
    assert.match(source, /const BOARD_SUBMISSION_PAGE_SIZE = 100/)
    assert.match(source, /limit\(BOARD_SUBMISSION_LOAD_LIMIT\)/)
    assert.match(source, /const \[jobPageByKey, setJobPageByKey\] = useState<Record<string, number>>\(\{\}\)/)
    assert.match(source, /const pageRows = job\.submissions\.slice\(start, start \+ BOARD_SUBMISSION_PAGE_SIZE\)/)
    assert.match(source, /<tbody>\{pageRows\.map\(renderSubmissionRow\)\}<\/tbody>/)
    assert.match(source, /Showing \{first\}-\{last\} of \{job\.submissions\.length\} · Best first/)
    assert.match(source, /Page \{pageIndex \+ 1\} \/ \{totalPages\}/)
    assert.match(source, /setBulkSelectionForSubmissions\(pageRows, e\.target\.checked\)/)
  })

  it("sorts each role page by AI fit quality before paginating", () => {
    assert.match(source, /function boardSubmissionQualityScore\(submission: BoardSubmissionDoc\): number/)
    assert.match(source, /function sortSubmissions\(submissions: BoardSubmissionDoc\[\]\): BoardSubmissionDoc\[\] \{[\s\S]*boardSubmissionQualityScore\(b\) - boardSubmissionQualityScore\(a\)/)
    assert.match(source, /if \(Math\.abs\(qualityDelta\) > 0\.000001\) return qualityDelta/)
    assert.match(source, /function buildJobGroups\(submissions: BoardSubmissionDoc\[\]\): BoardJobGroup\[\] \{[\s\S]*const sorted = sortSubmissions\(list\)/)
    assert.match(source, /submissions: sorted,\n\s+pendingCount: sorted\.filter\(isPending\)\.length,/)
    assert.match(source, /const pageRows = job\.submissions\.slice\(start, start \+ BOARD_SUBMISSION_PAGE_SIZE\)/)
  })

  it("does not clip later role tables inside the recruiter card", () => {
    const boardGroupBodyStyle = source.match(/const boardGroupBodyStyle: CSSProperties = \{[\s\S]*?\n\}/)
    assert.ok(boardGroupBodyStyle)
    assert.doesNotMatch(boardGroupBodyStyle[0], /maxHeight/)
    assert.doesNotMatch(boardGroupBodyStyle[0], /overflow/)
    assert.doesNotMatch(boardGroupBodyStyle[0], /scrollbarWidth/)
  })

  it("marks submissions viewed when opened and shows a persisted viewed badge", () => {
    assert.match(source, /adminViewedAt\?: \{ seconds\?: number \} \| string \| null/)
    assert.match(source, /function hasAdminViewed\(submission: BoardSubmissionDoc\): boolean/)
    assert.match(source, /function markSubmissionViewed\(submission: BoardSubmissionDoc\)/)
    assert.match(source, /updateDoc\(doc\(db\(\), "pa-recruiter-submissions", submission\.id\), \{[\s\S]*adminViewedAt: viewedAt,[\s\S]*adminViewedByEmail: viewedBy/)
    assert.match(source, /onClick=\{\(\) => \(selected \? setSelectedId\(null\) : openSubmission\(submission\)\)\}/)
    assert.match(source, /\{viewed && <Badge tone="muted">Viewed<\/Badge>\}/)
  })

  it("keeps message badges after reload by persisting parent comment metadata", () => {
    assert.match(source, /adminCommentCount\?: number \| null/)
    assert.match(source, /function normalizedCommentCount\(submission: BoardSubmissionDoc\): number/)
    assert.match(source, /const loadedCommentCounts = Object\.fromEntries\(/)
    assert.match(source, /setCommentCounts\(loadedCommentCounts\)/)
    assert.match(source, /updateDoc\(doc\(db\(\), "pa-recruiter-submissions", submissionId\), \{[\s\S]*adminCommentCount: safeCount,[\s\S]*adminLastCommentAt: lastCommentAt \?\? null/)
    assert.match(source, /const commentCount = commentCounts\[submission\.id\] \?\? normalizedCommentCount\(submission\)/)
  })
})
