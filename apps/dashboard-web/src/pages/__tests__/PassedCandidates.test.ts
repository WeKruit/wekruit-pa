import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"

import {
  PASSED_CANDIDATE_INTRO_DECISION_CALLABLE_NAME,
  PASSED_CANDIDATES_CALLABLE_NAME,
  PASSED_CANDIDATES_DEFAULT_LIMIT,
  PASSED_CANDIDATES_MAX_LIMIT,
  PASSED_CANDIDATES_ROUTE,
  buildPassedCandidatesRequest,
  formatIntroDecision,
  redactSensitiveText,
  type PassedCandidatesSnapshot,
} from "../PassedCandidates.helpers.js"
import { PassedCandidatesSnapshotView } from "../PassedCandidates.js"

Object.assign(globalThis, { React })

function renderPassedCandidatesSnapshotView(props: Parameters<typeof PassedCandidatesSnapshotView>[0]): string {
  return renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(PassedCandidatesSnapshotView, props)))
}

test("PassedCandidates helpers target the S7 admin snapshot callable", () => {
  assert.equal(PASSED_CANDIDATES_ROUTE, "/admin/passed-candidates")
  assert.equal(PASSED_CANDIDATES_CALLABLE_NAME, "paAdminPassedCandidatesSnapshot")
  assert.equal(PASSED_CANDIDATE_INTRO_DECISION_CALLABLE_NAME, "paAdminPassedCandidateIntroDecision")
  assert.equal(PASSED_CANDIDATES_DEFAULT_LIMIT, 50)
  assert.equal(PASSED_CANDIDATES_MAX_LIMIT, 100)
  assert.deepEqual(buildPassedCandidatesRequest({ jobId: " job-1 ", limit: 500 }), {
    jobId: "job-1",
    limit: 100,
  })
  assert.equal(
    redactSensitiveText("candidate@example.com +15555550100 gs://bucket/resume.pdf https://linkedin.com/in/private @private_handle"),
    "[redacted email] [redacted phone] [redacted resume] [redacted linkedin] [redacted handle]",
  )
  assert.equal(formatIntroDecision("accepted"), "accepted intro")
  assert.equal(formatIntroDecision("rejected"), "rejected intro")
})

test("PassedCandidates page renders static empty state and remains read-only", () => {
  const snapshot: PassedCandidatesSnapshot = {
    generatedAt: "2026-05-13T20:00:00.000Z",
    filters: { jobId: "job-1", limit: 50 },
    summary: {
      totalPassedSnapshots: 0,
      withConsent: 0,
      missingConsent: 0,
      withTranscript: 0,
      droppedInvalidSnapshot: 0,
      droppedStateMismatch: 0,
    },
    rows: [],
  }

  const html = renderPassedCandidatesSnapshotView({ snapshot })

  assert.match(html, /Passed Candidates/)
  assert.match(html, /No passed snapshots/)
  assert.match(html, /job-1/)
  assert.doesNotMatch(html, /<button/)
  assert.doesNotMatch(html, /Search|Browse|Schedule|Outreach|Message|Notes/i)
})

test("PassedCandidates page renders per-snapshot employer feedback controls", () => {
  const snapshot: PassedCandidatesSnapshot = {
    generatedAt: "2026-05-13T20:00:00.000Z",
    filters: { jobId: "job-1", limit: 50 },
    summary: {
      totalPassedSnapshots: 1,
      withConsent: 1,
      missingConsent: 0,
      withTranscript: 0,
      droppedInvalidSnapshot: 0,
      droppedStateMismatch: 0,
    },
    rows: [{
      id: "job-1__cand-1",
      snapshotId: "job-1__cand-1",
      candidateId: "cand-1",
      jobId: "job-1",
      candidateJobStateId: "cand-1__job-1",
      state: "employer_visible",
      displayName: "Candidate One",
      createdAt: "2026-05-13T20:00:00.000Z",
      profile: { consentStatus: "granted" },
      transcript: { turns: [] },
    }],
  }

  const html = renderPassedCandidatesSnapshotView({
    snapshot,
    onIntroDecision: async () => undefined,
  })

  assert.match(html, /Employer feedback/)
  assert.match(html, /Accept intro/)
  assert.match(html, /Reject intro/)
  assert.match(html, /Employer reason/)
})

test("PassedCandidates page source does not add global controls", () => {
  const source = readFileSync(new URL("../PassedCandidates.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(source, /pa-users|candidate-job-states|candidate-job-matches|pa-outbound/i)
  assert.doesNotMatch(source, /Search|Browse|Schedule|Outreach|Notes|Send/i)
})
