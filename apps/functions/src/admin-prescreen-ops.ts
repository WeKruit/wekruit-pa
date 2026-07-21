import { getFirestore, type Firestore, type Query } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { z } from "zod"
import {
  PA_COLLECTIONS,
  classifyCandidateProfile,
  classifyPrescreenReviewRow,
  deriveCandidateSource,
  summarizePrescreenReviewRows,
  type CandidateClass,
  type CandidateListUserDoc,
  type PrescreenOpsBucketCounts,
  type PrescreenOpsCommittedCounts,
  type PrescreenOpsJobRollup,
  type PrescreenOpsReviewState,
  type PrescreenOpsSessionCursor,
  type PrescreenOpsSessionReview,
  type PrescreenOpsSessionRow,
  type PrescreenOpsSnapshotOpsResponse,
  type PrescreenOpsSnapshotResponse,
  type PrescreenOpsSnapshotSessionsResponse,
  type PrescreenOpsTerminalCounts,
  type PrescreenOpsTotals,
  type PrescreenReviewQuestion,
} from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const PRESCREEN_SESSIONS = "pa-prescreen-sessions"
const SCAN_BATCH_SIZE = 300
const SCAN_CAP = 5_000
const SESSIONS_DEFAULT_LIMIT = 50
const SESSIONS_MAX_LIMIT = 200

/**
 * Field mask for the batched ops scan — drops the heavy cfgSnapshot /
 * workSession payloads so a 5k-doc scan stays inside the callable memory
 * budget. `questions` is kept because bucket classification and review
 * drawers need it.
 */
const SESSION_FIELD_MASK = [
  "userId",
  "jobId",
  "terminal",
  "terminalReason",
  "score",
  "scoreMax",
  "threshold",
  "createdAt",
  "updatedAt",
  "terminalActionPendingReview",
  "terminalActionFiredAt",
  "evaluationAttemptId",
  "review",
  "questions",
  "testMode",
  "isDemo",
  "demoSourcePool",
  "e164",
] as const

const SessionCursorSchema = z.object({
  createdAt: z.string().min(1),
  docId: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
})

const SessionSortSchema = z.enum(["strict_priority", "score_desc", "oldest", "newest"])

export const AdminPrescreenOpsSnapshotInputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("ops"),
    includeTest: z.boolean().optional(),
    adminToken: z.string().optional(),
  }),
  z.object({
    mode: z.literal("sessions"),
    jobId: z.string().optional(),
    /** Restrict to these candidate userIds — used by the Algolia name search
     *  (name → pa_candidates objectIDs → their sessions, whole pool, no scan). */
    userIds: z.array(z.string()).max(200).optional(),
    queue: z.enum(["pending", "committed", "all"]).optional(),
    bucket: z.string().optional(),
    includeTest: z.boolean().optional(),
    sort: SessionSortSchema.optional(),
    limit: z.number().int().optional(),
    cursor: SessionCursorSchema.optional(),
    adminToken: z.string().optional(),
  }),
])
export type AdminPrescreenOpsSnapshotInput = z.infer<typeof AdminPrescreenOpsSnapshotInputSchema>

type SessionTerminal = "PASS" | "FAIL" | "HARD_STOP" | "PAUSE"

