import type { Firestore } from "firebase-admin/firestore"
import {
  CandidateJobEventSchema,
  CandidateJobStateDocSchema,
  CandidateLifecycleEventSchema,
  CandidateProfileMarketplaceFieldsSchema,
  CorrectionEventSchema,
  EmployerVisibleProfileSchema,
  FeedbackEventSchema,
  JobEnrichmentEvalFixtureSchema,
  JobOpportunityDraftSchema,
  PA_COLLECTIONS,
  PA_JOB_ENRICHMENT_EVAL_FIXTURES_SUBCOLLECTION,
  PA_JOB_ENRICHMENT_SUBCOLLECTION,
  createEmployerVisibleProfileId,
  toPublicJobOpportunity,
  reduceCandidateJobState,
  reduceCandidateLifecycleState,
  type CandidateJobEvent,
  type CandidateJobState,
  type CandidateJobStateDoc,
  type CandidateLifecycleEvent,
  type CandidateLifecycleState,
  type CorrectionEvent,
  type EmployerVisibleProfile,
  type FeedbackEvent,
  type JobEnrichmentEvalFixture,
  type JobOpportunityDraft,
  createCandidateJobStateId,
} from "@pa/core-types"

const AUDIT_COLLECTION = PA_COLLECTIONS.auditEvents

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function auditId(prefix: string, eventId: string): string {
  return `${prefix}_${eventId}`
}

export type MarketplaceTransitionResult<TState extends string> = {
  state: TState
  changed: boolean
  idempotent: boolean
  auditEventId: string
  reason: string
}

export async function applyCandidateLifecycleEvent(
  db: Firestore,
  rawEvent: CandidateLifecycleEvent
): Promise<MarketplaceTransitionResult<CandidateLifecycleState>> {
  const event = CandidateLifecycleEventSchema.parse(rawEvent)
  const userRef = db.collection(PA_COLLECTIONS.users).doc(event.candidateId)
  const auditRef = db.collection(AUDIT_COLLECTION).doc(auditId("marketplace_lifecycle", event.eventId))

  return await db.runTransaction(async (tx) => {
    const auditSnap = await tx.get(auditRef)
    const userSnap = await tx.get(userRef)
    const userRaw = (userSnap.exists ? userSnap.data() : {}) as Record<string, unknown>
    const currentFields = CandidateProfileMarketplaceFieldsSchema.parse(userRaw)
    const currentState = currentFields.candidateLifecycleState

    if (auditSnap.exists) {
      return {
        state: currentState,
        changed: false,
        idempotent: true,
        auditEventId: auditRef.id,
        reason: "duplicate_transition_event",
      }
    }

    const reduced = reduceCandidateLifecycleState(currentState, event)
    tx.set(
      userRef,
      {
        ...currentFields,
        candidateLifecycleState: reduced.state,
        lifecycleUpdatedAt: event.occurredAt,
        lifecycleReason: reduced.reason,
        updatedAt: event.occurredAt,
      },
      { merge: true }
    )
    tx.set(auditRef, {
      id: auditRef.id,
      action: "marketplace.profile.transition",
      candidateId: event.candidateId,
      eventId: event.eventId,
      eventType: event.type,
      from: reduced.transition.from,
      to: reduced.transition.to,
      changed: reduced.changed,
      reason: reduced.reason,
      actor: event.actor,
      createdAt: event.occurredAt,
    })
    return {
      state: reduced.state,
      changed: reduced.changed,
      idempotent: false,
      auditEventId: auditRef.id,
      reason: reduced.reason,
    }
  })
}

