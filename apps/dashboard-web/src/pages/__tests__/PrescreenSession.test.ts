import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "../PrescreenSession.tsx"), "utf8")
const listSource = readFileSync(resolve(here, "../PrescreenSessionsList.tsx"), "utf8")

test("PrescreenSession exposes human review with required candidate message approval", () => {
  assert.match(source, /reviewEvaluationAttempt/)
  assert.match(source, /candidateMessageBody/)
  assert.match(source, /terminalActionPendingReview/)
  assert.match(source, /pa-evaluation-attempts/)
  assert.match(source, /textarea/i)
  assert.match(source, /pendingAckOutboundId/)
  assert.match(source, /decisionOutboundId/)
})

test("PrescreenSessionsList shows pending review state", () => {
  assert.match(listSource, /terminalActionPendingReview/)
  assert.match(listSource, /Pending HITL/)
  assert.match(listSource, /pendingRows/)
  assert.match(listSource, /AI proposed/)
  assert.match(listSource, /Strict recommendation/)
  assert.match(listSource, /PrescreenReviewToolbar/)
  assert.match(listSource, /StrictReviewBadge/)
  assert.match(listSource, /Quick review/)
  assert.match(listSource, /Bulk reject with LLM drafts/)
  assert.match(listSource, /draftPrescreenReviewMessages/)
  assert.match(listSource, /Approve rejects and queue/)
})
