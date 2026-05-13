import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  createCandidateJobMatchId,
  createCandidateJobStateId,
  createEmployerVisibleProfileId,
  type CandidateJobEvent,
  type EmployerVisibleProfile,
  type MarketplaceEvidence,
} from "@pa/core-types"
import {
  applyCandidateJobEvent,
  applyPassedCandidateSnapshot,
} from "@pa/pa-persistence"
import type { PrescreenTerminalKind } from "./prescreen-terminal-action.js"

const PRESCREEN_SESSIONS = "pa-prescreen-sessions"

export type PrescreenOutcomeTerminal = PrescreenTerminalKind

export type MarkFirstInterviewStartedArgs = {
  db: Firestore
  sessionId: string
  userId: string
  jobId: string
  occurredAt: string
}

export type MarkPrescreenTerminalOutcomeArgs = MarkFirstInterviewStartedArgs & {
  terminal: PrescreenOutcomeTerminal
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

function cleanStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const cleaned = cleanString(item, maxLength)
    if (cleaned) out.push(cleaned)
    if (out.length >= maxItems) break
  }
  return out
}

function redactRawContact(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]")
    .replace(/(?:\+?\d[\s().-]*){9,}/g, "[redacted phone]")
    .replace(/https?:\/\/[^\s]*(?:linkedin\.com|firebasestorage\.googleapis\.com|storage\.googleapis\.com)[^\s]*/gi, "[redacted link]")
    .replace(/gs:\/\/\S+/gi, "[redacted storage]")
}

function readNestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function consentAtFromUser(user: Record<string, unknown>): string | undefined {
  const direct = cleanString(user.piiConsentAt, 80)
  if (direct) return direct
  const contactPII = readNestedRecord(user.contactPII)
  return cleanString(contactPII.consentedAt, 80)
}

function summarizeSession(session: Record<string, unknown>, terminal: PrescreenOutcomeTerminal): string {
  const terminalReason = cleanString(session.terminalReason, 1_000)
  const score = typeof session.score === "number" ? session.score : undefined
  const scoreMax = typeof session.scoreMax === "number" ? session.scoreMax : undefined
  const scoreText =
    score !== undefined && scoreMax !== undefined && scoreMax > 0
      ? ` Score ${score.toFixed(2)}/${scoreMax.toFixed(2)}.`
      : ""
  return redactRawContact(
    terminalReason
      ? `${terminal}: ${terminalReason}.${scoreText}`
      : `${terminal}: first interview reached a terminal outcome.${scoreText}`
  ).slice(0, 2_000)
}

async function readDoc(db: Firestore, collectionName: string, id: string): Promise<Record<string, unknown>> {
  const snap = await db.collection(collectionName).doc(id).get()
  return snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : {}
}

export function buildPrescreenStartedEvent(args: MarkFirstInterviewStartedArgs): CandidateJobEvent {
  return {
    eventId: `prescreen-started-${args.sessionId}`,
    type: "prescreen_started",
    candidateId: args.userId,
    jobId: args.jobId,
    actor: "orchestrator",
    occurredAt: args.occurredAt,
    evidence: [{ source: "prescreen", summary: "First interview started", refId: args.sessionId }],
    prescreenSessionId: args.sessionId,
  }
}

export function buildPrescreenTerminalEvent(args: MarkPrescreenTerminalOutcomeArgs): CandidateJobEvent {
  const eventType =
    args.terminal === "PASS"
      ? "prescreen_passed"
      : args.terminal === "PAUSE"
        ? "manual_pause"
        : "prescreen_not_passed"
  return {
    eventId: `prescreen-terminal-${args.sessionId}-${args.terminal.toLowerCase()}`,
    type: eventType,
    candidateId: args.userId,
    jobId: args.jobId,
    actor: "orchestrator",
    occurredAt: args.occurredAt,
    evidence: [{ source: "prescreen", summary: `First interview terminal: ${args.terminal}`, refId: args.sessionId }],
    prescreenSessionId: args.sessionId,
  } as CandidateJobEvent
}

export async function markFirstInterviewStarted(args: MarkFirstInterviewStartedArgs) {
  return applyCandidateJobEvent(args.db, buildPrescreenStartedEvent(args))
}

