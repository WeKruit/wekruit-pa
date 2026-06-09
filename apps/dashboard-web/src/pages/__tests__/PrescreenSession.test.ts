import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "../PrescreenSession.tsx"), "utf8")
const listSource = readFileSync(resolve(here, "../PrescreenSessionsList.tsx"), "utf8")
const controlsSource = readFileSync(resolve(here, "../../components/prescreen/PrescreenReviewControls.tsx"), "utf8")
const drawersSource = readFileSync(resolve(here, "../../components/prescreen/PrescreenReviewDrawers.tsx"), "utf8")

test("PrescreenSession exposes human review with required candidate message approval", () => {
  assert.match(source, /reviewEvaluationAttempt/)
  assert.match(source, /candidateMessageBody/)
  assert.match(source, /decisionReason/)
  assert.match(source, /recommendedActions/)
  assert.match(source, /candidateDecision/)
  assert.match(source, /terminalActionPendingReview/)
  assert.match(source, /pa-evaluation-attempts/)
  assert.match(source, /textarea/i)
  assert.match(source, /pendingAckOutboundId/)
  assert.match(source, /decisionOutboundId/)
})

test("PrescreenSessionsList shows pending review state", () => {
  const adminReviewSource = `${listSource}\n${controlsSource}\n${drawersSource}`
  assert.match(adminReviewSource, /terminalActionPendingReview/)
  assert.match(adminReviewSource, /Pending HITL/)
  assert.match(adminReviewSource, /queueFilter/)
  assert.match(adminReviewSource, /terminalFilter/)
  assert.match(adminReviewSource, /actionFilter/)
  assert.match(adminReviewSource, /draftFilter/)
  assert.match(adminReviewSource, /bulkAction/)
  assert.match(adminReviewSource, /Claire terminal/)
  assert.match(adminReviewSource, /PAUSE means low confidence/)
  assert.match(adminReviewSource, /Review recommendation/)
  assert.match(adminReviewSource, /Committed final/)
  assert.match(adminReviewSource, /PrescreenReviewToolbar/)
  assert.match(adminReviewSource, /StrictReviewBadge/)
  assert.match(adminReviewSource, /Quick review/)
  assert.match(adminReviewSource, /listPrescreenSessionsPage/)
  assert.match(adminReviewSource, /getPrescreenOpsSnapshot/)
  assert.match(adminReviewSource, /Select visible/)
  assert.match(adminReviewSource, /Advanced filters/)
  assert.match(adminReviewSource, /Load more/)
  assert.match(adminReviewSource, /Bulk action/)
  assert.match(adminReviewSource, /Reject selected/)
  assert.match(adminReviewSource, /draftPrescreenReviewMessages/)
  assert.match(adminReviewSource, /Approve rejects and queue/)
  assert.match(adminReviewSource, /decisionReason/)
  assert.match(adminReviewSource, /recommendedActions/)
  assert.doesNotMatch(adminReviewSource, /Bulk pass/)
})
