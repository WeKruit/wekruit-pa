import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import {
  FLYWHEEL_EVAL_CALLABLE_NAME,
  FLYWHEEL_EVAL_ROUTE,
  buildFlywheelEvalSnapshotRequest,
  normalizeFlywheelEvalSnapshot,
  type FlywheelEvalSnapshot,
} from "../../lib/flywheel-eval-api.js"
import {
  FlywheelEvalSnapshotView,
  redactSensitiveText,
  summarizeRedactedPayload,
} from "../FlywheelEval.js"

test("FlywheelEval API helpers target the S8 admin snapshot callable", () => {
  assert.equal(FLYWHEEL_EVAL_CALLABLE_NAME, "paAdminFlywheelEvalSnapshot")
  assert.equal(FLYWHEEL_EVAL_ROUTE, "/admin/flywheel-eval")
  assert.deepEqual(buildFlywheelEvalSnapshotRequest(500), { limit: 100 })
  assert.deepEqual(buildFlywheelEvalSnapshotRequest(0), { limit: 20 })
})

test("FlywheelEval route and nav are wired under admin eval", () => {
  const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8")

  assert.match(appSource, /import FlywheelEval from "\.\/pages\/FlywheelEval\.js"/)
  assert.match(appSource, /<NavLink to="\/admin\/flywheel-eval">Flywheel Eval<\/NavLink>/)
  assert.match(appSource, /<Route path="\/admin\/flywheel-eval" element={<FlywheelEval \/>} \/>/)
  assert.doesNotMatch(appSource, /<Route path="\/j\/:jobId"/)
})

test("FlywheelEval page renders counts and redacted recent rows", () => {
  const snapshot: FlywheelEvalSnapshot = {
    generatedAt: "2026-05-13T23:00:00.000Z",
    filters: { limit: 20 },
    counts: {
      artifactsByKind: { candidate_profile_correction: 1, marketplace_simulation: 2 },
      artifactsByStatus: { ready: 1, needs_review: 1 },
      feedbackByKind: { prescreen_outcome: 3 },
      correctionsByTarget: { user_tags: 1, job_enrichment_draft: 1 },
      correctionsByActor: { candidate: 1, operator: 1 },
    },
    recentArtifacts: [
      {
        id: "artifact-1",
        artifactId: "artifact-1",
        kind: "candidate_profile_correction",
        status: "ready",
        sourceCorrectionEventIds: ["corr-1"],
        sourceFeedbackEventIds: [],
        candidateId: "cand-1",
        jobId: "job-1",
        payloadRedacted: {
          summary: "Candidate corrected role preferences.",
          prompt: "raw prompt with candidate@example.com",
          nested: { transcriptText: "full transcript +15555550100" },
        },
        evidence: [
          {
            source: "conversation",
            summary: "Candidate provided profile correction from resume.pdf",
            confidence: 0.92,
          },
        ],
        latestRunResult: {
          status: "pass",
          summary: "Regression fixture passed for https://storage.example/raw-transcript.txt",
        },
        createdAt: "2026-05-13T22:59:00.000Z",
      },
    ],
    recentCorrections: [
      {
        id: "corr-1",
        eventId: "corr-1",
        targetType: "user_tags",
        targetId: "cand-1",
        actor: "candidate",
        candidateId: "cand-1",
        reason: "Candidate says contact candidate@example.com is wrong and resume.pdf is stale.",
        beforeRedacted: { role: "pm", email: "candidate@example.com" },
        afterRedacted: { role: "product designer", phone: "+15555550100" },
        evidence: [{ source: "conversation", summary: "Open-ended correction" }],
        createdAt: "2026-05-13T22:58:00.000Z",
      },
    ],
    recentFeedback: [
      {
        id: "feedback-1",
        eventId: "feedback-1",
        kind: "prescreen_outcome",
        actor: "system",
        outcome: "passed",
        candidateId: "cand-1",
        jobId: "job-1",
        candidateJobStateId: "state-1",
        payloadRedacted: { score: 0.81, rawTranscript: "do not show" },
        evidence: [{ source: "prescreen", summary: "Claire completed first interview." }],
        createdAt: "2026-05-13T22:57:00.000Z",
      },
    ],
  }

  const html = renderToStaticMarkup(createElement(FlywheelEvalSnapshotView, { snapshot }))

  assert.match(html, /Flywheel Overview/)
  assert.match(html, /Artifacts by Kind/)
  assert.match(html, /candidate_profile_correction/)
  assert.match(html, /Corrections by Actor/)
  assert.match(html, /Recent Eval Artifacts/)
  assert.match(html, /Recent Corrections/)
  assert.match(html, /Recent Feedback/)
  assert.match(html, /\[redacted field\]/)
  assert.match(html, /\[redacted email\]/)
  assert.doesNotMatch(html, /candidate@example\.com/)
  assert.doesNotMatch(html, /\+15555550100/)
  assert.doesNotMatch(html, /resume\.pdf/)
  assert.doesNotMatch(html, /raw prompt/)
  assert.doesNotMatch(html, /full transcript/)
  assert.doesNotMatch(html, /storage\.example/)
})

test("FlywheelEval empty snapshot renders empty states", () => {
  const snapshot = normalizeFlywheelEvalSnapshot(null, { limit: 20 })
  const html = renderToStaticMarkup(createElement(FlywheelEvalSnapshotView, { snapshot }))

  assert.match(html, /No eval artifacts/)
  assert.match(html, /No correction events/)
  assert.match(html, /No feedback events/)
  assert.match(html, /No rows/)
})

test("FlywheelEval redaction helpers suppress raw transcript prompt contact and file fields", () => {
  assert.equal(
    redactSensitiveText("email candidate@example.com phone +15555550100 resume.pdf transcript prompt"),
    "email [redacted email] phone [redacted phone] [redacted file] [redacted field] [redacted field]",
  )
  assert.equal(
    summarizeRedactedPayload({
      email: "candidate@example.com",
      rawTranscript: "the full transcript",
      safeSignal: "operator summary",
    }),
    "email=[redacted field]; [redacted field]=[redacted field]; safeSignal=operator summary",
  )
})