async function buildEmployerVisibleSnapshot(
  args: MarkPrescreenTerminalOutcomeArgs
): Promise<{ snapshot: EmployerVisibleProfile; evidence: MarketplaceEvidence[] }> {
  const stateId = createCandidateJobStateId(args.userId, args.jobId)
  const [session, stateDoc, user, selfProfile] = await Promise.all([
    readDoc(args.db, PRESCREEN_SESSIONS, args.sessionId),
    readDoc(args.db, PA_COLLECTIONS.candidateJobStates, stateId),
    readDoc(args.db, PA_COLLECTIONS.users, args.userId),
    readDoc(args.db, PA_COLLECTIONS.candidateSelfProfiles, args.userId),
  ])
  const latestMatchId =
    cleanString(stateDoc.latestMatchId, 240) ?? createCandidateJobMatchId(args.userId, args.jobId)
  const match = await readDoc(args.db, PA_COLLECTIONS.candidateJobMatches, latestMatchId)
  const consentAt = consentAtFromUser(user)
  const displayName = consentAt
    ? cleanString(selfProfile.displayName, 200) ?? cleanString(user.displayName, 200)
    : undefined
  const profileSummary =
    cleanString(selfProfile.profileSummary, 4_000) ??
    cleanString(user.profileSummary, 4_000)
  const resumeSummary =
    cleanString(selfProfile.resumeSummary, 4_000) ??
    cleanString(user.resumeSummary, 4_000) ??
    cleanString(user.candidateProfileSummary, 4_000)
  const matchReasons = cleanStringArray(match.reasons, 3, 400)
  const matchReason =
    matchReasons.length > 0
      ? matchReasons.join("; ")
      : cleanString(match.reason, 2_000) ?? cleanString(match.summary, 2_000)
  const latestResumeArtifactId =
    cleanString(selfProfile.latestResumeArtifactId, 240) ??
    cleanString(user.latestResumeArtifactId, 240)

  const snapshot: EmployerVisibleProfile = {
    snapshotId: createEmployerVisibleProfileId(args.jobId, args.userId),
    candidateId: args.userId,
    jobId: args.jobId,
    candidateJobStateId: stateId,
    createdFromState: "passed",
    sourcePrescreenSessionId: args.sessionId,
    ...(latestMatchId ? { sourceMatchId: latestMatchId } : {}),
    ...(latestResumeArtifactId ? { sourceResumeArtifactId: latestResumeArtifactId } : {}),
    ...(displayName ? { displayName: redactRawContact(displayName).slice(0, 200) } : {}),
    ...(profileSummary ? { profileSummary: redactRawContact(profileSummary).slice(0, 4_000) } : {}),
    ...(resumeSummary ? { resumeSummary: redactRawContact(resumeSummary).slice(0, 4_000) } : {}),
    ...(selfProfile.globalTags && typeof selfProfile.globalTags === "object" ? { tagsSnapshot: selfProfile.globalTags as never } : {}),
    transcriptSummary: summarizeSession(session, args.terminal),
    passReason: summarizeSession(session, args.terminal),
    ...(matchReason ? { matchReason: redactRawContact(matchReason).slice(0, 2_000) } : {}),
    ...(consentAt ? { consentAt, piiConsentAt: consentAt } : {}),
    createdAt: args.occurredAt,
    createdBy: "system",
  }

  return {
    snapshot,
    evidence: [{ source: "prescreen", summary: "Candidate passed first interview", refId: args.sessionId }],
  }
}

export async function markPrescreenTerminalOutcome(args: MarkPrescreenTerminalOutcomeArgs) {
  if (args.terminal === "PASS") {
    const { snapshot, evidence } = await buildEmployerVisibleSnapshot(args)
    return applyPassedCandidateSnapshot(args.db, {
      eventId: `prescreen-terminal-${args.sessionId}-pass`,
      candidateId: args.userId,
      jobId: args.jobId,
      prescreenSessionId: args.sessionId,
      occurredAt: args.occurredAt,
      actor: "orchestrator",
      evidence,
      snapshot,
    })
  }
  return applyCandidateJobEvent(args.db, buildPrescreenTerminalEvent(args))
}