export async function applyCandidateJobEvent(
  db: Firestore,
  rawEvent: CandidateJobEvent
): Promise<MarketplaceTransitionResult<CandidateJobState> & { stateDocId: string }> {
  const event = CandidateJobEventSchema.parse(rawEvent)
  const stateDocId = createCandidateJobStateId(event.candidateId, event.jobId)
  const stateRef = db.collection(PA_COLLECTIONS.candidateJobStates).doc(stateDocId)
  const auditRef = db.collection(AUDIT_COLLECTION).doc(auditId("marketplace_candidate_job", event.eventId))

  return await db.runTransaction(async (tx) => {
    const auditSnap = await tx.get(auditRef)
    const stateSnap = await tx.get(stateRef)
    const currentDoc = stateSnap.exists
      ? CandidateJobStateDocSchema.parse(stateSnap.data())
      : null
    const currentState = currentDoc?.state ?? "candidate_matched"

    if (auditSnap.exists) {
      return {
        state: currentState,
        changed: false,
        idempotent: true,
        auditEventId: auditRef.id,
        reason: "duplicate_transition_event",
        stateDocId,
      }
    }

    const reduced = reduceCandidateJobState(currentState, event)
    const nextDoc: CandidateJobStateDoc = CandidateJobStateDocSchema.parse({
      ...(currentDoc ?? {}),
      id: stateDocId,
      candidateId: event.candidateId,
      jobId: event.jobId,
      state: reduced.state,
      previousState: currentState,
      stateUpdatedAt: event.occurredAt,
      reason: reduced.reason,
      archivedAt: reduced.state === "archived" ? event.occurredAt : currentDoc?.archivedAt,
    })
    tx.set(stateRef, nextDoc, { merge: true })
    tx.set(auditRef, {
      id: auditRef.id,
      action: "marketplace.candidate_job.transition",
      candidateId: event.candidateId,
      jobId: event.jobId,
      eventId: event.eventId,
      eventType: event.type,
      from: reduced.transition.from,
      to: reduced.transition.to,
      changed: reduced.changed,
      reason: reduced.reason,
      actor: event.actor,
      createdAt: event.occurredAt,
    })
    return {
      state: reduced.state,
      changed: reduced.changed,
      idempotent: false,
      auditEventId: auditRef.id,
      reason: reduced.reason,
      stateDocId,
    }
  })
}

async function writeAppendOnlyDoc<T>(
  db: Firestore,
  collectionName: string,
  docId: string,
  payload: T
): Promise<{ event: T; created: boolean }> {
  const ref = db.collection(collectionName).doc(docId)
  const existing = await ref.get()
  if (existing.exists) {
    const data = existing.data() as T
    if (stableJson(data) !== stableJson(payload)) {
      throw new Error(`conflicting_duplicate_event:${collectionName}/${docId}`)
    }
    return { event: data, created: false }
  }
  await ref.set(payload as Record<string, unknown>)
  return { event: payload, created: true }
}

type FirestoreDocRef = ReturnType<ReturnType<Firestore["collection"]>["doc"]>

function jobRootRef(db: Firestore, jobId: string): FirestoreDocRef {
  return db.collection(PA_COLLECTIONS.jobs).doc(jobId)
}

function jobEnrichmentDraftRef(db: Firestore, jobId: string, draftId: string): FirestoreDocRef {
  return jobRootRef(db, jobId).collection(PA_JOB_ENRICHMENT_SUBCOLLECTION).doc(draftId)
}

function jobEnrichmentEvalFixtureRef(
  db: Firestore,
  jobId: string,
  fixtureId: string
): FirestoreDocRef {
  return jobRootRef(db, jobId)
    .collection(PA_JOB_ENRICHMENT_EVAL_FIXTURES_SUBCOLLECTION)
    .doc(fixtureId)
}

async function writeAppendOnlyRefDoc<T>(
  ref: FirestoreDocRef,
  collectionName: string,
  docId: string,
  payload: T
): Promise<{ event: T; created: boolean }> {
  const existing = await ref.get()
  if (existing.exists) {
    const data = existing.data() as T
    if (stableJson(data) !== stableJson(payload)) {
      throw new Error(`conflicting_duplicate_event:${collectionName}/${docId}`)
    }
    return { event: data, created: false }
  }
  await ref.set(payload as Record<string, unknown>)
  return { event: payload, created: true }
}

export async function writeJobOpportunityDraft(
  db: Firestore,
  rawDraft: JobOpportunityDraft
): Promise<{ draft: JobOpportunityDraft; created: boolean }> {
  const draft = JobOpportunityDraftSchema.parse(rawDraft)
  const result = await writeAppendOnlyRefDoc(
    jobEnrichmentDraftRef(db, draft.jobId, draft.draftId),
    `${PA_COLLECTIONS.jobs}/${draft.jobId}/${PA_JOB_ENRICHMENT_SUBCOLLECTION}`,
    draft.draftId,
    draft
  )
  if (result.created) {
    await db.collection(AUDIT_COLLECTION).doc(auditId("marketplace_job_enrichment", draft.draftId)).set({
      id: auditId("marketplace_job_enrichment", draft.draftId),
      action: "marketplace.job_enrichment.draft.write",
      jobId: draft.jobId,
      draftId: draft.draftId,
      status: draft.status,
      approvalReady: draft.approvalReady,
      createdAt: draft.createdAt,
    })
  }
  return { draft: result.event, created: result.created }
}