type SessionScanRecord = {
  id: string
  userId: string
  jobId: string
  terminal: SessionTerminal | null
  terminalReason?: string
  score: number
  scoreMax: number
  threshold?: number
  createdAt: string
  updatedAt?: string
  terminalActionPendingReview?: boolean
  terminalActionFiredAt?: string
  evaluationAttemptId?: string
  review?: PrescreenOpsSessionReview
  questions?: Record<string, PrescreenReviewQuestion>
  testMode?: boolean
  isDemo?: boolean
  demoSourcePool?: string
  e164?: string
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  return firstString(record[key])
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function cleanTerminal(value: unknown): SessionTerminal | null {
  return value === "PASS" || value === "FAIL" || value === "HARD_STOP" || value === "PAUSE" ? value : null
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function toSessionRecord(id: string, raw: Record<string, unknown>): SessionScanRecord {
  const review =
    raw.review && typeof raw.review === "object" && !Array.isArray(raw.review)
      ? (raw.review as PrescreenOpsSessionReview)
      : undefined
  const questions =
    raw.questions && typeof raw.questions === "object" && !Array.isArray(raw.questions)
      ? (raw.questions as Record<string, PrescreenReviewQuestion>)
      : undefined
  return {
    id,
    userId: cleanString(raw.userId) ?? "",
    jobId: cleanString(raw.jobId) ?? "",
    terminal: cleanTerminal(raw.terminal),
    ...(cleanString(raw.terminalReason) ? { terminalReason: cleanString(raw.terminalReason) } : {}),
    score: finiteNumber(raw.score),
    scoreMax: finiteNumber(raw.scoreMax),
    ...(typeof raw.threshold === "number" && Number.isFinite(raw.threshold) ? { threshold: raw.threshold } : {}),
    createdAt: cleanString(raw.createdAt) ?? "",
    ...(cleanString(raw.updatedAt) ? { updatedAt: cleanString(raw.updatedAt) } : {}),
    ...(raw.terminalActionPendingReview === true ? { terminalActionPendingReview: true } : {}),
    ...(cleanString(raw.terminalActionFiredAt) ? { terminalActionFiredAt: cleanString(raw.terminalActionFiredAt) } : {}),
    ...(cleanString(raw.evaluationAttemptId) ? { evaluationAttemptId: cleanString(raw.evaluationAttemptId) } : {}),
    ...(review ? { review } : {}),
    ...(questions ? { questions } : {}),
    ...(raw.testMode === true ? { testMode: true } : {}),
    ...(raw.isDemo === true ? { isDemo: true } : {}),
    ...(cleanString(raw.demoSourcePool) ? { demoSourcePool: cleanString(raw.demoSourcePool) } : {}),
    ...(cleanString(raw.e164) ? { e164: cleanString(raw.e164) } : {}),
  }
}

/**
 * Port of `buildCandidateClassifierDoc` from
 * apps/dashboard-web/src/pages/PrescreenSessionsList.tsx so server-side
 * real-vs-test classification is bit-identical to the dashboard's.
 */
function buildCandidateClassifierDoc(
  row: Pick<SessionScanRecord, "userId" | "e164" | "testMode" | "isDemo" | "demoSourcePool">,
  rawUserDoc: Record<string, unknown> | null,
): CandidateListUserDoc {
  const userDoc = rawUserDoc ?? {}
  return {
    id: firstString(row.userId) ?? row.userId,
    phoneE164: firstString(
      userDoc.phoneE164,
      userDoc.e164,
      nestedString(userDoc.identity, "phoneE164"),
      nestedString(userDoc.identity, "e164"),
      nestedString(userDoc.contact, "phoneE164"),
      nestedString(userDoc.contact, "e164"),
      row.e164,
    ),
    email: firstString(userDoc.email, nestedString(userDoc.identity, "email"), nestedString(userDoc.contact, "email")),
    linkedinUrl: firstString(
      userDoc.linkedinUrl,
      userDoc.linkedInUrl,
      userDoc.linkedinURL,
      nestedString(userDoc.identity, "linkedinUrl"),
      nestedString(userDoc.contact, "linkedinUrl"),
    ),
    signupSource: firstString(userDoc.signupSource),
    source: firstString(userDoc.source),
    candidateLifecycleState: firstString(userDoc.candidateLifecycleState),
    onboardingStatus: firstString(userDoc.onboardingStatus),
    latestResumeArtifactId: firstString(userDoc.latestResumeArtifactId),
    piiConsentAt: firstString(userDoc.piiConsentAt),
    mem0UserId: firstString(userDoc.mem0UserId),
    testMode: userDoc.testMode === true || row.testMode === true,
    isDemo: userDoc.isDemo === true || row.isDemo === true,
    demoSourcePool: firstString(userDoc.demoSourcePool, row.demoSourcePool),
  }
}

function classifySessionCandidate(
  session: SessionScanRecord,
  userDocs: Map<string, Record<string, unknown> | null>,
): CandidateClass {
  const candidateDoc = buildCandidateClassifierDoc(session, userDocs.get(session.userId) ?? null)
  const source = deriveCandidateSource(candidateDoc)
  return classifyCandidateProfile(source, candidateDoc)
}

function hasCommittedReview(session: SessionScanRecord): boolean {
  return Boolean(cleanString(session.review?.finalTerminal))
}

function isStrandedNoReview(session: SessionScanRecord): boolean {
  return (
    (session.terminal === "PASS" || session.terminal === "FAIL" || session.terminal === "HARD_STOP") &&
    session.terminalActionPendingReview !== true &&
    !session.review &&
    !cleanString(session.terminalActionFiredAt)
  )
}

function deriveReviewState(session: SessionScanRecord): PrescreenOpsReviewState {
  if (session.terminal === null) return "in_progress"
  if (hasCommittedReview(session)) return "committed"
  if (session.terminalActionPendingReview === true) return "pending"
  if (session.terminal === "PAUSE") return "paused"
  if (cleanString(session.terminalActionFiredAt)) return "auto_finalized"
  return "stranded"
}

function emptyTerminalCounts(): PrescreenOpsTerminalCounts {
  return { PASS: 0, FAIL: 0, HARD_STOP: 0, PAUSE: 0, IN_PROGRESS: 0 }
}

function emptyCommittedCounts(): PrescreenOpsCommittedCounts {
  return { PASS: 0, FAIL: 0, HARD_STOP: 0 }
}

function tallyTerminals(sessions: SessionScanRecord[]): PrescreenOpsTerminalCounts {
  const counts = emptyTerminalCounts()
  for (const session of sessions) {
    if (session.terminal === null) counts.IN_PROGRESS += 1
    else counts[session.terminal] += 1
  }
  return counts
}

function tallyCommitted(sessions: SessionScanRecord[]): PrescreenOpsCommittedCounts {
  const counts = emptyCommittedCounts()
  for (const session of sessions) {
    const finalTerminal = cleanString(session.review?.finalTerminal)
    if (finalTerminal === "PASS" || finalTerminal === "FAIL" || finalTerminal === "HARD_STOP") {
      counts[finalTerminal] += 1
    }
  }
  return counts
}

function tallyBuckets(sessions: SessionScanRecord[]): PrescreenOpsBucketCounts {
  const summary = summarizePrescreenReviewRows(sessions)
  return {
    top_five_pass: summary.topFivePass,
    batch_reject: summary.batchReject,
    individual_review: summary.individualReview,
    hard_stop: summary.hardStop,
    paused: summary.paused,
  }
}

function isAutoFinalizedNoReview(session: SessionScanRecord): boolean {
  // Backfilled tier-2 docs carry review.status="legacy_unreviewed" — still
  // auto-finalized until an operator commits a finalTerminal.
  return (
    Boolean(cleanString(session.terminalActionFiredAt)) &&
    !hasCommittedReview(session) &&
    session.terminalActionPendingReview !== true
  )
}

async function loadDocsById(
  db: Firestore,
  collection: string,
  ids: string[],
): Promise<Map<string, Record<string, unknown> | null>> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.trim()))]
  const out = new Map<string, Record<string, unknown> | null>()
  for (const batch of chunk(unique, 100)) {
    const snaps = await db.getAll(...batch.map((id) => db.collection(collection).doc(id)))
    snaps.forEach((snap, index) => {
      out.set(batch[index]!, snap.exists ? (snap.data() as Record<string, unknown>) : null)
    })
  }
  return out
}

