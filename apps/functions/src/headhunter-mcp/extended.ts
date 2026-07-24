/**
 * headhunter-mcp/extended.ts — runners for the v2 headhunter tools that close
 * the competitor-parity gaps. Each is a thin, deterministic reducer over EXISTING
 * infra (V16 two-way matcher, prescreen sessions, candidate tiers, Cal.com
 * interview bookings) — no new business logic, no new model calls in-tool. The
 * agent does any NL→structured-filter parsing and passes typed args.
 *
 * Gaps closed here (read/compose only — safe):
 *  - search_candidate_pool   (#5 free-text pool search, no jobId)
 *  - rediscover_for_job      (#6 silver-medalist / retained-pool reactivation)
 *  - summarize_prescreen     (#3 transcript TL;DR + per-Q score + red flags)
 *  - get_scheduling_status   (#4 Cal.com interview booking state)
 */
import type { Firestore } from "firebase-admin/firestore"
import {
  rankCandidatesForJob,
  type CandidateForJobMatchResult,
  type MatchingCandidateRow,
  type MatchingJob,
} from "@pa/job-rec"
import { isYcPeopleUser } from "@pa/core-types"

type Db = Firestore
type Rec = Record<string, unknown>

/**
 * Lifecycle states that carry a usable (parsed/tagged) candidate profile. The
 * V16 matcher historically queried only `profile_ready`/`retained`, but ~0
 * candidates ever reach those — the live pool sits in `profile_created` (most),
 * `claimed`, `reachable`, plus the active/retained tail. `prospect` (no profile
 * yet), `opted_out` and `deleted` are correctly excluded.
 */
const MATCHABLE_LIFECYCLE_STATES = [
  "profile_created",
  "reachable",
  "claimed",
  "profile_ready",
  "active_job_seeker",
  "retained",
] as const

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []
const obj = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {})

/** Map a pa-users doc into the row shape the V16 candidate scorer consumes. */
function toCandidateRow(id: string, data: Rec): MatchingCandidateRow {
  const tags = obj(data.tags ?? data.globalTags)
  return {
    userId: id,
    displayName: str(data.displayName),
    lifecycle: (str(data.candidateLifecycleState) as MatchingCandidateRow["lifecycle"]) ?? undefined,
    outreach: {
      paused: data.outreachPaused === true,
      doNotContact: data.doNotContact === true,
      reachable: typeof data.phoneE164 === "string" || typeof data.email === "string",
    },
    tagsUpdatedAt: str(data.tagsUpdatedAt) ?? str(data.updatedAt),
    tags: tags as MatchingCandidateRow["tags"],
    cvEmbedding:
      Array.isArray(data.embedding) && data.embedding.every((n) => typeof n === "number")
        ? (data.embedding as number[])
        : null,
    llmMatch: typeof data.llmMatch === "number" ? data.llmMatch : null,
  }
}

// ───────────────────────── #5 search_candidate_pool ─────────────────────────

export type SearchPoolFilters = {
  roleFunction?: string[]
  skills?: string[]
  locations?: string[]
  industrySector?: string[]
  seniorityLevel?: string
  jobType?: string
  sponsorshipAvailable?: boolean
  limit?: number
}

/**
 * Free-text candidate search with NO jobId: the agent parses the hiring brief
 * into canonical filters, we synthesize a pseudo-job from them and run the real
 * V16 candidate scorer over the retained pool. The synthetic job is stamped
 * fresh + with a non-jobright apply URL so only CANDIDATE-side gates (role /
 * visa / location / careerStage / jobType) filter; job-side freshness/liveness
 * gates pass by construction.
 */
