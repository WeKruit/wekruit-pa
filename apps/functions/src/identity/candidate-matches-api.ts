import { onCall, HttpsError } from "firebase-functions/v2/https"
import { getFirestore, type Firestore } from "firebase-admin/firestore"

const COLLECTIONS = {
  candidateAuth: "pa-candidate-auth",
  candidateJobMatches: "pa-candidate-job-matches",
  candidateJobStates: "pa-candidate-job-states",
  jobs: "pa-jobs",
  outboundInvites: ["pa", "outbound-invites"].join("-"),
  prescreenSessions: "pa-prescreen-sessions",
  users: "pa-users",
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

type CandidateReviewDecision = {
  candidateMessageBody: string
  decisionReason: string
  recommendedActions: string[]
  finalTerminal: "PASS" | "FAIL" | "HARD_STOP"
  reviewedAt: string
}

export type CandidateMatchCard = {
  matchId: string
  jobId: string
  bucket: "recommended" | "invited"
  status: "recommended" | "invited" | "interview_started" | "review_pending" | "passed" | "not_passed" | "paused"
  job: CandidateMatchJobDisplay
  whyMatched: string[]
  rank?: number
  computedAt: string
  reviewDecision?: CandidateReviewDecision
}

export type CandidateListMatchesResult = {
  ok: true
  candidateId: string
  generatedAt: string
  matches: CandidateMatchCard[]
}

export interface CandidateListMatchesDeps {
  db: Firestore
  now?: () => Date
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
      cleanString(job.title, 300) ??
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

function projectStatus(
  stateValue: string | undefined,
  hasInvite: boolean,
  prescreenTerminal?: string,
  prescreenReviewPending?: boolean,
): CandidateMatchCard["status"] {
  if (stateValue === "prescreen_review_pending" || prescreenReviewPending) return "review_pending"
  if (stateValue === "passed") return "passed"
  if (stateValue === "employer_visible") return "passed"
  if (stateValue === "not_passed") return "not_passed"
  if (stateValue === "paused") return "paused"
  if (prescreenTerminal === "PASS") return "passed"
  if (prescreenTerminal === "FAIL" || prescreenTerminal === "HARD_STOP") return "not_passed"
  if (prescreenTerminal === "PAUSE") return "paused"
  if (stateValue === "candidate_matched") return "recommended"
  if (stateValue === "outbound_queued") return "invited"
  if (stateValue === "outbound_sent") return "invited"
  if (stateValue === "candidate_interested") return "invited"
  if (stateValue === "prescreen_started") return "interview_started"
  return hasInvite ? "invited" : "recommended"
}

function cleanReviewTerminal(value: unknown): CandidateReviewDecision["finalTerminal"] | undefined {
  return value === "PASS" || value === "FAIL" || value === "HARD_STOP" ? value : undefined
}

function projectCandidateReviewDecision(
  status: CandidateMatchCard["status"],
  prescreenSession?: Record<string, unknown>,
): CandidateReviewDecision | undefined {
  if (status !== "passed" && status !== "not_passed") return undefined
  const review = prescreenSession?.review
  if (!review || typeof review !== "object") return undefined
  const decision = (review as Record<string, unknown>).candidateDecision
  if (!decision || typeof decision !== "object") return undefined
  const record = decision as Record<string, unknown>
  const candidateMessageBody = cleanString(record.candidateMessageBody, 2_000)
  const decisionReason = cleanString(record.decisionReason, 1_000)
  const finalTerminal = cleanReviewTerminal(record.finalTerminal)
  const reviewedAt = cleanString(record.reviewedAt, 80)
  if (!candidateMessageBody || !decisionReason || !finalTerminal || !reviewedAt) return undefined
  if (status === "passed" && finalTerminal !== "PASS") return undefined
  if (status === "not_passed" && finalTerminal === "PASS") return undefined
  return {
    candidateMessageBody,
    decisionReason,
    recommendedActions: cleanStringArray(record.recommendedActions, 5, 240),
    finalTerminal,
    reviewedAt,
  }
}

function projectMatchCard(args: {
  matchId: string
  match?: Record<string, unknown>
  jobId: string
  job: Record<string, unknown>
  state?: Record<string, unknown>
  invite?: Record<string, unknown>
  prescreenTerminal?: string
  prescreenReviewPending?: boolean
  prescreenSession?: Record<string, unknown>
}): CandidateMatchCard {
  const match = args.match
  const state = cleanString(args.state?.state, 80)
  const hasInvite = args.invite !== undefined
  const bucket = hasInvite || (state !== undefined && state !== "candidate_matched") ? "invited" : "recommended"
  const whyMatched = cleanStringArray(match?.reasons, 4, 240)
  const status = projectStatus(state, hasInvite, args.prescreenTerminal, args.prescreenReviewPending)
  const reviewDecision = projectCandidateReviewDecision(status, args.prescreenSession)
  return {
    matchId: args.matchId,
    jobId: args.jobId,
    bucket,
    status,
    job: projectJobDisplay(args.jobId, args.job),
    whyMatched: whyMatched.length > 0 ? whyMatched : ["This role matches your saved profile."],
    ...(typeof match?.finalRank === "number" && Number.isInteger(match.finalRank) ? { rank: match.finalRank } : {}),
    computedAt: cleanString(match?.computedAt, 80) ?? cleanString(match?.updatedAt, 80) ?? new Date(0).toISOString(),
    ...(reviewDecision ? { reviewDecision } : {}),
  }
}

function cleanStringSet(value: unknown): Set<string> {
  const out = new Set<string>()
  const ingest = (item: unknown) => {
    if (typeof item === "string") {
      const cleaned = item.trim().toLowerCase()
      if (cleaned) out.add(cleaned)
    } else if (item && typeof item === "object") {
      const name = cleanString((item as Record<string, unknown>).name, 120)
      if (name) out.add(name.toLowerCase())
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) ingest(item)
  } else {
    ingest(value)
  }
  return out
}

function unionSets(...sets: Set<string>[]): Set<string> {
  const out = new Set<string>()
  for (const set of sets) {
    for (const value of set) out.add(value)
  }
  return out
}

function intersection(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = []
  for (const value of a) {
    if (b.has(value)) out.push(value)
  }
  return out
}

function jobSearchText(job: Record<string, unknown>): string {
  return [
    cleanString(job.title, 300),
    cleanString(job.jobTitle, 300),
    cleanString(job.roleTitle, 300),
    cleanString(job.companyName, 300),
    cleanString(job.company, 300),
    cleanString(job.location, 300),
    cleanString(job.descriptionMd, 4_000),
    cleanString(job.jdRaw, 4_000),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function publicRecommendationScore(args: {
  candidateTags: Record<string, unknown>
  jobId: string
  job: Record<string, unknown>
  nowMs: number
}): { score: number; reasons: string[] } {
  const candidateSkills = cleanStringSet(args.candidateTags.skills)
  const candidateIndustries = unionSets(
    cleanStringSet(args.candidateTags.industrySector),
    cleanStringSet(args.candidateTags.relevantIndustry),
    cleanStringSet(args.candidateTags.industryEnum)
  )
  const candidateRoles = unionSets(
    cleanStringSet(args.candidateTags.roleFunction),
    cleanStringSet(args.candidateTags.targetRoleFunction),
    cleanStringSet(args.candidateTags.targetRole)
  )
  const candidateRelevant = cleanStringSet(args.candidateTags.relevantTags)
  const jobIndustries = unionSets(cleanStringSet(args.job.industrySector), cleanStringSet(args.job.industryEnum))
  const jobRoles = cleanStringSet(args.job.roleFunction)
  const jobRelevant = cleanStringSet(args.job.relevantTags)
  const searchText = jobSearchText(args.job)

  const skillMatches = [...candidateSkills].filter((skill) => searchText.includes(skill.replace(/_/g, " ")) || searchText.includes(skill))
  const roleMatches = intersection(candidateRoles, jobRoles)
  const industryMatches = intersection(candidateIndustries, jobIndustries)
  const relevantMatches = intersection(candidateRelevant, jobRelevant)

  let score = 0
  score += Math.min(skillMatches.length, 6) * 3
  score += roleMatches.length * 5
  score += industryMatches.length * 4
  score += relevantMatches.length * 2

  const firstSeenAt = cleanString(args.job.firstSeenAt, 80)
  if (firstSeenAt) {
    const ageDays = (args.nowMs - Date.parse(firstSeenAt)) / (24 * 3600 * 1000)
    if (Number.isFinite(ageDays) && ageDays <= 30) score += 1
  }

  const reasons: string[] = []
  if (skillMatches.length > 0) {
    reasons.push(`Matches your resume skills: ${skillMatches.slice(0, 3).join(", ")}.`)
  }
  if (roleMatches.length > 0) {
    reasons.push(`Aligned with your target role area: ${roleMatches.slice(0, 2).join(", ")}.`)
  }
  if (industryMatches.length > 0) {
    reasons.push(`Fits your industry signal: ${industryMatches.slice(0, 2).join(", ")}.`)
  }
  if (reasons.length === 0) {
    reasons.push("This published role is available for Claire's first screen.")
  }

  return { score, reasons }
}

async function buildPublicRecommendedRows(args: {
  db: Firestore
  candidateId: string
  existingJobIds: Set<string>
  limit: number
  now: string
}): Promise<CandidateMatchCard[]> {
  const [userSnap, publicJobsSnap] = await Promise.all([
    args.db.collection(COLLECTIONS.users).doc(args.candidateId).get(),
    args.db.collection(COLLECTIONS.jobs).where("publicVisible", "==", true).limit(100).get(),
  ])
  const user = userSnap.data() as Record<string, unknown> | undefined
  const candidateTags =
    user?.tags && typeof user.tags === "object"
      ? (user.tags as Record<string, unknown>)
      : user?.globalTags && typeof user.globalTags === "object"
        ? (user.globalTags as Record<string, unknown>)
        : undefined
  if (!candidateTags) return []
  const nowMs = Date.parse(args.now)

  const ranked = publicJobsSnap.docs
    .map((doc) => {
      const job = doc.data() as Record<string, unknown>
      if (args.existingJobIds.has(doc.id)) return null
      if (job.publicVisible !== true) return null
      if (job.status && cleanString(job.status, 80) !== "active") return null
      if (job.dead === true) return null
      const scored = publicRecommendationScore({
        candidateTags,
        jobId: doc.id,
        job,
        nowMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
      })
      if (scored.score <= 0) return null
      return { docId: doc.id, job, ...scored }
    })
    .filter((row): row is { docId: string; job: Record<string, unknown>; score: number; reasons: string[] } => row !== null)
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
    .slice(0, args.limit)

  return ranked.map((row, index) => ({
    matchId: `${args.candidateId}__${row.docId}__public_recommendation`,
    jobId: row.docId,
    bucket: "recommended",
    status: "recommended",
    job: projectJobDisplay(row.docId, row.job),
    whyMatched: row.reasons,
    rank: index + 1,
    computedAt: args.now,
  }))
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
  const generatedAt = (deps.now ?? (() => new Date()))().toISOString()
  const [matchSnap, inviteSnap, stateSnap] = await Promise.all([
    deps.db.collection(COLLECTIONS.candidateJobMatches).where("candidateId", "==", candidateId).limit(limit).get(),
    deps.db.collection(COLLECTIONS.outboundInvites).where("candidateId", "==", candidateId).limit(limit).get(),
    deps.db.collection(COLLECTIONS.candidateJobStates).where("candidateId", "==", candidateId).limit(limit).get(),
  ])

  const byJobId = new Map<
    string,
    { matchId?: string; match?: Record<string, unknown>; invite?: Record<string, unknown>; state?: Record<string, unknown> }
  >()
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
  for (const doc of stateSnap.docs) {
    const row = doc.data() as Record<string, unknown>
    const jobId = cleanString(row.jobId, 200)
    const rowCandidateId = cleanString(row.candidateId, 200)
    const state = cleanString(row.state, 80)
    if (!jobId || rowCandidateId !== candidateId) continue
    if (state === "archived") continue
    byJobId.set(jobId, { ...(byJobId.get(jobId) ?? {}), state: row })
  }

  const rows = await Promise.all(
    Array.from(byJobId.entries()).map(async ([jobId, row]) => {
      const [jobSnap, fallbackStateSnap] = await Promise.all([
        deps.db.collection(COLLECTIONS.jobs).doc(jobId).get(),
        row.state
          ? Promise.resolve(null)
          : deps.db.collection(COLLECTIONS.candidateJobStates).doc(createCandidateJobStateId(candidateId, jobId)).get(),
      ])
      if (!jobSnap.exists) return null
      const job = jobSnap.data() as Record<string, unknown>
      if (job.publicVisible !== true) return null
      const state = row.state ?? (fallbackStateSnap?.exists ? (fallbackStateSnap.data() as Record<string, unknown>) : undefined)
      const prescreenSessionId = cleanString(state?.prescreenSessionId, 240)
      const prescreenSession = prescreenSessionId
        ? ((await deps.db
            .collection(COLLECTIONS.prescreenSessions)
            .doc(prescreenSessionId)
            .get()).data() ?? {})
        : {}
      const prescreenTerminal = cleanString(prescreenSession.terminal, 80)
      const prescreenReviewPending = prescreenSession.terminalActionPendingReview === true
      return projectMatchCard({
        jobId,
        matchId: row.matchId ?? createCandidateJobStateId(candidateId, jobId),
        match: row.match,
        invite: row.invite,
        job,
        state,
        prescreenTerminal,
        prescreenReviewPending,
        prescreenSession,
      })
    })
  )

  const visibleRows = rows.filter((row): row is CandidateMatchCard => row !== null)
  if (visibleRows.length < limit) {
    visibleRows.push(
      ...(await buildPublicRecommendedRows({
        db: deps.db,
        candidateId,
        existingJobIds: new Set(visibleRows.map((row) => row.jobId)),
        limit: limit - visibleRows.length,
        now: generatedAt,
      }))
    )
  }
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
    generatedAt,
    matches: visibleRows,
  }
}

export const paCandidateListMatches = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 1,
  },
  async (req): Promise<CandidateListMatchesResult> => {
    return runCandidateListMatches(req.data, req.auth, { db: getFirestore() })
  }
)
