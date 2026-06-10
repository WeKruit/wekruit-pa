// @ts-nocheck - source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const roleSource = readFileSync(resolve(here, "../RecruiterRole.tsx"), "utf8")
const boardSource = readFileSync(resolve(here, "../RecruiterBoard.tsx"), "utf8")
const toggleSource = readFileSync(resolve(here, "../../components/SubmissionUpdatesToggle.tsx"), "utf8")

test("role page renders an inline Your submissions section with the shared stepper", () => {
  const sectionStart = roleSource.indexOf("Your submissions for this role")
  assert.ok(sectionStart > 0, "inline submissions section exists on the role page")
  const guardStart = roleSource.lastIndexOf("{roleSubmissions.length > 0 && (", sectionStart)
  assert.ok(guardStart > 0, "section renders nothing when the recruiter has no submissions for the role")
  const sectionEnd = roleSource.indexOf("</section>", sectionStart)
  const sectionSlice = roleSource.slice(guardStart, sectionEnd)
  assert.match(sectionSlice, /<SubmissionStatusStepper status=\{row\.status\} requestedInfo=\{row\.requestedInfo\} \/>/)
  assert.match(sectionSlice, /Submitted \{roleSubmissionSubmittedDate\(row\)\}/)
  assert.doesNotMatch(sectionSlice, /No submitted candidates yet/, "empty state stays silent")
})

test("submit success refetches submissions so the inline section updates immediately", () => {
  const onSubmitStart = roleSource.indexOf("const onSubmit = async")
  const onSubmitEnd = roleSource.indexOf("const resetChecklist", onSubmitStart)
  const onSubmitSlice = roleSource.slice(onSubmitStart, onSubmitEnd)
  const successIdx = onSubmitSlice.indexOf("setSubmission(result)")
  const refetchIdx = onSubmitSlice.indexOf("const updatedSubmissions = await fetchRecruiterSubmissions()")
  assert.ok(successIdx > 0)
  assert.ok(refetchIdx > successIdx, "submissions refetch happens after a successful submit")
  assert.match(onSubmitSlice, /setSubmissions\(updatedSubmissions\)/)
})

test("stepper is shared by the My submissions tracker rows", () => {
  assert.match(boardSource, /import \{ SubmissionStatusStepper \} from "\.\.\/components\/SubmissionStatusStepper\.js"/)
  assert.match(boardSource, /<SubmissionStatusStepper status=\{submission\.status\} requestedInfo=\{submission\.requestedInfo\} \/>/)
  assert.doesNotMatch(boardSource, /SUBMISSION_PROGRESS/, "legacy six-step timeline is replaced by the pinned stepper")
})

test("per-job submitFields render between the candidate fields and the checklist", () => {
  const formStart = roleSource.indexOf('id="submit-candidate"')
  const consentIdx = roleSource.indexOf('className="rb-consent"', formStart)
  const checklistIdx = roleSource.indexOf("Fit checklist", formStart)
  const extraIdx = roleSource.indexOf("roleSubmitFields(job).map((field) =>", formStart)
  assert.ok(formStart > 0 && consentIdx > 0 && checklistIdx > 0)
  assert.ok(extraIdx > formStart, "extra fields render inside the submit form")
  assert.ok(extraIdx < checklistIdx, "extra fields render before the checklist")
  const extraSlice = roleSource.slice(extraIdx, consentIdx)
  assert.match(extraSlice, /\{field\.label\}\{field\.required \? " \*" : ""\}/, "label carries a required marker")
  assert.match(extraSlice, /placeholder=\{field\.placeholder \|\|/, "placeholder is wired")
  assert.match(extraSlice, /extraFields: \{ \.\.\.form\.extraFields, \[field\.id\]: e\.target\.value \}/, "values keyed by field id")
  assert.doesNotMatch(extraSlice, /\n\s+required\b/, "no native required attr; validation goes through packet blockers")
})

test("extraFields are validated, sent in the payload, and persisted in the per-job draft", () => {
  assert.match(roleSource, /extraFields: Record<string, string>/, "FormState carries extraFields")
  assert.match(roleSource, /extraFields: \{\},\n  \}\n\}/, "emptyForm seeds extraFields so the localStorage draft round-trips")
  assert.match(roleSource, /if \(field\.required && !value\) blockers\.push\(`\$\{field\.label\} is required for this role\.`\)/)
  assert.match(roleSource, /field\.kind === "url" && !normalizeSubmitUrl\(value\)/, "url kinds must parse as URLs")
  assert.ok(roleSource.includes("? trimmed : `https://${trimmed}`"), "scheme optional — https:// added when missing")
  assert.match(roleSource, /\.trim\(\)\.slice\(0, 500\)/, "values trimmed and capped at 500 chars")
  assert.match(roleSource, /\.\.\.\(Object\.keys\(extraFields\)\.length \? \{ extraFields \} : \{\}\)/, "payload includes extraFields keyed by field id")
})

test("email status-update toggle reads absent-as-true and writes submissionUpdatesEmail", () => {
  assert.match(toggleSource, /notificationPreferences\?\.submissionUpdatesEmail !== false/, "absent ⇒ true")
  assert.match(toggleSource, /updateRecruiterPreferences\(\{/)
  assert.match(toggleSource, /submissionUpdatesEmail: next/)
  assert.match(toggleSource, /Email me status updates/)
})

test("toggle is mounted on the board header profile area and the My submissions view", () => {
  assert.match(boardSource, /import \{ SubmissionUpdatesToggle \} from "\.\.\/components\/SubmissionUpdatesToggle\.js"/)
  const identityIdx = boardSource.indexOf('className="rb-platform__identity"')
  const headerToggleIdx = boardSource.indexOf("<SubmissionUpdatesToggle session={session} onSessionChange={setSession} compact />")
  assert.ok(identityIdx > 0 && headerToggleIdx > identityIdx, "toggle sits next to the profile identity block")
  const submissionsTabIdx = boardSource.indexOf("function SubmissionsTab(")
  const tabToggleIdx = boardSource.indexOf("<SubmissionUpdatesToggle session={session} onSessionChange={onSessionChange} />", submissionsTabIdx)
  assert.ok(submissionsTabIdx > 0 && tabToggleIdx > submissionsTabIdx, "toggle renders inside the submissions view")
})
