import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  PA_JOB_ENRICHMENT_EVAL_FIXTURES_SUBCOLLECTION,
  PA_JOB_ENRICHMENT_SUBCOLLECTION,
  createCandidateJobMatchId,
  createCandidateJobStateId,
  createEmployerVisibleProfileId,
  createJobEnrichmentEvalFixtureId,
  createOutboundInviteId,
  type CandidateJobEvent,
  type CandidateJobMatch,
  type CandidateLifecycleEvent,
  type CorrectionEvent,
  type EmployerVisibleProfile,
  type FeedbackEvent,
  type JobEnrichmentEvalFixture,
  type JobOpportunityDraft,
  type OutboundInvite,
} from "@pa/core-types"
import {
  applyCandidateJobEvent,
  applyCandidateLifecycleEvent,
  approveJobOpportunityDraft,
  markOutboundInviteDelivery,
  markOutboundInviteQueued,
  rejectJobOpportunityDraft,
  writeCorrectionEvent,
  writeCandidateJobMatch,
  writeEmployerVisibleProfile,
  writeFeedbackEvent,
  writeJobEnrichmentEvalFixture,
  writeJobOpportunityDraft,
  writeOutboundInviteDecision,
} from "./marketplace.js"

type Store = Map<string, Map<string, Record<string, unknown>>>

const now = "2026-05-13T12:00:00.000Z"

function makeStore(): Store {
  return new Map([
    ...Object.values(PA_COLLECTIONS).map((name) => [name, new Map()] as const),
    [PA_COLLECTIONS.jobs, new Map()] as const,
  ])
}

function makeFakeFirestore(store: Store = makeStore()): { db: Firestore; store: Store } {
  function col(name: string): Map<string, Record<string, unknown>> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }

  function docRef(collectionName: string, id: string) {
    return {
      id,
      _collectionName: collectionName,
      _id: id,
      collection(subcollectionName: string) {
        return collection(`${collectionName}/${id}/${subcollectionName}`)
      },
      async get() {
        const data = col(collectionName).get(id)
        return { exists: data !== undefined, id, data: () => data }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const current = col(collectionName).get(id)
        col(collectionName).set(id, opts?.merge && current ? { ...current, ...data } : { ...data })
      },
    }
  }

  function collection(collectionName: string) {
    return {
      doc(id: string) {
        return docRef(collectionName, id)
      },
    }
  }

  const db = {
    collection,
    async runTransaction<T>(fn: (tx: {
      get: (ref: ReturnType<typeof docRef>) => Promise<{ exists: boolean; id: string; data: () => Record<string, unknown> | undefined }>
      set: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>, opts?: { merge?: boolean }) => void
    }) => Promise<T>): Promise<T> {
      const writes: Array<{
        ref: ReturnType<typeof docRef>
        data: Record<string, unknown>
        opts?: { merge?: boolean }
      }> = []
      const tx = {
        async get(ref: ReturnType<typeof docRef>) {
          const data = col(ref._collectionName).get(ref._id)
          return { exists: data !== undefined, id: ref._id, data: () => data }
        },
        set(ref: ReturnType<typeof docRef>, data: Record<string, unknown>, opts?: { merge?: boolean }) {
          writes.push({ ref, data, opts })
        },
      }
      const result = await fn(tx)
      for (const w of writes) {
        const current = col(w.ref._collectionName).get(w.ref._id)
        col(w.ref._collectionName).set(
          w.ref._id,
          w.opts?.merge && current ? { ...current, ...w.data } : { ...w.data }
        )
      }
      return result
    },
  }

  return { db: db as unknown as Firestore, store }
}

function lifecycle(type: CandidateLifecycleEvent["type"], over: Partial<CandidateLifecycleEvent> = {}): CandidateLifecycleEvent {
  return {
    eventId: `lc-${type}`,
    candidateId: "cand-1",
    actor: "system",
    occurredAt: now,
    evidence: [{ source: "system", summary: "test" }],
    type,
    ...(over as Record<string, unknown>),
  } as CandidateLifecycleEvent
}