export async function runSearchCandidatePool(
  filters: SearchPoolFilters,
  deps: { db: Db; nowMs?: number },
): Promise<{
  direction: "brief_to_candidate"
  filters: SearchPoolFilters
  candidatePool: { totalLoaded: number; totalReturned: number }
  candidates: CandidateForJobMatchResult[]
}> {
  const nowMs = deps.nowMs ?? Date.parse("2026-06-24T00:00:00.000Z")
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 50)

  const matchable = new Set<string>(MATCHABLE_LIFECYCLE_STATES as readonly string[])
  const rows = new Map<string, MatchingCandidateRow>()
  const roles = strArr(filters.roleFunction).slice(0, 10)

  if (roles.length > 0) {
    // Push the roleFunction filter to the query: load only role-relevant
    // candidates (~hundreds), never the whole pool. Lifecycle gated in-memory.
    const snap = await deps.db
      .collection("pa-users")
      .where("tags.targetRoleFunction", "array-contains-any", roles)
      .limit(600)
      .get()
    for (const doc of snap.docs) {
      const data = doc.data() as Rec
      // YC people lane — never surface a YC founder/investor as a JOB candidate (Adam-LOCKED
      // 2026-07-24). Downstream of this list an operator can email them a job interview offer.
      if (isYcPeopleUser(data)) continue
      const lc = data.candidateLifecycleState
      if (typeof lc === "string" && matchable.has(lc)) rows.set(doc.id, toCandidateRow(doc.id, data))
    }
  } else {
    // No role in the brief: bounded parallel lifecycle scan.
    const perState = await Promise.all(
      MATCHABLE_LIFECYCLE_STATES.map((lifecycle) =>
        deps.db.collection("pa-users").where("candidateLifecycleState", "==", lifecycle).limit(250).get(),
      ),
    )
    for (const snap of perState) {
      for (const doc of snap.docs) {
        const data = doc.data() as Rec
        if (isYcPeopleUser(data)) continue // YC people lane — not job candidates
        rows.set(doc.id, toCandidateRow(doc.id, data))
      }
    }
  }
  const candidates = [...rows.values()]

  const syntheticJob: MatchingJob & { embedding?: number[] | null } = {
    id: "brief",
    companyName: "(brief)",
    jobTitle: "(brief search)",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "",
    primaryUrl: "https://wekruit.com/brief",
    atsApplyUrl: "https://wekruit.com/brief",
    industry: "any",
    industryKey: undefined,
    sponsorship: filters.sponsorshipAvailable === undefined ? null : filters.sponsorshipAvailable,
    jobType: filters.jobType,
    requiredSkills: strArr(filters.skills),
    firstSeenAt: new Date(nowMs).toISOString(),
    roleFunction: strArr(filters.roleFunction),
    industrySector: strArr(filters.industrySector),
    relevantTags: [],
    locationBuckets: strArr(filters.locations),
    seniorityLevel: filters.seniorityLevel,
    dead: false,
    embedding: null,
  }

  const ranked = rankCandidatesForJob(syntheticJob, candidates, { nowMs }).slice(0, limit)
  return {
    direction: "brief_to_candidate",
    filters,
    candidatePool: { totalLoaded: candidates.length, totalReturned: ranked.length },
    candidates: ranked,
  }
}

// ───────────────────────── #6 rediscover_for_job ─────────────────────────

/**
 * Silver-medalist / retained-pool reactivation: rank candidates who already
 * carry a global tier (tier_1 strongest … from a PRIOR rejection elsewhere)
 * against a (matching-jobs) job. Surfaces the "strong candidate, wrong role —
 * try them on this one" pool that our NOT_PASS-stays-in-pool rule creates.
 */
export async function runRediscoverForJob(
  input: { jobId: string; tiers?: Array<"tier_1" | "tier_2" | "tier_3">; limit?: number },
  deps: { db: Db; nowMs?: number },
): Promise<
  | {
      direction: "rediscover"
      jobId: string
      job: Rec
      tiers: string[]
      candidatePool: { totalLoaded: number; totalReturned: number }
      candidates: Array<CandidateForJobMatchResult & { globalTier?: string; tierReusable?: boolean }>
    }
  | { direction: "rediscover"; jobId: string; error: string }
