import { getFirestore, type Firestore, type Query } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { z } from "zod"
import {
  CandidateJobStateDocSchema,
  EmployerVisibleProfileSchema,
  PA_COLLECTIONS,
  type EmployerVisibleProfile,
} from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

export const AdminPassedCandidatesSnapshotInputSchema = z.object({
  jobId: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
  limit: z.number().int().optional().default(50).transform((value) => Math.max(1, Math.min(100, value))),
  adminToken: z.string().optional(),
})
export type AdminPassedCandidatesSnapshotInput = z.infer<typeof AdminPassedCandidatesSnapshotInputSchema>

export type PassedCandidateTranscriptTurn = {
  id: string
  role: "user" | "assistant" | "system"
  body: string
  qId?: string
  actionKind?: string
  scoreSummary?: string
  createdAt?: string
}

export type PassedCandidateRow = {
  id: string
  snapshotId: string
  candidateId: string
  jobId: string
  candidateJobStateId: string
  state: "passed" | "employer_visible"
  displayName: string
  resumeSummary?: string
  level1Snapshot?: Record<string, unknown>
  passReason?: string
  matchReason?: string
  createdAt: string
  profile: {
    piiConsentAt?: string
    consentStatus: "granted" | "missing"
    level1Status?: string
    level1CompletedAt?: string
    onboardingStatus?: string
    candidateLifecycleState?: string
  }
  transcript: {
    prescreenSessionId?: string
    turns: PassedCandidateTranscriptTurn[]
  }
}