function job(type: CandidateJobEvent["type"], over: Partial<CandidateJobEvent> = {}): CandidateJobEvent {
  return {
    eventId: `job-${type}`,
    candidateId: "cand-1",
    jobId: "job-1",
    actor: "system",
    occurredAt: now,
    evidence: [{ source: "system", summary: "test" }],
    type,
    ...(over as Record<string, unknown>),
  } as CandidateJobEvent
}

function candidateJobMatch(over: Partial<CandidateJobMatch> = {}): CandidateJobMatch {
  return {
    matchId: createCandidateJobMatchId("cand-1", "job-1"),
    candidateId: "cand-1",
    jobId: "job-1",
    direction: "job_to_candidate",
    matchVersion: "s5-test",
    jobEnrichmentVersion: "job-enrich-v1",
    computedAt: now,
    scoreBreakdown: {
      skills: { score: 0.82, weight: 0.5, summary: "TypeScript and React match" },
      location: { score: 1, weight: 0.2 },
    },
    matchedSignals: ["typescript", "remote_anywhere"],
    blockedSignals: [],
    candidateLifecycleStateAtMatch: "retained",
    candidateTagsUpdatedAt: now,
    hardFilterResult: "pass",
    finalScore: 0.84,
    reasons: ["strong_skill_match"],
    risks: [],
    missingInfo: [],
    recommendedAction: "hitl_review",
    evidence: [{ source: "job_match", summary: "S5 test match" }],
    createdAt: now,
    ...over,
  }
}

function outboundInvite(over: Partial<OutboundInvite> = {}): OutboundInvite {
  const matchId = createCandidateJobMatchId("cand-1", "job-1")
  return {
    inviteId: createOutboundInviteId({ candidateId: "cand-1", jobId: "job-1", matchId }),
    candidateId: "cand-1",
    jobId: "job-1",
    candidateJobStateId: createCandidateJobStateId("cand-1", "job-1"),
    matchId,
    status: "draft",
    policyDecision: "auto_outbound",
    approvalState: "not_required",
    dryRun: true,
    policyVersion: "s6-outreach-policy-v1",
    decisionReason: "eligible dry-run invite",
    blockedSignals: [],
    missingInfo: [],
    stickyAccountGroupId: "group-1",
    capacitySnapshot: {
      groupId: "group-1",
      fromNumber: "+15555550100",
      status: "active",
      dailyCap: 10,
      usedToday: 0,
      remainingToday: 10,
      checkedAt: now,
    },
    createdAt: now,
    ...over,
  }
}

test("applyCandidateLifecycleEvent writes pa-users marketplace fields plus one audit row", async () => {
  const { db, store } = makeFakeFirestore()
  const res = await applyCandidateLifecycleEvent(db, lifecycle("profile_created"))
  assert.equal(res.state, "profile_created")
  assert.equal(res.idempotent, false)

  const user = store.get(PA_COLLECTIONS.users)!.get("cand-1")!
  assert.equal(user.candidateLifecycleState, "profile_created")
  assert.equal(user.lifecycleReason, "global_profile_exists")
  assert.equal(user.marketplaceProfile, undefined)
  assert.equal(store.get(PA_COLLECTIONS.auditEvents)!.size, 1)

  const dup = await applyCandidateLifecycleEvent(db, lifecycle("profile_created"))
  assert.equal(dup.idempotent, true)
  assert.equal(store.get(PA_COLLECTIONS.auditEvents)!.size, 1)
})

