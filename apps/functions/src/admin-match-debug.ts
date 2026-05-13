/**
 * v1.7 Phase 70 — `paAdminMatchDebug` admin-only callable.
 *
 * Live debugger for the V16 match cascade. Mirrors `paPromoteSandboxTag`
 * admin-auth pattern (Firebase Auth `auth.token.admin === true` claim,
 * with `PA_ADMIN_TOKEN` fallback for scripted callers).
 *
 * REQ-IDs: MATCHDEBUG-01..04
 *
 * Endpoint shape:
 *
 *   Input  { userId, weightOverrides?, limit? }
 *   Output { jobs, total, dropped, hardFilter, noUserTags?, llmCacheStale?, userTags? }
 *
 * Diff vs the recruiter-bound `queryMatchingJobs` tool wrapper:
 *  - Returns the FULL v16 score breakdown per job (not just title/url/reason)
 *    so the dashboard can render per-component sliders + tooltips.
 *  - Echoes the loaded userTags snapshot for the dashboard sidebar profile
 *    (the recruiter-tool path strips it).
 *  - Accepts `weightOverrides` 0..1 per axis to power the score-sandbox UI.
 *
 * Architecture: thin shim over `queryMatchingJobsV16`. All score-component
 * logic lives in the V16 module — this CF only validates input + projects
 * the result for the dashboard.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getFirestore } from "firebase-admin/firestore"
import type { Firestore } from "firebase-admin/firestore"
import { z } from "zod"
import type {
  CandidateForJobMatchResult,
  MatchingCandidateRow,
  MatchingJob,
} from "@pa/job-rec"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

// PA_ADMIN_TOKEN — scripted-caller fallback (mirrors paPromoteSandboxTag).
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Each weight override is independently optional + clamped 0..1. Missing
 * keys fall back to canonical V16_SCORE_WEIGHTS inside `scoreV16Job`.
 */
const WeightOverridesSchema = z
  .object({
    llmMatch: z.number().min(0).max(1).optional(),
    skillJaccard: z.number().min(0).max(1).optional(),
    relevantTags: z.number().min(0).max(1).optional(),
    industrySector: z.number().min(0).max(1).optional(),
    cvEmbCosine: z.number().min(0).max(1).optional(),
    salaryFit: z.number().min(0).max(1).optional(),
  })
  .optional()

export const AdminMatchDebugInputSchema = z.object({
  userId: z.string().min(8),
  weightOverrides: WeightOverridesSchema,
  limit: z.number().int().min(1).max(50).default(10),
  /** Scripted-admin fallback (mirrors paPromoteSandboxTag). */
  adminToken: z.string().optional(),
})
export type AdminMatchDebugInput = z.infer<typeof AdminMatchDebugInputSchema>

export const AdminJobMatchDebugInputSchema = z.object({
  jobId: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(20),
  adminToken: z.string().optional(),
})
export type AdminJobMatchDebugInput = z.infer<typeof AdminJobMatchDebugInputSchema>

export type JobCandidateDebugMatch = Partial<CandidateForJobMatchResult> & {
  candidateId: string
  candidateTagSnapshot?: Record<string, unknown>
}

export type AdminJobMatchDebugResult = {
  direction: "job_to_candidate"
  jobId: string
  job: Record<string, unknown>
  candidatePool: {
    totalLoaded: number
    totalReturned: number
  }
  candidates: JobCandidateDebugMatch[]
  hardFilter: Record<string, number>
  dropped: number
}

