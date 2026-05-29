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
  matchingJobs: "matching-jobs",
  userJobRecommendations: "pa-user-job-recommendations",
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
  status: "recommended" | "invited" | "interview_started" | "review_pending" | "passed" | "not_passed" | "paused"
  /** WeKruit-collaborated job → candidate can pre-screen (CTA + session + status). */
  collab: boolean
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

// A pa-jobs doc is pre-screenable only when it carries a non-empty
// prescreenConfig.questions[]. Mirrors loadCollabPrescreenEligibleJobIds in
// the V16 matcher so the candidate-facing collab flag matches what the
// pre-screen runtime will actually accept.
function hasActivePrescreenConfig(job: Record<string, unknown> | undefined): boolean {
  const cfg = job?.prescreenConfig
  if (!cfg || typeof cfg !== "object") return false
  const questions = (cfg as { questions?: unknown }).questions
  return Array.isArray(questions) && questions.length > 0
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
  if (prescreenTerminal === "PASS") return "passed"
  if (prescreenTerminal === "FAIL" || prescreenTerminal === "HARD_STOP") return "not_passed"
  if (prescreenTerminal === "PAUSE") return "paused"
  if (stateValue === "candidate_matched") return "recommended"
  if (stateValue === "outbound_queued") return "invited"
  if (stateValue === "outbound_sent") return "invited"
  if (stateValue === "candidate_interested") return "invited"
  if (stateValue === "prescreen_started") return "interview_started"
  if (stateValue === "prescreen_review_pending") return "review_pending"
  if (stateValue === "passed") return "passed"
  if (stateValue === "employer_visible") return "passed"
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
  prescreenTerminal?: string
  prescreenReviewPending?: boolean
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
    // Pipeline matches live in pa-jobs (WeKruit-driven engagement) → pre-screenable.
    collab: true,
    status: projectStatus(state, hasInvite, args.prescreenTerminal, args.prescreenReviewPending),
    job: projectJobDisplay(args.jobId, args.job),
    whyMatched: whyMatched.length > 0 ? whyMatched : ["This role matches your saved profile."],
    ...(typeof match?.finalRank === "number" && Number.isInteger(match.finalRank) ? { rank: match.finalRank } : {}),
    computedAt: cleanString(match?.computedAt, 80) ?? cleanString(match?.updatedAt, 80) ?? new Date(0).toISOString(),
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

// Surface the recommendations the matcher actually produced for this user — the
// SOLE recommendation source (the old wholesale "show every collaborated pa-job
// to everyone" fallback is gone). generateJobRecs → recordRecommendedJobs writes
// recommended jobIds to pa-user-job-recommendations/{uid}/jobs. Job docs live in
// `matching-jobs` (the scraped/ranked pool); WeKruit-collaborated jobs are ALSO
// mirrored into `matching-jobs`, so they flow through the same hard-filtered
// matcher and land here only when they genuinely match this candidate.
//
// collab is derived per-rec from pa-jobs/{jobId}.wekruitCollaborationStatus +
// an active prescreenConfig — NOT from being shown wholesale. A collab rec is
// hydrated from its pa-jobs doc (employer-authoritative: title, salary reveal,
// prescreen) so the pre-screen CTA + Level-1 reveal render correctly. Reasons
// are re-derived cheaply (publicRecommendationScore) since the recorded state
// only stores {jobId, count, lastRecommendedAt}.
async function buildRecordedRecommendedRows(args: {
  db: Firestore
  candidateId: string
  existingJobIds: Set<string>
  limit: number
  now: string
}): Promise<CandidateMatchCard[]> {
  const userSnap = await args.db.collection(COLLECTIONS.users).doc(args.candidateId).get()
  const user = userSnap.data() as Record<string, unknown> | undefined
  const candidateTags =
    user?.tags && typeof user.tags === "object"
      ? (user.tags as Record<string, unknown>)
      : user?.globalTags && typeof user.globalTags === "object"
        ? (user.globalTags as Record<string, unknown>)
        : undefined
  if (!candidateTags) return []

  let recsSnap
  try {
    recsSnap = await args.db
      .collection(COLLECTIONS.userJobRecommendations)
      .doc(args.candidateId)
      .collection("jobs")
      .orderBy("lastRecommendedAt", "desc")
      .limit(Math.max(args.limit * 3, 30))
      .get()
  } catch {
    return []
  }
  const recById = new Map<string, string>()
  for (const doc of recsSnap.docs) {
    if (args.existingJobIds.has(doc.id)) continue
    const data = doc.data() as Record<string, unknown>
    recById.set(doc.id, cleanString(data.lastRecommendedAt, 80) ?? args.now)
  }
  if (recById.size === 0) return []
  const nowMs = Date.parse(args.now)

  const hydrated = await Promise.all(
    [...recById.keys()].map(async (jobId) => {
      // A recommended job may live in matching-jobs (general), pa-jobs (collab),
      // or both (collab jobs are mirrored into matching-jobs). Read both, then
      // pick the authoritative display source by collab status.
      const [mjSnap, paSnap] = await Promise.all([
        args.db.collection(COLLECTIONS.matchingJobs).doc(jobId).get(),
        args.db.collection(COLLECTIONS.jobs).doc(jobId).get(),
      ])
      const paJob = paSnap.exists ? (paSnap.data() as Record<string, unknown>) : undefined
      const isCollab =
        !!paJob &&
        cleanString(paJob.wekruitCollaborationStatus, 80) === "collaborated" &&
        hasActivePrescreenConfig(paJob)

      let job: Record<string, unknown>
      if (isCollab) {
        // Collab: pa-jobs is authoritative (carries prescreenConfig + reveal).
        if (paJob!.publicVisible !== true) return null
        if (paJob!.dead === true) return null
        job = paJob!
      } else {
        // General: matching-jobs is authoritative. Drop dead/inactive rows.
        if (!mjSnap.exists) return null
        job = mjSnap.data() as Record<string, unknown>
        if (job.dead === true) return null
        const statusStr = cleanString(job.status, 80)
        if (statusStr && statusStr !== "active") return null
      }
      const scored = publicRecommendationScore({
        candidateTags,
        jobId,
        job,
        nowMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
      })
      return { jobId, job, reasons: scored.reasons, lastAt: recById.get(jobId) ?? args.now, collab: isCollab }
    })
  )

  const rows = hydrated
    .filter(
      (r): r is { jobId: string; job: Record<string, unknown>; reasons: string[]; lastAt: string; collab: boolean } =>
        r !== null
    )
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .slice(0, args.limit)

  return rows.map((row, index) => ({
    matchId: `${args.candidateId}__${row.jobId}__${row.collab ? "collab" : "recorded_recommendation"}`,
    jobId: row.jobId,
    bucket: "recommended",
    // collab → pre-screen CTA + session + status; general → "See role" only.
    collab: row.collab,
    status: "recommended",
    job: projectJobDisplay(row.jobId, row.job),
    whyMatched:
      row.reasons.length > 0
        ? row.reasons
        : row.collab
          ? ["WeKruit-collaborated role — Claire can run your first screen."]
          : ["This role matches your saved profile."],
    rank: index + 1,
    computedAt: row.lastAt,
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
      })
    })
  )

  const pipelineRows = rows.filter((row): row is CandidateMatchCard => row !== null)

  // Two sources, merged + DEDUPED by jobId:
  //   1. pipeline (candidate already engaged)      — collab, full status
  //   2. recorded daily-recommend recs             — the matcher's actual output
  //      for THIS user; collab flag derived per-rec from pa-jobs collaboration
  //      status (NOT shown wholesale). A collab job appears here only when it
  //      passed the hard-filtered matcher and was recorded for this candidate.
  // No generic publicVisible / wholesale-collab fallback — directive 2026-05-29.
  const recRows = await buildRecordedRecommendedRows({
    db: deps.db,
    candidateId,
    existingJobIds: new Set(pipelineRows.map((row) => row.jobId)),
    limit,
    now: generatedAt,
  })

  const mergedById = new Map<string, CandidateMatchCard>()
  for (const row of [...pipelineRows, ...recRows]) {
    if (!mergedById.has(row.jobId)) mergedById.set(row.jobId, row)
  }
  const merged = Array.from(mergedById.values())
  // Order: active pipeline (invited) → WeKruit collab → general recommendations,
  // then by rank, then recency.
  const tier = (m: CandidateMatchCard): number => (m.bucket === "invited" ? 0 : m.collab ? 1 : 2)
  merged.sort((a, b) => {
    const ta = tier(a)
    const tb = tier(b)
    if (ta !== tb) return ta - tb
    const aRank = a.rank ?? Number.MAX_SAFE_INTEGER
    const bRank = b.rank ?? Number.MAX_SAFE_INTEGER
    if (aRank !== bRank) return aRank - bRank
    return b.computedAt.localeCompare(a.computedAt)
  })

  return {
    ok: true,
    candidateId,
    generatedAt,
    matches: merged.slice(0, limit),
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
