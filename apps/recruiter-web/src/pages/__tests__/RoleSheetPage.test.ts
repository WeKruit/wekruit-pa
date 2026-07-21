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

function sliceFrom(src: string, start: string): string {
  const startIdx = src.indexOf(start)
  assert.ok(startIdx >= 0, `marker exists: ${start}`)
  return src.slice(startIdx)
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
    "Expected salary range (recommended)",
    "Notice period",
    "Availability",
  ])
  assert.match(columnsSlice, /\{ id: "name", label: "Candidate name", required: true, key: true \}/)
  assert.match(columnsSlice, /\{ id: "email", label: "Email", required: true \}/)
  assert.match(columnsSlice, /\{ id: "linkedin", label: "LinkedIn", required: true \}/)
  assert.match(columnsSlice, /\{ id: "resume", label: "Resume", required: true \}/)
})

test("candidate table header shows compact review columns", () => {
  const tableSlice = sliceBetween(source, '<table className="rs-ctable">', "</thead>")
  const order = [
    tableSlice.indexOf("<th>Candidate</th>"),
    tableSlice.indexOf("<th>Submitted</th>"),
    tableSlice.indexOf("<th>Status</th>"),
    tableSlice.indexOf("<th>Feedback</th>"),
  ]
  for (const idx of order) assert.ok(idx >= 0, "every compact table column renders a header")
  assert.deepEqual([...order].sort((a, b) => a - b), order, "compact headers stay in the pinned order")
  assert.ok(tableSlice.indexOf("{CANDIDATE_COLUMNS.map") < 0, "full candidate cells stay in the detail panel")
  assert.ok(tableSlice.indexOf("{checklistColumns.map") < 0, "checklist stays in the panel, not the table")
})

test("checklist-item columns are generated from the job checklist groups, hard→fit→bonus→anti", () => {
  assert.match(source, /const CHECKLIST_KIND_ORDER: ChecklistKind\[\] = \["hard", "fit", "bonus", "anti"\]/)
  assert.match(source, /CHECKLIST_KIND_ORDER\.indexOf\(a\.kind\) - CHECKLIST_KIND_ORDER\.indexOf\(b\.kind\)/)
  assert.match(source, /groups\.flatMap\(\(group\) => group\.items\.map\(\(item\) => \(\{ id: item\.id, text: item\.text, kind: group\.kind \}\)\)\)/)
  assert.match(source, /function checklistShortLabel\(text: string\): string/)
  assert.match(source, /words\.slice\(0, 4\)\.join\(" "\)/)
  // checklist rendered in add form + detail drawer with kind chip (both use group.kind)
  assert.match(source, /<span className=\{`rs-chip rs-cltier__chip is-\$\{group\.kind\}`\}>\{CHECKLIST_KIND_CHIP\[group\.kind\]\}<\/span>/)
})