export type AdminJobMatchDebugDeps = {
  db: Firestore
  rankCandidatesForJob?: (args: {
    job: MatchingJob
    candidates: MatchingCandidateRow[]
    limit: number
  }) => Promise<JobCandidateDebugMatch[]> | JobCandidateDebugMatch[]
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function cleanTags(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function projectMatchingJob(jobId: string, raw: Record<string, unknown>): MatchingJob & { embedding?: number[] | null } {
  const globalTags = cleanTags(raw.globalTags)
  const requiredSkills = cleanStringArray(raw.requiredSkills)
  const fallbackSkills = cleanStringArray(globalTags.skills)
  const industrySector = cleanStringArray(raw.industrySector)
  const fallbackIndustrySector = cleanStringArray(globalTags.industrySector)
  return {
    id: jobId,
    companyName: cleanString(raw.companyName) ?? cleanString(raw.companyDisplayName) ?? "Unknown company",
    jobTitle: cleanString(raw.jobTitle) ?? cleanString(raw.title) ?? cleanString(raw.roleTitle) ?? "Open role",
    salaryMax: typeof raw.salaryMax === "number" ? raw.salaryMax : null,
    salaryMin: typeof raw.salaryMin === "number" ? raw.salaryMin : null,
    locationRaw: cleanString(raw.locationRaw) ?? cleanString(raw.location) ?? "",
    primaryUrl: cleanString(raw.primaryUrl) ?? cleanString(raw.atsApplyUrl) ?? "",
    atsApplyUrl: cleanString(raw.atsApplyUrl),
    industry: cleanString(raw.industry) ?? "any",
    industryKey: cleanString(raw.industryKey),
    sponsorship: typeof raw.sponsorship === "boolean" ? raw.sponsorship : null,
    jobType: cleanString(raw.jobType),
    requiredSkills: requiredSkills.length > 0 ? requiredSkills : fallbackSkills,
    firstSeenAt: cleanString(raw.firstSeenAt),
    roleFunction: cleanStringArray(raw.roleFunction),
    industrySector: industrySector.length > 0 ? industrySector : fallbackIndustrySector,
    relevantTags: cleanStringArray(raw.relevantTags).length > 0
      ? cleanStringArray(raw.relevantTags)
      : cleanStringArray(globalTags.relevantTags),
    locationBuckets: cleanStringArray(raw.locationBuckets),
    seniorityLevel: cleanString(raw.seniorityLevel),
    dead: typeof raw.dead === "boolean" ? raw.dead : undefined,
    embedding: Array.isArray(raw.embedding) && raw.embedding.every((item) => typeof item === "number")
      ? raw.embedding as number[]
      : null,
  }
}

function candidateTagSnapshot(tags: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ["skills", "industrySector", "targetRoleFunction", "targetLocations", "relevantTags"]) {
    const value = tags[key]
    if (Array.isArray(value) && value.length > 0) out[key] = value.slice(0, 12)
  }
  return out
}

async function loadCandidatePool(db: Firestore): Promise<MatchingCandidateRow[]> {
  const rows = new Map<string, MatchingCandidateRow>()
  for (const lifecycle of ["profile_ready", "retained"] as const) {
    const snap = await db
      .collection("pa-users")
      .where("candidateLifecycleState", "==", lifecycle)
      .limit(500)
      .get()
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>
      const tags = cleanTags(data.tags ?? data.globalTags)
      rows.set(doc.id, {
        userId: doc.id,
        displayName: cleanString(data.displayName),
        lifecycle,
        outreach: {
          paused: data.outreachPaused === true,
          doNotContact: data.doNotContact === true,
          reachable: typeof data.phoneE164 === "string" || typeof data.email === "string",
        },
        tagsUpdatedAt: cleanString(data.tagsUpdatedAt) ?? cleanString(data.updatedAt),
        tags: tags as MatchingCandidateRow["tags"],
        cvEmbedding: Array.isArray(data.embedding) && data.embedding.every((item) => typeof item === "number")
          ? data.embedding as number[]
          : null,
        llmMatch: typeof data.llmMatch === "number" ? data.llmMatch : null,
      })
    }
  }
  return [...rows.values()]
}

function aggregateHardFilters(rows: JobCandidateDebugMatch[]): Record<string, number> {
  const counters: Record<string, number> = { pass: 0, soft_block: 0, hard_block: 0, unknown: 0 }
  for (const row of rows) {
    const key = typeof row.hardFilterResult === "string" ? row.hardFilterResult : "unknown"
    counters[key] = (counters[key] ?? 0) + 1
  }
  return counters
}