> {
  const tiers = (input.tiers && input.tiers.length ? input.tiers : ["tier_1", "tier_2"]).slice(0, 10)
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50)
  const nowMs = deps.nowMs ?? Date.parse("2026-06-24T00:00:00.000Z")

  const jobSnap = await deps.db.collection("matching-jobs").doc(input.jobId).get()
  if (!jobSnap.exists) {
    return {
      direction: "rediscover",
      jobId: input.jobId,
      error: "job_not_in_matching_jobs (rediscover currently matches the scraped catalog; collab-job support pending)",
    }
  }
  const raw = (jobSnap.data() ?? {}) as Rec
  const gt = obj(raw.globalTags)
  const job: MatchingJob & { embedding?: number[] | null } = {
    id: input.jobId,
    companyName: str(raw.companyName) ?? str(raw.companyDisplayName) ?? "Unknown company",
    jobTitle: str(raw.jobTitle) ?? str(raw.title) ?? "Open role",
    salaryMax: typeof raw.salaryMax === "number" ? raw.salaryMax : null,
    salaryMin: typeof raw.salaryMin === "number" ? raw.salaryMin : null,
    locationRaw: str(raw.locationRaw) ?? str(raw.location) ?? "",
    primaryUrl: str(raw.primaryUrl) ?? str(raw.atsApplyUrl) ?? "",
    atsApplyUrl: str(raw.atsApplyUrl),
    industry: str(raw.industry) ?? "any",
    industryKey: str(raw.industryKey),
    sponsorship: typeof raw.sponsorship === "boolean" ? raw.sponsorship : null,
    jobType: str(raw.jobType),
    requiredSkills: strArr(raw.requiredSkills).length ? strArr(raw.requiredSkills) : strArr(gt.skills),
    firstSeenAt: str(raw.firstSeenAt) ?? new Date(nowMs).toISOString(),
    roleFunction: strArr(raw.roleFunction),
    industrySector: strArr(raw.industrySector).length ? strArr(raw.industrySector) : strArr(gt.industrySector),
    relevantTags: strArr(raw.relevantTags).length ? strArr(raw.relevantTags) : strArr(gt.relevantTags),
    locationBuckets: strArr(raw.locationBuckets),
    seniorityLevel: str(raw.seniorityLevel),
    dead: typeof raw.dead === "boolean" ? raw.dead : false,
    embedding:
      Array.isArray(raw.embedding) && raw.embedding.every((n) => typeof n === "number")
        ? (raw.embedding as number[])
        : null,
  }

  const snap = await deps.db
    .collection("pa-users")
    .where("globalCandidateTier.tier", "in", tiers)
    .limit(500)
    .get()
  const tierById = new Map<string, { tier?: string; reusable?: boolean }>()
  const candidates: MatchingCandidateRow[] = []
  for (const doc of snap.docs) {
    const data = doc.data() as Rec
    if (isYcPeopleUser(data)) continue // YC people lane — never rediscovered as a job candidate
    candidates.push(toCandidateRow(doc.id, data))
    const t = obj(data.globalCandidateTier)
    tierById.set(doc.id, { tier: str(t.tier), reusable: t.reusable === true })
  }

  const isCollab = raw.wekruitCollaborationStatus === "collaborated" || raw.isWekruitCollab === true
  const ranked = rankCandidatesForJob(job, candidates, { nowMs, isCollaborationJob: isCollab }).slice(0, limit)
  return {
    direction: "rediscover",
    jobId: input.jobId,
    job: { jobId: input.jobId, jobTitle: job.jobTitle, companyName: job.companyName, roleFunction: job.roleFunction },
    tiers,
    candidatePool: { totalLoaded: candidates.length, totalReturned: ranked.length },
    candidates: ranked.map((r) => ({ ...r, ...tierById.get(r.candidateId) })),
  }
}

// ───────────────────────── #3 summarize_prescreen ─────────────────────────

async function findSessionId(
  db: Db,
  input: { sessionId?: string; jobId?: string; userId?: string },
): Promise<string | undefined> {
  if (input.sessionId) return input.sessionId
  if (input.jobId && input.userId) {
    const snap = await db
      .collection("pa-prescreen-sessions")
      .where("jobId", "==", input.jobId)
      .where("userId", "==", input.userId)
      .limit(20)
      .get()
    // newest by createdAt (no orderBy → avoid composite-index requirement)
    const docs = snap.docs.slice().sort((a, b) => {
      const ax = String((a.data() as Rec).createdAt ?? "")
      const bx = String((b.data() as Rec).createdAt ?? "")
      return bx.localeCompare(ax)
    })
    return docs[0]?.id
  }
  return undefined
}

