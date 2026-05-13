import assert from "node:assert/strict"
import test from "node:test"
import { PA_COLLECTIONS } from "../../../packages/core-types/src/index.js"
import { planJobOutreach } from "../../../apps/functions/src/outreach/service.js"
import {
  candidate,
  capacity,
  collectionDocs,
  collectionSize,
  defaultCandidateId,
  job,
  liveOutreachDeps,
  makeFakeFirestore,
  match,
  now,
} from "./fixtures.js"

test("dry-run planning may persist pa-outbound-invites but never pa-outbound or candidate contact", async () => {
  const { db, store } = makeFakeFirestore()
  const deps = liveOutreachDeps(db)
  let contactAttempts = 0

  const result = await planJobOutreach(
    {
      job: job(),
      matches: [match()],
      candidatesById: { [defaultCandidateId]: candidate() },
      capacityByCandidateId: { [defaultCandidateId]: capacity() },
      now,
      dryRun: true,
      approvalMode: "approved",
      persistDecisions: true,
    },
    {
      ...deps,
      enqueueOutbound: async (input) => {
        contactAttempts += 1
        return deps.enqueueOutbound!(input)
      },
    }
  )

  assert.equal(result.summary.total, 1)
  assert.equal(result.summary.queueEligible, 1)
  assert.equal(result.summary.dryRun, 1)
  assert.equal(result.summary.queued, 0)
  assert.equal(contactAttempts, 0)
  assert.equal(collectionSize(store, PA_COLLECTIONS.outboundInvites), 1)
  assert.equal(collectionSize(store, PA_COLLECTIONS.outbound), 0)
  assert.equal(collectionSize(store, PA_COLLECTIONS.users), 0)

  const [invite] = collectionDocs(store, PA_COLLECTIONS.outboundInvites)
  assert.equal(invite!.dryRun, true)
  assert.equal(invite!.status, "draft")
  assert.equal(invite!.policyDecision, "auto_outbound")
})

test("dry-run does not contact candidates even when every live gate except dryRun is satisfied", async () => {
  const { db, store } = makeFakeFirestore()

  const result = await planJobOutreach(
    {
      job: job(),
      matches: [match({ finalScore: 0.95 })],
      candidatesById: { [defaultCandidateId]: candidate({ phoneE164: "+15555550123" }) },
      capacityByCandidateId: { [defaultCandidateId]: capacity() },
      now,
      dryRun: true,
      approvalMode: "approved",
      persistDecisions: true,
    },
    {
      ...liveOutreachDeps(db),
      enqueueOutbound: async () => {
        throw new Error("dry-run must not enqueue pa-outbound")
      },
    }
  )

  assert.equal(result.rows[0]!.decision.allowQueue, false)
  assert.equal(result.rows[0]!.invite.dryRun, true)
  assert.equal(collectionSize(store, PA_COLLECTIONS.outboundInvites), 1)
  assert.equal(collectionSize(store, PA_COLLECTIONS.outbound), 0)
})