async function scanSessions(db: Firestore): Promise<{ sessions: SessionScanRecord[]; truncated: boolean }> {
  const sessions: SessionScanRecord[] = []
  let cursor: string | undefined
  let truncated = false
  for (;;) {
    let query: Query = db
      .collection(PRESCREEN_SESSIONS)
      .orderBy("createdAt", "desc")
      .select(...SESSION_FIELD_MASK)
      .limit(SCAN_BATCH_SIZE)
    if (cursor !== undefined) query = query.startAfter(cursor)
    const snap = await query.get()
    for (const doc of snap.docs) {
      sessions.push(toSessionRecord(doc.id, (doc.data() ?? {}) as Record<string, unknown>))
    }
    if (snap.docs.length < SCAN_BATCH_SIZE) break
    if (sessions.length >= SCAN_CAP) {
      truncated = true
      break
    }
    const last = sessions[sessions.length - 1]!.createdAt
    if (!last || last === cursor) break
    cursor = last
  }
  return { sessions: sessions.slice(0, SCAN_CAP), truncated }
}

function buildJobRollups(args: {
  sessions: SessionScanRecord[]
  realSessionIds: Set<string>
  includeTest: boolean
  jobDocs: Map<string, Record<string, unknown> | null>
}): PrescreenOpsJobRollup[] {
  const groups = new Map<string, SessionScanRecord[]>()
  for (const session of args.sessions) {
    const jobId = session.jobId || "unknown"
    const group = groups.get(jobId)
    if (group) group.push(session)
    else groups.set(jobId, [session])
  }

  const rollups: PrescreenOpsJobRollup[] = []
  for (const [jobId, group] of groups) {
    const real = group.filter((session) => args.realSessionIds.has(session.id))
    const kpiSessions = args.includeTest ? group : real
    const job = args.jobDocs.get(jobId) ?? {}
    rollups.push({
      jobId,
      title:
        firstString(job.title, job.roleTitle, job.jobTitle, nestedString(job.prescreenConfig, "jobTitle")) ?? jobId,
      company: firstString(job.company, job.companyName, nestedString(job.prescreenConfig, "company")) ?? "",
      jobStatus: firstString(job.status) ?? "unknown",
      sessionCount: group.length,
      realSessionCount: real.length,
      testSessionCount: group.length - real.length,
      byTerminal: tallyTerminals(kpiSessions),
      pendingReview: kpiSessions.filter((session) => session.terminalActionPendingReview === true).length,
      committed: tallyCommitted(kpiSessions),
      autoFinalized: kpiSessions.filter(isAutoFinalizedNoReview).length,
      stranded: kpiSessions.filter(isStrandedNoReview).length,
      byBucket: tallyBuckets(kpiSessions),
      lastSessionAt: group.reduce((max, session) => (session.createdAt > max ? session.createdAt : max), ""),
    })
  }
  rollups.sort((a, b) => b.lastSessionAt.localeCompare(a.lastSessionAt))
  return rollups
}

