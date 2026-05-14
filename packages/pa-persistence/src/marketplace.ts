import type { Firestore } from "firebase-admin/firestore"
import {
  CandidateJobEventSchema,
  CandidateJobMatchSchema,
  CandidateJobStateDocSchema,
  CandidateLifecycleEventSchema,
  CandidateProfileMarketplaceFieldsSchema,
  CorrectionEventSchema,
  EmployerVisibleProfileSchema,
  EvalArtifactSchema,
  FeedbackEventSchema,
  JobEnrichmentEvalFixtureSchema,
  JobOpportunityDraftSchema,
  LaunchReadinessSnapshotSchema,
  OutreachStopControlSchema,
  PrivacyRequestSchema,
  OutboundInviteSchema,
  PA_COLLECTIONS,
  PA_JOB_ENRICHMENT_EVAL_FIXTURES_SUBCOLLECTION,
  PA_JOB_ENRICHMENT_SUBCOLLECTION,
  createEmployerVisibleProfileId,
  toPublicJobOpportunity,
  reduceCandidateJobState,
  reduceCandidateLifecycleState,
  type CandidateJobEvent,
  type CandidateJobMatch,
  type CandidateJobState,
  type CandidateJobStateDoc,
  type CandidateLifecycleEvent,
  type CandidateLifecycleState,
  type CorrectionEvent,
  type EmployerVisibleProfile,
  type EvalArtifact,
  type FeedbackEvent,
  type JobEnrichmentEvalFixture,
  type JobOpportunityDraft,
  type LaunchReadinessSnapshot,
  type MarketplaceEvidence,
  type MarketplaceActor,
  type OutreachStopControl,
  type OutreachStopControlScope,
  type OutboundInvite,
  type PrivacyRequest,
  type StateReductionResult,
  createCandidateJobStateId,
  createCandidateJobMatchId,
  createEvalArtifactId,
  createOutreachStopControlId,
  createOutboundInviteId,
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

function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneUndefined)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, pruneUndefined(v)])
    )
  }
  return value
}

