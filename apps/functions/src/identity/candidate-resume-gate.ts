import { onCall, HttpsError } from "firebase-functions/v2/https"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { claimCandidateProfile as defaultClaimCandidateProfile } from "@pa/pa-persistence"

type CallableAuth = {
  uid?: string
  token?: Record<string, unknown>
}

type ResumeArtifactGateView = {
  resumeId: string
  status?: string
  parsedCandidateResumeId?: string
} | null

type ParsedResumeGateView = {
  id: string
  data: Record<string, unknown>
} | null

export type CandidateResumeGateStatus =
  | "needs_resume_upload"
  | "resume_processing"
  | "ready"

export interface CandidateResumeGateInput {
  browserUid?: string | null
}

export interface CandidateResumeGateResult {
  ok: true
  candidateId: string
  status: CandidateResumeGateStatus
  hasResume: boolean
  labelsReady: boolean
  resumeArtifactId?: string
  parsedResumeId?: string
}

export interface CandidateResumeGateDeps {
  db: Firestore
  claimCandidateProfile?: typeof defaultClaimCandidateProfile
  loadCandidateAuthMapping?: (db: Firestore, firebaseUid: string) => Promise<{ candidateId: string } | null>
  loadCandidateUser?: (db: Firestore, candidateId: string) => Promise<Record<string, unknown> | null>
  loadCandidateSelfProfile?: (db: Firestore, candidateId: string) => Promise<Record<string, unknown> | null>
  loadLatestResumeArtifact?: (
    db: Firestore,
    candidateId: string,
    user: Record<string, unknown> | null,
    selfProfile: Record<string, unknown> | null
  ) => Promise<ResumeArtifactGateView>
  loadLatestParsedResume?: (db: Firestore, candidateId: string) => Promise<ParsedResumeGateView>
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

function authEmail(auth: CallableAuth | undefined): string | undefined {
  return (
    cleanString(auth?.token?.email, 320) ??
    cleanString(auth?.token?.linkedinEmail, 320)
  )?.toLowerCase()
}

function authDisplayName(auth: CallableAuth | undefined): string | null {
  return (
    cleanString(auth?.token?.name, 200) ??
    cleanString(auth?.token?.linkedinName, 200) ??
    null
  )
}

function requestBrowserUid(data: unknown): string | null {
  const input = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  return cleanString(input.browserUid, 128) ?? null
}

async function defaultLoadCandidateUser(
  db: Firestore,
  candidateId: string
): Promise<Record<string, unknown> | null> {
  const snap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  return snap.exists ? (snap.data() ?? null) : null
}

async function defaultLoadCandidateAuthMapping(
  db: Firestore,
  firebaseUid: string
): Promise<{ candidateId: string } | null> {
  const snap = await db.collection(PA_COLLECTIONS.candidateAuth).doc(firebaseUid).get()
  if (!snap.exists) return null
  const candidateId = cleanString(snap.data()?.candidateId, 160)
  return candidateId ? { candidateId } : null
}

async function defaultLoadCandidateSelfProfile(
  db: Firestore,
  candidateId: string
): Promise<Record<string, unknown> | null> {
  const snap = await db.collection(PA_COLLECTIONS.candidateSelfProfiles).doc(candidateId).get()
  return snap.exists ? (snap.data() ?? null) : null
}

async function defaultLoadLatestResumeArtifact(
  db: Firestore,
  candidateId: string,
  user: Record<string, unknown> | null,
  selfProfile: Record<string, unknown> | null
): Promise<ResumeArtifactGateView> {
  const latestId =
    cleanString(user?.latestResumeArtifactId, 160) ??
    cleanString(selfProfile?.latestResumeArtifactId, 160)
  if (latestId) {
    const snap = await db.collection(PA_COLLECTIONS.resumeArtifacts).doc(latestId).get()
    if (snap.exists) {
      const data = snap.data() ?? {}
      return {
        resumeId: latestId,
        status: cleanString(data.status, 40),
        parsedCandidateResumeId: cleanString(data.parsedCandidateResumeId, 160),
      }
    }
  }

  const snap = await db
    .collection(PA_COLLECTIONS.resumeArtifacts)
    .where("candidateId", "==", candidateId)
    .limit(1)
    .get()
  const first = snap.docs[0]
  if (!first) return null
  const data = first.data() ?? {}
  return {
    resumeId: cleanString(data.resumeId, 160) ?? first.id,
    status: cleanString(data.status, 40),
    parsedCandidateResumeId: cleanString(data.parsedCandidateResumeId, 160),
  }
}

async function defaultLoadLatestParsedResume(
  db: Firestore,
  candidateId: string
): Promise<ParsedResumeGateView> {
  const snap = await db
    .collection("parsedCandidateResumes")
    .where("userId", "==", candidateId)
    .limit(1)
    .get()
  const first = snap.docs[0]
  if (!first) return null
  return { id: first.id, data: first.data() ?? {} }
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

function hasParsedLabelSignals(parsed: ParsedResumeGateView): boolean {
  if (!parsed) return false
  const data = parsed.data
  if (
    nonEmptyArray(data.topSkills) ||
    nonEmptyArray(data.industryTags) ||
    nonEmptyArray(data.relevantIndustry) ||
    nonEmptyArray(data.relevantSpecialization) ||
    nonEmptyArray(data.proposedTags) ||
    nonEmptyArray(data.industries) ||
    nonEmptyArray(data.workHistory)
  ) {
    return true
  }
  const profile = data.candidateProfile
  if (profile && typeof profile === "object") {
    return nonEmptyArray((profile as Record<string, unknown>).skills)
  }
  return false
}

function isUsableArtifact(artifact: ResumeArtifactGateView): boolean {
  if (!artifact) return false
  return artifact.status !== "failed" && artifact.status !== "archived"
}

export async function runCandidateResumeGateStatus(
  data: unknown,
  auth: CallableAuth | undefined,
  deps: CandidateResumeGateDeps
): Promise<CandidateResumeGateResult> {
  const firebaseUid = cleanString(auth?.uid, 128)
  if (!firebaseUid) {
    throw new HttpsError("unauthenticated", "Sign in before starting this screen.")
  }

  const email = authEmail(auth)
  if (!email || !email.includes("@")) {
    throw new HttpsError("failed-precondition", "Signed-in account has no verified email.")
  }
  if (auth?.token?.email_verified === false) {
    throw new HttpsError("failed-precondition", "Signed-in email is not verified.")
  }

  const existingAuth = await (deps.loadCandidateAuthMapping ?? defaultLoadCandidateAuthMapping)(
    deps.db,
    firebaseUid
  )
  const candidateId = existingAuth?.candidateId ?? (
    await (deps.claimCandidateProfile ?? defaultClaimCandidateProfile)(deps.db, {
      firebaseUid,
      email,
      browserUid: requestBrowserUid(data),
      displayName: authDisplayName(auth),
    })
  ).candidateId
  const [user, selfProfile] = await Promise.all([
    (deps.loadCandidateUser ?? defaultLoadCandidateUser)(deps.db, candidateId),
    (deps.loadCandidateSelfProfile ?? defaultLoadCandidateSelfProfile)(deps.db, candidateId),
  ])
  const [artifact, parsed] = await Promise.all([
    (deps.loadLatestResumeArtifact ?? defaultLoadLatestResumeArtifact)(
      deps.db,
      candidateId,
      user,
      selfProfile
    ),
    (deps.loadLatestParsedResume ?? defaultLoadLatestParsedResume)(deps.db, candidateId),
  ])

  const hasResume = Boolean(parsed || isUsableArtifact(artifact))
  const labelsReady = hasParsedLabelSignals(parsed)
  const status: CandidateResumeGateStatus = !hasResume
    ? "needs_resume_upload"
    : labelsReady
      ? "ready"
      : "resume_processing"

  return {
    ok: true,
    candidateId,
    status,
    hasResume,
    labelsReady,
    ...(artifact?.resumeId ? { resumeArtifactId: artifact.resumeId } : {}),
    ...(parsed?.id ? { parsedResumeId: parsed.id } : {}),
  }
}

export const paCandidateResumeGateStatus = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 30,
  },
  async (req): Promise<CandidateResumeGateResult> => {
    return runCandidateResumeGateStatus(req.data, req.auth, {
      db: getFirestore(),
    })
  }
)