test("applyCandidateJobEvent keeps NOT_PASS job-specific and does not mutate pa-users", async () => {
  const { db, store } = makeFakeFirestore()
  await applyCandidateJobEvent(db, job("prescreen_started"))
  const result = await applyCandidateJobEvent(db, job("prescreen_not_passed"))
  assert.equal(result.state, "not_passed")
  assert.equal(store.get(PA_COLLECTIONS.users)!.size, 0)

  const stateDoc = store.get(PA_COLLECTIONS.candidateJobStates)!.get(createCandidateJobStateId("cand-1", "job-1"))!
  assert.equal(stateDoc.state, "not_passed")
  assert.equal(stateDoc.reason, "candidate_retained_for_other_jobs")
})

test("applyCandidateJobEvent does not use match score as an interview gate", async () => {
  const { db } = makeFakeFirestore()
  const result = await applyCandidateJobEvent(db, job("prescreen_started", { matchScore: 0.01 }))
  assert.equal(result.state, "prescreen_started")
})

test("writeCandidateJobMatch writes match evidence and latest candidate-job state", async () => {
  const { db, store } = makeFakeFirestore()
  const match = candidateJobMatch()
  const result = await writeCandidateJobMatch(db, match)

  assert.equal(result.created, true)
  assert.equal(result.updated, false)
  assert.equal(result.idempotent, false)
  assert.equal(result.stateDocId, createCandidateJobStateId("cand-1", "job-1"))
  assert.equal(store.get(PA_COLLECTIONS.candidateJobMatches)!.get(match.matchId)!.matchVersion, "s5-test")

  const stateDoc = store.get(PA_COLLECTIONS.candidateJobStates)!.get(result.stateDocId)!
  assert.equal(stateDoc.state, "candidate_matched")
  assert.equal(stateDoc.latestMatchId, match.matchId)
  assert.equal(store.get(PA_COLLECTIONS.auditEvents)!.has(result.auditEventId), true)
})

test("writeCandidateJobMatch is idempotent for the same deterministic match and rejects conflicts", async () => {
  const { db, store } = makeFakeFirestore()
  const match = candidateJobMatch()

  assert.equal((await writeCandidateJobMatch(db, match)).created, true)
  const duplicate = await writeCandidateJobMatch(db, match)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.updated, false)
  assert.equal(duplicate.idempotent, true)
  assert.equal(store.get(PA_COLLECTIONS.candidateJobMatches)!.size, 1)
  assert.equal(store.get(PA_COLLECTIONS.auditEvents)!.size, 1)

  await assert.rejects(
    () => writeCandidateJobMatch(db, candidateJobMatch({ finalScore: 0.4 })),
    /conflicting_duplicate_event/
  )
})

test("writeCandidateJobMatch replaces newer materialized evidence and rejects stale writes", async () => {
  const { db, store } = makeFakeFirestore()
  const match = candidateJobMatch({ computedAt: "2026-05-13T12:00:00.000Z", finalScore: 0.7 })
  const newer = candidateJobMatch({ computedAt: "2026-05-13T13:00:00.000Z", finalScore: 0.91 })
  const stale = candidateJobMatch({ computedAt: "2026-05-13T11:00:00.000Z", finalScore: 0.99 })

  assert.equal((await writeCandidateJobMatch(db, match)).created, true)
  const updated = await writeCandidateJobMatch(db, newer)

  assert.equal(updated.created, false)
  assert.equal(updated.updated, true)
  assert.equal(updated.idempotent, false)
  assert.equal(store.get(PA_COLLECTIONS.candidateJobMatches)!.get(match.matchId)!.finalScore, 0.91)
  assert.equal(store.get(PA_COLLECTIONS.auditEvents)!.size, 2)

  await assert.rejects(
    () => writeCandidateJobMatch(db, stale),
    /stale_candidate_job_match/
  )
})

test("writeCandidateJobMatch never writes outbound, invites, or global candidate profile", async () => {
  const { db, store } = makeFakeFirestore()
  await writeCandidateJobMatch(
    db,
    candidateJobMatch({ recommendedAction: "auto_outbound" })
  )

  assert.equal(store.get(PA_COLLECTIONS.outbound)!.size, 0)
  assert.equal(store.get(PA_COLLECTIONS.outboundInvites)!.size, 0)
  assert.equal(store.get(PA_COLLECTIONS.users)!.size, 0)
})

