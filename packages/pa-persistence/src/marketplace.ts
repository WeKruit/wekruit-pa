import type { Firestore } from "firebase-admin/firestore"
import {
  CandidateJobEventSchema,
  CandidateJobStateDocSchema,
  CandidateLifecycleEventSchema,
  CandidateProfileMarketplaceFieldsSchema,
  CorrectionEventSchema,
  EmployerVisibleProfileSchema,
  FeedbackEventSchema,
  PA_COLLECTIONS,
  createEmployerVisibleProfileId,
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
