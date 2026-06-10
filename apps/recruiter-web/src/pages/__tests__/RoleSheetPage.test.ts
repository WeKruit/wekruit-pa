// @ts-nocheck - source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "../RoleSheetPage.tsx"), "utf8")
const css = readFileSync(resolve(here, "../../styles/role-sheet.css"), "utf8")
const apiSource = readFileSync(resolve(here, "../../lib/recruiter-board-api.ts"), "utf8")
const mainSource = readFileSync(resolve(here, "../../main.tsx"), "utf8")

function sliceBetween(src: string, start: string, end: string): string {
  const startIdx = src.indexOf(start)
  assert.ok(startIdx >= 0, `marker exists: ${start}`)
  const endIdx = src.indexOf(end, startIdx)
  assert.ok(endIdx > startIdx, `closing marker exists: ${end}`)
  return src.slice(startIdx, endIdx)
}

test("candidate columns are declared in the founder's sheet order", () => {
  const columnsSlice = sliceBetween(source, "const CANDIDATE_COLUMNS: SheetColumn[] = [", "\n]")
  const labels = [...columnsSlice.matchAll(/label: "([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(labels.slice(0, 6), [
    "Candidate name",
    "Email",
    "LinkedIn",
    "Resume",
    "Current company",
    "Current title",
  ])
  assert.deepEqual(labels, [
    "Candidate name",
    "Email",
    "LinkedIn",
    "Resume",
    "Current company",
    "Current title",
    "Location",
    "Years of exp",
    "Work auth",
    "Employment status",
    "Comp expectation",
    "Notice period",
    "Availability",
  ])
  assert.match(columnsSlice, /\{ id: "name", label: "Candidate name", required: true, key: true \}/)
  assert.match(columnsSlice, /\{ id: "email", label: "Email", required: true \}/)
  assert.match(columnsSlice, /\{ id: "linkedin", label: "LinkedIn", required: true \}/)
  assert.match(columnsSlice, /\{ id: "resume", label: "Resume", required: true \}/)
})

test("header row runs candidate cells → checklist → submit fields → Notes → Status → Feedback → 💬 → action", () => {
  const head = sliceBetween(source, "<thead>", "</thead>")
  const order = [
    head.indexOf("{CANDIDATE_COLUMNS.map"),
    head.indexOf("{checklistColumns.map"),
    head.indexOf("{extraFieldDefs.map"),
    head.indexOf(">Notes</th>"),
    head.indexOf(">Status</th>"),
    head.indexOf(">Feedback</th>"),
    head.indexOf("💬</th>"),
    head.indexOf('rs-c-action'),
  ]
  for (const idx of order) assert.ok(idx >= 0, "every column group renders a header")
  assert.deepEqual([...order].sort((a, b) => a - b), order, "header groups appear in the pinned order")
})

test("checklist-item columns are generated from the job checklist groups, hard→fit→bonus→anti", () => {
  assert.match(source, /const CHECKLIST_KIND_ORDER: ChecklistKind\[\] = \["hard", "fit", "bonus", "anti"\]/)
  assert.match(source, /CHECKLIST_KIND_ORDER\.indexOf\(a\.kind\) - CHECKLIST_KIND_ORDER\.indexOf\(b\.kind\)/)
  assert.match(source, /groups\.flatMap\(\(group\) => group\.items\.map\(\(item\) => \(\{ id: item\.id, text: item\.text, kind: group\.kind \}\)\)\)/)
  // short header + full text on hover + group chip
  assert.match(source, /function checklistShortLabel\(text: string\): string/)
  assert.match(source, /words\.slice\(0, 4\)\.join\(" "\)/)
  assert.match(source, /<th key=\{column\.id\} title=\{column\.text\} className=\{`rs-th rs-c-check is-\$\{column\.kind\}`\}>/)
  assert.match(source, /<span className=\{`rs-chip is-\$\{column\.kind\}`\}>\{CHECKLIST_KIND_CHIP\[column\.kind\]\}<\/span>/)
})