export async function runAdminJobMatchDebug(
  raw: unknown,
  deps: AdminJobMatchDebugDeps
): Promise<AdminJobMatchDebugResult> {
  const parsed = AdminJobMatchDebugInputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }
  const jobSnap = await deps.db.collection("matching-jobs").doc(parsed.data.jobId).get()
  if (!jobSnap.exists) {
    throw new HttpsError("not-found", "matching job not found")
  }
  const rawJob = (jobSnap.data() ?? {}) as Record<string, unknown>
  const job = projectMatchingJob(parsed.data.jobId, rawJob)
  const candidates = await loadCandidatePool(deps.db)
  const ranker =
    deps.rankCandidatesForJob ??
    (async (args: { job: MatchingJob; candidates: MatchingCandidateRow[]; limit: number }) => {
      const mod = await import("@pa/job-rec")
      return mod.rankCandidatesForJob(args.job, args.candidates).slice(0, args.limit)
    })
  const ranked = (await ranker({ job, candidates, limit: parsed.data.limit })).slice(0, parsed.data.limit)
  const candidateById = new Map(candidates.map((candidate) => [candidate.userId, candidate]))
  const projected = ranked.map((row, index) => {
    const candidate = candidateById.get(row.candidateId)
    const rowCandidateTagSnapshot = "candidateTagSnapshot" in row ? row.candidateTagSnapshot : undefined
    return {
      ...row,
      finalRank: row.finalRank ?? index + 1,
      candidateLifecycleState: row.candidateLifecycleState ?? candidate?.lifecycle,
      candidateTagSnapshot: rowCandidateTagSnapshot ?? candidateTagSnapshot(candidate?.tags ?? {}),
    }
  })
  return {
    direction: "job_to_candidate",
    jobId: parsed.data.jobId,
    job: {
      jobId: parsed.data.jobId,
      jobTitle: job.jobTitle,
      companyName: job.companyName,
      sponsorship: job.sponsorship,
      roleFunction: job.roleFunction ?? [],
      industrySector: job.industrySector ?? [],
    },
    candidatePool: {
      totalLoaded: candidates.length,
      totalReturned: projected.length,
    },
    candidates: projected,
    hardFilter: aggregateHardFilters(projected),
    dropped: Math.max(0, candidates.length - projected.length),
  }
}

// ---------------------------------------------------------------------------
// CF entry — admin-gated, delegates to V16
// ---------------------------------------------------------------------------

export const paAdminMatchDebug = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req) => {
    // 1. Admin gate — same pattern as paPromoteSandboxTag.
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })

    // 2. Parse + validate.
    const parsed = AdminMatchDebugInputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }

    // 3. Lazy-load V16 (heavier than the rest of this file; admin-only call).
    const { queryMatchingJobsV16 } = await import("@pa/job-rec")
    const db = getFirestore()

    const args: Parameters<typeof queryMatchingJobsV16>[0] = {
      userId: parsed.data.userId,
      limit: parsed.data.limit,
    }
    if (parsed.data.weightOverrides) {
      args.weightOverrides = parsed.data.weightOverrides
    }

    const out = await queryMatchingJobsV16(args, { db, log: () => undefined })

    // 4. Project a thin shape for dashboard rendering — keep score breakdown
    //    + matchedSkills + a slice of requiredSkills for the JD diff drawer.
    return {
      jobs: out.jobs.map((j) => ({
        jobId: j.id,
        jobTitle: j.jobTitle,
        companyName: j.companyName,
        atsApplyUrl: j.atsApplyUrl ?? null,
        roleFunction: j.roleFunction ?? [],
        seniorityLevel: j.seniorityLevel ?? null,
        sponsorship: j.sponsorship ?? null,
        firstSeenAt: j.firstSeenAt ?? null,
        v16Score: j.v16Score,
        matchedSkills: j.matchedSkills,
        reason: j.reason,
        requiredSkills: Array.isArray(j.requiredSkills)
          ? j.requiredSkills.slice(0, 10)
          : [],
      })),
      total: out.total,
      dropped: out.dropped,
      hardFilter: out.hardFilter,
      noUserTags: out.noUserTags ?? false,
      llmCacheStale: out.llmCacheStale ?? false,
      userTags: out.userTags ?? null,
    }
  },
)

export const paAdminJobMatchDebug = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminJobMatchDebug(req.data, { db: getFirestore() })
  },
)
