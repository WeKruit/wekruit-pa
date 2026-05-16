/**
 * v2.0 External Supply V1 — Wave C Block D2 — Admin-only callable that
 * iterates resolved external-supply records and writes a deterministic
 * `pa-candidate-company-job-evaluations` doc per (candidate, job, runId).
 *
 * Behavior:
 *  1. Admin auth gate (same pattern as `resolve-identity.ts` —
 *     `@wekruit.com` Firebase Auth or `token.admin === true`).
 *  2. Resolve the run scope:
 *       - explicit `recordIds[]` overrides `batchId`.
 *       - otherwise queries `pa-external-candidate-records?batchId == batchId`
 *         and keeps `identityResolutionStatus in {create_new, merge_existing}`.
 *  3. Load `pa-jobs/{jobId}` for job context. Falls back to an empty job
 *     stub (rubric will surface `missingInfo`).
 *  4. Load `pa-companies/{companyId}` for company context. Optional —
 *     missing company is captured via `missingInfo: ["company_context_unknown"]`.
 *  5. Upsert a `pa-candidate-evaluation-runs/{runId}` doc with status
 *     `running` → `completed`. `runId` is caller-supplied or generated.
 *  6. For each in-scope record, fetch the candidate profile from
 *     `pa-users/{record.resolvedUserId}`. Skip when profile missing.
 *  7. Call `composeEvaluation` (pure) and write the result to
 *     `pa-candidate-company-job-evaluations/{evaluationId}` using
 *     `createExternalEvaluationId(candidateId, jobId, runId)` — deterministic
 *     so re-running the same runId is an idempotent overwrite.
 *  8. Return tier breakdown + per-bucket counters.
 *
 * Determinism notes:
 *  - The rubric is pure (no Firestore reads from inside `composeEvaluation`).
 *  - `runId` is part of the evaluation doc id, so a single record can have
 *    multiple historical evaluations (one per run) — handy for A/B and
 *    regression tracking.
 *  - Tier is never `do_not_contact` — Invariant 9.
 */

import { randomUUID } from "node:crypto"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  createExternalEvaluationId,
  type CandidateCompanyJobEvaluation,
  type CandidateEvaluationRun,
  type CandidateProfile,
  type EvaluationTier,
  type ExternalCandidateRecord,
} from "@pa/core-types"
import {
  RUBRIC_VERSION_DEFAULT,
  composeEvaluation,
  type CompanyContext,
  type JobContext,
} from "@pa/external-supply"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"
import { parseExternalCandidateRecordDoc } from "./record-doc.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunEvaluationInput {
  batchId?: string
  recordIds?: string[]
  companyId: string
  jobId: string
  rubricVersion?: string
  runId?: string
}

export interface RunEvaluationResult {
  ok: true
  runId: string
  processed: number
  completed: number
  skipped: number
  tierBreakdown: Record<EvaluationTier, number>
}

export interface RunEvaluationDeps {
  db: Firestore
  now?: () => string
  newId?: () => string
}

type CallableAuth = Parameters<typeof requireExternalSupplyAdmin>[0]

// ---------------------------------------------------------------------------
// Pure handler — deps-injected for tests
// ---------------------------------------------------------------------------

const STATUSES_IN_SCOPE: ReadonlySet<ExternalCandidateRecord["identityResolutionStatus"]> = new Set([
  "create_new",
  "merge_existing",
])

const ZERO_BREAKDOWN: Record<EvaluationTier, number> = {
  tier_1_personal_linkedin_and_email: 0,
  tier_2_personal_email: 0,
  tier_3_general_email: 0,
  retain_only: 0,
  blocked: 0,
}

