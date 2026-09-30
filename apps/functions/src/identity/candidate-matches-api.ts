import { onCall, HttpsError } from "firebase-functions/v2/https"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { buildRichMatchReason } from "@pa/job-rec"

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
  interviewBookings: "pa-interview-bookings",
} as const

/** Booking statuses that mean a real interview time is locked in. */
const SCHEDULED_BOOKING_STATUSES = new Set(["booked", "confirmed"])

type CallableAuth = {
  uid?: string
}

type CandidateMatchJobDisplay = {
  title: string
  company: string
  location?: string
  salaryRange?: string
  /** Internal WeKruit page (`/j/:jobId`) — used by collab jobs (our page + pre-screen). */
  href: string
  /** External apply URL (ATS posting). Present for scraped/recommended jobs whose
   *  "apply path" is the real listing, not a WeKruit page. Frontend: non-collab → open this. */
  applyUrl?: string
}

type CandidateReviewDecision = {
  candidateMessageBody: string
  decisionReason: string
  recommendedActions: string[]
  finalTerminal: "PASS" | "FAIL" | "HARD_STOP"
  reviewedAt: string
}

/** A booked/confirmed interview surfaced onto the match card. */
export type CandidateMatchBooking = {
  bookingId: string
  status: string
  slotIso?: string
  meetingUrl?: string
  timeZone?: string
}

export type CandidateMatchCard = {
  matchId: string
  jobId: string
  bucket: "recommended" | "invited"
  status:
    | "recommended"
    | "invited"
    | "interview_started"
    | "scheduled"
    | "review_pending"
    | "passed"
    | "intro_accepted"
    | "intro_rejected"
    | "not_passed"
    | "paused"
  /** WeKruit-collaborated job → candidate can pre-screen (CTA + session + status). */
  collab: boolean
  job: CandidateMatchJobDisplay
  whyMatched: string[]
  rank?: number
  computedAt: string
  reviewDecision?: CandidateReviewDecision
  /** Present when a real interview slot is booked (status === "scheduled"). */
  booking?: CandidateMatchBooking
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

function latestIsoString(...values: unknown[]): string | undefined {
  let best: { value: string; time: number } | undefined
  for (const value of values) {
    const cleaned = cleanString(value, 80)
    if (!cleaned) continue
    const time = Date.parse(cleaned)
    if (!Number.isFinite(time)) continue
    if (!best || time > best.time) best = { value: cleaned, time }
  }
  return best?.value
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
    ...(() => {
      // External apply URL for scraped/recommended jobs (atsApplyUrl is a V16 hard
      // filter → always present on recorded matching-jobs recs). Non-collab "See role"
      // opens this real listing; collab jobs ignore it and use href (our page).
      const applyUrl = cleanString(job.atsApplyUrl, 1000) ?? cleanString(job.primaryUrl, 1000)
      return applyUrl && /^https?:\/\//i.test(applyUrl) ? { applyUrl } : {}
    })(),
  }
}