test("writeCandidateJobMatch validates deterministic ids and preserves first-interview state", async () => {
  const { db, store } = makeFakeFirestore()
  await assert.rejects(
    () => writeCandidateJobMatch(db, candidateJobMatch({ matchId: "random" })),
    /matchId must equal createCandidateJobMatchId/
  )

  const stateId = createCandidateJobStateId("cand-1", "job-1")
  store.get(PA_COLLECTIONS.candidateJobStates)!.set(stateId, {
    id: stateId,
    candidateId: "cand-1",
    jobId: "job-1",
    state: "prescreen_started",
    stateUpdatedAt: "2026-05-13T11:00:00.000Z",
    reason: "first_interview_started",
  })

  await writeCandidateJobMatch(db, candidateJobMatch({ finalScore: 0.01 }))
  const stateDoc = store.get(PA_COLLECTIONS.candidateJobStates)!.get(stateId)!
  assert.equal(stateDoc.state, "prescreen_started")
  assert.equal(stateDoc.reason, "first_interview_started")
  assert.equal(stateDoc.latestMatchId, createCandidateJobMatchId("cand-1", "job-1"))
})

test("writeOutboundInviteDecision writes auditable decisions without outbound or user writes", async () => {
  const { db, store } = makeFakeFirestore()
  const invite = outboundInvite()
  const result = await writeOutboundInviteDecision(db, invite)

  assert.equal(result.created, true)
  assert.equal(result.idempotent, false)
  assert.equal(result.invite.inviteId, invite.inviteId)
  assert.equal(store.get(PA_COLLECTIONS.outboundInvites)!.get(invite.inviteId)!.status, "draft")
  assert.equal(store.get(PA_COLLECTIONS.outbound)!.size, 0)
  assert.equal(store.get(PA_COLLECTIONS.users)!.size, 0)
  assert.equal(store.get(PA_COLLECTIONS.auditEvents)!.has(result.auditEventId), true)

  const duplicate = await writeOutboundInviteDecision(db, invite)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.idempotent, true)
  assert.equal(store.get(PA_COLLECTIONS.outboundInvites)!.size, 1)
})

test("writeOutboundInviteDecision rejects mismatched ids and conflicting duplicates", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () => writeOutboundInviteDecision(db, outboundInvite({ inviteId: "random" })),
    /outbound_invite_id_mismatch/
  )
  await assert.rejects(
    () => writeOutboundInviteDecision(db, outboundInvite({ candidateJobStateId: "wrong" })),
    /candidate_job_state_id_mismatch/
  )

  const invite = outboundInvite()
  await writeOutboundInviteDecision(db, invite)
  await assert.rejects(
    () => writeOutboundInviteDecision(db, outboundInvite({ decisionReason: "changed" })),
    /conflicting_duplicate_event/
  )
})

test("markOutboundInviteQueued links queue evidence then moves candidate-job state", async () => {
  const { db, store } = makeFakeFirestore()
  const invite = outboundInvite({ dryRun: false, approvalState: "approved" })
  await writeOutboundInviteDecision(db, invite)
  store.get(PA_COLLECTIONS.outbound)!.set("outbound-1", {
    id: "outbound-1",
    userId: "cand-1",
    status: "pending",
    createdAt: now,
  })

  const result = await markOutboundInviteQueued(db, {
    inviteId: invite.inviteId,
    outboundId: "outbound-1",
    queuedAt: now,
    actor: "system",
  })
  assert.equal(result.state, "outbound_queued")
  const storedInvite = store.get(PA_COLLECTIONS.outboundInvites)!.get(invite.inviteId)!
  assert.equal(storedInvite.status, "queued")
  assert.equal(storedInvite.outboundId, "outbound-1")
  const state = store.get(PA_COLLECTIONS.candidateJobStates)!.get(createCandidateJobStateId("cand-1", "job-1"))!
  assert.equal(state.state, "outbound_queued")
  assert.equal(state.outboundInviteId, invite.inviteId)
})