async function runOpsMode(
  deps: { db: Firestore; now?: () => string },
  input: Extract<AdminPrescreenOpsSnapshotInput, { mode: "ops" }>,
): Promise<PrescreenOpsSnapshotOpsResponse> {
  const includeTest = input.includeTest === true
  const [countSnap, scan] = await Promise.all([
    deps.db.collection(PRESCREEN_SESSIONS).count().get(),
    scanSessions(deps.db),
  ])
  const exactSessionCount = finiteNumber((countSnap.data() as { count?: unknown }).count)

  const userDocs = await loadDocsById(deps.db, PA_COLLECTIONS.users, scan.sessions.map((session) => session.userId))
  const realSessionIds = new Set<string>()
  for (const session of scan.sessions) {
    if (classifySessionCandidate(session, userDocs) === "candidate_account") realSessionIds.add(session.id)
  }
  const realSessions = scan.sessions.filter((session) => realSessionIds.has(session.id))
  const kpiSessions = includeTest ? scan.sessions : realSessions

  const byTerminal = tallyTerminals(kpiSessions)
  const totals: PrescreenOpsTotals = {
    sessions: exactSessionCount,
    realSessions: realSessions.length,
    testSessions: scan.sessions.length - realSessions.length,
    inProgress: byTerminal.IN_PROGRESS,
    byTerminal,
    pendingHumanReview: kpiSessions.filter((session) => session.terminalActionPendingReview === true).length,
    committed: tallyCommitted(kpiSessions),
    autoFinalizedNoReview: kpiSessions.filter(isAutoFinalizedNoReview).length,
    strandedNoReview: kpiSessions.filter(isStrandedNoReview).length,
    byBucket: tallyBuckets(kpiSessions),
  }

  const jobDocs = await loadDocsById(
    deps.db,
    PA_COLLECTIONS.jobs,
    scan.sessions.map((session) => session.jobId).filter((jobId) => jobId.length > 0),
  )
  const jobs = buildJobRollups({ sessions: scan.sessions, realSessionIds, includeTest, jobDocs })

  return {
    generatedAt: deps.now?.() ?? new Date().toISOString(),
    scanned: scan.sessions.length,
    truncated: scan.truncated,
    totals,
    jobs,
  }
}

