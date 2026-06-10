// @ts-nocheck - source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "../RecruiterRole.tsx"), "utf8")

test("role submit form defaults to exactly 4 required fields", () => {
  const formStart = source.indexOf('id="submit-candidate"')
  assert.ok(formStart > 0, "submit form exists")
  const formEnd = source.indexOf("Fit checklist", formStart)
  assert.ok(formEnd > formStart, "checklist section follows the candidate fields")
  const formSlice = source.slice(formStart, formEnd)
  const totalRequired = (formSlice.match(/\n\s+required\b/g) ?? []).length
  const editStart = formSlice.indexOf("{submitterEditOpen && (")
  assert.ok(editStart > 0, "submitter contact fields are collapsed behind an edit affordance")
  const editEnd = formSlice.indexOf("</>", editStart)
  assert.ok(editEnd > editStart)
  const hiddenRequired = (formSlice.slice(editStart, editEnd).match(/\n\s+required\b/g) ?? []).length
  assert.equal(hiddenRequired, 2, "submitter name + email stay required but hidden by default")
  assert.equal(totalRequired - hiddenRequired, 4, "default path requires candidate name, email, link, consent only")
})

test("submitter contact is prefilled from the recruiter profile", () => {
  assert.match(source, /submitterName: state\.submitterName \|\| session\.recruiter\.name/)
  assert.match(source, /submitterEmail: state\.submitterEmail \|\| session\.recruiter\.email/)
  assert.match(source, /Submitting as \{form\.submitterName\.trim\(\) \|\| session\.recruiter\.name\}/)
  assert.match(source, /\{submitterEditOpen \? "Done editing" : "Edit"\}/)
})

test("optional candidate fields collapse under More details", () => {
  const toggle = source.indexOf('className="rb-more-toggle"')
  assert.ok(toggle > 0, "More details toggle exists")
  const detailsStart = source.indexOf("{detailsOpen && (", toggle)
  assert.ok(detailsStart > toggle)
  const detailsEnd = source.indexOf("</>", detailsStart)
  const detailsSlice = source.slice(detailsStart, detailsEnd)
  assert.match(detailsSlice, /candidateCurrentRole/)
  assert.match(detailsSlice, /candidateYoe/)
  assert.match(detailsSlice, /candidateNotes/)
  assert.doesNotMatch(detailsSlice, /\n\s+required\b/, "collapsed fields are optional")
  assert.match(source, /if \(!candidateNotes\) warnings\.push\(/, "missing fit note warns instead of blocking")
})

test("submit failure keeps the form draft; draft clears on success only", () => {
  assert.match(source, /if \(!result\.ok\) \{\s*\n\s*setSubmitError\(formatSubmissionFailure\(result\.reason\)\)\s*\n\s*return\s*\n\s*\}/)
  assert.match(source, /setSubmitError\(formatSubmissionFailure\(error instanceof Error \? error\.message : String\(error\)\)\)/)
  assert.match(source, /if \(jobId\) saveFormState\(jobId, form\)/)
  assert.match(source, /\{submitError && <div className="rb-error">Submission failed: \{submitError\}<\/div>\}/)
  const onSubmitStart = source.indexOf("const onSubmit = async")
  const onSubmitEnd = source.indexOf("const resetChecklist", onSubmitStart)
  const onSubmitSlice = source.slice(onSubmitStart, onSubmitEnd)
  const successIdx = onSubmitSlice.indexOf("setSubmission(result)")
  const clearIdx = onSubmitSlice.indexOf("clearSubmissionDraft()")
  assert.ok(successIdx > 0, "success state recorded in onSubmit")
  assert.ok(clearIdx > successIdx, "draft cleared only after the success state")
})

test("post-submit success links to My submissions tracker", () => {
  assert.match(source, /<Link className="rb-btn" to="\/recruiters\?tab=submissions">Track status in My submissions<\/Link>/)
})
