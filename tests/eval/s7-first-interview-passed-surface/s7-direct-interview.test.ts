import assert from "node:assert/strict"
import test from "node:test"
import {
  PA_COLLECTIONS,
  createCandidateJobStateId,
} from "../../../packages/core-types/src/index.js"
import {
  markFirstInterviewStarted,
  markPrescreenTerminalOutcome,
} from "../../../apps/functions/src/prescreen-outcome-service.js"
import {
  collectionSize,
  defaultJobId,
  directCandidateId,
  makeFakeFirestore,
  now,
  seedMatch,
  seedPrescreenSession,
  snapshotId,
} from "./fixtures.js"

test("S7 direct candidate gets first interview even with low initial match score and PASS becomes visible", async () => {
  const { db, store } = makeFakeFirestore()
  seedMatch(store, { candidateId: directCandidateId, jobId: defaultJobId, finalScore: 0.01 })
  seedPrescreenSession(store, {
    sessionId: "ps-s7-direct-pass",
    candidateId: directCandidateId,
    terminal: "PASS",
    terminalReason: "Direct candidate passed. Email direct@example.com should redact.",
  })

  const started = await markFirstInterviewStarted({
    db,
    sessionId: "ps-s7-direct-pass",
    userId: directCandidateId,
    jobId: defaultJobId,
    occurredAt: now,
  })
  assert.equal(started.state, "prescreen_started")

  await markPrescreenTerminalOutcome({
    db,
    sessionId: "ps-s7-direct-pass",
    userId: directCandidateId,
    jobId: defaultJobId,
    terminal: "PASS",
    occurredAt: now,
  })

  const state = store.get(PA_COLLECTIONS.candidateJobStates)!.get(createCandidateJobStateId(directCandidateId, defaultJobId))!
  assert.equal(state.state, "employer_visible")
  assert.equal(state.prescreenSessionId, "ps-s7-direct-pass")
  assert.equal(state.employerVisibleProfileId, snapshotId(defaultJobId, directCandidateId))
  assert.equal(collectionSize(store, PA_COLLECTIONS.employerVisibleProfiles), 1)

  const snapshot = store.get(PA_COLLECTIONS.employerVisibleProfiles)!.get(snapshotId(defaultJobId, directCandidateId))!
  assert.equal(snapshot.sourcePrescreenSessionId, "ps-s7-direct-pass")
  assert.doesNotMatch(JSON.stringify(snapshot), /direct@example\.com/)
})