/** Candidate display name from the pa-users doc, so sessions are searchable by name. */
function candidateDisplayName(userDoc: Record<string, unknown> | null | undefined): string | undefined {
  if (!userDoc) return undefined
  const direct = firstString(
    userDoc.displayName,
    userDoc.name,
    userDoc.fullName,
    userDoc.candidateName,
    nestedString(userDoc.level1Info, "name"),
    nestedString(userDoc.pii, "name"),
  )
  if (direct) return direct
  const combined = [cleanString(userDoc.firstName), cleanString(userDoc.lastName)].filter(Boolean).join(" ").trim()
  if (combined) return combined
  return firstString(userDoc.email, userDoc.phone, userDoc.phoneNumber)
}

function buildSessionRow(
  session: SessionScanRecord,
  candidateClass: CandidateClass,
  job: Record<string, unknown>,
  candidateName?: string,
): PrescreenOpsSessionRow {
  const classification = classifyPrescreenReviewRow(session)
  const jobTitle = firstString(job.title, job.roleTitle, job.jobTitle, nestedString(job.prescreenConfig, "jobTitle"))
  const jobCompany = firstString(job.company, job.companyName, nestedString(job.prescreenConfig, "company"))
  return {
    id: session.id,
    userId: session.userId,
    ...(candidateName ? { candidateName } : {}),
    jobId: session.jobId,
    ...(jobTitle ? { jobTitle } : {}),
    ...(jobCompany ? { jobCompany } : {}),
    terminal: session.terminal,
    ...(session.terminalReason ? { terminalReason: session.terminalReason } : {}),
    score: session.score,
    scoreMax: session.scoreMax,
    ...(typeof session.threshold === "number" ? { threshold: session.threshold } : {}),
    createdAt: session.createdAt,
    ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
    ...(session.terminalActionPendingReview === true ? { terminalActionPendingReview: true } : {}),
    ...(session.terminalActionFiredAt ? { terminalActionFiredAt: session.terminalActionFiredAt } : {}),
    ...(session.evaluationAttemptId ? { evaluationAttemptId: session.evaluationAttemptId } : {}),
    ...(session.review ? { review: session.review } : {}),
    ...(session.questions ? { questions: session.questions } : {}),
    classification: {
      bucket: classification.bucket,
      label: classification.label,
      reasons: classification.reasons,
    },
    reviewState: deriveReviewState(session),
    candidateClass,
  }
}

function prescreenScoreRatio(session: Pick<SessionScanRecord, "score" | "scoreMax">): number {
  const max = finiteNumber(session.scoreMax)
  if (max <= 0) return 0
  return finiteNumber(session.score) / max
}

function compareScoreDesc(
  a: Pick<SessionScanRecord, "id" | "score" | "scoreMax" | "createdAt">,
  b: Pick<SessionScanRecord, "id" | "score" | "scoreMax" | "createdAt">,
): number {
  const ratioDelta = prescreenScoreRatio(b) - prescreenScoreRatio(a)
  if (ratioDelta !== 0) return ratioDelta
  const scoreDelta = finiteNumber(b.score) - finiteNumber(a.score)
  if (scoreDelta !== 0) return scoreDelta
  const timeDelta = b.createdAt.localeCompare(a.createdAt)
  if (timeDelta !== 0) return timeDelta
  return b.id.localeCompare(a.id)
}