test("checklist cells are graded selects: — / Strong / Yes / Partial / No", () => {
  const optionsSlice = sliceBetween(source, "const CHECKLIST_VALUE_OPTIONS", "\n]")
  const labels = [...optionsSlice.matchAll(/label: "([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(labels, ["—", "Strong", "Yes", "Partial", "No"])
  const values = [...optionsSlice.matchAll(/\{ value: "([a-z]*)", label:/g)].map((m) => m[1])
  assert.deepEqual(values, ["", "strong", "yes", "partial", "no"])
  assert.match(source, /\{CHECKLIST_VALUE_OPTIONS\.map\(\(option\) => \(/)
})

test("the blank add row is always the last table row", () => {
  const body = sliceBetween(source, "<tbody>", "</tbody>")
  const rowsIdx = body.indexOf("{roleSubmissions.map((row) => (")
  const addIdx = body.indexOf("<AddRow")
  assert.ok(rowsIdx >= 0 && addIdx > rowsIdx, "AddRow renders after the real rows")
  assert.match(source, /className="rs-row-add"/)
})

test("add row gates Submit on required identity URLs, required submit fields, and consent", () => {
  const blockersSlice = sliceBetween(source, "function addRowBlockers", "\nfunction ")
  assert.match(blockersSlice, /if \(!draft\.cells\.name\.trim\(\)\) blockers\.push\("Candidate name is required\."\)/)
  assert.match(blockersSlice, /if \(!email\) blockers\.push\("Candidate email is required\."\)/)
  assert.match(blockersSlice, /if \(!linkedin\) blockers\.push\("LinkedIn URL is required\."\)/)
  assert.match(blockersSlice, /else if \(!normalizeSheetUrl\(linkedin\)\) blockers\.push\("LinkedIn URL must be a valid URL\."\)/)
  assert.match(blockersSlice, /if \(!resume\) blockers\.push\("Resume is required — paste a link or drop a file\."\)/)
  assert.match(blockersSlice, /else if \(!normalizeSheetUrl\(resume\) && !draft\.resumeFileName\) blockers\.push\("Resume must be a valid URL or an uploaded file\."\)/)
  assert.doesNotMatch(blockersSlice, /LinkedIn URL or resume link is required/)
  assert.match(blockersSlice, /if \(field\.required && !value\) blockers\.push\(`\$\{field\.label\} is required for this role\.`\)/)
  assert.match(blockersSlice, /if \(!draft\.consent\) blockers\.push\("Candidate consent is required\."\)/)
  assert.match(source, /const addRowReady = addBlockers\.length === 0/)
  assert.match(source, /disabled=\{!ready \|\| submitting\}/)
  // the consent checkbox lives in the add row's action cell
  const addRowSlice = sliceBetween(source, "function AddRow(", "\nfunction ThreadDrawer(")
  assert.match(addRowSlice, /className="rs-consent"/)
  assert.match(addRowSlice, /Candidate consented/)
})

test("disabled add-row submit explains the blocking fields inline", () => {
  const addRowSlice = sliceBetween(source, "function AddRow(", "\nfunction ThreadDrawer(")
  assert.match(addRowSlice, /const submitBlockerId = "rs-add-row-submit-blockers"/)
  assert.match(addRowSlice, /aria-describedby=\{ready \? undefined : submitBlockerId\}/)
  assert.match(addRowSlice, /role="status"/)
  assert.match(addRowSlice, /aria-live="polite"/)
  assert.match(addRowSlice, /Cannot submit yet/)
  assert.match(addRowSlice, /blockers\.slice\(0, 4\)\.map/)
  assert.match(addRowSlice, /Fix \{blockers\.length - 4\} more/)
  assert.match(css, /\.rs-submit-blockers/)
})

test("add row submits through paRecruiterSubmission with cells, graded checklist, and extraFields", () => {
  const submitSlice = sliceBetween(source, "const submitAddRow = async", "const threadRow =")
  assert.match(submitSlice, /await submitRecruiterCandidate\(\{/)
  assert.match(submitSlice, /candidate: candidatePayload\(addDraft\),/)
  assert.match(submitSlice, /checklist: checklistPayload\(addDraft\),/)
  assert.match(submitSlice, /candidateConsent: true,/)
  assert.match(submitSlice, /extraFields: extraFieldsPayload\(addDraft, extraFieldDefs\),/)
  // the seven sheet-only cells ride inside candidate{}
  const payloadSlice = sliceBetween(source, "function candidatePayload", "\nfunction checklistPayload")
  for (const cell of [
    "currentCompany",
    "location",
    "workAuthorization",
    "employmentStatus",
    "compensationExpectation",
    "noticePeriod",
    "interviewAvailability",
  ]) {
    assert.match(payloadSlice, new RegExp(`${cell}: draft\\.cells\\.${cell}\\.trim\\(\\)`), `${cell} maps onto candidate{}`)
  }
  assert.match(payloadSlice, /currentRole: draft\.cells\.currentTitle\.trim\(\)/, "Current title column maps to candidate.currentRole")
})

test("submit success resets the blank row; failure keeps values with an inline error under the table", () => {
  const submitSlice = sliceBetween(source, "const submitAddRow = async", "const threadRow =")
  const failIdx = submitSlice.indexOf("setSubmitError(formatSubmitFailure(result.reason))")
  const returnIdx = submitSlice.indexOf("return", failIdx)
  const refreshIdx = submitSlice.indexOf("await refreshSubmissions()")
  const resetIdx = submitSlice.indexOf("setAddDraft(emptyAddRowDraft())")
  const clearIdx = submitSlice.indexOf("clearAddRowDraft(jobId)")
  assert.ok(failIdx >= 0 && returnIdx > failIdx, "failure path bails before any reset")
  assert.ok(refreshIdx > returnIdx && resetIdx > refreshIdx && clearIdx > resetIdx, "success refetches rows then resets the blank row")
  const tableIdx = source.indexOf('<div className="rs-table-wrap">')
  const errorIdx = source.indexOf('{submitError && <div className="rs-sheet-error">')
  assert.ok(tableIdx >= 0 && errorIdx > tableIdx, "inline submit error renders under the table")
})

test("the blank row draft persists to localStorage per job", () => {
  assert.match(source, /const SHEET_DRAFT_KEY_PREFIX = "rs-draft-v1:"/)
  assert.match(source, /localStorage\.getItem\(SHEET_DRAFT_KEY_PREFIX \+ jobId\)/)
  assert.match(source, /localStorage\.setItem\(SHEET_DRAFT_KEY_PREFIX \+ jobId, JSON\.stringify\(draft\)\)/)
  assert.match(source, /if \(jobId\) setAddDraft\(loadAddRowDraft\(jobId\)\)/)
  assert.match(source, /if \(jobId\) saveAddRowDraft\(jobId, next\)/, "every edit persists the blank-row draft")
  assert.match(source, /jobId \? loadAddRowDraft\(jobId\) : emptyAddRowDraft\(\)/, "draft restores on first render")
})

test("editing a row exposes Save which PATCHes through paRecruiterSubmissionUpdate", () => {
  const saveSlice = sliceBetween(source, "const saveRow = async", "const addBlockers =")
  assert.match(saveSlice, /await updateRecruiterSubmission\(\{/)
  assert.match(saveSlice, /submissionId: submissionApiId\(row\),/)
  assert.match(saveSlice, /candidate: candidatePayload\(draft\),/)
  assert.match(saveSlice, /checklist: checklistPayload\(draft\),/)
  assert.match(saveSlice, /extraFields: extraFieldsPayload\(draft, extraFieldDefs\),/)
  // Save only renders for a dirty editable row
  const rowSlice = sliceBetween(source, "function SheetRow(", "\nfunction AddRow(")
  assert.match(rowSlice, /const dirty = draft !== null/)
  assert.match(rowSlice, /\{editable \? \(\s*\n\s*dirty && \(/)
  assert.match(rowSlice, /\{saving \? "Saving…" : "Save"\}/)
})

test("rows stay editable only while WeKruit owns them; locked rows render plain text", () => {
  assert.match(source, /const EDITABLE_STATUSES = new Set\(\["submitted", "new", "reviewing", "wekruit_interview"\]\)/)
  assert.match(source, /return EDITABLE_STATUSES\.has\(row\.status \|\| "submitted"\)/)
  const rowSlice = sliceBetween(source, "function SheetRow(", "\nfunction AddRow(")
  assert.match(rowSlice, /if \(!editable\) \{/)
  assert.match(rowSlice, /return value \|\| "—"/)
})

test("409 row_locked surfaces the pinned toast", () => {
  const saveSlice = sliceBetween(source, "const saveRow = async", "const addBlockers =")
  assert.match(saveSlice, /e instanceof RecruiterApiError && e\.status === 409/)
  assert.match(saveSlice, /showToast\("Row locked — candidate is with the client"\)/)
})

test("💬 opens the thread drawer: name header, stepper, needs-info banner, conversation, send", () => {
  assert.match(source, /className="rs-thread-btn" onClick=\{onOpenThread\}/)
  const drawerSlice = sliceBetween(source, "function ThreadDrawer(", "\n}\n")
  assert.match(drawerSlice, /className="rs-drawer"/)
  assert.match(drawerSlice, /<h2>\{row\.candidate\?\.name \|\| "Candidate"\}<\/h2>/)
  assert.match(drawerSlice, /<SubmissionStatusStepper status=\{row\.status\} \/>/)
  assert.match(drawerSlice, /rs-drawer__banner/)
  assert.match(drawerSlice, /Needs more info/)
  assert.match(drawerSlice, /is-\$\{comment\.by === "recruiter" \? "recruiter" : "wekruit"\}/)
  assert.match(drawerSlice, /\{sending \? "Sending…" : "Send"\}/)
  // comments load on open and refresh after send
  assert.match(source, /const comments = await fetchRecruiterSubmissionComments\(submissionApiId\(row\)\)/)
  const sendSlice = sliceBetween(source, "const sendComment = async", "if (error)")
  const addIdx = sendSlice.indexOf("await addRecruiterSubmissionComment({")
  const reloadIdx = sendSlice.indexOf("await loadComments(threadRow)")
  assert.ok(addIdx >= 0 && reloadIdx > addIdx, "thread auto-refreshes after sending")
  // recruiter messages sit right-aligned
  assert.match(css, /\.rs-msg\.is-recruiter \{ align-self: flex-end;/)
})

test("Status and Feedback columns are read-only sheet cells", () => {
  const rowSlice = sliceBetween(source, "function SheetRow(", "\nfunction AddRow(")
  assert.match(rowSlice, /<td data-label="Status" className="rs-c-status rs-c-key">\{sheetStageLabel\(row\)\}<\/td>/)
  assert.match(rowSlice, /\{sheetFeedbackText\(row, comments\)\}/)
  // stage label comes from the pinned 4-step model, feedback falls back to em-dash
  assert.match(source, /const model = buildSubmissionStatusStepper\(row\.status, row\.requestedInfo\)/)
  assert.match(source, /model\.terminal \? model\.outcome\.label : model\.steps\[model\.currentStep\]\?\.label/)
  assert.match(source, /return "—"\n\}/)
})

test("JD section is open by default above the sheet", () => {
  assert.ok(source.includes('<details className="rs-jd" open>'), "JD renders inside an open <details>")
  const jdIdx = source.indexOf('<details className="rs-jd" open>')
  const tableIdx = source.indexOf('<table className="rs-sheet">')
  assert.ok(jdIdx >= 0 && tableIdx > jdIdx, "the sheet follows the JD")
  assert.match(source, /\{job\.jdBlocks\.map\(\(block, i\) => \(/)
  assert.match(source, /\{job\.recruiterBoard\.culture\.bullets\.map\(\(bullet, i\) => \(/)
})

test("legend strip summarizes checklist groups with hover guidance", () => {
  assert.match(source, /className="rs-legend"/)
  const legendSlice = sliceBetween(source, "const CHECKLIST_LEGEND_LABEL", "\n}")
  assert.match(legendSlice, /hard: "Hard filters"/)
  assert.match(legendSlice, /fit: "Strong fit"/)
  assert.match(legendSlice, /bonus: "Bonus"/)
  assert.match(legendSlice, /anti: "Anti-signals"/)
  assert.match(source, /hover any column header for the full requirement\./)
})

test("sheet header and first column are sticky; rows degrade to cards under 900px", () => {
  assert.match(css, /\.rs-sheet thead th \{\s*\n\s*position: sticky;\s*\n\s*top: 0;/)
  assert.match(css, /\.rs-sheet th:first-child,\s*\n\.rs-sheet td:first-child \{\s*\n\s*position: sticky;\s*\n\s*left: 0;/)
  assert.match(css, /@media \(max-width: 899px\)/)
  assert.match(css, /content: attr\(data-label\);/)
  assert.match(css, /\.rs-sheet tr\.rs-row-real td\.rs-c-more \{ display: none; \}/)
  // every body cell carries the data-label the card view reads
  assert.match(source, /<td\s*\n\s*key=\{column\.id\}\s*\n\s*data-label=\{column\.label\}/)
  assert.match(source, /data-label="Status"/)
})

test("banned legacy-page strings stay out of the sheet page", () => {
  for (const banned of [
    "Pending slots",
    "pipeline",
    "Scorecard",
    "prospect",
    "Quick source",
    "packet",
    "deal room",
    "calibration",
    "proof",
    "Review risks",
    "payout",
    "marketplace",
    "credits",
    "Suggested asks",
  ]) {
    assert.ok(!source.includes(banned), `"${banned}" stays off the role sheet page`)
  }
})

test("api helpers cover the pinned update + comments contract", () => {
  assert.match(apiSource, /RECRUITER_SUBMISSION_UPDATE_URL = `\$\{DEFAULT_BASE\}\/paRecruiterSubmissionUpdate`/)
  assert.match(apiSource, /RECRUITER_SUBMISSION_COMMENTS_LIST_URL = `\$\{DEFAULT_BASE\}\/paRecruiterSubmissionCommentsList`/)
  assert.match(apiSource, /RECRUITER_SUBMISSION_COMMENT_ADD_URL = `\$\{DEFAULT_BASE\}\/paRecruiterSubmissionCommentAdd`/)
  assert.match(apiSource, /export type SubmissionChecklistValue = "strong" \| "yes" \| "partial" \| "no"/)
  for (const cell of [
    "currentCompany",
    "location",
    "workAuthorization",
    "employmentStatus",
    "compensationExpectation",
    "noticePeriod",
    "interviewAvailability",
  ]) {
    assert.match(apiSource, new RegExp(`${cell}\\?: string`), `SubmissionCandidateCells carries ${cell}`)
  }
  // update throws a status-carrying error so the page can branch on 409
  const updateSlice = sliceBetween(apiSource, "export async function updateRecruiterSubmission", "export interface RecruiterSubmissionComment")
  assert.match(updateSlice, /throw new RecruiterApiError\(body\.reason \?\? `paRecruiterSubmissionUpdate HTTP \$\{res\.status\}`, res\.status\)/)
  assert.match(apiSource, /\?submissionId=\$\{encodeURIComponent\(submissionId\)\}/)
  const commentSlice = sliceBetween(apiSource, "export async function addRecruiterSubmissionComment", "export async function checkRecruiterCandidateIdentity")
  assert.match(commentSlice, /method: "POST"/)
})

test("the role route renders RoleSheetPage; the old role page is unrendered", () => {
  assert.match(mainSource, /import RoleSheetPage from "\.\/pages\/RoleSheetPage\.js"/)
  assert.match(mainSource, /<Route path="\/recruiters\/job\/:jobId" element=\{<RoleSheetPage \/>\} \/>/)
  assert.ok(!mainSource.includes("RecruiterRole"), "old RecruiterRole page is no longer routed")
})
