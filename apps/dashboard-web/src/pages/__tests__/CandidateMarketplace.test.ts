import assert from "node:assert/strict"
import test from "node:test"
import {
  compactValue,
  emptyMarketplaceRows,
  formatPercent,
  formatScore,
  marketplaceExternalHref,
  summarizeMarketplaceLearningLoop,
  marketplaceResumeArtifactFor,
  marketplaceResumeOriginalSource,
  sortRowsByTime,
  summarizeMarketplace,
  type MarketplaceRow,
} from "../CandidateMarketplace.helpers.js"

test("sortRowsByTime orders newest valid timestamp first without mutating input", () => {
  const rows: MarketplaceRow[] = [
    { id: "old", updatedAt: "2026-05-12T00:00:00.000Z" },
    { id: "missing" },
    { id: "new", updatedAt: "2026-05-13T00:00:00.000Z" },
  ]

  const sorted = sortRowsByTime(rows, ["updatedAt", "createdAt"])

  assert.deepEqual(sorted.map((row) => row.id), ["new", "old", "missing"])
  assert.deepEqual(rows.map((row) => row.id), ["old", "missing", "new"])
})

test("sortRowsByTime handles Firestore timestamp-like values", () => {
  const rows: MarketplaceRow[] = [
    { id: "old", createdAt: { toMillis: () => 1000 } },
    { id: "new", createdAt: { seconds: 2 } },
  ]

  const sorted = sortRowsByTime(rows, ["createdAt"])

  assert.deepEqual(sorted.map((row) => row.id), ["new", "old"])
})

test("format helpers handle dashboard-null values and numeric values", () => {
  assert.equal(formatScore(0.87321), "0.87")
  assert.equal(formatScore(undefined), "-")
  assert.equal(formatPercent(0.64), "64%")
  assert.equal(formatPercent(Number.NaN), "-")
  assert.equal(compactValue(null), "-")
  assert.equal(compactValue("abcdef", 3), "abc...")
  assert.equal(compactValue({ a: 1 }), "{\"a\":1}")
})

test("summarizeMarketplace keeps passed and not-passed job state counts separate", () => {
  const rows = emptyMarketplaceRows()
  rows.jobStates = [
    { id: "a", state: "passed" },
    { id: "b", state: "employer_visible" },
    { id: "c", state: "not_passed" },
    { id: "d", state: "prescreen_started" },
  ]
  rows.employerSnapshots = [{ id: "snap-1" }]
  rows.resumes = [{ id: "resume-1" }]
  rows.handles = [{ id: "handle-1" }, { id: "handle-2" }]
  rows.authMappings = [{ id: "firebase-uid", candidateId: "candidate-1" }]
  rows.identityEvents = [{ id: "event-1", type: "candidate_claimed" }]
  rows.sourceLinks = [{ id: "source-1", candidateId: "candidate-1" }]
  rows.identityConflicts = [
    { id: "conflict-open", status: "open" },
    { id: "conflict-resolved", status: "resolved" },
    { id: "conflict-closed", resolvedAt: "2026-05-13T00:00:00.000Z" },
  ]

  assert.deepEqual(summarizeMarketplace(rows), {
    totalJobStates: 4,
    passedJobs: 2,
    activeJobs: 1,
    notPassedJobs: 1,
    employerVisibleProfiles: 1,
    resumeArtifacts: 1,
    handles: 2,
    authMappings: 1,
    identityEvents: 1,
    openIdentityConflicts: 1,
    sourceLinks: 1,
  })
})

test("summarizeMarketplaceLearningLoop surfaces missing employer feedback after match artifacts", () => {
  const rows = emptyMarketplaceRows()
  rows.matches = [
    { id: "match-1", jobId: "job-1", finalScore: 0.88, recommendedAction: "recommend" },
    { id: "match-2", jobId: "job-2", finalScore: 0.71, recommendedAction: "watch" },
  ]

  const summary = summarizeMarketplaceLearningLoop(rows)

  assert.equal(summary.status, "awaiting_feedback")
  assert.equal(summary.label, "Awaiting employer feedback")
  assert.equal(summary.metrics.find((metric) => metric.label === "Match artifacts")?.value, "2")
  assert.equal(summary.metrics.find((metric) => metric.label === "Employer feedback")?.value, "0")
  assert.match(summary.nextAction, /Record accepted\/rejected intro/i)
})

test("summarizeMarketplaceLearningLoop flags rejected employer feedback without correction events", () => {
  const rows = emptyMarketplaceRows()
  rows.matches = [{ id: "match-1", jobId: "job-1", finalScore: 0.88 }]
  rows.feedback = [
    {
      id: "feedback-1",
      kind: "employer_action",
      actor: "operator",
      outcome: "intro_rejected",
      payloadRedacted: { decision: "rejected", reason: "Needs deeper infrastructure ownership" },
    },
  ]

  const summary = summarizeMarketplaceLearningLoop(rows)

  assert.equal(summary.status, "needs_correction")
  assert.equal(summary.label, "Feedback needs correction signal")
  assert.equal(summary.metrics.find((metric) => metric.label === "Employer feedback")?.value, "1")
  assert.equal(summary.metrics.find((metric) => metric.label === "Corrections")?.value, "0")
  assert.match(summary.nextAction, /Convert rejection reason into a correction event/i)
})

test("summarizeMarketplaceLearningLoop treats accepted intro feedback as learning without requiring a correction", () => {
  const rows = emptyMarketplaceRows()
  rows.matches = [{ id: "match-1", jobId: "job-1", finalScore: 0.92 }]
  rows.feedback = [
    {
      id: "feedback-1",
      kind: "employer_action",
      outcome: "intro_accepted",
      payloadRedacted: { decision: "accepted", reason: "Strong systems ownership" },
    },
  ]

  const summary = summarizeMarketplaceLearningLoop(rows)

  assert.equal(summary.status, "learning")
  assert.equal(summary.label, "Learning loop active")
  assert.doesNotMatch(summary.body, /correction signal/i)
  assert.doesNotMatch(summary.nextAction, /correction evidence/i)
})

test("marketplaceExternalHref opens web and Cloud Storage refs but ignores inline refs", () => {
  assert.equal(marketplaceExternalHref("https://linkedin.com/in/test"), "https://linkedin.com/in/test")
  assert.equal(marketplaceExternalHref("linkedin.com/in/test"), "https://linkedin.com/in/test")
  assert.equal(
    marketplaceExternalHref("gs://wekruit-resumes/bulk uploads/Adam Resume.pdf"),
    "https://storage.cloud.google.com/wekruit-resumes/bulk%20uploads/Adam%20Resume.pdf"
  )
  assert.equal(marketplaceExternalHref("inline://candidate_upload/resume.pdf"), undefined)
})

test("marketplaceResumeOriginalSource prefers stored artifact source refs", () => {
  const rows: MarketplaceRow[] = [
    { id: "older", resumeId: "older", storageUri: "gs://bucket/old.pdf" },
    { id: "artifact-1", resumeId: "artifact-1", storageUri: "gs://bucket/latest resume.pdf" },
  ]
  const artifact = marketplaceResumeArtifactFor(rows, "artifact-1")
  const source = marketplaceResumeOriginalSource(artifact, { id: "parsed", mediaUrl: "inline://resume.pdf" })

  assert.equal(artifact?.id, "artifact-1")
  assert.equal(source.raw, "gs://bucket/latest resume.pdf")
  assert.equal(source.href, "https://storage.cloud.google.com/bucket/latest%20resume.pdf")
})