export type PassedCandidatesSnapshot = {
  generatedAt: string
  filters: {
    jobId: string
    limit: number
  }
  summary: {
    totalPassedSnapshots: number
    withConsent: number
    missingConsent: number
    withTranscript: number
    droppedInvalidSnapshot: number
    droppedStateMismatch: number
  }
  rows: PassedCandidateRow[]
}

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const PHONE_RE = /(?:\+\d[\d\s().-]{7,}\d|\b(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b)/g
const RESUME_RE = /\b(?:https?:\/\/\S*(?:resume|cv)[^\s]*|gs:\/\/\S+|(?:resume|cv)[\w ._-]*\.(?:pdf|docx?|txt))\b/gi
const STORAGE_RE = /\b(?:https?:\/\/\S*(?:storage\.googleapis\.com|firebasestorage\.googleapis\.com|storage\.cloud\.google\.com)\S*)\b/gi
const LINKEDIN_RE = /\bhttps?:\/\/(?:www\.)?linkedin\.com\/\S+\b/gi
const HANDLE_RE = /(^|\s)@[A-Za-z0-9_.-]{3,}\b/g
const PRESCREEN_SESSIONS = "pa-prescreen-sessions"

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function redactPassedCandidateText(value: string): string {
  return value
    .replace(EMAIL_RE, "[redacted email]")
    .replace(PHONE_RE, "[redacted phone]")
    .replace(LINKEDIN_RE, "[redacted linkedin]")
    .replace(HANDLE_RE, "$1[redacted handle]")
    .replace(STORAGE_RE, "[redacted storage]")
    .replace(RESUME_RE, "[redacted resume]")
}

function safeText(value: unknown, max = 2_000): string | undefined {
  const cleaned = cleanString(value)
  if (!cleaned) return undefined
  return redactPassedCandidateText(cleaned).slice(0, max)
}

function allowedUserProfile(raw: Record<string, unknown> | undefined, snapshot: EmployerVisibleProfile): PassedCandidateRow["profile"] {
  const piiConsentAt = cleanString(raw?.piiConsentAt) ?? snapshot.consentAt
  return {
    ...(piiConsentAt ? { piiConsentAt } : {}),
    consentStatus: piiConsentAt ? "granted" : "missing",
    ...(cleanString(raw?.level1Status) ? { level1Status: cleanString(raw?.level1Status) } : {}),
    ...(cleanString(raw?.level1CompletedAt) ? { level1CompletedAt: cleanString(raw?.level1CompletedAt) } : {}),
    ...(cleanString(raw?.onboardingStatus) ? { onboardingStatus: cleanString(raw?.onboardingStatus) } : {}),
    ...(cleanString(raw?.candidateLifecycleState) ? { candidateLifecycleState: cleanString(raw?.candidateLifecycleState) } : {}),
  }
}

async function loadDoc(db: Firestore, collection: string, docId: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection(collection).doc(docId).get()
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
}

async function loadTranscript(db: Firestore, prescreenSessionId: string | undefined): Promise<PassedCandidateTranscriptTurn[]> {
  if (!prescreenSessionId) return []
  const snap = await db
    .collection(`${PRESCREEN_SESSIONS}/${prescreenSessionId}/turns`)
    .orderBy("ts", "asc")
    .limit(20)
    .get()

  return snap.docs.flatMap((doc) => {
    const raw = doc.data() as Record<string, unknown>
    const action = raw.action && typeof raw.action === "object" ? raw.action as Record<string, unknown> : {}
    const score =
      typeof raw.score === "number" ? raw.score :
        typeof action.score === "number" ? action.score :
          undefined
    const scoreMax =
      typeof raw.scoreMax === "number" ? raw.scoreMax :
        typeof action.scoreMax === "number" ? action.scoreMax :
          undefined
    const body = safeText(raw.reply ?? raw.body, 1_000)
    if (!body) return []
    return [{
      id: cleanString(raw.id) ?? doc.id,
      role: "user",
      body,
      ...(cleanString(raw.qId) ? { qId: cleanString(raw.qId) } : {}),
      ...(cleanString(action.kind) ? { actionKind: cleanString(action.kind) } : {}),
      ...(typeof score === "number" && typeof scoreMax === "number"
        ? { scoreSummary: `${score.toFixed(2)}/${scoreMax.toFixed(2)}` }
        : {}),
      ...(cleanString(raw.ts) ? { createdAt: cleanString(raw.ts) } : {}),
    }]
  })
}

function buildRow(args: {
  snapshot: EmployerVisibleProfile
  state: { state: "passed" | "employer_visible"; prescreenSessionId?: string }
  user?: Record<string, unknown>
  selfProfile?: Record<string, unknown>
  transcript: PassedCandidateTranscriptTurn[]
}): PassedCandidateRow {
  const profile = allowedUserProfile(args.user, args.snapshot)
  const displayName =
    safeText(args.snapshot.displayName, 120) ??
    (profile.consentStatus === "granted" ? safeText(args.selfProfile?.displayName, 120) : undefined) ??
    args.snapshot.candidateId
  return {
    id: args.snapshot.snapshotId,
    snapshotId: args.snapshot.snapshotId,
    candidateId: args.snapshot.candidateId,
    jobId: args.snapshot.jobId,
    candidateJobStateId: args.snapshot.candidateJobStateId,
    state: args.state.state,
    displayName,
    ...(safeText(args.snapshot.resumeSummary, 1_000) ? { resumeSummary: safeText(args.snapshot.resumeSummary, 1_000) } : {}),
    ...(args.snapshot.level1Snapshot && typeof args.snapshot.level1Snapshot === "object"
      ? { level1Snapshot: args.snapshot.level1Snapshot as Record<string, unknown> }
      : {}),
    ...(safeText(args.snapshot.passReason, 1_000) ? { passReason: safeText(args.snapshot.passReason, 1_000) } : {}),
    ...(safeText(args.snapshot.matchReason, 1_000) ? { matchReason: safeText(args.snapshot.matchReason, 1_000) } : {}),
    createdAt: args.snapshot.createdAt,
    profile,
    transcript: {
      ...(args.state.prescreenSessionId ? { prescreenSessionId: args.state.prescreenSessionId } : {}),
      turns: args.transcript,
    },
  }
}

function summarize(
  rows: PassedCandidateRow[],
  dropped: { invalid: number; stateMismatch: number },
): PassedCandidatesSnapshot["summary"] {
  return {
    totalPassedSnapshots: rows.length,
    withConsent: rows.filter((row) => row.profile.consentStatus === "granted").length,
    missingConsent: rows.filter((row) => row.profile.consentStatus === "missing").length,
    withTranscript: rows.filter((row) => row.transcript.turns.length > 0).length,
    droppedInvalidSnapshot: dropped.invalid,
    droppedStateMismatch: dropped.stateMismatch,
  }
}

export async function runAdminPassedCandidatesSnapshot(
  raw: unknown,
  deps: { db: Firestore; now?: () => string },
): Promise<PassedCandidatesSnapshot> {
  const parsed = AdminPassedCandidatesSnapshotInputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }

  const dropped = { invalid: 0, stateMismatch: 0 }
  let query: Query = deps.db
    .collection(PA_COLLECTIONS.employerVisibleProfiles)
    .where("jobId", "==", parsed.data.jobId)
  query = query.limit(parsed.data.limit)
  const snap = await query.get()

  const rows: PassedCandidateRow[] = []
  for (const doc of snap.docs) {
    const parsedSnapshot = EmployerVisibleProfileSchema.safeParse(doc.data())
    if (!parsedSnapshot.success || parsedSnapshot.data.createdFromState !== "passed") {
      dropped.invalid += 1
      continue
    }
    const snapshot = parsedSnapshot.data
    const stateRaw = await loadDoc(deps.db, PA_COLLECTIONS.candidateJobStates, snapshot.candidateJobStateId)
    const state = CandidateJobStateDocSchema.safeParse(stateRaw)
    const validState =
      state.success &&
      state.data.candidateId === snapshot.candidateId &&
      state.data.jobId === snapshot.jobId &&
      (state.data.state === "passed" || state.data.state === "employer_visible")
    if (!validState || !state.success) {
      dropped.stateMismatch += 1
      continue
    }
    const visibleState = state.data.state === "employer_visible" ? "employer_visible" : "passed"

    const [user, selfProfile, transcript] = await Promise.all([
      loadDoc(deps.db, PA_COLLECTIONS.users, snapshot.candidateId),
      loadDoc(deps.db, PA_COLLECTIONS.candidateSelfProfiles, snapshot.candidateId),
      loadTranscript(deps.db, state.data.prescreenSessionId),
    ])
    rows.push(buildRow({
      snapshot,
      state: {
        state: visibleState,
        ...(state.data.prescreenSessionId ? { prescreenSessionId: state.data.prescreenSessionId } : {}),
      },
      user,
      selfProfile,
      transcript,
    }))
  }

  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return {
    generatedAt: deps.now?.() ?? new Date().toISOString(),
    filters: {
      jobId: parsed.data.jobId,
      limit: parsed.data.limit,
    },
    summary: summarize(rows, dropped),
    rows,
  }
}

export const paAdminPassedCandidatesSnapshot = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 60, secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminPassedCandidatesSnapshot(req.data, { db: getFirestore() })
  },
)