function firestorePayload(value: Record<string, unknown>): Record<string, unknown> {
  return pruneUndefined(value) as Record<string, unknown>
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
      prescreenSessionId:
        "prescreenSessionId" in event
          ? event.prescreenSessionId ?? currentDoc?.prescreenSessionId
          : currentDoc?.prescreenSessionId,
      employerVisibleProfileId:
        event.type === "employer_snapshot_created"
          ? event.employerVisibleProfileId
          : currentDoc?.employerVisibleProfileId,
      outboundInviteId:
        event.type === "outbound_queued" || event.type === "outbound_sent"
          ? event.outboundInviteId
          : currentDoc?.outboundInviteId,
      outboundId:
        event.type === "outbound_queued" || event.type === "outbound_sent"
          ? event.outboundId
          : currentDoc?.outboundId,
      latestMatchId:
        event.type === "outbound_queued"
          ? event.matchId ?? currentDoc?.latestMatchId
          : currentDoc?.latestMatchId,
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

export type WriteCandidateJobMatchResult = {
  match: CandidateJobMatch
  created: boolean
  updated: boolean
  idempotent: boolean
  stateDocId: string
  auditEventId: string
}

function timestampOrderValue(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function addDaysIso(baseIso: string, days: number): string {
  return new Date(timestampOrderValue(baseIso) + days * 24 * 60 * 60 * 1000).toISOString()
}

function safeAuditPart(value: string): string {
  return value.replace(/[\\/]/g, "_")
}

export async function writeCandidateJobMatch(
  db: Firestore,
  rawMatch: CandidateJobMatch
): Promise<WriteCandidateJobMatchResult> {
  const match = CandidateJobMatchSchema.parse(rawMatch)
  const expectedMatchId = createCandidateJobMatchId(match.candidateId, match.jobId)
  if (match.matchId !== expectedMatchId) {
    throw new Error("candidate_job_match_id_mismatch")
  }

  const stateDocId = createCandidateJobStateId(match.candidateId, match.jobId)
  const matchRef = db.collection(PA_COLLECTIONS.candidateJobMatches).doc(match.matchId)
  const stateRef = db.collection(PA_COLLECTIONS.candidateJobStates).doc(stateDocId)
  const auditRef = db
    .collection(AUDIT_COLLECTION)
    .doc(auditId("marketplace_candidate_job_match", `${match.matchId}_${safeAuditPart(match.computedAt)}`))

  return await db.runTransaction(async (tx) => {
    const matchSnap = await tx.get(matchRef)
    const stateSnap = await tx.get(stateRef)
    const auditSnap = await tx.get(auditRef)

    const currentDoc = stateSnap.exists
      ? CandidateJobStateDocSchema.parse(stateSnap.data())
      : null
    const currentState = currentDoc?.state ?? "candidate_matched"

    if (matchSnap.exists) {
      const existingMatch = CandidateJobMatchSchema.parse(matchSnap.data())
      if (stableJson(existingMatch) !== stableJson(match)) {
        const existingTime = timestampOrderValue(existingMatch.computedAt)
        const nextTime = timestampOrderValue(match.computedAt)
        if (nextTime < existingTime) {
          throw new Error(`stale_candidate_job_match:${PA_COLLECTIONS.candidateJobMatches}/${match.matchId}`)
        }
        if (nextTime <= existingTime) {
          throw new Error(`conflicting_duplicate_event:${PA_COLLECTIONS.candidateJobMatches}/${match.matchId}`)
        }
      } else {
        return {
          match: existingMatch,
          created: false,
          updated: false,
          idempotent: true,
          stateDocId,
          auditEventId: auditRef.id,
        }
      }
    }

    const event: CandidateJobEvent = {
      eventId: `match-${match.matchId}`,
      type: "match_recorded",
      candidateId: match.candidateId,
      jobId: match.jobId,
      actor: "system",
      occurredAt: match.computedAt,
      evidence: match.evidence,
      matchScore: match.finalScore,
    }
    const reduced = reduceCandidateJobState(currentState, event)
    const nextDoc: CandidateJobStateDoc = CandidateJobStateDocSchema.parse({
      ...(currentDoc ?? {}),
      id: stateDocId,
      candidateId: match.candidateId,
      jobId: match.jobId,
      state: reduced.state,
      previousState: currentState,
      stateUpdatedAt: currentDoc?.stateUpdatedAt ?? match.computedAt,
      reason: currentDoc?.reason ?? reduced.reason,
      latestMatchId: match.matchId,
      archivedAt: currentDoc?.archivedAt,
    })

    tx.set(matchRef, match as Record<string, unknown>)
    tx.set(stateRef, nextDoc, { merge: true })
    if (!auditSnap.exists) {
      tx.set(auditRef, {
        id: auditRef.id,
        action: "marketplace.candidate_job.match.write",
        candidateId: match.candidateId,
        jobId: match.jobId,
        matchId: match.matchId,
        direction: match.direction,
        matchVersion: match.matchVersion,
        jobEnrichmentVersion: match.jobEnrichmentVersion,
        latestMatchId: match.matchId,
        createdAt: match.computedAt,
      })
    }

    return {
      match,
      created: !matchSnap.exists,
      updated: matchSnap.exists,
      idempotent: false,
      stateDocId,
      auditEventId: auditRef.id,
    }
  })
}

export type WriteOutboundInviteDecisionResult = {
  invite: OutboundInvite
  created: boolean
  idempotent: boolean
  auditEventId: string
}

function expectedOutboundInviteId(invite: Pick<OutboundInvite, "candidateId" | "jobId" | "matchId">): string {
  return createOutboundInviteId({
    candidateId: invite.candidateId,
    jobId: invite.jobId,
    matchId: invite.matchId,
  })
}

export async function writeOutboundInviteDecision(
  db: Firestore,
  rawInvite: OutboundInvite
): Promise<WriteOutboundInviteDecisionResult> {
  const invite = OutboundInviteSchema.parse(rawInvite)
  if (invite.inviteId !== expectedOutboundInviteId(invite)) {
    throw new Error("outbound_invite_id_mismatch")
  }
  const stateDocId = createCandidateJobStateId(invite.candidateId, invite.jobId)
  if (invite.candidateJobStateId !== stateDocId) {
    throw new Error("candidate_job_state_id_mismatch")
  }

  const inviteRef = db.collection(PA_COLLECTIONS.outboundInvites).doc(invite.inviteId)
  const auditRef = db
    .collection(AUDIT_COLLECTION)
    .doc(auditId("marketplace_outbound_invite_decision", invite.inviteId))

  return await db.runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef)
    const auditSnap = await tx.get(auditRef)

    if (inviteSnap.exists) {
      const existingInvite = OutboundInviteSchema.parse(inviteSnap.data())
      if (stableJson(pruneUndefined(existingInvite)) !== stableJson(pruneUndefined(invite))) {
        throw new Error(`conflicting_duplicate_event:${PA_COLLECTIONS.outboundInvites}/${invite.inviteId}`)
      }
      return {
        invite: existingInvite,
        created: false,
        idempotent: true,
        auditEventId: auditRef.id,
      }
    }

    tx.set(inviteRef, firestorePayload(invite as Record<string, unknown>))
    if (!auditSnap.exists) {
      tx.set(auditRef, firestorePayload({
        id: auditRef.id,
        action: "marketplace.outbound_invite.decision.write",
        candidateId: invite.candidateId,
        jobId: invite.jobId,
        candidateJobStateId: invite.candidateJobStateId,
        inviteId: invite.inviteId,
        matchId: invite.matchId,
        policyDecision: invite.policyDecision,
        approvalState: invite.approvalState,
        status: invite.status,
        dryRun: invite.dryRun,
        blockedSignals: invite.blockedSignals,
        stickyAccountGroupId: invite.stickyAccountGroupId,
        createdAt: invite.createdAt,
      }))
    }

    return {
      invite,
      created: true,
      idempotent: false,
      auditEventId: auditRef.id,
    }
  })
}