/**
 * Prescreen TL;DR for the operator: reuses the judge output ALREADY persisted on
 * the session (per-question aggregate score/confidence + summary) — no re-LLM.
 * Returns terminal + reason, per-question scores with one-line summaries, and
 * red flags (gating-Q failures, low confidence, terminal cause, engagement).
 */
export async function runSummarizePrescreen(
  input: { sessionId?: string; jobId?: string; userId?: string },
  deps: { db: Db },
): Promise<Rec> {
  const sessionId = await findSessionId(deps.db, input)
  if (!sessionId) return { error: "no_session_found", input }
  const snap = await deps.db.collection("pa-prescreen-sessions").doc(sessionId).get()
  if (!snap.exists) return { error: "session_not_found", sessionId }
  const s = snap.data() as Rec

  const questions = obj(s.questions)
  const qOrder = strArr(s.qOrder)
  const orderedIds = qOrder.length ? qOrder : Object.keys(questions)

  const perQuestion: Array<Rec> = []
  const redFlags: string[] = []
  for (const qId of orderedIds) {
    const q = obj(questions[qId])
    const scored = obj(q.scored)
    const agg = obj(scored.aggregate)
    const finalS = typeof q.finalS === "number" ? q.finalS : typeof agg.s === "number" ? agg.s : undefined
    const finalC = typeof q.finalC === "number" ? q.finalC : typeof agg.c === "number" ? agg.c : undefined
    perQuestion.push({
      qId,
      type: str(q.type),
      weight: typeof q.weight === "number" ? q.weight : undefined,
      score: finalS,
      confidence: finalC,
      clarifyRounds: typeof q.clarifyRounds === "number" ? q.clarifyRounds : undefined,
      summary: str(agg.summary),
      terminalCause: str(q.terminalCause),
      lastReply: strArr(q.evidenceReplies).slice(-1)[0],
    })
    if (str(q.terminalCause)) redFlags.push(`${qId}: ${str(q.terminalCause)}`)
    if (str(q.type) === "MUST_HAVE" && typeof finalS === "number" && finalS < 0.5) {
      redFlags.push(`${qId}: weak must-have (score ${finalS.toFixed(2)})`)
    }
  }

  const review = obj(s.review)
  const engagement = obj(review.engagementSignal)
  return {
    sessionId,
    userId: str(s.userId),
    jobId: str(s.jobId),
    terminal: str(s.terminal) ?? "IN_PROGRESS",
    terminalReason: str(s.terminalReason),
    score: typeof s.score === "number" ? s.score : undefined,
    scoreMax: typeof s.scoreMax === "number" ? s.scoreMax : undefined,
    threshold: typeof s.threshold === "number" ? s.threshold : undefined,
    ratio:
      typeof s.score === "number" && typeof s.scoreMax === "number" && s.scoreMax > 0
        ? Number((s.score / s.scoreMax).toFixed(3))
        : undefined,
    engagement: engagement.level ? { level: str(engagement.level), evidence: str(engagement.evidence) } : undefined,
    redFlags,
    perQuestion,
    createdAt: str(s.createdAt),
    updatedAt: str(s.updatedAt),
  }
}

// ───────────────────────── #4 get_scheduling_status ─────────────────────────

/** Read Cal.com interview-booking state for a candidate (one row per job). */
export async function runSchedulingStatus(
  input: { userId: string; jobId?: string },
  deps: { db: Db },
): Promise<{ userId: string; bookings: Rec[] }> {
  let q = deps.db.collection("pa-interview-bookings").where("userId", "==", input.userId)
  if (input.jobId) q = q.where("jobId", "==", input.jobId)
  const snap = await q.limit(25).get()
  const bookings = snap.docs.map((d) => {
    const b = d.data() as Rec
    return {
      id: d.id,
      jobId: str(b.jobId),
      status: str(b.status),
      timeZone: str(b.timeZone),
      offeredCount: Array.isArray(b.offeredSlots) ? b.offeredSlots.length : 0,
      selectedSlotIso: str(b.selectedSlotIso),
      meetingUrl: str(b.meetingUrl),
      confirmationEmailSentAt: str(b.confirmationEmailSentAt),
      lastError: str(b.lastError),
      updatedAt: str(b.updatedAt),
    }
  })
  return { userId: input.userId, bookings }
}
