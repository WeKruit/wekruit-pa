import { onCall, HttpsError } from "firebase-functions/v2/https"
import { getFirestore, type Firestore } from "firebase-admin/firestore"

const COLLECTIONS = {
  candidateAuth: "pa-candidate-auth",
  candidateJobMatches: "pa-candidate-job-matches",
  candidateJobStates: "pa-candidate-job-states",
  jobs: "pa-jobs",
  outboundInvites: ["pa", "outbound-invites"].join("-"),
} as const

type CallableAuth = {
  uid?: string
}

type CandidateMatchJobDisplay = {
  title: string
  company: string
  location?: string
  salaryRange?: string
  href: string
}

export type CandidateMatchCard = {
  matchId: string
  jobId: string
  bucket: "recommended" | "invited"
  status: "recommended" | "invited" | "interview_started" | "passed" | "not_passed" | "paused"
  job: CandidateMatchJobDisplay
  whyMatched: string[]
  rank?: number
  computedAt: string
}

export type CandidateListMatchesResult = {
  ok: true
  candidateId: string
  generatedAt: string
  matches: CandidateMatchCard[]
}

export interface CandidateListMatchesDeps {
  db: Firestore
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

function createCandidateJobStateId(candidateId: string, jobId: string): string {
  return `${candidateId}__${jobId}`
}

function parseLimit(data: unknown): number {
  const raw = data && typeof data === "object" ? (data as Record<string, unknown>).limit : undefined
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 25
  return Math.max(1, Math.min(50, Math.floor(raw)))
}

function projectJobDisplay(jobId: string, job: Record<string, unknown>): CandidateMatchJobDisplay {
  const prescreenConfig =
    job.prescreenConfig && typeof job.prescreenConfig === "object"
      ? (job.prescreenConfig as Record<string, unknown>)
      : {}
  const level1Reveal =
    prescreenConfig.level1Reveal && typeof prescreenConfig.level1Reveal === "object"
      ? (prescreenConfig.level1Reveal as Record<string, unknown>)
      : {}
  return {
    title:
      cleanString(prescreenConfig.jobTitle, 300) ??
      cleanString(job.jobTitle, 300) ??
      cleanString(job.roleTitle, 300) ??
      "Open role",
    company:
      cleanString(prescreenConfig.company, 300) ??
      cleanString(job.companyName, 300) ??
      cleanString(job.companyDisplayName, 300) ??
      "Confidential employer",
    ...(cleanString(job.location, 300) ?? cleanString(job.locationRaw, 300)
      ? { location: cleanString(job.location, 300) ?? cleanString(job.locationRaw, 300) }
      : {}),
    ...(cleanString(level1Reveal.salaryRange, 120) ?? cleanString(job.salaryRange, 120)
      ? { salaryRange: cleanString(level1Reveal.salaryRange, 120) ?? cleanString(job.salaryRange, 120) }
      : {}),
    href: `/j/${jobId}`,
  }
}

async function getCandidateIdForAuth(db: Firestore, firebaseUid: string): Promise<string> {
  const snap = await db.collection(COLLECTIONS.candidateAuth).doc(firebaseUid).get()
  if (!snap.exists) {
    throw new HttpsError("failed-precondition", "Signed-in account is not linked to a candidate profile.")
  }
  const candidateId = cleanString(snap.data()?.candidateId, 200)
  if (!candidateId) {
    throw new HttpsError("failed-precondition", "Signed-in account is not linked to a candidate profile.")
  }
  return candidateId
}

function projectStatus(stateValue: string | undefined, hasInvite: boolean): CandidateMatchCard["status"] {
  if (stateValue === "prescreen_started") return "interview_started"
  if (stateValue === "passed") return "passed"
  if (stateValue === "not_passed") return "not_passed"
  if (stateValue === "paused") return "paused"
  return hasInvite ? "invited" : "recommended"
}

function projectMatchCard(args: {
  matchId: string
  match?: Record<string, unknown>
  jobId: string
  job: Record<string, unknown>
  state?: Record<string, unknown>
  invite?: Record<string, unknown>
}): CandidateMatchCard {
  const match = args.match
  const state = cleanString(args.state?.state, 80)
  const hasInvite = args.invite !== undefined
  const bucket = hasInvite || (state !== undefined && state !== "candidate_matched") ? "invited" : "recommended"
  const whyMatched = cleanStringArray(match?.reasons, 4, 240)
  return {
    matchId: args.matchId,
    jobId: args.jobId,
    bucket,
    status: projectStatus(state, hasInvite),
    job: projectJobDisplay(args.jobId, args.job),
    whyMatched: whyMatched.length > 0 ? whyMatched : ["This role matches your saved profile."],
    ...(typeof match?.finalRank === "number" && Number.isInteger(match.finalRank) ? { rank: match.finalRank } : {}),
    computedAt: cleanString(match?.computedAt, 80) ?? cleanString(match?.updatedAt, 80) ?? new Date(0).toISOString(),
  }
}

export async function runCandidateListMatches(
  data: unknown,
  auth: CallableAuth | undefined,
  deps: CandidateListMatchesDeps
): Promise<CandidateListMatchesResult> {
  const firebaseUid = cleanString(auth?.uid, 128)
  if (!firebaseUid) {
    throw new HttpsError("unauthenticated", "Sign in before viewing candidate matches.")
  }

  const candidateId = await getCandidateIdForAuth(deps.db, firebaseUid)
  const limit = parseLimit(data)
  const [matchSnap, inviteSnap] = await Promise.all([
    deps.db.collection(COLLECTIONS.candidateJobMatches).where("candidateId", "==", candidateId).limit(limit).get(),
    deps.db.collection(COLLECTIONS.outboundInvites).where("candidateId", "==", candidateId).limit(limit).get(),
  ])

  const byJobId = new Map<string, { matchId?: string; match?: Record<string, unknown>; invite?: Record<string, unknown> }>()
  for (const doc of matchSnap.docs) {
    const row = doc.data() as Record<string, unknown>
    const jobId = cleanString(row.jobId, 200)
    const rowCandidateId = cleanString(row.candidateId, 200)
    if (!jobId || rowCandidateId !== candidateId) continue
    if (cleanString(row.recommendedAction, 80) === "do_not_contact") continue
    if (cleanString(row.hardFilterResult, 80) === "hard_block") continue
    byJobId.set(jobId, { ...(byJobId.get(jobId) ?? {}), matchId: doc.id, match: row })
  }
  for (const doc of inviteSnap.docs) {
    const row = doc.data() as Record<string, unknown>
    const jobId = cleanString(row.jobId, 200)
    const rowCandidateId = cleanString(row.candidateId, 200)
    if (!jobId || rowCandidateId !== candidateId) continue
    byJobId.set(jobId, { ...(byJobId.get(jobId) ?? {}), invite: row })
  }

  const rows = await Promise.all(
    Array.from(byJobId.entries()).map(async ([jobId, row]) => {
      const [jobSnap, stateSnap] = await Promise.all([
        deps.db.collection(COLLECTIONS.jobs).doc(jobId).get(),
        deps.db.collection(COLLECTIONS.candidateJobStates).doc(createCandidateJobStateId(candidateId, jobId)).get(),
      ])
      if (!jobSnap.exists) return null
      const job = jobSnap.data() as Record<string, unknown>
      if (job.publicVisible !== true) return null
      return projectMatchCard({
        jobId,
        matchId: row.matchId ?? createCandidateJobStateId(candidateId, jobId),
        match: row.match,
        invite: row.invite,
        job,
        state: stateSnap.exists ? (stateSnap.data() as Record<string, unknown>) : undefined,
      })
    })
  )

  const visibleRows = rows.filter((row): row is CandidateMatchCard => row !== null)
  visibleRows.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket === "invited" ? -1 : 1
    const aRank = a.rank ?? Number.MAX_SAFE_INTEGER
    const bRank = b.rank ?? Number.MAX_SAFE_INTEGER
    if (aRank !== bRank) return aRank - bRank
    return b.computedAt.localeCompare(a.computedAt)
  })

  return {
    ok: true,
    candidateId,
    generatedAt: new Date().toISOString(),
    matches: visibleRows,
  }
}

export const paCandidateListMatches = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 30,
  },
  async (req): Promise<CandidateListMatchesResult> => {
    return runCandidateListMatches(req.data, req.auth, { db: getFirestore() })
  }
)
