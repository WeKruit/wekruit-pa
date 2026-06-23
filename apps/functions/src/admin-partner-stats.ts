import { getFirestore, type Firestore, Timestamp } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { z } from "zod"
import {
  CandidateJobStateSchema,
  PA_COLLECTIONS,
  PA_USER_SOURCES,
  type CandidateJobState,
  type PaUserSource,
} from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const InputSchema = z.object({
  partnerSource: z.string().optional(),
  adminToken: z.string().optional(),
})

function toIso(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value
  if (value instanceof Timestamp) return value.toDate().toISOString()
  if (typeof value === "object" && value !== null && "_seconds" in value) {
    const sec = Number((value as { _seconds?: unknown })._seconds ?? 0)
    return new Date(sec * 1000).toISOString()
  }
  return fallback
}

function entryOf(raw: unknown): { source?: string; jobId?: string } {
  const o = raw && typeof raw === "object" ? (raw as { source?: unknown; jobId?: unknown }) : null
  return {
    source: typeof o?.source === "string" ? o.source : undefined,
    jobId: typeof o?.jobId === "string" ? o.jobId : undefined,
  }
}

export interface PartnerStatsFunnelSummary {
  signedUp: number
  withResume: number
  withSkills: number
  enteredJobFlow: number
  prescreenStarted: number
  prescreenReviewPending: number
  pendingHumanReview: number
  awaitingHmResponse: number
  passed: number
  rejected: number
  notPassed: number
  employerVisible: number
}

export interface PartnerStatsUserRow {
  userId: string
  email: string
  displayName?: string
  registeredAt: string
  lifecycleState?: string
  source?: string
  entrySource?: string
  entryJobId?: string
  attributedVia: "top_level" | "entry" | "both"
  hasResume: boolean
  resumeStatus?: string
  roleFunction: string[]
  careerStage?: string
  yoeRange?: string
  topSkills: string[]
  jobs: Array<{
    jobId: string
    jobTitle: string
    company: string
    state: CandidateJobState
    stateUpdatedAt: string
    reviewStatus?: string
    aiVerdict?: string
    prescreenTerminal?: string
    prescreenScore?: number
  }>
  currentStage: string
}

export interface PartnerStatsSnapshot {
  generatedAt: string
  partnerSource: string
  funnel: PartnerStatsFunnelSummary
  users: PartnerStatsUserRow[]
  allPartnerSources: string[]
}