export type ApproveJobOpportunityDraftInput = {
  jobId: string
  draftId: string
  approvedBy: string
  approvedAt: string
}

export async function approveJobOpportunityDraft(
  db: Firestore,
  input: ApproveJobOpportunityDraftInput
): Promise<JobOpportunityDraft> {
  const draftRef = jobEnrichmentDraftRef(db, input.jobId, input.draftId)
  const rootRef = jobRootRef(db, input.jobId)
  const auditRef = db
    .collection(AUDIT_COLLECTION)
    .doc(auditId("marketplace_job_enrichment_approved", input.draftId))

  return await db.runTransaction(async (tx) => {
    const draftSnap = await tx.get(draftRef)
    if (!draftSnap.exists) throw new Error("job_opportunity_draft_missing")
    const draft = JobOpportunityDraftSchema.parse(draftSnap.data())
    if (draft.jobId !== input.jobId || draft.draftId !== input.draftId) {
      throw new Error("job_opportunity_draft_link_mismatch")
    }
    if (draft.status === "rejected") throw new Error("job_opportunity_draft_rejected")
    if (!draft.approvalReady) throw new Error("job_opportunity_draft_not_approval_ready")

    const approved = JobOpportunityDraftSchema.parse({
      ...draft,
      status: "approved",
      approvedAt: input.approvedAt,
      approvedBy: input.approvedBy,
      updatedAt: input.approvedAt,
    })
    tx.set(draftRef, approved, { merge: false })
    tx.set(
      rootRef,
      {
        jobOpportunity: toPublicJobOpportunity(approved.opportunity),
        enrichmentVersion: approved.enrichmentVersion,
        enrichmentApprovedAt: input.approvedAt,
        updatedAt: input.approvedAt,
      },
      { merge: true }
    )
    tx.set(auditRef, {
      id: auditRef.id,
      action: "marketplace.job_enrichment.approve",
      jobId: input.jobId,
      draftId: input.draftId,
      actor: input.approvedBy,
      createdAt: input.approvedAt,
    })
    return approved
  })
}

export type RejectJobOpportunityDraftInput = {
  jobId: string
  draftId: string
  rejectedBy: string
  rejectedAt: string
  reason: string
}

export async function rejectJobOpportunityDraft(
  db: Firestore,
  input: RejectJobOpportunityDraftInput
): Promise<JobOpportunityDraft> {
  const draftRef = jobEnrichmentDraftRef(db, input.jobId, input.draftId)
  const auditRef = db
    .collection(AUDIT_COLLECTION)
    .doc(auditId("marketplace_job_enrichment_rejected", input.draftId))

  return await db.runTransaction(async (tx) => {
    const draftSnap = await tx.get(draftRef)
    if (!draftSnap.exists) throw new Error("job_opportunity_draft_missing")
    const draft = JobOpportunityDraftSchema.parse(draftSnap.data())
    if (draft.status === "approved") throw new Error("job_opportunity_draft_already_approved")
    const rejected = JobOpportunityDraftSchema.parse({
      ...draft,
      status: "rejected",
      rejectedAt: input.rejectedAt,
      rejectedBy: input.rejectedBy,
      rejectionReason: input.reason,
      updatedAt: input.rejectedAt,
    })
    tx.set(draftRef, rejected, { merge: false })
    tx.set(auditRef, {
      id: auditRef.id,
      action: "marketplace.job_enrichment.reject",
      jobId: input.jobId,
      draftId: input.draftId,
      actor: input.rejectedBy,
      reason: input.reason,
      createdAt: input.rejectedAt,
    })
    return rejected
  })
}