function pipelineFallbackReason(job: CandidateMatchJobDisplay): string {
  return `${job.title} at ${job.company} is in your WeKruit pipeline; Claire can run the first screen.`
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
  hasScheduledBooking?: boolean,
): CandidateMatchCard["status"] {
  // Terminal pass/fail/review states win over a booking (the interview track is
  // orthogonal — a passed candidate keeps the "passed" framing).
  if (stateValue === "prescreen_review_pending" || prescreenReviewPending) return "review_pending"
  if (stateValue === "passed") return "passed"
  if (stateValue === "employer_visible") return "passed"
  if (stateValue === "intro_accepted") return "intro_accepted"
  if (stateValue === "intro_rejected") return "intro_rejected"
  if (stateValue === "not_passed") return "not_passed"
  if (stateValue === "paused") return "paused"
  if (prescreenTerminal === "PASS") return "passed"
  if (prescreenTerminal === "FAIL" || prescreenTerminal === "HARD_STOP") return "not_passed"
  if (prescreenTerminal === "PAUSE") return "paused"
  // A booked/confirmed interview (no terminal yet) → "scheduled". Slots above
  // interview_started/invited/recommended so the locked-in time is what shows.
  if (hasScheduledBooking) return "scheduled"
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

function projectBooking(booking?: Record<string, unknown>): CandidateMatchBooking | undefined {
  if (!booking) return undefined
  const status = cleanString(booking.status, 40)
  if (!status || !SCHEDULED_BOOKING_STATUSES.has(status)) return undefined
  const bookingId = cleanString(booking.id, 240)
  if (!bookingId) return undefined
  return {
    bookingId,
    status,
    ...(cleanString(booking.selectedSlotIso, 80) ? { slotIso: cleanString(booking.selectedSlotIso, 80) } : {}),
    ...(cleanString(booking.meetingUrl, 1000) && /^https?:\/\//i.test(cleanString(booking.meetingUrl, 1000)!)
      ? { meetingUrl: cleanString(booking.meetingUrl, 1000) }
      : {}),
    ...(cleanString(booking.timeZone, 80) ? { timeZone: cleanString(booking.timeZone, 80) } : {}),
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
  booking?: Record<string, unknown>
}): CandidateMatchCard {
  const match = args.match
  const state = cleanString(args.state?.state, 80)
  const hasInvite = args.invite !== undefined
  const booking = projectBooking(args.booking)
  const bucket = hasInvite || booking || (state !== undefined && state !== "candidate_matched") ? "invited" : "recommended"
  // "WHY CLAIRE MATCHED YOU" (Adam directive 2026-05-30): prefer the GROUNDED
  // pitch persisted on the match doc (`matchReason`, LLM-composed / rich-
  // deterministic at recommendation time). Fall back to the legacy `reasons`
  // array only when no stored pitch exists; final fallback stays pipeline-specific.
  const storedReason = cleanString(match?.matchReason, 600)
  const legacyReasons = cleanStringArray(match?.reasons, 4, 240)
  const whyMatched = storedReason ? [storedReason] : legacyReasons
  const jobDisplay = projectJobDisplay(args.jobId, args.job)
  const status = projectStatus(state, hasInvite, args.prescreenTerminal, args.prescreenReviewPending, booking !== undefined)
  const reviewDecision = projectCandidateReviewDecision(status, args.prescreenSession)
  const activityAt =
    latestIsoString(
      args.state?.stateUpdatedAt,
      args.invite?.candidateResponse &&
        typeof args.invite.candidateResponse === "object" &&
        (args.invite.candidateResponse as Record<string, unknown>).respondedAt,
      args.invite?.deliveredAt,
      args.invite?.sentAt,
      args.invite?.queuedAt,
      args.invite?.approvedAt,
      args.invite?.updatedAt,
      args.invite?.createdAt,
      match?.updatedAt,
      match?.computedAt,
      match?.createdAt
    ) ?? new Date(0).toISOString()
  return {
    matchId: args.matchId,
    jobId: args.jobId,
    bucket,
    // Pipeline matches live in pa-jobs (WeKruit-driven engagement) → pre-screenable.
    collab: true,
    status,
    job: jobDisplay,
    whyMatched: whyMatched.length > 0 ? whyMatched : [pipelineFallbackReason(jobDisplay)],
    ...(typeof match?.finalRank === "number" && Number.isInteger(match.finalRank) ? { rank: match.finalRank } : {}),
    computedAt: activityAt,
    ...(reviewDecision ? { reviewDecision } : {}),
    ...(booking ? { booking } : {}),
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

/**
 * Resolve the "WHY CLAIRE MATCHED YOU" lines for a recommended/matched row.
 *
 * Adam directive 2026-05-30: the reason must be a compelling, specific,
 * recruiter-style pitch — never "Matches your resume skills: java, javascript."
 *
 *   1. STORED reason  — the grounded pitch persisted at recommendation time
 *      (LLM-composed in the runtime find_match path, or rich-deterministic in
 *      the daily batch). Authoritative; surface it verbatim.
 *   2. RICH fallback  — re-derive a multi-signal pitch via buildRichMatchReason
 *      over the live job + candidate tags (legacy rec/match docs have no stored
 *      reason). Grounded in real fit signals; fail-soft.
 *   3. Last resort    — a grounded collab / saved-profile line.
 */
function resolveWhyMatched(args: {
  storedReason?: string
  candidateTags?: Record<string, unknown>
  job: Record<string, unknown>
  collab: boolean
}): string[] {
  const stored = cleanString(args.storedReason, 600)
  if (stored) return [stored]
  if (args.candidateTags) {
    try {
      const rich = buildRichMatchReason({
        candidate: args.candidateTags,
        job: args.job,
        lang: cleanString((args.candidateTags as { preferredLang?: unknown }).preferredLang, 8) === "zh" ? "zh" : "en",
      })
      const cleaned = cleanString(rich, 600)
      if (cleaned) return [cleaned]
    } catch {
      /* fall through to grounded last-resort line */
    }
  }
  return args.collab
    ? ["WeKruit-collaborated role — Claire can run your first screen."]
    : ["This role matches your saved profile."]
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
    // Adam directive 2026-05-30: surface the GROUNDED rich pitch over the live
    // job + candidate tags — NOT the weak `publicRecommendationScore` templates
    // ("Matches your resume skills: java, javascript."). The numeric `score` is
    // still used for ranking above; only the displayed reason is replaced.
    // resolveWhyMatched's collab-aware last-resort line subsumes the prior inline
    // fallback (WeKruit-collaborated… / saved-profile).
    whyMatched: resolveWhyMatched({ candidateTags, job: row.job, collab: row.collab }),
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
  const [matchSnap, inviteSnap, stateSnap, bookingSnap] = await Promise.all([
    deps.db.collection(COLLECTIONS.candidateJobMatches).where("candidateId", "==", candidateId).limit(limit).get(),
    deps.db.collection(COLLECTIONS.outboundInvites).where("candidateId", "==", candidateId).limit(limit).get(),
    deps.db.collection(COLLECTIONS.candidateJobStates).where("candidateId", "==", candidateId).limit(limit).get(),
    // pa-interview-bookings is keyed by `userId` (== candidateId == pa-users id).
    deps.db.collection(COLLECTIONS.interviewBookings).where("userId", "==", candidateId).limit(limit).get(),
  ])

  const byJobId = new Map<
    string,
    {
      matchId?: string
      match?: Record<string, unknown>
      invite?: Record<string, unknown>
      state?: Record<string, unknown>
      booking?: Record<string, unknown>
    }
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
  for (const doc of bookingSnap.docs) {
    // Inject the doc id (projectBooking reads booking.id) — data() omits it.
    const row: Record<string, unknown> = { id: doc.id, ...(doc.data() as Record<string, unknown>) }
    const jobId = cleanString(row.jobId, 200)
    if (!jobId) continue
    // Prefer the booking that represents a locked-in slot; a later confirmed
    // booking overwrites an earlier offered one for the same job.
    const existing = byJobId.get(jobId)
    const incomingScheduled = SCHEDULED_BOOKING_STATUSES.has(cleanString(row.status, 40) ?? "")
    const existingScheduled =
      existing?.booking && SCHEDULED_BOOKING_STATUSES.has(cleanString(existing.booking.status, 40) ?? "")
    if (existingScheduled && !incomingScheduled) continue
    byJobId.set(jobId, { ...(existing ?? {}), booking: row })
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
        booking: row.booking,
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
    memory: "512MiB",
    timeoutSeconds: 30,
    maxInstances: 1,
  },
  async (req): Promise<CandidateListMatchesResult> => {
    return runCandidateListMatches(req.data, req.auth, { db: getFirestore() })
  }
)