async function scanSessionRecordsForPage(
  db: Firestore,
  input: Extract<AdminPrescreenOpsSnapshotInput, { mode: "sessions" }>,
): Promise<SessionScanRecord[]> {
  const records: SessionScanRecord[] = []
  let cursor: PrescreenOpsSessionCursor | undefined
  for (;;) {
    let query: Query = db.collection(PRESCREEN_SESSIONS)
    const jobId = cleanString(input.jobId)
    if (jobId) query = query.where("jobId", "==", jobId)
    if (input.queue === "pending") query = query.where("terminalActionPendingReview", "==", true)
    query = query.orderBy("createdAt", "desc").orderBy("__name__", "desc")
    if (cursor) query = query.startAfter(cursor.createdAt, cursor.docId)
    query = query.select(...SESSION_FIELD_MASK).limit(SCAN_BATCH_SIZE)

    const snap = await query.get()
    if (snap.docs.length === 0) break
    const batch = snap.docs.map((doc) => toSessionRecord(doc.id, (doc.data() ?? {}) as Record<string, unknown>))
    records.push(...batch)
    if (snap.docs.length < SCAN_BATCH_SIZE || records.length >= SCAN_CAP) break
    const last = batch[batch.length - 1]
    if (!last?.createdAt) break
    cursor = { createdAt: last.createdAt, docId: last.id }
  }
  return records.slice(0, SCAN_CAP)
}

async function runScoreSortedSessionsMode(
  deps: { db: Firestore; now?: () => string },
  input: Extract<AdminPrescreenOpsSnapshotInput, { mode: "sessions" }>,
  pageLimit: number,
): Promise<PrescreenOpsSnapshotSessionsResponse> {
  const records = await scanSessionRecordsForPage(deps.db, input)
  const userDocs = await loadDocsById(deps.db, PA_COLLECTIONS.users, records.map((record) => record.userId))
  const bucket = cleanString(input.bucket)
  const candidates = records.flatMap((record) => {
    const candidateClass = classifySessionCandidate(record, userDocs)
    if (input.includeTest !== true && candidateClass !== "candidate_account") return []
    if (input.queue === "committed" && !hasCommittedReview(record)) return []
    const classification = classifyPrescreenReviewRow(record)
    if (bucket && classification.bucket !== bucket) return []
    return [{ record, candidateClass }]
  })

  candidates.sort((a, b) => compareScoreDesc(a.record, b.record))

  const offset = input.cursor?.offset ?? 0
  const page = candidates.slice(offset, offset + pageLimit)
  const nextOffset = offset + page.length
  const lastInPage = page[page.length - 1]?.record
  const nextCursor: PrescreenOpsSessionCursor | undefined =
    nextOffset < candidates.length && lastInPage
      ? { createdAt: lastInPage.createdAt, docId: lastInPage.id, offset: nextOffset }
      : undefined

  const jobDocs = await loadDocsById(
    deps.db,
    PA_COLLECTIONS.jobs,
    page.map((item) => item.record.jobId).filter((jobId) => jobId.length > 0),
  )
  return {
    rows: page.map((item) =>
      buildSessionRow(
        item.record,
        item.candidateClass,
        jobDocs.get(item.record.jobId) ?? {},
        candidateDisplayName(userDocs.get(item.record.userId)),
      ),
    ),
    ...(nextCursor ? { nextCursor } : {}),
  }
}

/**
 * Whole-pool name search path: the dashboard resolves a typed name to candidate
 * userIds via Algolia (pa_candidates) and passes them here. We fetch only those
 * users' sessions (chunked `userId in` — single-field, auto-indexed, no scan),
 * so the search covers every session without loading pages.
 */
async function runUserIdsSessionsMode(
  deps: { db: Firestore },
  input: Extract<AdminPrescreenOpsSnapshotInput, { mode: "sessions" }>,
  userIds: string[],
): Promise<PrescreenOpsSnapshotSessionsResponse> {
  const uniqueIds = [...new Set(userIds.filter((id) => typeof id === "string" && id.trim()))].slice(0, 200)
  if (uniqueIds.length === 0) return { rows: [] }
  const jobIdFilter = cleanString(input.jobId)

  const records: SessionScanRecord[] = []
  for (let i = 0; i < uniqueIds.length; i += 10) {
    const chunk = uniqueIds.slice(i, i + 10)
    const snap = await deps.db.collection(PRESCREEN_SESSIONS).where("userId", "in", chunk).select(...SESSION_FIELD_MASK).get()
    for (const doc of snap.docs) {
      records.push(toSessionRecord(doc.id, (doc.data() ?? {}) as Record<string, unknown>))
    }
  }

  const [userDocs, jobDocs] = await Promise.all([
    loadDocsById(deps.db, PA_COLLECTIONS.users, uniqueIds),
    loadDocsById(deps.db, PA_COLLECTIONS.jobs, records.map((r) => r.jobId).filter((j) => j.length > 0)),
  ])
  const bucket = cleanString(input.bucket)
  const rows = records.flatMap((record) => {
    if (jobIdFilter && record.jobId !== jobIdFilter) return []
    const candidateClass = classifySessionCandidate(record, userDocs)
    if (input.includeTest !== true && candidateClass !== "candidate_account") return []
    if (input.queue === "pending" && record.terminalActionPendingReview !== true) return []
    if (input.queue === "committed" && !hasCommittedReview(record)) return []
    const row = buildSessionRow(
      record,
      candidateClass,
      jobDocs.get(record.jobId) ?? {},
      candidateDisplayName(userDocs.get(record.userId)),
    )
    if (bucket && row.classification.bucket !== bucket) return []
    return [row]
  })
  rows.sort((a, b) => compareScoreDesc(a, b))
  return { rows }
}