async function buildSnapshot(db: Firestore, partnerSource?: string): Promise<PartnerStatsSnapshot> {
  const partnerSources = PA_USER_SOURCES.filter(
    (s) => s !== "admin" && s !== "dev_test" && s !== "e2e_run" && s !== "qa_run",
  )

  const allSourcesInDb = new Set<string>()
  const allDocs = await db.collection(PA_COLLECTIONS.users).get()
  for (const d of allDocs.docs) {
    const u = d.data()
    if (typeof u.source === "string" && u.source) allSourcesInDb.add(u.source)
    const fe = entryOf(u.firstSignupEntry)
    const le = entryOf(u.lastSignupEntry)
    if (fe.source) allSourcesInDb.add(fe.source)
    if (le.source) allSourcesInDb.add(le.source)
  }
  const knownPartnerSources = [...allSourcesInDb].filter(
    (s) => s !== "admin" && s !== "dev_test" && s !== "e2e_run" && s !== "qa_run" && s !== "candidate",
  ).sort()

  const targetSource = partnerSource || "layoffhedge"

  const cohort: Array<{ id: string; data: Record<string, unknown> }> = []
  for (const d of allDocs.docs) {
    const u = d.data()
    const topMatch = u.source === targetSource
    const fe = entryOf(u.firstSignupEntry)
    const le = entryOf(u.lastSignupEntry)
    const entryMatch = fe.source === targetSource || le.source === targetSource
    if (topMatch || entryMatch) {
      cohort.push({ id: d.id, data: u })
    }
  }

  cohort.sort((a, b) => {
    const ac = toIso(a.data.createdAt, "")
    const bc = toIso(b.data.createdAt, "")
    return ac < bc ? 1 : ac > bc ? -1 : 0
  })

  const funnel: PartnerStatsFunnelSummary = {
    signedUp: 0,
    withResume: 0,
    withSkills: 0,
    enteredJobFlow: 0,
    prescreenStarted: 0,
    prescreenReviewPending: 0,
    pendingHumanReview: 0,
    awaitingHmResponse: 0,
    passed: 0,
    rejected: 0,
    notPassed: 0,
    employerVisible: 0,
  }
  funnel.signedUp = cohort.length

  const cohortIds = cohort.map((c) => c.id)
  const prescreenByUserJob = new Map<string, { terminal?: string; score?: number }>()
  const CHUNK = 30
  for (let i = 0; i < cohortIds.length; i += CHUNK) {
    const chunk = cohortIds.slice(i, i + CHUNK)
    const snap = await db.collection("pa-prescreen-sessions")
      .where("userId", "in", chunk)
      .select("userId", "jobId", "terminal", "score", "scoreMax")
      .get().catch(() => ({ docs: [] as Array<{ data: () => Record<string, unknown> }> }))
    for (const d of snap.docs) {
      const ps = d.data()
      const uid = ps.userId as string | undefined
      const jid = ps.jobId as string | undefined
      if (!uid || !jid) continue
      const key = `${uid}__${jid}`
      const existing = prescreenByUserJob.get(key)
      const terminal = typeof ps.terminal === "string" ? ps.terminal : undefined
      if (!existing || terminal === "PASS" || (terminal && !existing.terminal)) {
        const scoreVal = typeof ps.score === "number" ? ps.score : undefined
        const maxVal = typeof ps.scoreMax === "number" ? ps.scoreMax : undefined
        prescreenByUserJob.set(key, {
          terminal,
          score: scoreVal != null && maxVal ? Math.round((scoreVal / maxVal) * 100) : undefined,
        })
      }
    }
  }

  const rows: PartnerStatsUserRow[] = await Promise.all(
    cohort.map(async ({ id, data: u }) => {
      const topMatch = u.source === targetSource
      const fe = entryOf(u.firstSignupEntry)
      const le = entryOf(u.lastSignupEntry)
      const entryMatch = fe.source === targetSource || le.source === targetSource
      const entrySource = entryMatch ? targetSource : (fe.source ?? le.source)
      const entryJobId =
        (fe.source === targetSource ? fe.jobId : undefined) ??
        (le.source === targetSource ? le.jobId : undefined) ??
        fe.jobId ?? le.jobId
      const attributedVia = topMatch && entryMatch ? "both" as const : topMatch ? "top_level" as const : "entry" as const

      const resumeSnap = await db.collection("parsedCandidateResumes")
        .where("userId", "==", id).limit(1).get().catch(() => ({ size: 0 }))
      const hasResume = resumeSnap.size > 0 || u.resumeStatus === "parsed"
      const resumeStatus = (u.resumeStatus as string | undefined) ?? (hasResume ? "parsed" : "none")
      if (hasResume) funnel.withResume++

      const tags = (u.tags && typeof u.tags === "object" ? u.tags : {}) as Record<string, unknown>
      const skillsRaw = Array.isArray(tags.skills) ? tags.skills : []
      const topSkills = skillsRaw
        .map((s: unknown) => (typeof s === "string" ? s : (s && typeof s === "object" && "value" in s ? String((s as { value: unknown }).value) : "")))
        .filter(Boolean)
        .slice(0, 8) as string[]
      if (topSkills.length) funnel.withSkills++

      const roleFn = Array.isArray(tags.targetRoleFunction) ? tags.targetRoleFunction as string[] :
        Array.isArray(tags.roleFunction) ? tags.roleFunction as string[] : []
      const careerStage = typeof tags.careerStage === "string" ? tags.careerStage : undefined
      const yoeRange = tags.yoeRange ? JSON.stringify(tags.yoeRange) :
        typeof tags.yoe === "number" ? String(tags.yoe) : undefined

      const stateSnap = await db.collection(PA_COLLECTIONS.candidateJobStates)
        .where("candidateId", "==", id).limit(50).get().catch(() => ({ docs: [] as Array<{ id: string; data: () => Record<string, unknown> }> }))

      const jobStates = stateSnap.docs.map((d) => {
        const sd = d.data() ?? {}
        return {
          jobId: sd.jobId as string ?? "",
          state: sd.state as string ?? "",
          stateUpdatedAt: toIso(sd.stateUpdatedAt, ""),
          awaitingHmResponse: sd.awaitingHmResponse === true,
          prescreenSessionId: typeof sd.prescreenSessionId === "string" ? sd.prescreenSessionId : undefined,
        }
      }).filter((j) => j.jobId)

      if (jobStates.length) funnel.enteredJobFlow++
      for (const j of jobStates) {
        if (j.state === "prescreen_started") funnel.prescreenStarted++
        if (j.state === "prescreen_review_pending" && j.awaitingHmResponse) funnel.awaitingHmResponse++
        if (j.state === "prescreen_review_pending" && !j.awaitingHmResponse) funnel.prescreenReviewPending++
        if (j.state === "passed") funnel.passed++
        if (j.state === "not_passed") funnel.notPassed++
        if (j.state === "employer_visible") funnel.employerVisible++
      }

      const distinctJobIds = [...new Set(jobStates.map((s) => s.jobId))]
      const jobDocs = await Promise.all(
        distinctJobIds.map((jid) => db.collection(PA_COLLECTIONS.jobs).doc(jid).get().catch(() => null)),
      )
      const jobMeta = new Map<string, { title: string; company: string }>()
      for (let i = 0; i < distinctJobIds.length; i++) {
        const snap = jobDocs[i]
        const jd = snap?.data?.() ?? {}
        jobMeta.set(distinctJobIds[i]!, {
          title: (jd.title as string | undefined) ?? "Unknown",
          company: (jd.company as string | undefined) ?? "",
        })
      }

      const jobs = jobStates.map((s) => {
        const parsed = CandidateJobStateSchema.safeParse(s.state)
        const meta = jobMeta.get(s.jobId) ?? { title: "Unknown", company: "" }
        const ps = prescreenByUserJob.get(`${id}__${s.jobId}`)
        return {
          jobId: s.jobId,
          jobTitle: meta.title,
          company: meta.company,
          state: (parsed.success ? parsed.data : s.state) as CandidateJobState,
          stateUpdatedAt: s.stateUpdatedAt,
          ...(s.awaitingHmResponse ? { reviewStatus: "awaiting_hm_response" as const } : {}),
          ...(ps?.terminal ? { prescreenTerminal: ps.terminal } : {}),
          ...(ps?.score != null ? { prescreenScore: ps.score } : {}),
        }
      })

      let currentStage = "signed_up"
      if (hasResume) currentStage = "resume_submitted"
      if (jobStates.some((j) => j.state === "prescreen_started")) currentStage = "interviewing"
      if (jobStates.some((j) => j.state === "prescreen_review_pending" && !j.awaitingHmResponse)) currentStage = "review_pending"
      if (jobStates.some((j) => j.state === "prescreen_review_pending" && j.awaitingHmResponse)) currentStage = "awaiting_hm_response"
      if (jobStates.some((j) => j.state === "passed")) currentStage = "passed"
      if (jobStates.some((j) => j.state === "employer_visible")) currentStage = "employer_visible"
      if (jobStates.some((j) => j.state === "not_passed") && !jobStates.some((j) => j.state === "passed" || j.state === "employer_visible")) {
        currentStage = "not_passed"
      }

      const hasPassTerminal = jobs.some((j) => j.prescreenTerminal === "PASS")
      const hasFailOrPause = jobs.some((j) => j.prescreenTerminal === "FAIL" || j.prescreenTerminal === "HARD_STOP" || j.prescreenTerminal === "PAUSE")
      if (hasPassTerminal && (currentStage === "review_pending" || currentStage === "interviewing")) {
        currentStage = "pending_human_review"
        funnel.pendingHumanReview++
      } else if (hasFailOrPause && !hasPassTerminal && (currentStage === "review_pending" || currentStage === "interviewing")) {
        currentStage = "rejected"
        funnel.rejected++
      }

      return {
        userId: id,
        email: (u.email as string | undefined) ?? "",
        displayName: (u.displayName as string | undefined) ?? undefined,
        registeredAt: toIso(u.createdAt, new Date(0).toISOString()),
        lifecycleState: (u.lifecycleState as string | undefined) ?? undefined,
        source: typeof u.source === "string" ? u.source : undefined,
        entrySource,
        entryJobId,
        attributedVia,
        hasResume,
        resumeStatus,
        roleFunction: roleFn,
        careerStage,
        yoeRange,
        topSkills,
        jobs,
        currentStage,
      }
    }),
  )

  return {
    generatedAt: new Date().toISOString(),
    partnerSource: targetSource,
    funnel,
    users: rows,
    allPartnerSources: knownPartnerSources,
  }
}

export const paAdminPartnerStats = onCall(
  {
    region: "us-central1",
    memory: "1GiB",
    maxInstances: 5,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = InputSchema.safeParse(req.data)
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    return buildSnapshot(getFirestore(), parsed.data.partnerSource)
  },
)

const SetAwaitingHmSchema = z.object({
  candidateJobStateId: z.string().min(1),
  awaitingHmResponse: z.boolean(),
})

export const paAdminSetAwaitingHm = onCall(
  {
    region: "us-central1",
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = SetAwaitingHmSchema.safeParse(req.data)
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    const { candidateJobStateId, awaitingHmResponse } = parsed.data
    const db = getFirestore()
    const ref = db.collection(PA_COLLECTIONS.candidateJobStates).doc(candidateJobStateId)
    const snap = await ref.get()
    if (!snap.exists) throw new HttpsError("not-found", "Job state not found")
    const state = snap.data()?.state as string | undefined
    if (state !== "prescreen_review_pending") {
      throw new HttpsError("failed-precondition", `Can only set awaiting HM on review-pending states, got ${state}`)
    }
    await ref.update({ awaitingHmResponse })
    return { ok: true }
  },
)