export async function runEvaluation(
  data: unknown,
  auth: CallableAuth,
  deps: RunEvaluationDeps,
): Promise<RunEvaluationResult> {
  const { uid } = requireExternalSupplyAdmin(auth)
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const newId = deps.newId ?? (() => randomUUID())

  const input = parseRunEvaluationInput(data)

  const runId = input.runId ?? newId()
  const rubricVersion = input.rubricVersion ?? RUBRIC_VERSION_DEFAULT

  // 1. Upsert the run doc — status running.
  const runRef = db.collection(PA_COLLECTIONS.candidateEvaluationRuns).doc(runId)
  const runStarted = now()
  const initialRunDoc: CandidateEvaluationRun = {
    runId,
    companyId: input.companyId,
    jobId: input.jobId,
    rubricVersion,
    triggeredBy: uid,
    candidateCount: 0,
    completedCount: 0,
    status: "running",
    createdAt: runStarted,
    startedAt: runStarted,
    updatedAt: runStarted,
  }
  if (input.batchId) initialRunDoc.scopeBatchId = input.batchId
  if (input.recordIds && input.recordIds.length > 0) {
    initialRunDoc.scopeRecordIds = [...input.recordIds]
  }
  await runRef.set(initialRunDoc, { merge: true })

  // 2. Load job + company context.
  const job = await loadJobContext(db, input.jobId)
  const company = await loadCompanyContext(db, input.companyId)

  // 3. Determine record set.
  const records = await loadRecords(db, input)
  await runRef.set({ candidateCount: records.length, updatedAt: now() }, { merge: true })

  // 4. Per-record evaluation loop.
  const breakdown: Record<EvaluationTier, number> = { ...ZERO_BREAKDOWN }
  let completed = 0
  let skipped = 0

  for (const record of records) {
    if (!record.resolvedUserId) {
      skipped += 1
      continue
    }
    let profile: CandidateProfile | null = null
    try {
      profile = await loadCandidateProfile(db, record.resolvedUserId)
    } catch (err) {
      logger.error("external_supply.evaluate.profile_load_failed", {
        runId,
        recordId: record.recordId,
        candidateId: record.resolvedUserId,
        err: err instanceof Error ? err.message : String(err),
      })
      skipped += 1
      continue
    }
    if (!profile) {
      skipped += 1
      continue
    }

    let draft: Omit<CandidateCompanyJobEvaluation, "evaluationId" | "evaluationRunId">
    try {
      draft = composeEvaluation(
        { profile, record, company, job },
        { rubricVersion, nowIso: now() },
      )
    } catch (err) {
      logger.error("external_supply.evaluate.compose_failed", {
        runId,
        recordId: record.recordId,
        candidateId: profile.candidateId,
        err: err instanceof Error ? err.message : String(err),
      })
      skipped += 1
      continue
    }

    const evaluationId = createExternalEvaluationId(profile.candidateId, input.jobId, runId)
    const evalDoc: CandidateCompanyJobEvaluation = {
      ...draft,
      evaluationId,
      evaluationRunId: runId,
    }
    await db
      .collection(PA_COLLECTIONS.candidateCompanyJobEvaluations)
      .doc(evaluationId)
      .set(evalDoc, { merge: false })

    breakdown[draft.proposedTier] += 1
    completed += 1
  }

  const finishedAt = now()
  await runRef.set(
    {
      status: "completed",
      completedCount: completed,
      completedAt: finishedAt,
      updatedAt: finishedAt,
    },
    { merge: true },
  )

  return {
    ok: true,
    runId,
    processed: records.length,
    completed,
    skipped,
    tierBreakdown: breakdown,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRunEvaluationInput(data: unknown): RunEvaluationInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const companyId = typeof obj.companyId === "string" ? obj.companyId.trim() : ""
  const jobId = typeof obj.jobId === "string" ? obj.jobId.trim() : ""
  if (!companyId) throw new HttpsError("invalid-argument", "companyId is required")
  if (!jobId) throw new HttpsError("invalid-argument", "jobId is required")
  const batchId = typeof obj.batchId === "string" && obj.batchId.trim().length > 0
    ? obj.batchId.trim()
    : undefined
  const recordIds = Array.isArray(obj.recordIds)
    ? (obj.recordIds.filter((v) => typeof v === "string" && v.trim().length > 0) as string[])
    : undefined
  if (!batchId && (!recordIds || recordIds.length === 0)) {
    throw new HttpsError("invalid-argument", "either batchId or recordIds[] is required")
  }
  const rubricVersion =
    typeof obj.rubricVersion === "string" && obj.rubricVersion.trim().length > 0
      ? obj.rubricVersion.trim()
      : undefined
  const runId =
    typeof obj.runId === "string" && obj.runId.trim().length > 0 ? obj.runId.trim() : undefined
  return {
    batchId,
    recordIds: recordIds && recordIds.length > 0 ? recordIds : undefined,
    companyId,
    jobId,
    rubricVersion,
    runId,
  }
}

async function loadRecords(
  db: Firestore,
  input: RunEvaluationInput,
): Promise<ExternalCandidateRecord[]> {
  const col = db.collection(PA_COLLECTIONS.externalCandidateRecords)
  const out: ExternalCandidateRecord[] = []

  if (input.recordIds && input.recordIds.length > 0) {
    for (const recordId of input.recordIds) {
      const snap = await col.doc(recordId).get()
      if (!snap.exists) continue
      const record = parseExternalCandidateRecordDoc(snap.data())
      if (!record) continue
      if (!STATUSES_IN_SCOPE.has(record.identityResolutionStatus)) continue
      out.push(record)
    }
    return out
  }

  // batchId path.
  const snap = await col.where("batchId", "==", input.batchId).get()
  for (const doc of snap.docs) {
    const record = parseExternalCandidateRecordDoc(doc.data())
    if (!record) continue
    if (!STATUSES_IN_SCOPE.has(record.identityResolutionStatus)) continue
    out.push(record)
  }
  return out
}

async function loadCandidateProfile(
  db: Firestore,
  candidateId: string,
): Promise<CandidateProfile | null> {
  const snap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  if (!snap.exists) return null
  const data = snap.data() as Record<string, unknown> | undefined
  if (!data) return null
  // We do not Zod-parse with strict because `pa-users` docs in V1 commonly
  // carry legacy fields the marketplace schema doesn't enforce. Instead we
  // shape-coerce into the minimum subset the rubric reads.
  return coerceCandidateProfile(candidateId, data)
}

/**
 * Coerce a raw `pa-users` doc into the minimum `CandidateProfile` shape the
 * rubric reads. Exported (additive) so the preview callable can run the
 * deterministic tier forecast without going through `runEvaluation` (which
 * writes Firestore docs). No behaviour change vs the prior private fn.
 */
export function coerceCandidateProfile(
  candidateId: string,
  raw: Record<string, unknown>,
): CandidateProfile {
  return {
    candidateId,
    candidateLifecycleState:
      (raw.candidateLifecycleState as CandidateProfile["candidateLifecycleState"]) ??
      "prospect",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    lifecycleUpdatedAt:
      typeof raw.lifecycleUpdatedAt === "string" ? raw.lifecycleUpdatedAt : undefined,
    lifecycleReason: typeof raw.lifecycleReason === "string" ? raw.lifecycleReason : undefined,
    profileCompleteness:
      typeof raw.profileCompleteness === "number" ? raw.profileCompleteness : undefined,
    globalTags: (raw.globalTags as CandidateProfile["globalTags"]) ?? undefined,
    piiConsentAt: typeof raw.piiConsentAt === "string" ? raw.piiConsentAt : undefined,
    level1CollectedAt:
      typeof raw.level1CollectedAt === "string" ? raw.level1CollectedAt : undefined,
    mem0UserId: typeof raw.mem0UserId === "string" ? raw.mem0UserId : undefined,
    latestResumeArtifactId:
      typeof raw.latestResumeArtifactId === "string" ? raw.latestResumeArtifactId : undefined,
    linkedinUrl: typeof raw.linkedinUrl === "string" ? raw.linkedinUrl : undefined,
    outreach: (raw.outreach as CandidateProfile["outreach"]) ?? undefined,
    conversationDerivedPreferences:
      (raw.conversationDerivedPreferences as CandidateProfile["conversationDerivedPreferences"]) ??
      undefined,
  }
}

/**
 * Read-only load of `pa-jobs/{jobId}` coerced to a {@link JobContext}.
 * Exported (additive) so the preview callable can fetch job context for the
 * tier forecast without writing Firestore. Falls back to a `{ jobId }` stub
 * on missing/erroring docs. No behaviour change vs the prior private fn.
 */
export async function loadJobContext(db: Firestore, jobId: string): Promise<JobContext> {
  // The spec's source-of-truth is `pa-jobs` for marketplace job context.
  // When the doc is absent or sparse, we still produce a JobContext stub —
  // the rubric will surface `missingInfo` for every empty axis.
  try {
    const snap = await db.collection("pa-jobs").doc(jobId).get()
    if (!snap.exists) return { jobId }
    const raw = (snap.data() ?? {}) as Record<string, unknown>
    return coerceJobContext(jobId, raw)
  } catch (err) {
    logger.warn("external_supply.evaluate.job_load_failed", {
      jobId,
      err: err instanceof Error ? err.message : String(err),
    })
    return { jobId }
  }
}

function coerceJobContext(jobId: string, raw: Record<string, unknown>): JobContext {
  const stringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : undefined
  const sponsorshipRaw = raw.sponsorship
  const sponsorship =
    typeof sponsorshipRaw === "boolean" ? sponsorshipRaw : sponsorshipRaw === null ? null : undefined
  const ctx: JobContext = { jobId }
  const title = typeof raw.title === "string" ? raw.title : typeof raw.jobTitle === "string" ? raw.jobTitle : undefined
  if (title) ctx.title = title
  const roleFunction = stringArray(raw.roleFunction)
  if (roleFunction) ctx.roleFunction = roleFunction
  const requiredSkills = stringArray(raw.requiredSkills)
  if (requiredSkills) ctx.requiredSkills = requiredSkills
  const seniorityLevel = typeof raw.seniorityLevel === "string" ? raw.seniorityLevel : undefined
  if (seniorityLevel) ctx.seniorityLevel = seniorityLevel
  const locationBuckets = stringArray(raw.locationBuckets)
  if (locationBuckets) ctx.locationBuckets = locationBuckets
  if (sponsorship !== undefined) ctx.sponsorship = sponsorship
  const jobType = typeof raw.jobType === "string" ? raw.jobType : undefined
  if (jobType) ctx.jobType = jobType
  const industrySector = stringArray(raw.industrySector)
  if (industrySector) ctx.industrySector = industrySector
  const firstSeenAt = typeof raw.firstSeenAt === "string" ? raw.firstSeenAt : undefined
  if (firstSeenAt) ctx.firstSeenAt = firstSeenAt
  if (typeof raw.salaryMin === "number") ctx.salaryMin = raw.salaryMin
  else if (raw.salaryMin === null) ctx.salaryMin = null
  if (typeof raw.salaryMax === "number") ctx.salaryMax = raw.salaryMax
  else if (raw.salaryMax === null) ctx.salaryMax = null
  return ctx
}

/**
 * Read-only load of `pa-companies/{companyId}` coerced to a
 * {@link CompanyContext}. Exported (additive) so the preview callable can
 * read company context for the tier forecast without writes. Falls back to
 * a `{ companyId, name: companyId }` stub on missing/erroring docs. No
 * behaviour change vs the prior private fn.
 */
export async function loadCompanyContext(
  db: Firestore,
  companyId: string,
): Promise<CompanyContext> {
  try {
    const snap = await db.collection("pa-companies").doc(companyId).get()
    if (!snap.exists) {
      return { companyId, name: companyId }
    }
    const raw = (snap.data() ?? {}) as Record<string, unknown>
    return coerceCompanyContext(companyId, raw)
  } catch (err) {
    logger.warn("external_supply.evaluate.company_load_failed", {
      companyId,
      err: err instanceof Error ? err.message : String(err),
    })
    return { companyId, name: companyId }
  }
}

function coerceCompanyContext(
  companyId: string,
  raw: Record<string, unknown>,
): CompanyContext {
  const stringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : undefined
  const ctx: CompanyContext = { companyId }
  const name = typeof raw.name === "string" ? raw.name : undefined
  if (name) ctx.name = name
  const industrySector = stringArray(raw.industrySector)
  if (industrySector) ctx.industrySector = industrySector
  if (typeof raw.size === "string") {
    const sz = raw.size as CompanyContext["size"]
    ctx.size = sz
  }
  const competitorCompanies = stringArray(raw.competitorCompanies)
  if (competitorCompanies) ctx.competitorCompanies = competitorCompanies
  const schoolPreferences = stringArray(raw.schoolPreferences)
  if (schoolPreferences) ctx.schoolPreferences = schoolPreferences
  return ctx
}

// ---------------------------------------------------------------------------
// Production CF wrapper
// ---------------------------------------------------------------------------

export const paExternalSupplyRunEvaluation = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async (req): Promise<RunEvaluationResult> => {
    return runEvaluation(req.data, req.auth, { db: getFirestore() })
  },
)
