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
  makeFakeFirestore,
  now,
  outboundCandidateId,
  seedMatch,
  seedOutboundState,
  seedPrescreenSession,
} from "./fixtures.js"

test("S7 outbound candidate enters the same first interview and PASS does not enqueue outbound", async () => {
  const { db, store } = makeFakeFirestore()
  seedMatch(store, { candidateId: outboundCandidateId, jobId: defaultJobId, finalScore: 0.72 })
  seedOutboundState(store, outboundCandidateId, defaultJobId)
  seedPrescreenSession(store, {
    sessionId: "ps-s7-outbound-pass",
    candidateId: outboundCandidateId,
    terminal: "PASS",
    terminalReason: "Outbound candidate passed first interview.",
  })
  const outboundBefore = collectionSize(store, PA_COLLECTIONS.outbound)
  const inviteBefore = collectionSize(store, PA_COLLECTIONS.outboundInvites)

  await markFirstInterviewStarted({
    db,
    sessionId: "ps-s7-outbound-pass",
    userId: outboundCandidateId,
    jobId: defaultJobId,
    occurredAt: now,
  })
  await markPrescreenTerminalOutcome({
    db,
    sessionId: "ps-s7-outbound-pass",
    userId: outboundCandidateId,
    jobId: defaultJobId,
    terminal: "PASS",
    occurredAt: now,
  })

  const state = store.get(PA_COLLECTIONS.candidateJobStates)!.get(createCandidateJobStateId(outboundCandidateId, defaultJobId))!
  assert.equal(state.state, "employer_visible")
  assert.equal(collectionSize(store, PA_COLLECTIONS.employerVisibleProfiles), 1)
  assert.equal(collectionSize(store, PA_COLLECTIONS.outbound), outboundBefore)
  assert.equal(collectionSize(store, PA_COLLECTIONS.outboundInvites), inviteBefore)
})
