import assert from "node:assert/strict"
import test from "node:test"
import {
  PA_COLLECTIONS,
  createOutreachDuplicateSuppressionKey,
} from "../../../packages/core-types/src/index.js"
import { planJobOutreach } from "../../../apps/functions/src/outreach/service.js"
import {
  markOutboundInviteDelivery,
  markOutboundInviteQueued,
  writeOutboundInviteDecision,
} from "../../../packages/pa-persistence/src/marketplace.js"
import {
  candidate,
  capacity,
  collectionDocs,
  collectionSize,
  defaultCandidateId,
  fullCapacity,
  job,
  liveOutreachDeps,
  makeFakeFirestore,
  match,
  now,
  outboundInvite,
} from "./fixtures.js"

test("approved live plan queues exactly the eligible outbound rows and persists blocked decisions", async () => {
  const { db, store } = makeFakeFirestore()

  const result = await planJobOutreach(
    {
      job: job(),
      matches: [
        match({ candidateId: "cand-eligible" }),
        match({ candidateId: "cand-capacity-full" }),
        match({ candidateId: "cand-cooldown" }),
        match({ candidateId: "cand-duplicate" }),
      ],
      candidatesById: {
        "cand-eligible": candidate({ candidateId: "cand-eligible", phoneE164: "+15555550101" }),
        "cand-capacity-full": candidate({ candidateId: "cand-capacity-full", phoneE164: "+15555550102" }),
        "cand-cooldown": candidate({
          candidateId: "cand-cooldown",
          phoneE164: "+15555550103",
          outreach: { status: "cooldown", cooldownUntil: "2026-05-20T12:00:00.000Z" },
        }),
        "cand-duplicate": candidate({ candidateId: "cand-duplicate", phoneE164: "+15555550104" }),
      },
      capacityByCandidateId: {
        "cand-eligible": capacity(),
        "cand-capacity-full": fullCapacity(),
        "cand-cooldown": capacity(),
        "cand-duplicate": capacity(),
      },
      existingInvitesByCandidateId: {
        "cand-duplicate": [
          outboundInvite({
            candidateId: "cand-duplicate",
            jobId: "job-old",
            status: "sent",
            dryRun: false,
            duplicateSuppressionKey: createOutreachDuplicateSuppressionKey(
              "cand-duplicate",
              "Invoko",
              "product-designer",
            ),
            createdAt: "2026-05-10T12:00:00.000Z",
          }),
        ],
      },
      now,
      dryRun: false,
      approvalMode: "approved",
      persistDecisions: true,
    },
    liveOutreachDeps(db)
  )

  assert.equal(result.summary.total, 4)
  assert.equal(result.summary.queueEligible, 1)
  assert.equal(result.summary.queued, 1)
  assert.equal(result.summary.blocked, 3)
  assert.equal(collectionSize(store, PA_COLLECTIONS.outboundInvites), 4)
  assert.equal(collectionSize(store, PA_COLLECTIONS.outbound), 1)
  assert.equal(collectionSize(store, PA_COLLECTIONS.users), 1)

  const [queued] = result.rows.filter((row) => row.queuedOutboundId)
  assert.equal(queued!.candidateId, "cand-eligible")
  const [outbound] = collectionDocs(store, PA_COLLECTIONS.outbound)
  assert.equal(outbound!.userId, "cand-eligible")
  assert.equal(outbound!.idempotencyKey, queued!.decision.outboundIdempotencyKey)
  const [user] = collectionDocs(store, PA_COLLECTIONS.users)
  assert.equal(user!.outreach && typeof user!.outreach === "object" ? (user!.outreach as { lastOutboundAt?: string }).lastOutboundAt : undefined, now)
})

test("outbound_queued and outbound_sent require explicit queue/provider evidence", async () => {
  const { db, store } = makeFakeFirestore()
  const invite = outboundInvite({ dryRun: false, approvalState: "approved", status: "approved" })
  await writeOutboundInviteDecision(db, invite)

  await assert.rejects(
    () =>
      markOutboundInviteQueued(db, {
        inviteId: invite.inviteId,
        outboundId: "missing-outbound",
        queuedAt: now,
        actor: "system",
      }),
    /outbound_queue_row_missing/
  )
  assert.equal(collectionSize(store, PA_COLLECTIONS.candidateJobStates), 0)

  store.get(PA_COLLECTIONS.outbound)!.set("outbound-1", {
    id: "outbound-1",
    userId: defaultCandidateId,
    toE164: "+15555550123",
    body: "S6 eval queued row",
    status: "pending",
    createdAt: now,
    idempotencyKey: "s6-outbound-evidence",
  })

  const queued = await markOutboundInviteQueued(db, {
    inviteId: invite.inviteId,
    outboundId: "outbound-1",
    queuedAt: now,
    actor: "system",
  })
  assert.equal(queued.state, "outbound_queued")
  assert.equal(queued.invite.outboundId, "outbound-1")

  await assert.rejects(
    () =>
      markOutboundInviteDelivery(db, {
        inviteId: invite.inviteId,
        outboundId: "wrong-outbound",
        providerStatus: "SENT",
        deliveredAt: now,
        actor: "system",
      }),
    /outbound_id_mismatch/
  )

  await assert.rejects(
    () =>
      markOutboundInviteDelivery(db, {
        inviteId: invite.inviteId,
        outboundId: "outbound-1",
        providerStatus: "",
        deliveredAt: now,
        actor: "system",
      }),
    /String must contain|too_small|Invalid/
  )

  const sent = await markOutboundInviteDelivery(db, {
    inviteId: invite.inviteId,
    outboundId: "outbound-1",
    providerStatus: "SENT",
    deliveredAt: now,
    actor: "system",
  })
  assert.equal(sent.state, "outbound_sent")
  assert.equal(sent.invite.status, "sent")
  assert.equal(sent.invite.providerStatus, "SENT")
})