export async function writeJobEnrichmentEvalFixture(
  db: Firestore,
  rawFixture: JobEnrichmentEvalFixture
): Promise<{ fixture: JobEnrichmentEvalFixture; created: boolean }> {
  const fixture = JobEnrichmentEvalFixtureSchema.parse(rawFixture)
  const result = await writeAppendOnlyRefDoc(
    jobEnrichmentEvalFixtureRef(db, fixture.jobId, fixture.fixtureId),
    `${PA_COLLECTIONS.jobs}/${fixture.jobId}/${PA_JOB_ENRICHMENT_EVAL_FIXTURES_SUBCOLLECTION}`,
    fixture.fixtureId,
    fixture
  )
  if (result.created) {
    await db.collection(AUDIT_COLLECTION).doc(auditId("marketplace_job_enrichment_eval", fixture.fixtureId)).set({
      id: auditId("marketplace_job_enrichment_eval", fixture.fixtureId),
      action: "marketplace.job_enrichment.eval_fixture.write",
      jobId: fixture.jobId,
      fixtureId: fixture.fixtureId,
      createdAt: fixture.createdAt,
    })
  }
  return { fixture: result.event, created: result.created }
}

export async function writeFeedbackEvent(
  db: Firestore,
  rawEvent: FeedbackEvent
): Promise<{ event: FeedbackEvent; created: boolean }> {
  const event = FeedbackEventSchema.parse(rawEvent)
  const result = await writeAppendOnlyDoc(db, PA_COLLECTIONS.feedbackEvents, event.eventId, event)
  if (result.created) {
    await db.collection(AUDIT_COLLECTION).doc(auditId("marketplace_feedback", event.eventId)).set({
      id: auditId("marketplace_feedback", event.eventId),
      action: "marketplace.feedback.append",
      eventId: event.eventId,
      candidateId: event.candidateId ?? null,
      jobId: event.jobId ?? null,
      actor: event.actor,
      createdAt: event.createdAt,
    })
  }
  return result
}

export async function writeCorrectionEvent(
  db: Firestore,
  rawEvent: CorrectionEvent
): Promise<{ event: CorrectionEvent; created: boolean }> {
  const event = CorrectionEventSchema.parse(rawEvent)
  const result = await writeAppendOnlyDoc(db, PA_COLLECTIONS.correctionEvents, event.eventId, event)
  if (result.created) {
    await db.collection(AUDIT_COLLECTION).doc(auditId("marketplace_correction", event.eventId)).set({
      id: auditId("marketplace_correction", event.eventId),
      action: "marketplace.correction.append",
      eventId: event.eventId,
      candidateId: event.candidateId ?? null,
      jobId: event.jobId ?? null,
      actor: event.actor,
      createdAt: event.createdAt,
    })
  }
  return result
}

export async function writeEmployerVisibleProfile(
  db: Firestore,
  rawSnapshot: EmployerVisibleProfile
): Promise<{ snapshot: EmployerVisibleProfile; created: boolean }> {
  const snapshot = EmployerVisibleProfileSchema.parse(rawSnapshot)
  const expectedId = createEmployerVisibleProfileId(snapshot.jobId, snapshot.candidateId)
  if (snapshot.snapshotId !== expectedId) {
    throw new Error(`invalid_employer_visible_snapshot_id:${snapshot.snapshotId}`)
  }
  const stateSnap = await db
    .collection(PA_COLLECTIONS.candidateJobStates)
    .doc(snapshot.candidateJobStateId)
    .get()
  if (!stateSnap.exists) {
    throw new Error("candidate_job_state_missing")
  }
  const stateDoc = CandidateJobStateDocSchema.parse(stateSnap.data())
  if (
    stateDoc.id !== snapshot.candidateJobStateId ||
    stateDoc.candidateId !== snapshot.candidateId ||
    stateDoc.jobId !== snapshot.jobId
  ) {
    throw new Error("employer_visible_candidate_job_link_mismatch")
  }
  if (stateDoc.state !== "passed") {
    throw new Error("employer_visible_requires_passed_state")
  }
  const result = await writeAppendOnlyDoc(
    db,
    PA_COLLECTIONS.employerVisibleProfiles,
    snapshot.snapshotId,
    snapshot
  )
  if (result.created) {
    await db.collection(AUDIT_COLLECTION).doc(auditId("marketplace_employer_visible", snapshot.snapshotId)).set({
      id: auditId("marketplace_employer_visible", snapshot.snapshotId),
      action: "marketplace.employer_visible.create",
      snapshotId: snapshot.snapshotId,
      candidateId: snapshot.candidateId,
      jobId: snapshot.jobId,
      actor: snapshot.createdBy,
      createdAt: snapshot.createdAt,
    })
  }
  return { snapshot: result.event, created: result.created }
}