export type MarkOutboundInviteQueuedInput = {
  inviteId: string
  outboundId: string
  queuedAt: string
  actor: MarketplaceActor
}

export type MarkOutboundInviteDeliveryInput = {
  inviteId: string
  outboundId: string
  providerStatus: string
  deliveredAt: string
  actor: MarketplaceActor
  lastError?: string
}

function deliveryStatusFromProvider(providerStatus: string): OutboundInvite["status"] {
  const normalized = providerStatus.trim().toUpperCase()
  if (normalized === "DELIVERED") return "delivered"
  if (normalized === "FAILED" || normalized === "ERROR") return "failed"
  if (normalized === "DEAD_LETTER") return "dead_letter"
  return "sent"
}

export async function markOutboundInviteQueued(
  db: Firestore,
  input: MarkOutboundInviteQueuedInput
): Promise<MarketplaceTransitionResult<CandidateJobState> & { stateDocId: string; invite: OutboundInvite }> {
  const inviteRef = db.collection(PA_COLLECTIONS.outboundInvites).doc(input.inviteId)
  const outboundRef = db.collection(PA_COLLECTIONS.outbound).doc(input.outboundId)
  const auditRef = db
    .collection(AUDIT_COLLECTION)
    .doc(auditId("marketplace_outbound_invite_queued", `${input.inviteId}_${input.outboundId}`))

  return await db.runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef)
    if (!inviteSnap.exists) throw new Error("outbound_invite_missing")
    const invite = OutboundInviteSchema.parse(inviteSnap.data())
    if (invite.dryRun) throw new Error("outbound_invite_dry_run")
    if (invite.status === "queued" && invite.outboundId === input.outboundId) {
      const stateDocId = createCandidateJobStateId(invite.candidateId, invite.jobId)
      const stateSnap = await tx.get(db.collection(PA_COLLECTIONS.candidateJobStates).doc(stateDocId))
      const currentDoc = stateSnap.exists ? CandidateJobStateDocSchema.parse(stateSnap.data()) : null
      return {
        state: currentDoc?.state ?? "outbound_queued",
        changed: false,
        idempotent: true,
        auditEventId: auditRef.id,
        reason: "duplicate_outbound_invite_queued",
        stateDocId,
        invite,
      }
    }
    if (invite.status !== "draft" && invite.status !== "approved") {
      throw new Error(`outbound_invite_not_queueable:${invite.status}`)
    }
    if (invite.approvalState !== "approved" && invite.approvalState !== "not_required") {
      throw new Error(`outbound_invite_not_approved:${invite.approvalState}`)
    }
    const outboundSnap = await tx.get(outboundRef)
    if (!outboundSnap.exists) throw new Error("outbound_queue_row_missing")

    const stateDocId = createCandidateJobStateId(invite.candidateId, invite.jobId)
    const stateRef = db.collection(PA_COLLECTIONS.candidateJobStates).doc(stateDocId)
    const userRef = db.collection(PA_COLLECTIONS.users).doc(invite.candidateId)
    const stateSnap = await tx.get(stateRef)
    const userSnap = await tx.get(userRef)
    const currentDoc = stateSnap.exists ? CandidateJobStateDocSchema.parse(stateSnap.data()) : null
    const currentUserFields = CandidateProfileMarketplaceFieldsSchema.parse(
      userSnap.exists ? userSnap.data() : {}
    )
    const currentState = currentDoc?.state ?? "candidate_matched"
    const event: CandidateJobEvent = CandidateJobEventSchema.parse({
      eventId: `outbound-queued-${input.inviteId}-${input.outboundId}`,
      type: "outbound_queued",
      candidateId: invite.candidateId,
      jobId: invite.jobId,
      actor: input.actor,
      occurredAt: input.queuedAt,
      evidence: [{ source: "outbound_delivery", summary: "Outbound queue row created", refId: input.outboundId }],
      outboundInviteId: invite.inviteId,
      outboundId: input.outboundId,
      matchId: invite.matchId,
    })
    const reduced = reduceCandidateJobState(currentState, event)
    const nextDoc: CandidateJobStateDoc = CandidateJobStateDocSchema.parse({
      ...(currentDoc ?? {}),
      id: stateDocId,
      candidateId: invite.candidateId,
      jobId: invite.jobId,
      state: reduced.state,
      previousState: currentState,
      stateUpdatedAt: input.queuedAt,
      reason: reduced.reason,
      outboundInviteId: invite.inviteId,
      outboundId: input.outboundId,
      latestMatchId: invite.matchId ?? currentDoc?.latestMatchId,
      archivedAt: currentDoc?.archivedAt,
    })
    const nextInvite = OutboundInviteSchema.parse({
      ...invite,
      status: "queued",
      outboundId: input.outboundId,
      queuedAt: input.queuedAt,
      updatedAt: input.queuedAt,
    })

    tx.set(inviteRef, firestorePayload(nextInvite as Record<string, unknown>), { merge: true })
    tx.set(stateRef, firestorePayload(nextDoc as Record<string, unknown>), { merge: true })
    tx.set(
      userRef,
      firestorePayload({
        outreach: {
          ...(currentUserFields.outreach ?? {}),
          status: "cooldown",
          lastOutboundAt: input.queuedAt,
          cooldownUntil: addDaysIso(input.queuedAt, 7),
        },
        updatedAt: input.queuedAt,
      }),
      { merge: true }
    )
    tx.set(auditRef, firestorePayload({
      id: auditRef.id,
      action: "marketplace.outbound_invite.queued",
      candidateId: invite.candidateId,
      jobId: invite.jobId,
      inviteId: invite.inviteId,
      outboundId: input.outboundId,
      from: reduced.transition.from,
      to: reduced.transition.to,
      changed: reduced.changed,
      reason: reduced.reason,
      actor: input.actor,
      createdAt: input.queuedAt,
    }))

    return {
      state: reduced.state,
      changed: reduced.changed,
      idempotent: false,
      auditEventId: auditRef.id,
      reason: reduced.reason,
      stateDocId,
      invite: nextInvite,
    }
  })
}