test("markOutboundInviteDelivery only marks sent from queued invite evidence", async () => {
  const { db, store } = makeFakeFirestore()
  const invite = outboundInvite({ dryRun: false, approvalState: "approved" })
  await writeOutboundInviteDecision(db, invite)
  await assert.rejects(
    () =>
      markOutboundInviteDelivery(db, {
        inviteId: invite.inviteId,
        outboundId: "outbound-1",
        providerStatus: "SENT",
        deliveredAt: now,
        actor: "system",
      }),
    /outbound_invite_not_queued/
  )

  store.get(PA_COLLECTIONS.outbound)!.set("outbound-1", {
    id: "outbound-1",
    userId: "cand-1",
    status: "pending",
    createdAt: now,
  })
  await markOutboundInviteQueued(db, {
    inviteId: invite.inviteId,
    outboundId: "outbound-1",
    queuedAt: now,
    actor: "system",
  })

  const result = await markOutboundInviteDelivery(db, {
    inviteId: invite.inviteId,
    outboundId: "outbound-1",
    providerStatus: "SENT",
    deliveredAt: now,
    actor: "system",
  })
  assert.equal(result.state, "outbound_sent")
  assert.equal(store.get(PA_COLLECTIONS.outboundInvites)!.get(invite.inviteId)!.status, "sent")
})

test("feedback and correction events are append-only with conflict detection", async () => {
  const { db } = makeFakeFirestore()
  const feedback: FeedbackEvent = {
    eventId: "fb-1",
    kind: "match_feedback",
    actor: "operator",
    candidateId: "cand-1",
    jobId: "job-1",
    evidence: [],
    payloadRedacted: {},
    createdAt: now,
  }
  assert.equal((await writeFeedbackEvent(db, feedback)).created, true)
  assert.equal((await writeFeedbackEvent(db, feedback)).created, false)
  await assert.rejects(
    () => writeFeedbackEvent(db, { ...feedback, outcome: "changed" }),
    /conflicting_duplicate_event/
  )

  const correction: CorrectionEvent = {
    eventId: "corr-1",
    targetType: "candidate_profile",
    targetId: "cand-1",
    actor: "operator",
    reason: "wrong tag",
    evidence: [],
    beforeRedacted: {},
    afterRedacted: {},
    createdAt: now,
  }
  assert.equal((await writeCorrectionEvent(db, correction)).created, true)
  assert.equal((await writeCorrectionEvent(db, correction)).created, false)
  await assert.rejects(
    () => writeCorrectionEvent(db, { ...correction, reason: "different" }),
    /conflicting_duplicate_event/
  )
})

test("employer-visible snapshot requires passed candidate-job state", async () => {
  const { db, store } = makeFakeFirestore()
  const stateId = createCandidateJobStateId("cand-1", "job-1")
  store.get(PA_COLLECTIONS.candidateJobStates)!.set(stateId, {
    id: stateId,
    candidateId: "cand-1",
    jobId: "job-1",
    state: "prescreen_started",
    stateUpdatedAt: now,
  })
  const snapshot: EmployerVisibleProfile = {
    snapshotId: createEmployerVisibleProfileId("job-1", "cand-1"),
    candidateId: "cand-1",
    jobId: "job-1",
    candidateJobStateId: stateId,
    createdFromState: "passed",
    createdBy: "system",
    createdAt: now,
  }
  await assert.rejects(() => writeEmployerVisibleProfile(db, snapshot), /requires_passed_state/)

  store.get(PA_COLLECTIONS.candidateJobStates)!.set(stateId, {
    id: stateId,
    candidateId: "cand-1",
    jobId: "job-1",
    state: "passed",
    stateUpdatedAt: now,
  })
  await assert.rejects(
    () =>
      writeEmployerVisibleProfile(db, {
        ...snapshot,
        snapshotId: createEmployerVisibleProfileId("job-2", "cand-1"),
        jobId: "job-2",
      }),
    /candidate_job_link_mismatch/
  )

  const result = await writeEmployerVisibleProfile(db, snapshot)
  assert.equal(result.created, true)
  assert.equal(store.get(PA_COLLECTIONS.employerVisibleProfiles)!.size, 1)
})

