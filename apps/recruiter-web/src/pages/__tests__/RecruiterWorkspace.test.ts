/**
 * Source-contract tests for the Recruiter Workspace (design implementation).
 *
 * The workspace must be wired to the REAL recruiter-board API — no demo data —
 * and must keep the design's three views plus the live deep links.
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const workspaceSrc = readFileSync(join(here, "..", "RecruiterWorkspace.tsx"), "utf8")
const mainSrc = readFileSync(join(here, "..", "..", "main.tsx"), "utf8")
const boardSrc = readFileSync(join(here, "..", "RecruiterBoard.tsx"), "utf8")

test("workspace owns /recruiters and the legacy classic board is not reachable", () => {
  assert.match(mainSrc, /path="\/recruiters" element={<RecruiterWorkspace \/>}/)
  assert.match(mainSrc, /path="\/recruiters\/classic" element={<Navigate to="\/recruiters" replace \/>}/)
  assert.doesNotMatch(mainSrc, /import RecruiterBoard/)
  assert.match(mainSrc, /path="\/recruiters\/job\/:jobId" element={<RoleSheetPage \/>}/)
  assert.match(mainSrc, /path="\/recruiters\/submission\/:submissionId"/)
})

test("workspace is wired to the real API — every data surface has a live source", () => {
  // submissions list + detail
  assert.match(workspaceSrc, /fetchRecruiterSubmissions\(\)/)
  // roles
  assert.match(workspaceSrc, /fetchCollabJobs\(\)/)
  // sourced count for the quarter goal
  assert.match(workspaceSrc, /fetchRecruiterSourcedCandidates\(\)/)
  // Ask WeKruit thread
  assert.match(workspaceSrc, /fetchRecruiterSubmissionComments\(/)
  assert.match(workspaceSrc, /addRecruiterSubmissionComment\(/)
  // consent resend (Needs-you action)
  assert.match(workspaceSrc, /resendRecruiterCandidateConfirmation\(/)
  // email updates toggle
  assert.match(workspaceSrc, /updateRecruiterPreferences\(\{ notificationPreferences: \{ submissionUpdatesEmail/)
})

test("no demo data — design fixture names must not survive into the implementation", () => {
  for (const fixture of ["Maya Chen", "Devin Park", "Jordan Avery", "atlas-fae", "northwind-ml"]) {
    assert.ok(!workspaceSrc.includes(fixture), `demo fixture leaked: ${fixture}`)
  }
})

test("status model covers every real backend pipeline status", () => {
  for (const status of ["new", "submitted", "reviewing", "wekruit_interview", "client_review", "advanced", "hired", "rejected", "duplicate"]) {
    assert.match(workspaceSrc, new RegExp(`\\b${status}\\b`), `missing status: ${status}`)
  }
})

test("the gate is reused from RecruiterBoard, not reimplemented", () => {
  assert.match(workspaceSrc, /RecruiterAccessGate/)
  assert.match(workspaceSrc, /readRecruiterInviteLinkFromLocation/)
  assert.match(workspaceSrc, /writePendingRecruiterAccess/)
  // signed-out renders the shared gate component
  assert.match(workspaceSrc, /<RecruiterAccessGate inviteLink={inviteLink} onSessionClaimed={setSession} \/>/)
})

test("design feedback loop is present: rating /4, reasons, note, stepper, payout, timeline", () => {
  assert.match(workspaceSrc, /recruiterFeedbackRating/)
  assert.match(workspaceSrc, /recruiterFeedbackReasons/)
  assert.match(workspaceSrc, /recruiterFeedbackNote/)
  assert.match(workspaceSrc, /buildSteps/)
  assert.match(workspaceSrc, /payoutModel/)
  assert.match(workspaceSrc, /statusHistory/)
  // rating scale is the real 1–4
  assert.match(workspaceSrc, /\/4/)
})

test("submit flow stays on the role sheet — workspace links, never reimplements", () => {
  assert.match(workspaceSrc, /\/recruiters\/job\/\$\{selectedRole\.jobId\}/)
  assert.ok(!workspaceSrc.includes("submitRecruiterCandidate"), "workspace must not own the submit mutation")
})

test("email deep links keep working: ?tab=submissions opens the submissions view", () => {
  assert.match(workspaceSrc, /tabParam === "submissions" \? "submissions"/)
})

test("workspace presents active roles as open, not approved-access gated", () => {
  assert.doesNotMatch(workspaceSrc, /Approved access/)
  assert.doesNotMatch(workspaceSrc, /Single-submit/)
  assert.doesNotMatch(workspaceSrc, /approvedJobIds/)
  assert.doesNotMatch(workspaceSrc, /fetchRecruiterRoleApplications\(\)/)
  assert.doesNotMatch(boardSrc, /Approved recruiters see/)
})