export async function markOutboundInviteDelivery(
  db: Firestore,
  input: MarkOutboundInviteDeliveryInput
): Promise<MarketplaceTransitionResult<CandidateJobState> & { stateDocId: string; invite: OutboundInvite }> {
  const inviteRef = db.collection(PA_COLLECTIONS.outboundInvites).doc(input.inviteId)
  const auditRef = db
    .collection(AUDIT_COLLECTION)
    .doc(auditId("marketplace_outbound_invite_delivery", `${input.inviteId}_${safeAuditPart(input.providerStatus)}`))

  return await db.runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef)
    if (!inviteSnap.exists) throw new Error("outbound_invite_missing")
    const invite = OutboundInviteSchema.parse(inviteSnap.data())
    if (invite.status !== "queued" && invite.status !== "sent" && invite.status !== "delivered") {
      throw new Error("outbound_invite_not_queued")
    }
    if (invite.outboundId !== input.outboundId) throw new Error("outbound_id_mismatch")

    const normalizedStatus = deliveryStatusFromProvider(input.providerStatus)
    const nextStatus =
      invite.status === "delivered" && normalizedStatus === "sent"
        ? "delivered"
        : normalizedStatus
    const stateDocId = createCandidateJobStateId(invite.candidateId, invite.jobId)
    const stateRef = db.collection(PA_COLLECTIONS.candidateJobStates).doc(stateDocId)
    const stateSnap = await tx.get(stateRef)
    const currentDoc = stateSnap.exists ? CandidateJobStateDocSchema.parse(stateSnap.data()) : null
    const currentState = currentDoc?.state ?? "candidate_matched"

    let reduced = reductionForNoStateChange(
      currentState,
      `outbound_${nextStatus}`,
      input.deliveredAt,
      "outbound_delivery_recorded"
    )
    if (nextStatus === "sent" || nextStatus === "delivered") {
      const event: CandidateJobEvent = CandidateJobEventSchema.parse({
        eventId: `outbound-sent-${input.inviteId}-${input.outboundId}`,
        type: "outbound_sent",
        candidateId: invite.candidateId,
        jobId: invite.jobId,
        actor: input.actor,
        occurredAt: input.deliveredAt,
        evidence: [{ source: "outbound_delivery", summary: "Provider accepted outbound", refId: input.outboundId }],
        outboundInviteId: invite.inviteId,
        outboundId: input.outboundId,
        providerStatus: input.providerStatus,
      })
      reduced = reduceCandidateJobState(currentState, event)
      const nextDoc: CandidateJobStateDoc = CandidateJobStateDocSchema.parse({
        ...(currentDoc ?? {}),
        id: stateDocId,
        candidateId: invite.candidateId,
        jobId: invite.jobId,
        state: reduced.state,
        previousState: currentState,
        stateUpdatedAt: input.deliveredAt,
        reason: reduced.reason,
        outboundInviteId: invite.inviteId,
        outboundId: input.outboundId,
        latestMatchId: currentDoc?.latestMatchId,
        archivedAt: currentDoc?.archivedAt,
      })
      tx.set(stateRef, firestorePayload(nextDoc as Record<string, unknown>), { merge: true })
    }

    const nextInvite = OutboundInviteSchema.parse({
      ...invite,
      status: nextStatus,
      providerStatus: input.providerStatus,
      sentAt:
        nextStatus === "sent" || nextStatus === "delivered"
          ? invite.sentAt ?? input.deliveredAt
          : invite.sentAt,
      deliveredAt: nextStatus === "delivered" ? input.deliveredAt : invite.deliveredAt,
      failedAt: nextStatus === "failed" || nextStatus === "dead_letter" ? input.deliveredAt : invite.failedAt,
      lastError: input.lastError ?? invite.lastError,
      updatedAt: input.deliveredAt,
    })
    tx.set(inviteRef, firestorePayload(nextInvite as Record<string, unknown>), { merge: true })
    tx.set(auditRef, firestorePayload({
      id: auditRef.id,
      action: "marketplace.outbound_invite.delivery",
      candidateId: invite.candidateId,
      jobId: invite.jobId,
      inviteId: invite.inviteId,
      outboundId: input.outboundId,
      providerStatus: input.providerStatus,
      status: nextStatus,
      from: reduced.transition.from,
      to: reduced.transition.to,
      changed: reduced.changed,
      reason: reduced.reason,
      actor: input.actor,
      createdAt: input.deliveredAt,
    }))

    return {
      state: reduced.state,
      changed: reduced.changed,
      idempotent: false,
      auditEventId: auditRef.id,
      reason: reduced.reason,
      stateDocId,
      invite: nextInvite,
    }
  })
}