test("checklist cells are graded selects: — / Strong / Yes / Partial / No", () => {
  const optionsSlice = sliceBetween(source, "const CHECKLIST_VALUE_OPTIONS", "\n]")
  const labels = [...optionsSlice.matchAll(/label: "([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(labels, ["—", "Strong", "Yes", "Partial", "No"])
  const values = [...optionsSlice.matchAll(/\{ value: "([a-z]*)", label:/g)].map((m) => m[1])
  assert.deepEqual(values, ["", "strong", "yes", "partial", "no"])
  assert.match(source, /\{CHECKLIST_VALUE_OPTIONS\.map\(\(o\) => \(/)
})

test("the add-candidate panel renders before the candidates table when opened", () => {
  const panelIdx = source.indexOf("<AddCandidatePanel")
  const tableIdx = source.indexOf('<table className="rs-ctable">')
  assert.ok(panelIdx >= 0 && tableIdx > panelIdx, "AddCandidatePanel renders before the candidates table")
  assert.match(source, /className="rs-addpanel"/)
  assert.match(source, /className="rs-add-btn"/)
})

test("add form gates Submit on required identity URLs and required submit fields", () => {
  const blockersSlice = sliceBetween(source, "function addRowBlockers", "\nfunction ")
  assert.match(blockersSlice, /if \(!draft\.cells\.name\.trim\(\)\) blockers\.push\("Candidate name is required\."\)/)
  assert.match(blockersSlice, /if \(!email\) blockers\.push\("Candidate email is required\."\)/)
  assert.match(blockersSlice, /if \(!linkedin\) blockers\.push\("LinkedIn URL is required\."\)/)
  assert.match(blockersSlice, /else if \(!normalizeSheetUrl\(linkedin\)\) blockers\.push\("LinkedIn URL must be a valid URL\."\)/)
  assert.match(blockersSlice, /if \(!resume\) blockers\.push\("Resume is required — paste a link or drop a file\."\)/)
  assert.match(blockersSlice, /else if \(!normalizeSheetUrl\(resume\) && !draft\.resumeFileName\) blockers\.push\("Resume must be a valid URL or an uploaded file\."\)/)
  assert.doesNotMatch(blockersSlice, /compensationExpectation.*required/i)
  assert.doesNotMatch(blockersSlice, /LinkedIn URL or resume link is required/)
  assert.match(blockersSlice, /if \(field\.required && !value\) blockers\.push\(`\$\{field\.label\} is required for this role\.`\)/)
  assert.match(source, /const addRowReady = addBlockers\.length === 0/)
  assert.match(source, /disabled=\{!ready \|\| submitting\}/)
})

test("add form also gates Submit on unanswered hard/anti checklist items (strong-fit and bonuses optional)", () => {
  const blockersSlice = sliceBetween(source, "function addRowBlockers", "\nfunction formatSubmitFailure")
  // required tiers come from a single list; bonus is excluded
  assert.match(source, /const CHECKLIST_REQUIRED_KINDS: ChecklistKind\[\] = \["hard", "anti"\]/)
  assert.match(blockersSlice, /CHECKLIST_REQUIRED_KINDS\.includes\(col\.kind\) && !\(draft\.checklist\[col\.id\] \?\? ""\)/)
  assert.match(blockersSlice, /blockers\.push\("Answer every hard and anti checklist item \(strong-fit signals and bonuses are optional\)\."\)/)
  // the gate reads from the job's checklist columns, threaded into the blocker fn
  assert.match(source, /addRowBlockers\(addDraft, extraFieldDefs, checklistColumns\)/)
})

test("checklist is grouped into required/optional tiers with the contract rule text", () => {
  // tier metadata: label + required flag + one-line rule, in the shared order
  const metaSlice = sliceBetween(source, "const CHECKLIST_TIER_META", "\n}")
  assert.match(metaSlice, /hard: \{ label: "Hard filters", required: true, rule: "Must mostly be met to be considered a match\." \}/)
  assert.match(metaSlice, /fit: \{ label: "Strong fit signals", required: false, rule: "Ideal candidates hit 2 or more — optional, but it helps\." \}/)
  assert.match(metaSlice, /anti: \{ label: "Anti-signals", required: true, rule: "If any is present, likely NOT a match\." \}/)
  assert.match(metaSlice, /bonus: \{ label: "Bonuses", required: false, rule: "Nice to have — leave blank if unknown\." \}/)
  // display order hard → fit → anti → bonus, and a grouping helper that filters by kind
  assert.match(source, /const CHECKLIST_TIER_DISPLAY_ORDER: ChecklistKind\[\] = \["hard", "fit", "anti", "bonus"\]/)
  assert.match(source, /function groupChecklistByTier\(columns: ChecklistColumn\[\]\): ChecklistTierGroup\[\]/)
  // one shared renderer drives both the submit form and the read-only detail
  assert.match(source, /function ChecklistTiers\(/)
  assert.match(source, /<span className=\{`rs-cltier__req \$\{meta\.required \? "is-required" : "is-optional"\}`\}>/)
  assert.match(source, /<p className="rs-cltier__rule">\{meta\.rule\}<\/p>/)
  // tier-group header + required-badge styles exist
  assert.match(css, /\.rs-cltier__head/)
  assert.match(css, /\.rs-cltier__req\.is-required/)
  assert.match(css, /\.rs-cltier__req\.is-optional/)
})

test("read-only detail shows checked-vs-failed (anti inverted) + the score legend", () => {
  // anti tier inverts: a present anti is a red flag, absent is clear
  const visSlice = sliceBetween(source, "function checklistVisual", "\nfunction ")
  assert.match(visSlice, /if \(kind === "anti"\)/)
  assert.match(visSlice, /word: "flag present", tone: "notmet"/)
  assert.match(visSlice, /word: "clear", tone: "met"/) // anti "no" reads as clear/green
  assert.match(visSlice, /word: "not met", tone: "notmet"/) // positive "no"
  assert.match(visSlice, /word: "not answered", tone: "unanswered"/)
  // glyph + word render with a tone class; colors per met/partial/notmet/unanswered
  assert.match(source, /<span className=\{`rs-clmark is-\$\{vis\.tone\}`\}>/)
  for (const tone of ["met", "partial", "notmet", "unanswered"]) {
    assert.match(css, new RegExp(`\\.rs-clmark\\.is-${tone}`), `clmark tone style for ${tone}`)
  }
  // score legend line: Hard X/Y met · Fit X/Y · Bonus X/Y · Anti N flag(s)
  assert.match(source, /function checklistScoreLegend\(s: ChecklistScore\): string/)
  assert.match(source, /`Hard \$\{s\.hardMet\}\/\$\{s\.hardTotal\} met · `/)
  assert.match(source, /`Anti \$\{s\.antiFlags\} flag\(s\)\. `/)
  assert.match(source, /A match needs most hard filters met and no anti-flags\./)
  assert.match(source, /checklistScoreLegend\(checklistScore\(checklistColumns, view\.checklist\)\)/)
})

test("disabled add panel submit explains the blocking fields inline", () => {
  const addFormSlice = sliceBetween(source, "function AddCandidatePanel(", "\nfunction ThreadDrawer(")
  assert.match(addFormSlice, /role="status"/)
  assert.match(addFormSlice, /aria-live="polite"/)
  assert.match(addFormSlice, /To submit:/)
  assert.match(addFormSlice, /blockers\.slice\(0, 5\)\.map/)
  assert.match(addFormSlice, /disabled=\{!ready \|\| submitting\}/)
  assert.match(css, /\.rs-submit-blockers/)
})

test("add row submits through paRecruiterSubmission with cells, graded checklist, and extraFields", () => {
  const submitSlice = sliceBetween(source, "const submitAddRow = async", "const threadRow =")
  assert.match(submitSlice, /await submitRecruiterCandidate\(\{/)
  assert.match(submitSlice, /candidate: candidatePayload\(addDraft\),/)
  assert.match(submitSlice, /checklist: checklistPayload\(addDraft\),/)
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
  const formIdx = source.indexOf("<AddCandidatePanel")
  assert.ok(formIdx >= 0, "inline submit panel renders")
  assert.match(source, /\{error && <div className="rs-sheet-error">Submission failed: \{error\}<\/div>\}/)
})

test("the blank row draft persists to localStorage per job", () => {
  assert.match(source, /const SHEET_DRAFT_KEY_PREFIX = "rs-draft-v1:"/)
  assert.match(source, /localStorage\.getItem\(SHEET_DRAFT_KEY_PREFIX \+ jobId\)/)
  assert.match(source, /localStorage\.setItem\(SHEET_DRAFT_KEY_PREFIX \+ jobId, JSON\.stringify\(draft\)\)/)
  assert.match(source, /if \(jobId\) setAddDraft\(loadAddRowDraft\(jobId\)\)/)
  assert.match(source, /if \(jobId\) saveAddRowDraft\(jobId, next\)/, "every edit persists the blank-row draft")
  assert.match(source, /jobId \? loadAddRowDraft\(jobId\) : emptyAddRowDraft\(\)/, "draft restores on first render")
})

test("candidate detail panel owns row editing; thread drawer owns conversation only", () => {
  const detailSlice = sliceBetween(source, "function CandidateDetailPanel(", "\nfunction AddCandidatePanel(")
  assert.match(detailSlice, /onEdit: \(mutate: \(draft: RowDraft\) => RowDraft\) => void/)
  assert.match(detailSlice, /onSave: \(\) => void/)
  assert.match(detailSlice, /<input type="text" value=\{value\} onChange=\{\(e\) => setCell\(col\.id, e\.target\.value\)\} \/>/)
  assert.match(detailSlice, /<textarea value=\{view\.notes\}/)
  assert.match(detailSlice, /Save changes/)
  const drawerSlice = sliceFrom(source, "function ThreadDrawer(")
  assert.ok(!drawerSlice.includes("onEdit"), "conversation drawer has no edit callback")
  assert.ok(!drawerSlice.includes("onSave"), "conversation drawer has no save callback")
  assert.match(drawerSlice, /Message WeKruit/)
})

test("EDITABLE_STATUSES is still declared for the add-form update path", () => {
  assert.match(source, /const EDITABLE_STATUSES = new Set\(\["submitted", "new", "reviewing", "wekruit_interview"\]\)/)
  assert.match(source, /return EDITABLE_STATUSES\.has\(row\.status \|\| "submitted"\)/)
})

test("candidate detail and thread drawer show status, fields, checklist, conversation, send", () => {
  const detailSlice = sliceBetween(source, "function CandidateDetailPanel(", "\nfunction AddCandidatePanel(")
  assert.match(detailSlice, /className="rs-detail"/)
  assert.match(detailSlice, /<h3>\{view\.cells\.name \|\| "Candidate"\}<\/h3>/)
  assert.match(detailSlice, /<span className=\{`rs-status is-\$\{tone\}`\}>\{sheetStageLabel\(row\)\}<\/span>/)
  assert.match(detailSlice, /\{CANDIDATE_COLUMNS\.map\(\(col\) => \{/)
  assert.match(detailSlice, /Screening checklist/)
  assert.match(detailSlice, /💬 Conversation/)
  const drawerSlice = sliceFrom(source, "function ThreadDrawer(")
  assert.match(drawerSlice, /className="rs-drawer"/)
  assert.match(drawerSlice, /<h2>\{row\.candidate\?\.name \|\| "Candidate"\}<\/h2>/)
  assert.match(drawerSlice, /<SubmissionStatusStepper status=\{row\.status\} statusHistory=\{row\.statusHistory\} \/>/)
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

test("Status and Feedback columns are read-only candidate table cells", () => {
  const tableSlice = sliceBetween(source, '<table className="rs-ctable">', "</table>")
  assert.match(tableSlice, /const model = buildSubmissionStatusStepper\(row\.status, row\.requestedInfo\)/)
  assert.match(tableSlice, /const fb = sheetFeedbackText\(row, commentsByRow\[row\.id\]\)/)
  assert.match(tableSlice, /<td><span className=\{`rs-status is-\$\{tone\}`\}>\{sheetStageLabel\(row\)\}<\/span><\/td>/)
  assert.match(tableSlice, /<td className="rs-crow__fb" title=\{fb\}>\{fb\}<\/td>/)
  // stage label comes from the pinned 4-step model, feedback falls back to em-dash
  assert.match(source, /const model = buildSubmissionStatusStepper\(row\.status, row\.requestedInfo\)/)
  assert.match(source, /model\.terminal \? model\.outcome\.label : model\.steps\[model\.currentStep\]\?\.label/)
  assert.match(source, /return "—"\n\}/)
})

test("role brief renders the JD before the candidate workspace", () => {
  assert.ok(source.includes('<details className="rs-brief__jd" open>'), "JD renders inside the role brief")
  const jdIdx = source.indexOf('<details className="rs-brief__jd" open>')
  const candsIdx = source.indexOf('<section className="rs-cands">')
  assert.ok(jdIdx >= 0 && candsIdx > jdIdx, "the candidate workspace follows the role brief")
  assert.match(source, /\{job\.jdBlocks\.map\(\(block, i\) => \(/)
  assert.match(source, /\{job\.recruiterBoard\.culture\.bullets\.map\(\(b, i\) => <li key=\{i\}>\{b\}<\/li>\)\}/)
})

test("JD list-kind blocks (null body + items[]) must not crash the sheet", () => {
  // 2026-06-10 prod blank-page: jdBlocks like {heading, items} carry body:null —
  // renderJdBody(null.split) crashed the whole route. Both shapes render.
  assert.match(source, /function renderJdBody\(text: string \| null \| undefined, items\?: string\[\]\)/)
  assert.match(source, /typeof text !== "string"/)
  assert.match(source, /renderJdBody\(block\.body, block\.items\)/)
})

test("legend strip summarizes checklist groups with hover guidance", () => {
  assert.match(source, /className="rs-brief__rubric"/)
  const legendSlice = sliceBetween(source, "const CHECKLIST_LEGEND_LABEL", "\n}")
  assert.match(legendSlice, /hard: "Hard filters"/)
  assert.match(legendSlice, /fit: "Strong fit"/)
  assert.match(legendSlice, /bonus: "Bonus"/)
  assert.match(legendSlice, /anti: "Anti-signals"/)
  assert.match(source, /What WeKruit screens for/)
  assert.match(source, /CHECKLIST_LEGEND_LABEL\[group\.kind\]/)
})

test("candidate workspace layout and table use the current responsive surface", () => {
  assert.match(css, /\.rs-shell2/)
  assert.match(css, /grid-template-columns: 340px minmax\(0, 1fr\);/)
  assert.match(css, /\.rs-shell2\.has-detail \{ grid-template-columns: 300px minmax\(0, 1fr\) 380px; \}/)
  assert.match(css, /@media \(max-width: 1080px\)/)
  assert.match(css, /\.rs-ctable/)
  assert.match(css, /\.rs-crow/)
  assert.match(css, /@media \(max-width: 560px\) \{ \.rs-addpanel__grid \{ grid-template-columns: 1fr; \} \}/)
  assert.match(source, /className="rs-crow__cand"/)
  assert.match(source, /className="rs-crow__fb"/)
  // submissions table only renders when the zero-submission empty state is false
  assert.match(source, /roleSubmissions\.length === 0 \?/)
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