async function runSessionsMode(
  deps: { db: Firestore; now?: () => string },
  input: Extract<AdminPrescreenOpsSnapshotInput, { mode: "sessions" }>,
): Promise<PrescreenOpsSnapshotSessionsResponse> {
  if (input.userIds && input.userIds.length) {
    return runUserIdsSessionsMode(deps, input, input.userIds)
  }
  const pageLimit = Math.max(1, Math.min(SESSIONS_MAX_LIMIT, input.limit ?? SESSIONS_DEFAULT_LIMIT))
  if (input.sort === "score_desc") {
    return runScoreSortedSessionsMode(deps, input, pageLimit)
  }

  let query: Query = deps.db.collection(PRESCREEN_SESSIONS)
  const jobId = cleanString(input.jobId)
  if (jobId) query = query.where("jobId", "==", jobId)
  if (input.queue === "pending") query = query.where("terminalActionPendingReview", "==", true)
  query = query.orderBy("createdAt", "desc").orderBy("__name__", "desc")
  if (input.cursor) query = query.startAfter(input.cursor.createdAt, input.cursor.docId)
  query = query.select(...SESSION_FIELD_MASK).limit(pageLimit + 1)
  const snap = await query.get()

  const records = snap.docs.map((doc) => toSessionRecord(doc.id, (doc.data() ?? {}) as Record<string, unknown>))
  const hasMore = records.length > pageLimit
  const page = records.slice(0, pageLimit)
  const lastInPage = page[page.length - 1]
  const nextCursor: PrescreenOpsSessionCursor | undefined =
    hasMore && lastInPage ? { createdAt: lastInPage.createdAt, docId: lastInPage.id } : undefined

  const [userDocs, jobDocs] = await Promise.all([
    loadDocsById(deps.db, PA_COLLECTIONS.users, page.map((record) => record.userId)),
    loadDocsById(
      deps.db,
      PA_COLLECTIONS.jobs,
      page.map((record) => record.jobId).filter((jobId) => jobId.length > 0),
    ),
  ])
  const bucket = cleanString(input.bucket)
  const rows = page.flatMap((record) => {
    const candidateClass = classifySessionCandidate(record, userDocs)
    if (input.includeTest !== true && candidateClass !== "candidate_account") return []
    if (input.queue === "committed" && !hasCommittedReview(record)) return []
    const row = buildSessionRow(
      record,
      candidateClass,
      jobDocs.get(record.jobId) ?? {},
      candidateDisplayName(userDocs.get(record.userId)),
    )
    if (bucket && row.classification.bucket !== bucket) return []
    return [row]
  })

  return {
    rows,
    ...(nextCursor ? { nextCursor } : {}),
  }
}

export async function runAdminPrescreenOpsSnapshot(
  raw: unknown,
  deps: { db: Firestore; now?: () => string },
): Promise<PrescreenOpsSnapshotResponse> {
  const parsed = AdminPrescreenOpsSnapshotInputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }
  if (parsed.data.mode === "ops") {
    return runOpsMode(deps, parsed.data)
  }
  return runSessionsMode(deps, parsed.data)
}

export const paAdminPrescreenOpsSnapshot = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 120, maxInstances: 1, secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminPrescreenOpsSnapshot(req.data, { db: getFirestore() })
  },
)