function reductionForNoStateChange(
  state: CandidateJobState,
  eventType: string,
  occurredAt: string,
  reason: string
): StateReductionResult<CandidateJobState> {
  return {
    state,
    changed: false,
    reason,
    transition: { from: state, to: state, eventType, occurredAt },
  }
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
      firestorePayload({
        jobOpportunity: toPublicJobOpportunity(approved.opportunity),
        enrichmentVersion: approved.enrichmentVersion,
        enrichmentApprovedAt: input.approvedAt,
        updatedAt: input.approvedAt,
      }),
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

export async function writeEvalArtifact(
  db: Firestore,
  rawArtifact: EvalArtifact
): Promise<{ artifact: EvalArtifact; created: boolean }> {
  const artifact = EvalArtifactSchema.parse(rawArtifact)
  const result = await writeAppendOnlyDoc(
    db,
    PA_COLLECTIONS.evalArtifacts,
    artifact.artifactId,
    artifact
  )
  if (result.created) {
    await db.collection(AUDIT_COLLECTION).doc(auditId("marketplace_eval_artifact", artifact.artifactId)).set({
      id: auditId("marketplace_eval_artifact", artifact.artifactId),
      action: "marketplace.eval_artifact.write",
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      status: artifact.status,
      candidateId: artifact.candidateId ?? null,
      jobId: artifact.jobId ?? null,
      createdBy: artifact.createdBy,
      createdAt: artifact.createdAt,
    })
  }
  return { artifact: result.event, created: result.created }
}

export type WriteEvalArtifactForCorrectionInput = {
  correction: CorrectionEvent
  artifactKind?: EvalArtifact["kind"]
  status?: EvalArtifact["status"]
  payloadRedacted?: Record<string, unknown>
  latestRunResult?: EvalArtifact["latestRunResult"]
  evidence?: MarketplaceEvidence[]
  scenarioRef?: string
  runRef?: string
  createdAt?: string
  updatedAt?: string
}

export async function writeEvalArtifactForCorrection(
  db: Firestore,
  input: WriteEvalArtifactForCorrectionInput
): Promise<{
  correction: CorrectionEvent
  correctionCreated: boolean
  artifact: EvalArtifact
  artifactCreated: boolean
}> {
  const correction = CorrectionEventSchema.parse(input.correction)
  const kind = input.artifactKind ?? "correction_regression_fixture"
  const artifact = EvalArtifactSchema.parse({
    artifactId: createEvalArtifactId(kind, correction.eventId),
    kind,
    status: input.status ?? "ready",
    sourceCorrectionEventIds: [correction.eventId],
    scenarioRef: input.scenarioRef,
    runRef: input.runRef,
    candidateId: correction.candidateId,
    jobId: correction.jobId,
    payloadRedacted: input.payloadRedacted ?? {
      targetType: correction.targetType,
      targetId: correction.targetId,
      beforeRedacted: correction.beforeRedacted,
      afterRedacted: correction.afterRedacted,
      reason: correction.reason,
    },
    latestRunResult: input.latestRunResult,
    evidence: input.evidence ?? correction.evidence,
    createdBy: correction.actor,
    createdAt: input.createdAt ?? correction.createdAt,
    updatedAt: input.updatedAt,
  })

  const correctionWrite = await writeCorrectionEvent(db, correction)
  const artifactWrite = await writeEvalArtifact(db, artifact)
  return {
    correction: correctionWrite.event,
    correctionCreated: correctionWrite.created,
    artifact: artifactWrite.artifact,
    artifactCreated: artifactWrite.created,
  }
}

export async function writePrivacyRequest(
  db: Firestore,
  rawRequest: PrivacyRequest
): Promise<{ request: PrivacyRequest; created: boolean; existingOpen: boolean }> {
  const request = PrivacyRequestSchema.parse(rawRequest)
  const existingOpen = await db
    .collection(PA_COLLECTIONS.privacyRequests)
    .where("candidateId", "==", request.candidateId)
    .where("kind", "==", request.kind)
    .where("status", "in", ["submitted", "in_review"])
    .limit(1)
    .get()

  if (!existingOpen.empty) {
    return {
      request: PrivacyRequestSchema.parse(existingOpen.docs[0]!.data()),
      created: false,
      existingOpen: true,
    }
  }

  const result = await writeAppendOnlyRefDoc(
    db.collection(PA_COLLECTIONS.privacyRequests).doc(request.requestId),
    PA_COLLECTIONS.privacyRequests,
    request.requestId,
    request
  )
  if (result.created) {
    await db.collection(AUDIT_COLLECTION).doc(auditId("marketplace_privacy_request", request.requestId)).set({
      id: auditId("marketplace_privacy_request", request.requestId),
      action: "marketplace.privacy_request.create",
      requestId: request.requestId,
      kind: request.kind,
      status: request.status,
      candidateId: request.candidateId,
      sourceSurface: request.sourceSurface,
      requestedBy: request.requestedBy,
      createdAt: request.createdAt,
    })
  }
  return { request: result.event, created: result.created, existingOpen: false }
}

export async function writeLaunchReadinessSnapshot(
  db: Firestore,
  rawSnapshot: LaunchReadinessSnapshot
): Promise<{ snapshot: LaunchReadinessSnapshot; created: boolean }> {
  const snapshot = LaunchReadinessSnapshotSchema.parse(rawSnapshot)
  const result = await writeAppendOnlyRefDoc(
    db.collection(PA_COLLECTIONS.launchReadinessSnapshots).doc(snapshot.snapshotId),
    PA_COLLECTIONS.launchReadinessSnapshots,
    snapshot.snapshotId,
    snapshot
  )
  return { snapshot: result.event, created: result.created }
}

export type WriteOutreachStopControlInput = {
  scope: OutreachStopControlScope
  scopeId?: string
  paused: boolean
  reason?: string
  actor: MarketplaceActor
  now: string
  expiresAt?: string
}

export async function writeOutreachStopControl(
  db: Firestore,
  input: WriteOutreachStopControlInput
): Promise<{
  control: OutreachStopControl
  previous: OutreachStopControl | null
  changed: boolean
  auditEventId: string
}> {
  const controlId = createOutreachStopControlId({ scope: input.scope, scopeId: input.scopeId })
  const ref = db.collection(PA_COLLECTIONS.outreachStopControls).doc(controlId)
  const auditRef = db
    .collection(AUDIT_COLLECTION)
    .doc(auditId("marketplace_outreach_stop_control", `${controlId}_${input.now}`))

  return await db.runTransaction(async (tx) => {
    const currentSnap = await tx.get(ref)
    const previous = currentSnap.exists ? OutreachStopControlSchema.parse(currentSnap.data()) : null
    const control = OutreachStopControlSchema.parse({
      controlId,
      scope: input.scope,
      scopeId: input.scopeId,
      paused: input.paused,
      reason: input.reason,
      actor: input.actor,
      createdAt: previous?.createdAt ?? input.now,
      updatedAt: input.now,
      expiresAt: input.expiresAt,
    })
    const changed = !previous || stableJson(previous) !== stableJson(control)
    tx.set(ref, firestorePayload(control as Record<string, unknown>), { merge: false })
    tx.set(auditRef, {
      id: auditRef.id,
      action: "marketplace.outreach_stop_control.write",
      controlId,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      paused: control.paused,
      changed,
      actor: input.actor,
      createdAt: input.now,
    })
    return {
      control,
      previous,
      changed,
      auditEventId: auditRef.id,
    }
  })
}

export async function readOutreachStopControl(
  db: Firestore,
  input: { scope: OutreachStopControlScope; scopeId?: string }
): Promise<OutreachStopControl> {
  const controlId = createOutreachStopControlId(input)
  const snap = await db.collection(PA_COLLECTIONS.outreachStopControls).doc(controlId).get()
  if (!snap.exists) {
    return OutreachStopControlSchema.parse({
      controlId,
      scope: input.scope,
      scopeId: input.scopeId,
      paused: false,
      actor: "system",
      createdAt: "1970-01-01T00:00:00.000Z",
    })
  }
  return OutreachStopControlSchema.parse(snap.data())
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

export type ApplyPassedCandidateSnapshotInput = {
  eventId: string
  candidateId: string
  jobId: string
  prescreenSessionId: string
  occurredAt: string
  actor: MarketplaceActor
  evidence?: MarketplaceEvidence[]
  snapshot: EmployerVisibleProfile
}

export type ApplyPassedCandidateSnapshotResult = {
  snapshot: EmployerVisibleProfile
  snapshotCreated: boolean
  state: CandidateJobState
  stateDocId: string
  idempotent: boolean
  auditEventIds: string[]
}

export async function applyPassedCandidateSnapshot(
  db: Firestore,
  input: ApplyPassedCandidateSnapshotInput
): Promise<ApplyPassedCandidateSnapshotResult> {
  const passedEvent = CandidateJobEventSchema.parse({
    eventId: input.eventId,
    type: "prescreen_passed",
    candidateId: input.candidateId,
    jobId: input.jobId,
    actor: input.actor,
    occurredAt: input.occurredAt,
    evidence: input.evidence ?? [{ source: "prescreen", summary: "Candidate passed first interview" }],
    prescreenSessionId: input.prescreenSessionId,
  })
  const snapshot = EmployerVisibleProfileSchema.parse(input.snapshot)
  const stateDocId = createCandidateJobStateId(input.candidateId, input.jobId)
  const expectedSnapshotId = createEmployerVisibleProfileId(input.jobId, input.candidateId)
  if (snapshot.snapshotId !== expectedSnapshotId) {
    throw new Error(`invalid_employer_visible_snapshot_id:${snapshot.snapshotId}`)
  }
  if (
    snapshot.candidateId !== input.candidateId ||
    snapshot.jobId !== input.jobId ||
    snapshot.candidateJobStateId !== stateDocId
  ) {
    throw new Error("employer_visible_candidate_job_link_mismatch")
  }
  if (
    snapshot.sourcePrescreenSessionId &&
    snapshot.sourcePrescreenSessionId !== input.prescreenSessionId
  ) {
    throw new Error("employer_visible_prescreen_session_mismatch")
  }

  const employerEvent: CandidateJobEvent = CandidateJobEventSchema.parse({
    eventId: `employer-visible-${snapshot.snapshotId}`,
    type: "employer_snapshot_created",
    candidateId: input.candidateId,
    jobId: input.jobId,
    actor: input.actor,
    occurredAt: input.occurredAt,
    evidence: [{ source: "prescreen", summary: "Passed profile snapshot created", refId: snapshot.snapshotId }],
    prescreenSessionId: input.prescreenSessionId,
    employerVisibleProfileId: snapshot.snapshotId,
  })

  const stateRef = db.collection(PA_COLLECTIONS.candidateJobStates).doc(stateDocId)
  const snapshotRef = db.collection(PA_COLLECTIONS.employerVisibleProfiles).doc(snapshot.snapshotId)
  const passAuditRef = db.collection(AUDIT_COLLECTION).doc(auditId("marketplace_candidate_job", passedEvent.eventId))
  const employerAuditRef = db.collection(AUDIT_COLLECTION).doc(auditId("marketplace_candidate_job", employerEvent.eventId))
  const snapshotAuditRef = db.collection(AUDIT_COLLECTION).doc(auditId("marketplace_employer_visible", snapshot.snapshotId))

  return await db.runTransaction(async (tx) => {
    const stateSnap = await tx.get(stateRef)
    const snapshotSnap = await tx.get(snapshotRef)
    const passAuditSnap = await tx.get(passAuditRef)
    const employerAuditSnap = await tx.get(employerAuditRef)
    const snapshotAuditSnap = await tx.get(snapshotAuditRef)
    const currentDoc = stateSnap.exists
      ? CandidateJobStateDocSchema.parse(stateSnap.data())
      : null
    const currentState = currentDoc?.state ?? "candidate_matched"

    if (snapshotSnap.exists) {
      const existingSnapshot = EmployerVisibleProfileSchema.parse(snapshotSnap.data())
      if (stableJson(pruneUndefined(existingSnapshot)) !== stableJson(pruneUndefined(snapshot))) {
        throw new Error(`conflicting_duplicate_event:${PA_COLLECTIONS.employerVisibleProfiles}/${snapshot.snapshotId}`)
      }
      if (
        passAuditSnap.exists ||
        employerAuditSnap.exists ||
        currentState === "employer_visible"
      ) {
        return {
          snapshot: existingSnapshot,
          snapshotCreated: false,
          state: currentState,
          stateDocId,
          idempotent: true,
          auditEventIds: [passAuditRef.id, employerAuditRef.id, snapshotAuditRef.id],
        }
      }
    }

    const passReduced = reduceCandidateJobState(currentState, passedEvent)
    if (passReduced.state !== "passed") {
      throw new Error(`candidate_job_not_passable:${passReduced.reason}`)
    }
    const visibleReduced = reduceCandidateJobState(passReduced.state, employerEvent)
    if (visibleReduced.state !== "employer_visible") {
      throw new Error(`candidate_job_not_employer_visible:${visibleReduced.reason}`)
    }

    const nextDoc: CandidateJobStateDoc = CandidateJobStateDocSchema.parse({
      ...(currentDoc ?? {}),
      id: stateDocId,
      candidateId: input.candidateId,
      jobId: input.jobId,
      state: visibleReduced.state,
      previousState: passReduced.state,
      stateUpdatedAt: input.occurredAt,
      reason: visibleReduced.reason,
      prescreenSessionId: input.prescreenSessionId,
      employerVisibleProfileId: snapshot.snapshotId,
      outboundInviteId: currentDoc?.outboundInviteId,
      outboundId: currentDoc?.outboundId,
      latestMatchId: currentDoc?.latestMatchId,
      archivedAt: currentDoc?.archivedAt,
    })

    tx.set(stateRef, firestorePayload(nextDoc as Record<string, unknown>), { merge: true })
    tx.set(snapshotRef, firestorePayload(snapshot as Record<string, unknown>))
    if (!passAuditSnap.exists) {
      tx.set(passAuditRef, firestorePayload({
        id: passAuditRef.id,
        action: "marketplace.candidate_job.transition",
        candidateId: input.candidateId,
        jobId: input.jobId,
        eventId: passedEvent.eventId,
        eventType: passedEvent.type,
        from: passReduced.transition.from,
        to: passReduced.transition.to,
        changed: passReduced.changed,
        reason: passReduced.reason,
        actor: passedEvent.actor,
        createdAt: passedEvent.occurredAt,
      }))
    }
    if (!employerAuditSnap.exists) {
      tx.set(employerAuditRef, firestorePayload({
        id: employerAuditRef.id,
        action: "marketplace.candidate_job.transition",
        candidateId: input.candidateId,
        jobId: input.jobId,
        eventId: employerEvent.eventId,
        eventType: employerEvent.type,
        from: visibleReduced.transition.from,
        to: visibleReduced.transition.to,
        changed: visibleReduced.changed,
        reason: visibleReduced.reason,
        actor: employerEvent.actor,
        createdAt: employerEvent.occurredAt,
      }))
    }
    if (!snapshotAuditSnap.exists) {
      tx.set(snapshotAuditRef, firestorePayload({
        id: snapshotAuditRef.id,
        action: "marketplace.employer_visible.create",
        snapshotId: snapshot.snapshotId,
        candidateId: snapshot.candidateId,
        jobId: snapshot.jobId,
        actor: snapshot.createdBy,
        createdAt: snapshot.createdAt,
      }))
    }

    return {
      snapshot,
      snapshotCreated: !snapshotSnap.exists,
      state: visibleReduced.state,
      stateDocId,
      idempotent: false,
      auditEventIds: [passAuditRef.id, employerAuditRef.id, snapshotAuditRef.id],
    }
  })
}