function jobOpportunityDraft(over: Partial<JobOpportunityDraft> = {}): JobOpportunityDraft {
  return {
    draftId: "draft-1",
    jobId: "job-1",
    status: "draft",
    approvalReady: true,
    rawSnapshot: {
      source: "ats",
      capturedAt: now,
      title: "Founding Product Engineer",
      companyName: "WeKruit",
      description: "Build Claire.",
      metadata: {},
    },
    opportunity: {
      title: "Founding Product Engineer",
      companyName: "WeKruit",
      roleFunction: ["software_engineering"],
      industrySector: ["software_and_saas"],
      relevantTags: ["ai_infra"],
      skills: [
        {
          name: "typescript",
          bucket: "programming_languages",
          proficiency: "advanced",
          evidenceCount: 1,
          baseWeight: 0.7,
        },
      ],
      seniority: {
        label: "senior",
        minYears: 5,
        maxYears: 8,
        evidence: [{ source: "ats", summary: "JD asks for 5+ years" }],
      },
      hardFilters: {
        sponsorshipAvailable: null,
        locations: ["remote_anywhere"],
        jobTypes: ["full_time"],
      },
      softScoringWeights: {
        skills: 0.5,
        roleFunction: 0.2,
        industrySector: 0.2,
        location: 0.1,
        compensation: 0,
        visa: 0,
        companyPreference: 0,
      },
      prescreen: {
        questions: [
          {
            questionId: "q-react",
            prompt: "Tell me about a React project you shipped.",
            signal: "frontend depth",
            required: true,
          },
        ],
        passSignals: [],
      },
      scoringRubric: {
        mustHave: ["ships production software"],
        niceToHave: ["AI product experience"],
        disqualifiers: [],
      },
      candidateBrief: {
        headline: "Consumer AI startup founding engineer role.",
        sellingPoints: ["high ownership"],
        risksToClarify: [],
      },
    },
    coverage: {
      overall: "high",
      missingSignals: [],
      seniorityEvidence: "explicit_years",
      sponsorshipSignal: "silent",
    },
    hitlFlags: [],
    enrichmentVersion: "s4-test",
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

test("job opportunity drafts stay private and approval promotes only public-safe fields", async () => {
  const { db, store } = makeFakeFirestore()
  const draft = jobOpportunityDraft()
  const write = await writeJobOpportunityDraft(db, draft)
  assert.equal(write.created, true)
  assert.equal((await writeJobOpportunityDraft(db, draft)).created, false)
  await assert.rejects(
    () => writeJobOpportunityDraft(db, { ...draft, enrichmentVersion: "changed" }),
    /conflicting_duplicate_event/
  )

  const draftPath = `${PA_COLLECTIONS.jobs}/job-1/${PA_JOB_ENRICHMENT_SUBCOLLECTION}`
  assert.equal(store.get(draftPath)!.get("draft-1")!.rawSnapshot !== undefined, true)
  assert.equal(store.get(PA_COLLECTIONS.jobs)!.get("job-1"), undefined)

  const approved = await approveJobOpportunityDraft(db, {
    jobId: "job-1",
    draftId: "draft-1",
    approvedBy: "operator-1",
    approvedAt: "2026-05-13T12:05:00.000Z",
  })
  assert.equal(approved.status, "approved")

  const rootJob = store.get(PA_COLLECTIONS.jobs)!.get("job-1")!
  assert.deepEqual(Object.keys(rootJob).sort(), [
    "enrichmentApprovedAt",
    "enrichmentVersion",
    "jobOpportunity",
    "updatedAt",
  ])
  assert.equal(rootJob.jobOpportunity && typeof rootJob.jobOpportunity, "object")
  assert.equal((rootJob.jobOpportunity as Record<string, unknown>).hardFilters !== undefined, true)
  assert.equal((rootJob.jobOpportunity as Record<string, unknown>).softScoringWeights, undefined)
  assert.equal((rootJob.jobOpportunity as Record<string, unknown>).prescreen, undefined)
  assert.equal((rootJob.jobOpportunity as Record<string, unknown>).scoringRubric, undefined)
  assert.equal((rootJob.jobOpportunity as Record<string, unknown>).candidateBrief, undefined)
  assert.equal(rootJob.rawSnapshot, undefined)
  assert.equal(rootJob.hitlFlags, undefined)

  const storedDraft = store.get(draftPath)!.get("draft-1")!
  assert.equal(storedDraft.status, "approved")
  assert.equal(storedDraft.approvedBy, "operator-1")
  assert.equal(store.get(PA_COLLECTIONS.auditEvents)!.has("marketplace_job_enrichment_approved_draft-1"), true)

  await assert.rejects(
    () =>
      approveJobOpportunityDraft(db, {
        jobId: "job-1",
        draftId: "missing",
        approvedBy: "operator-1",
        approvedAt: now,
      }),
    /job_opportunity_draft_missing/
  )
})

test("job opportunity approval rejects non-ready or rejected drafts", async () => {
  const { db } = makeFakeFirestore()
  await writeJobOpportunityDraft(db, jobOpportunityDraft({ draftId: "review-1", approvalReady: false }))
  await assert.rejects(
    () =>
      approveJobOpportunityDraft(db, {
        jobId: "job-1",
        draftId: "review-1",
        approvedBy: "operator-1",
        approvedAt: now,
      }),
    /job_opportunity_draft_not_approval_ready/
  )

  const rejected = await rejectJobOpportunityDraft(db, {
    jobId: "job-1",
    draftId: "review-1",
    rejectedBy: "operator-1",
    rejectedAt: now,
    reason: "needs stronger evidence",
  })
  assert.equal(rejected.status, "rejected")
  await assert.rejects(
    () =>
      approveJobOpportunityDraft(db, {
        jobId: "job-1",
        draftId: "review-1",
        approvedBy: "operator-1",
        approvedAt: now,
      }),
    /job_opportunity_draft_rejected/
  )
})

test("job enrichment eval fixtures are append-only under pa-jobs subcollection", async () => {
  const { db, store } = makeFakeFirestore()
  const fixture: JobEnrichmentEvalFixture = {
    fixtureId: createJobEnrichmentEvalFixtureId("job-1", "seniority-title-only"),
    jobId: "job-1",
    rawSnapshot: {
      source: "ats",
      capturedAt: now,
      title: "Senior Product Engineer",
      companyName: "WeKruit",
      description: "Build Claire.",
      metadata: {},
    },
    expectedCoverage: "low",
    expectedHitlFlags: ["low_coverage"],
    createdAt: now,
  }
  assert.equal((await writeJobEnrichmentEvalFixture(db, fixture)).created, true)
  assert.equal((await writeJobEnrichmentEvalFixture(db, fixture)).created, false)
  await assert.rejects(
    () => writeJobEnrichmentEvalFixture(db, { ...fixture, expectedCoverage: "high" }),
    /conflicting_duplicate_event/
  )
  const path = `${PA_COLLECTIONS.jobs}/job-1/${PA_JOB_ENRICHMENT_EVAL_FIXTURES_SUBCOLLECTION}`
  assert.equal(store.get(path)!.get(fixture.fixtureId)!.expectedCoverage, "low")
})
