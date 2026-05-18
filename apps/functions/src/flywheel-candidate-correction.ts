import { createHash } from "node:crypto"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { z } from "zod"
import {
  CandidateSelfProfileSchema,
  CorrectionEventSchema,
  PA_COLLECTIONS,
  type CandidateSelfProfile,
  type CorrectionEvent,
} from "@pa/core-types"
import { writeEvalArtifactForCorrection } from "@pa/pa-persistence"
import { materializeEvalArtifactForCorrection, sanitizeEvalPayload } from "./flywheel-eval.js"

export { materializeEvalArtifactForCorrection } from "./flywheel-eval.js"

type CallableAuth = {
  uid?: string
}

const CandidateCorrectionInputSchema = z.object({
  correctionText: z.string().trim().min(1).max(2_000),
  sourceSurface: z.literal("me_profile").default("me_profile"),
  targetType: z.enum(["candidate_profile", "user_tags", "candidate_job_state", "candidate_job_match"]).default("candidate_profile"),
  targetId: z.string().trim().min(1).max(200).optional(),
  jobId: z.string().trim().min(1).max(200).optional(),
  structuredFields: z.record(z.unknown()).default({}),
  before: z.record(z.unknown()).default({}),
  after: z.record(z.unknown()).default({}),
})
export type CandidateCorrectionInput = z.input<typeof CandidateCorrectionInputSchema>

export type CandidateFlywheelCorrectionResult = {
  ok: true
  candidateId: string
  selfProfile: CandidateSelfProfile
  appliedKeys: string[]
  correctionEventId: string
  artifactId: string
  correctionCreated: boolean
  artifactCreated: boolean
}

export type CandidateFlywheelCorrectionDeps = {
  db: Firestore
  now?: () => string
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20)
}

function safeStructuredRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeEvalPayload(value)
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {}
}

function safeCorrectionReason(correctionText: string): string {
  const sanitized = sanitizeEvalPayload(correctionText)
  return typeof sanitized === "string" ? sanitized : "candidate_submitted_profile_correction"
}

async function getCandidateIdForAuth(db: Firestore, firebaseUid: string): Promise<string> {
  const snap = await db.collection(PA_COLLECTIONS.candidateAuth).doc(firebaseUid).get()
  if (!snap.exists) {
    throw new HttpsError("failed-precondition", "Signed-in account is not linked to a candidate profile.")
  }
  const candidateId = cleanString(snap.data()?.candidateId, 200)
  if (!candidateId) {
    throw new HttpsError("failed-precondition", "Signed-in account is not linked to a candidate profile.")
  }
  return candidateId
}

async function getCandidateSelfProfile(db: Firestore, candidateId: string): Promise<CandidateSelfProfile> {
  const snap = await db.collection(PA_COLLECTIONS.candidateSelfProfiles).doc(candidateId).get()
  if (!snap.exists) {
    throw new HttpsError("failed-precondition", "Candidate profile projection is not ready.")
  }
  return CandidateSelfProfileSchema.parse(snap.data())
}

function mergeStructuredAfter(parsed: z.infer<typeof CandidateCorrectionInputSchema>): Record<string, unknown> {
  return safeStructuredRecord({
    ...parsed.structuredFields,
    ...parsed.after,
  })
}

function buildCandidateCorrectionEvent(input: {
  parsed: z.infer<typeof CandidateCorrectionInputSchema>
  candidateId: string
  createdAt: string
}): CorrectionEvent {
  const targetId = input.parsed.targetId ?? input.candidateId
  const afterRedacted = mergeStructuredAfter(input.parsed)
  return CorrectionEventSchema.parse({
    eventId: `candidate_correction_${input.candidateId}_${stableHash({
      targetType: input.parsed.targetType,
      targetId,
      jobId: input.parsed.jobId,
      correctionText: input.parsed.correctionText,
      structuredFields: afterRedacted,
      createdAt: input.createdAt,
    })}`,
    targetType: input.parsed.targetType,
    targetId,
    actor: "candidate",
    candidateId: input.candidateId,
    jobId: input.parsed.jobId,
    reason: safeCorrectionReason(input.parsed.correctionText),
    beforeRedacted: safeStructuredRecord(input.parsed.before),
    afterRedacted,
    evidence: [{ source: "conversation", summary: "Candidate-submitted profile correction" }],
    createdAt: input.createdAt,
  })
}

export async function runCandidateFlywheelCorrection(
  data: unknown,
  auth: CallableAuth | undefined,
  deps: CandidateFlywheelCorrectionDeps,
): Promise<CandidateFlywheelCorrectionResult> {
  const firebaseUid = cleanString(auth?.uid, 128)
  if (!firebaseUid) {
    throw new HttpsError("unauthenticated", "Sign in before submitting profile corrections.")
  }

  const parsed = CandidateCorrectionInputSchema.safeParse(data)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }

  const candidateId = await getCandidateIdForAuth(deps.db, firebaseUid)
  const createdAt = deps.now?.() ?? new Date().toISOString()
  const correction = buildCandidateCorrectionEvent({
    parsed: parsed.data,
    candidateId,
    createdAt,
  })
  const artifact = materializeEvalArtifactForCorrection({
    correction,
    kind: "candidate_profile_correction",
    createdAt,
  })
  const result = await writeEvalArtifactForCorrection(deps.db, {
    correction,
    artifactKind: artifact.kind,
    status: artifact.status,
    payloadRedacted: artifact.payloadRedacted,
    evidence: artifact.evidence,
    createdAt: artifact.createdAt,
  })
  const selfProfile = await getCandidateSelfProfile(deps.db, candidateId)

  return {
    ok: true,
    candidateId,
    selfProfile,
    appliedKeys: Object.keys(correction.afterRedacted).sort(),
    correctionEventId: result.correction.eventId,
    artifactId: result.artifact.artifactId,
    correctionCreated: result.correctionCreated,
    artifactCreated: result.artifactCreated,
  }
}

export const paCandidateProfileCorrection = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 30, maxInstances: 1 },
  async (req): Promise<CandidateFlywheelCorrectionResult> => {
    return runCandidateFlywheelCorrection(req.data, req.auth, { db: getFirestore() })
  },
)
