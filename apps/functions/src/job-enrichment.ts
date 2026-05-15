import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { getFirestore } from "firebase-admin/firestore"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { defineSecret } from "firebase-functions/params"
import { z } from "zod"
import {
  PA_COLLECTIONS,
  JobOpportunityDraftSchema,
  createJobEnrichmentDraftId,
  type CorrectionEvent,
  type JobOpportunityDraft as MarketplaceJobOpportunityDraft,
} from "@pa/core-types"
import { deriveJobOpportunityDraft, enrichJobTags, type EnrichJobTagsResult } from "@pa/job-tag-enricher"
import { PrescreenConfigSchema, type PrescreenConfig } from "@pa/pa-orchestrator"
import {
  approveJobOpportunityDraft as defaultApproveJobOpportunityDraft,
  rejectJobOpportunityDraft as defaultRejectJobOpportunityDraft,
  writeCorrectionEvent as defaultWriteCorrectionEvent,
  writeJobOpportunityDraft as defaultWriteJobOpportunityDraft,
} from "@pa/pa-persistence"
import { ANTHROPIC_API_KEY } from "./orchestrator-deps.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const ENRICHMENT_VERSION = "s4-admin-job-enrichment-v1"

type CallableAuthLike = {
  auth?: {
    uid?: string
    token?: {
      admin?: unknown
      email?: unknown
    }
  }
  data?: unknown
}

type RawJobDoc = Record<string, unknown> & {
  id?: string
}

const GenerateDraftInputSchema = z.object({
  jobId: z.string().trim().min(1),
  adminToken: z.string().optional(),
})

const RefreshDraftInputSchema = z.object({
  jobId: z.string().trim().min(1),
  draftId: z.string().trim().min(1).optional(),
  adminToken: z.string().optional(),
})

const ApproveDraftInputSchema = z.object({
  jobId: z.string().trim().min(1),
  draftId: z.string().trim().min(1),
  adminToken: z.string().optional(),
})

const RejectDraftInputSchema = z.object({
  jobId: z.string().trim().min(1),
  draftId: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(2_000),
  adminToken: z.string().optional(),
})

const SaveCorrectionsInputSchema = z.object({
  jobId: z.string().trim().min(1),
  draftId: z.string().trim().min(1),
  corrections: z.string().trim().min(1).max(2_000),
  beforeRedacted: z.record(z.unknown()).optional(),
  afterRedacted: z.record(z.unknown()).optional(),
  adminToken: z.string().optional(),
})

export type GenerateDraftInput = z.infer<typeof GenerateDraftInputSchema>
export type RefreshDraftInput = z.infer<typeof RefreshDraftInputSchema>
export type ApproveDraftInput = z.infer<typeof ApproveDraftInputSchema>
export type RejectDraftInput = z.infer<typeof RejectDraftInputSchema>
export type SaveCorrectionsInput = z.infer<typeof SaveCorrectionsInputSchema>

export interface JobEnrichmentDeps {
  db?: Firestore
  readJob?: (jobId: string) => Promise<RawJobDoc | null>
  enrich?: (input: {
    title: string
    companyName?: string | null
    jobDescription?: string | null
    locationRaw?: string | null
    sourceRepo?: string | null
  }) => Promise<EnrichJobTagsResult>
  writeDraft?: (
    db: Firestore,
    draft: MarketplaceJobOpportunityDraft
  ) => Promise<{ draft: MarketplaceJobOpportunityDraft; created: boolean }>
  approveDraft?: (
    db: Firestore,
    input: { jobId: string; draftId: string; approvedBy: string; approvedAt: string }
  ) => Promise<MarketplaceJobOpportunityDraft>
  rejectDraft?: (
    db: Firestore,
    input: { jobId: string; draftId: string; rejectedBy: string; rejectedAt: string; reason: string }
  ) => Promise<MarketplaceJobOpportunityDraft>
  writeCorrection?: (
    db: Firestore,
    event: CorrectionEvent
  ) => Promise<{ event: CorrectionEvent; created: boolean }>
  nowIso?: () => string
  log?: (event: string, payload?: Record<string, unknown>) => void
}

export function authorizeJobEnrichmentAdmin(req: CallableAuthLike): string {
  const email = typeof req.auth?.token?.email === "string" ? req.auth.token.email.trim().toLowerCase() : ""
  if (email.endsWith("@wekruit.com") || email === "indolencorlol@gmail.com") return email

  const adminClaim = req.auth?.token?.admin
  const uid = req.auth?.uid ?? ""
  if (adminClaim === true || adminClaim === "true") return uid || "admin-claim"

  const dataObj = req.data && typeof req.data === "object" ? (req.data as Record<string, unknown>) : {}
  const provided = typeof dataObj.adminToken === "string" ? dataObj.adminToken.trim() : ""
  const expected = (process.env.PA_ADMIN_TOKEN ?? "").trim()
  if (expected && provided && provided === expected) return uid || "admin-token"

  throw new HttpsError("permission-denied", "admin only")
}

export async function runJobEnrichmentGenerateDraft(
  input: GenerateDraftInput,
  deps: JobEnrichmentDeps,
): Promise<{ ok: true; jobId: string; draftId: string; status: string; approvalReady: boolean; created: boolean }> {
  return runJobEnrichmentRefreshDraft(input, deps)
}

export async function runJobEnrichmentRefreshDraft(
  input: RefreshDraftInput,
  deps: JobEnrichmentDeps,
): Promise<{ ok: true; jobId: string; draftId: string; status: string; approvalReady: boolean; created: boolean }> {
  const db = requireDb(deps)
  const now = (deps.nowIso ?? nowIso)()
  const rawJob = await readJob(input.jobId, deps)
  if (!rawJob) throw new HttpsError("not-found", `job_missing:${input.jobId}`)

  const snapshot = rawSnapshotFromJob(input.jobId, rawJob, now, input.draftId)
  const llmEnriched = await (deps.enrich ?? defaultEnrichJobTags)({
    title: snapshot.title,
    companyName: snapshot.companyName ?? null,
    jobDescription: snapshot.description ?? null,
    locationRaw: snapshot.locationText ?? null,
    sourceRepo: stringOrNull(rawJob.sourceRepo),
  })
  const enriched = mergeStructuredJobTags(llmEnriched, rawJob)
  const draftId =
    createJobEnrichmentDraftId(
      input.jobId,
      createHash("sha256")
        .update(`${input.jobId}|${stringOrNull(rawJob.contentHash) ?? ""}|${now}`)
        .digest("hex"),
    )
  const marketplaceDraft = toMarketplaceDraft({
    jobId: input.jobId,
    draftId,
    now,
    snapshot,
    enriched,
  })
  const written = await (deps.writeDraft ?? defaultWriteJobOpportunityDraft)(db, marketplaceDraft)
  deps.log?.("pa.job_enrichment.draft_refreshed", {
    jobId: input.jobId,
    draftId: written.draft.draftId,
    status: written.draft.status,
    approvalReady: written.draft.approvalReady,
    created: written.created,
  })
  return {
    ok: true,
    jobId: written.draft.jobId,
    draftId: written.draft.draftId,
    status: written.draft.status,
    approvalReady: written.draft.approvalReady,
    created: written.created,
  }
}

function mergeStructuredJobTags(enriched: EnrichJobTagsResult, rawJob: RawJobDoc): EnrichJobTagsResult {
  const tags = enriched.tags
  const roleFunction = normalizeRoleFunctions(rawJob.roleFunction)
  const industrySector = stringArray(rawJob.industrySector) as EnrichJobTagsResult["tags"]["industrySector"]
  const locationBuckets = normalizeLocationBuckets(rawJob.locationBuckets)
  const seniorityLevel = normalizeSeniorityLevel(rawJob.seniorityLevel)
  const jobType = stringOrNull(rawJob.jobType) as EnrichJobTagsResult["tags"]["jobType"] | null
  const sponsorshipHint = typeof rawJob.sponsorship === "boolean" ? rawJob.sponsorship : tags.sponsorshipHint
  const fields = {
    ...tags.confidence.fields,
    ...(roleFunction.length ? { roleFunction: Math.max(tags.confidence.fields.roleFunction, 0.95) } : {}),
    ...(industrySector.length ? { industrySector: Math.max(tags.confidence.fields.industrySector, 0.95) } : {}),
    ...(locationBuckets.length ? { locationBuckets: Math.max(tags.confidence.fields.locationBuckets, 0.95) } : {}),
    ...(seniorityLevel ? { seniorityLevel: Math.max(tags.confidence.fields.seniorityLevel, 0.9) } : {}),
    ...(jobType ? { jobType: Math.max(tags.confidence.fields.jobType, 0.95) } : {}),
  }
  const hasCriticalStructuredFields = roleFunction.length > 0 && locationBuckets.length > 0 && Boolean(seniorityLevel || tags.seniorityLevel)
  return {
    ...enriched,
    tags: {
      ...tags,
      skills: normalizeOpportunitySkills(tags.skills),
      relevantTags: normalizeOpenTags(tags.relevantTags),
      ...(roleFunction.length ? { roleFunction } : {}),
      ...(industrySector.length ? { industrySector } : {}),
      ...(locationBuckets.length ? { locationBuckets } : {}),
      ...(seniorityLevel ? { seniorityLevel } : {}),
      ...(jobType ? { jobType } : {}),
      sponsorshipHint,
      confidence: {
        ...tags.confidence,
        overall: hasCriticalStructuredFields ? Math.max(tags.confidence.overall, 0.9) : tags.confidence.overall,
        fields,
      },
    },
  }
}

function normalizeOpportunitySkills(
  skills: EnrichJobTagsResult["tags"]["skills"],
): EnrichJobTagsResult["tags"]["skills"] {
  const replacements: Record<string, string> = {
    ai: "artificial_intelligence",
    ml: "machine_learning",
    api: "apis",
    ci: "continuous_integration",
    cd: "continuous_delivery",
    db: "databases",
    ui: "user_interface_design",
    ux: "user_experience_design",
  }
  const rejected = knownAbbreviations()
  return skills
    .map((skill) => {
      const name = replacements[skill.name] ?? skill.name
      return { ...skill, name }
    })
    .filter((skill) => !rejected.has(skill.name))
}

function normalizeOpenTags(tags: string[]): string[] {
  const rejected = knownAbbreviations()
  return tags.filter((tag) => !rejected.has(tag))
}

function knownAbbreviations(): Set<string> {
  return new Set([
    "swe", "pm", "tpm", "epm", "sde", "qa", "sre", "ds", "fe", "be",
    "sf", "nyc", "la", "dc", "uk", "us", "usa", "eu",
    "js", "ts", "py", "k8s", "ml", "ai", "ux", "ui", "oss", "pr", "cd", "ci", "db", "vm", "iam", "ide", "cli", "api",
    "svp", "evp", "ceo", "cto", "cfo", "coo", "cmo", "cpo", "ciso",
    "hr", "rfp", "kpi", "saas",
  ])
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : []
}

function normalizeLocationBuckets(value: unknown): EnrichJobTagsResult["tags"]["locationBuckets"] {
  const legacyToCanonical: Record<string, string> = {
    new_york: "new_york_metro",
    remote: "remote_united_states",
  }
  return stringArray(value).map((item) => legacyToCanonical[item] ?? item) as EnrichJobTagsResult["tags"]["locationBuckets"]
}

function normalizeRoleFunctions(value: unknown): EnrichJobTagsResult["tags"]["roleFunction"] {
  const valid = new Set([
    "software_engineering",
    "engineering_and_development",
    "data_analysis",
    "product_management",
    "business_analyst",
    "creatives_and_design",
    "consultant",
    "accounting_and_finance",
    "marketing",
    "management_and_executive",
    "sales",
    "human_resources",
    "legal_and_compliance",
    "arts_and_entertainment",
    "education_and_training",
    "public_sector_and_government",
    "customer_service_and_support",
  ])
  return stringArray(value).filter((item) => valid.has(item)) as EnrichJobTagsResult["tags"]["roleFunction"]
}

function normalizeSeniorityLevel(value: unknown): EnrichJobTagsResult["tags"]["seniorityLevel"] | null {
  const seniority = stringOrNull(value)
  if (!seniority) return null
  if (seniority === "executive") return "c_level"
  const valid = new Set([
    "student",
    "intern",
    "entry_level",
    "junior",
    "mid_level",
    "senior",
    "staff",
    "principal",
    "manager",
    "director",
    "vp",
    "c_level",
    "founder",
  ])
  return (valid.has(seniority) ? seniority : null) as EnrichJobTagsResult["tags"]["seniorityLevel"] | null
}

export async function runJobEnrichmentApproveDraft(
  input: ApproveDraftInput,
  actor: string,
  deps: JobEnrichmentDeps,
): Promise<{ ok: true; jobId: string; draftId: string; status: "approved" }> {
  const db = requireDb(deps)
  const now = (deps.nowIso ?? nowIso)()
  const approved = await (deps.approveDraft ?? defaultApproveJobOpportunityDraft)(db, {
    jobId: input.jobId,
    draftId: input.draftId,
    approvedBy: actor,
    approvedAt: now,
  })
  await publishApprovedJobOpportunityDraft(db, approved, actor, now)
  deps.log?.("pa.job_enrichment.draft_approved", { jobId: input.jobId, draftId: input.draftId, actor })
  return { ok: true, jobId: approved.jobId, draftId: approved.draftId, status: "approved" }
}

export async function runJobEnrichmentRejectDraft(
  input: RejectDraftInput,
  actor: string,
  deps: JobEnrichmentDeps,
): Promise<{ ok: true; jobId: string; draftId: string; status: "rejected" }> {
  const db = requireDb(deps)
  const now = (deps.nowIso ?? nowIso)()
  const rejected = await (deps.rejectDraft ?? defaultRejectJobOpportunityDraft)(db, {
    jobId: input.jobId,
    draftId: input.draftId,
    rejectedBy: actor,
    rejectedAt: now,
    reason: input.reason,
  })
  deps.log?.("pa.job_enrichment.draft_rejected", { jobId: input.jobId, draftId: input.draftId, actor })
  return { ok: true, jobId: rejected.jobId, draftId: rejected.draftId, status: "rejected" }
}

export async function runJobEnrichmentSaveCorrections(
  input: SaveCorrectionsInput,
  actor: string,
  deps: JobEnrichmentDeps,
): Promise<{ ok: true; eventId: string; created: boolean }> {
  const db = requireDb(deps)
  const now = (deps.nowIso ?? nowIso)()
  const eventId = correctionEventId(input.jobId, input.draftId, input.corrections, now)
  const result = await (deps.writeCorrection ?? defaultWriteCorrectionEvent)(db, {
    eventId,
    targetType: "job_enrichment_draft",
    targetId: input.draftId,
    actor: "operator",
    jobId: input.jobId,
    reason: input.corrections,
    beforeRedacted: input.beforeRedacted ?? {},
    afterRedacted: input.afterRedacted ?? {},
    evidence: [
      {
        source: "admin",
        summary: `Correction saved by ${actor}`,
        refId: input.draftId,
      },
    ],
    createdAt: now,
  })
  deps.log?.("pa.job_enrichment.correction_saved", { jobId: input.jobId, draftId: input.draftId, actor })
  return { ok: true, eventId: result.event.eventId, created: result.created }
}

export const paJobEnrichmentGenerateDraft = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 90,
    secrets: [PA_ADMIN_TOKEN, PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY],
  },
  async (req) => {
    authorizeJobEnrichmentAdmin(req as CallableAuthLike)
    const parsed = GenerateDraftInputSchema.safeParse(req.data)
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    hydrateEnrichmentSecrets()
    try {
      return await runJobEnrichmentGenerateDraft(parsed.data, productionDeps())
    } catch (err) {
      throw toHttpsError(err)
    }
  },
)

export const paJobEnrichmentRefreshDraft = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 90,
    secrets: [PA_ADMIN_TOKEN, PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY],
  },
  async (req) => {
    authorizeJobEnrichmentAdmin(req as CallableAuthLike)
    const parsed = RefreshDraftInputSchema.safeParse(req.data)
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    hydrateEnrichmentSecrets()
    try {
      return await runJobEnrichmentRefreshDraft(parsed.data, productionDeps())
    } catch (err) {
      throw toHttpsError(err)
    }
  },
)

export const paJobEnrichmentApproveDraft = onCall(
  { region: "us-central1", memory: "256MiB", secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    const actor = authorizeJobEnrichmentAdmin(req as CallableAuthLike)
    const parsed = ApproveDraftInputSchema.safeParse(req.data)
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    try {
      return await runJobEnrichmentApproveDraft(parsed.data, actor, productionDeps())
    } catch (err) {
      throw toHttpsError(err)
    }
  },
)

export const paJobEnrichmentRejectDraft = onCall(
  { region: "us-central1", memory: "256MiB", secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    const actor = authorizeJobEnrichmentAdmin(req as CallableAuthLike)
    const parsed = RejectDraftInputSchema.safeParse(req.data)
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    try {
      return await runJobEnrichmentRejectDraft(parsed.data, actor, productionDeps())
    } catch (err) {
      throw toHttpsError(err)
    }
  },
)

export const paJobEnrichmentSaveCorrections = onCall(
  { region: "us-central1", memory: "256MiB", secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    const actor = authorizeJobEnrichmentAdmin(req as CallableAuthLike)
    const parsed = SaveCorrectionsInputSchema.safeParse(req.data)
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    try {
      return await runJobEnrichmentSaveCorrections(parsed.data, actor, productionDeps())
    } catch (err) {
      throw toHttpsError(err)
    }
  },
)

function productionDeps(): JobEnrichmentDeps {
  const db = getFirestore()
  return {
    db,
    readJob: async (jobId) => {
      const snap = await db.collection("matching-jobs").doc(jobId).get()
      return snap.exists ? ({ id: snap.id, ...snap.data() } as RawJobDoc) : null
    },
    log: (event, payload) => logger.info(event, payload ?? {}),
  }
}

function requireDb(deps: JobEnrichmentDeps): Firestore {
  if (!deps.db) throw new HttpsError("internal", "job enrichment db dependency missing")
  return deps.db
}

async function readJob(jobId: string, deps: JobEnrichmentDeps): Promise<RawJobDoc | null> {
  if (deps.readJob) return deps.readJob(jobId)
  const db = requireDb(deps)
  const snap = await db.collection("matching-jobs").doc(jobId).get()
  return snap.exists ? ({ id: snap.id, ...snap.data() } as RawJobDoc) : null
}

export async function publishApprovedJobOpportunityDraft(
  db: Firestore,
  draft: MarketplaceJobOpportunityDraft,
  actor: string,
  now: string,
): Promise<void> {
  const approved = JobOpportunityDraftSchema.parse(draft)
  if (approved.status !== "approved") {
    throw new HttpsError("failed-precondition", "job_opportunity_draft_not_approved")
  }

  const prescreenConfig = prescreenConfigFromApprovedDraft(approved, actor, now)
  const opportunity = approved.opportunity
  const firstJobType = opportunity.hardFilters.jobTypes[0]
  const requiredSkills = opportunity.skills.map((skill) => skill.name).filter(Boolean)
  const matchingPatch: Record<string, unknown> = {
    roleFunction: opportunity.roleFunction,
    industrySector: opportunity.industrySector,
    relevantTags: opportunity.relevantTags,
    requiredSkills,
    locationBuckets: opportunity.hardFilters.locations,
    jobOpportunityDraftId: approved.draftId,
    jobOpportunityApprovedAt: now,
    jobOpportunityApprovedBy: actor,
    jobOpportunityEnrichmentVersion: approved.enrichmentVersion,
    updatedAt: now,
  }
  if (firstJobType) matchingPatch.jobType = firstJobType
  if (opportunity.seniority.label) matchingPatch.seniorityLevel = opportunity.seniority.label
  if (opportunity.hardFilters.sponsorshipAvailable !== null) {
    matchingPatch.sponsorship = opportunity.hardFilters.sponsorshipAvailable
    matchingPatch.sponsorshipSource = "job_enrichment_approved"
    matchingPatch.sponsorshipBackfilledAt = now
  }

  await db.collection("matching-jobs").doc(approved.jobId).set(matchingPatch, { merge: true })

  const publicJobPatch: Record<string, unknown> = {
    title: opportunity.title,
    descriptionMd: descriptionMdFromDraft(approved),
    publicVisible: true,
    candidatePageStatus: "published",
    prescreenConfig,
    jobOpportunity: {
      title: opportunity.title,
      ...(opportunity.companyName ? { companyName: opportunity.companyName } : {}),
      roleFunction: opportunity.roleFunction,
      industrySector: opportunity.industrySector,
      skills: opportunity.skills,
      relevantTags: opportunity.relevantTags,
      seniority: {
        ...(opportunity.seniority.label ? { label: opportunity.seniority.label } : {}),
        ...(opportunity.seniority.minYears !== undefined ? { minYears: opportunity.seniority.minYears } : {}),
        ...(opportunity.seniority.maxYears !== undefined ? { maxYears: opportunity.seniority.maxYears } : {}),
      },
      hardFilters: opportunity.hardFilters,
    },
    enrichmentVersion: approved.enrichmentVersion,
    enrichmentApprovedAt: now,
    updatedAt: now,
  }
  if (opportunity.companyName) publicJobPatch.company = opportunity.companyName

  await db.collection(PA_COLLECTIONS.jobs).doc(approved.jobId).set(publicJobPatch, { merge: true })
}

export function prescreenConfigFromApprovedDraft(
  draft: MarketplaceJobOpportunityDraft,
  actor: string,
  now: string,
): PrescreenConfig {
  const questions = draft.opportunity.prescreen.questions.map((question, index) => {
    const qId = qIdFromQuestion(question.questionId, question.signal, index)
    const type = !question.required ? "GOOD_TO_HAVE" : index === 0 ? "MUST_HAVE" : "PROBING"
    return {
      qId,
      type,
      weight: question.required ? 1 : 0.5,
      matchThreshold: matchThresholdForQuestion(qId, type),
      prompt: bilingual(clampText(question.prompt, 800)),
      clarifyPrompt: bilingual(clarifyPromptForQuestion(question, draft.opportunity.title)),
      keywords: keywordSpecsForQuestion(question, draft, qId),
    }
  })

  return PrescreenConfigSchema.parse({
    version: 1,
    jobTitle: draft.opportunity.title,
    ...(draft.opportunity.companyName ? { company: draft.opportunity.companyName } : {}),
    threshold: 0.65,
    confidenceThreshold: 0.7,
    maxClarifyRounds: 2,
    voiceMode: "professional_prescreen",
    questions,
    ...(draft.rawSnapshot.applyUrl || draft.rawSnapshot.compensationText
      ? {
          level1Reveal: {
            ...(draft.rawSnapshot.applyUrl ? { applyUrl: draft.rawSnapshot.applyUrl } : {}),
            ...(draft.rawSnapshot.compensationText ? { salaryRange: draft.rawSnapshot.compensationText } : {}),
          },
        }
      : {}),
    lastEditedBy: actor,
    lastEditedAt: now,
  })
}

function descriptionMdFromDraft(draft: MarketplaceJobOpportunityDraft): string {
  const brief = draft.opportunity.candidateBrief
  const lines = [
    `# ${draft.opportunity.title}`,
    draft.opportunity.companyName ? `**${draft.opportunity.companyName}**` : "",
    brief?.headline ?? "",
    ...(brief?.sellingPoints ?? []),
    draft.rawSnapshot.description ?? "",
  ]
  return lines.filter((line) => line.trim().length > 0).join("\n\n").slice(0, 12_000)
}

function qIdFromQuestion(questionId: string, signal: string, index: number): string {
  const raw = questionId.trim() || signal.trim() || `question_${index + 1}`
  const safe = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")
  const prefixed = /^[a-z]/.test(safe) ? safe : `q_${safe}`
  return prefixed.slice(0, 64) || `q_${index + 1}`
}

function keywordFromSignal(signal: string, fallback: string): string {
  const words = signal.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const compact = words.slice(0, 4).join("_")
  return (compact || fallback).slice(0, 60)
}

function matchThresholdForQuestion(questionId: string, type: "MUST_HAVE" | "PROBING" | "GOOD_TO_HAVE"): number {
  if (type === "GOOD_TO_HAVE") return 0
  if (type === "PROBING") return 0.65
  // Role fit is a nearest-overlap story question. Production LLM scoring on
  // strong adjacent engineering work can cluster around 0.70-0.85. The
  // opener should find nearest relevant ownership, then later questions check
  // depth, logistics, and hard filters.
  if (questionId === "role_fit") return 0.7
  return 0.85
}

function keywordSpecsForQuestion(
  question: MarketplaceJobOpportunityDraft["opportunity"]["prescreen"]["questions"][number],
  draft: MarketplaceJobOpportunityDraft,
  fallbackQId: string,
): Array<{ keyword: string; weight: number; hint: string }> {
  const opportunity = draft.opportunity
  const skills = opportunity.skills.map((skill) => skill.name).filter(Boolean).slice(0, 8)
  const roleFunctions = opportunity.roleFunction.map((role) => role.replace(/_/g, " ")).slice(0, 4)
  const title = opportunity.title
  const roleContext = [title, ...roleFunctions, ...skills].filter(Boolean).join("; ")

  if (fallbackQId === "role_fit") {
    return [
      {
        keyword: keywordFromSignal(`${question.signal} ${title} ${roleFunctions.join(" ")}`, "recent_role_fit"),
        weight: 1,
        hint: clampText(
          [
            `Score recent work that is genuinely aligned with ${roleContext || title}.`,
            "Count concrete personal ownership, systems touched, APIs/services/databases/dashboards, debugging, production impact, customer/user impact, and shipped outcomes.",
            "Adjacent projects count when the candidate personally built or owned relevant engineering/product systems; do not require the exact same title.",
          ].join(" "),
          600,
        ),
      },
    ]
  }

  if (fallbackQId === "technical_depth") {
    return [
      {
        keyword: keywordFromSignal(`${question.signal} ${skills.join(" ")}`, "technical_depth"),
        weight: 1,
        hint: clampText(
          [
            `Score concrete depth in required skills${skills.length ? `: ${skills.join(", ")}` : ""}.`,
            "Look for implementation details, technical tradeoffs, data models, APIs, debugging, reliability, ownership boundaries, and how the candidate knew the work succeeded.",
          ].join(" "),
          600,
        ),
      },
    ]
  }

  if (fallbackQId === "location_alignment") {
    const locations = opportunity.hardFilters.locations.join(", ")
    return [
      {
        keyword: "location_alignment",
        weight: 1,
        hint: clampText(
          `Score whether the candidate confirms they can work with the role location or remote setup${locations ? `: ${locations}` : ""}.`,
          600,
        ),
      },
    ]
  }

  if (fallbackQId === "compensation_alignment") {
    const salary = draft.rawSnapshot.compensationText
    return [
      {
        keyword: "compensation_alignment",
        weight: 1,
        hint: clampText(
          `Score whether the candidate says the compensation target is aligned${salary ? ` with ${salary}` : ""}.`,
          600,
        ),
      },
    ]
  }

  if (fallbackQId === "sponsorship_status") {
    const sponsorshipAvailable = opportunity.hardFilters.sponsorshipAvailable
    return [
      {
        keyword: "sponsorship_alignment",
        weight: 1,
        hint: clampText(
          sponsorshipAvailable === false
            ? "Score high only when the candidate says they do not need current or future visa sponsorship."
            : "Score whether the candidate clearly states their current or future visa sponsorship need.",
          600,
        ),
      },
    ]
  }

  return [{ keyword: keywordFromSignal(question.signal, fallbackQId), weight: 1, hint: clampText(question.signal, 600) }]
}

function clarifyPromptForQuestion(
  question: MarketplaceJobOpportunityDraft["opportunity"]["prescreen"]["questions"][number],
  title: string,
): string {
  const titleLower = title.toLowerCase()
  const promptLower = question.prompt.toLowerCase()
  if (
    question.questionId === "role_fit" &&
    /\btechnical account manager\b|\btechnical account\b|\bsolutions?\s+(engineer|consultant)\b/.test(titleLower)
  ) {
    return "It does not need to be the exact same title. Share the closest customer, partner, API, onboarding, support, or technical project you owned: what was the issue, what did you do, and what changed?"
  }
  if (question.questionId === "role_fit" || promptLower.includes("best matches")) {
    return "It does not need to be an exact title match. Share the closest project you owned: the context, what you personally did, and what changed because of it."
  }
  return "Please add one concrete example from your own work: the context, what you personally did, and the result."
}

function bilingual(text: string): { en: string; zh: string } {
  return { en: text, zh: text }
}

function clampText(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1).trimEnd()
}

async function defaultEnrichJobTags(input: {
  title: string
  companyName?: string | null
  jobDescription?: string | null
  locationRaw?: string | null
  sourceRepo?: string | null
}): Promise<EnrichJobTagsResult> {
  return enrichJobTags(input)
}

function toMarketplaceDraft(input: {
  jobId: string
  draftId: string
  now: string
  snapshot: MarketplaceJobOpportunityDraft["rawSnapshot"]
  enriched: EnrichJobTagsResult
}): MarketplaceJobOpportunityDraft {
  const tags = input.enriched.tags
  const salaryRange = parseSalaryRange(input.snapshot.compensationText)
  const derived = deriveJobOpportunityDraft({
    rawJob: {
      title: input.snapshot.title,
      companyName: input.snapshot.companyName,
      locationRaw: input.snapshot.locationText,
      jobDescription: input.snapshot.description,
      salaryRange: salaryRange ?? undefined,
    },
    enrichedJobTags: tags,
  })

  const missingSignals = Object.entries(derived.coverage.fields)
    .filter(([, value]) => value.state === "hitl")
    .map(([key]) => key)
  const sponsorshipSignal =
    tags.sponsorshipHint === true ? "explicit_yes" : tags.sponsorshipHint === false ? "explicit_no" : "silent"
  const seniorityEvidence = tags.confidence.fields.seniorityLevel >= 0.7 ? "rubric" : "title_only"
  const approvalReady = derived.approvalReady && seniorityEvidence !== "title_only"
  const hitlFlags = derived.hitlFlags.map((flag, index) => ({
    flagId: `${input.draftId}_flag_${index + 1}`,
    kind: flag === "WEAK_SENIORITY_COVERAGE" ? "seniority_title_only" as const : "low_coverage" as const,
    severity:
      flag === "MISSING_SALARY_COVERAGE" ||
      flag === "SPONSORSHIP_SILENT" ||
      flag === "MISSING_SKILLS_COVERAGE"
        ? "review" as const
        : "blocking" as const,
    reason: flag.toLowerCase().replace(/_/g, " "),
    evidence: [{ source: "llm_infer" as const, summary: flag, confidence: tags.confidence.overall }],
  }))

  return JobOpportunityDraftSchema.parse({
    draftId: input.draftId,
    jobId: input.jobId,
    status: approvalReady ? "draft" : "needs_review",
    approvalReady,
    rawSnapshot: input.snapshot,
    opportunity: {
      title: input.snapshot.title,
      companyName: input.snapshot.companyName,
      roleFunction: tags.roleFunction,
      industrySector: tags.industrySector,
      skills: tags.skills,
      relevantTags: tags.relevantTags,
      seniority: {
        label: tags.seniorityLevel,
        evidence: [
          {
            source: "llm_infer",
            summary: `Seniority inferred as ${tags.seniorityLevel}.`,
            confidence: tags.confidence.fields.seniorityLevel,
          },
        ],
      },
      hardFilters: {
        sponsorshipAvailable: tags.sponsorshipHint,
        locations: tags.locationBuckets,
        jobTypes: [tags.jobType],
        ...(salaryRange?.min ? { salaryMinUsd: salaryRange.min } : {}),
        ...(salaryRange?.max ? { salaryMaxUsd: salaryRange.max } : {}),
      },
      softScoringWeights: {
        skills: 0.35,
        roleFunction: 0.2,
        industrySector: 0.15,
        location: 0.1,
        compensation: salaryRange ? 0.1 : 0,
        visa: tags.sponsorshipHint === null ? 0 : 0.05,
        companyPreference: 0.05,
      },
      prescreen: {
        questions: derived.prescreenConfigDraft.questions.map((question) => ({
          questionId: question.id,
          prompt: question.prompt,
          signal: question.rubricDimensionId,
          required: question.required,
        })),
        passSignals: derived.scoringRubric.dimensions.flatMap((dimension) => dimension.evidence).slice(0, 12),
      },
      scoringRubric: {
        mustHave: [
          ...tags.roleFunction.map((token) => `Role function: ${token}`),
          ...tags.skills.slice(0, 5).map((skill) => `Skill: ${skill.name}`),
        ],
        niceToHave: tags.relevantTags.slice(0, 8).map((token) => `Relevant tag: ${token}`),
        disqualifiers: tags.sponsorshipHint === false ? ["Candidate requires sponsorship when role does not sponsor."] : [],
      },
      candidateBrief: {
        headline: derived.candidateBrief.title,
        sellingPoints: [derived.candidateBrief.body],
        risksToClarify: missingSignals,
      },
    },
    coverage: {
      overall: approvalReady ? "high" : seniorityEvidence === "title_only" ? "low" : tags.confidence.overall >= 0.65 ? "medium" : "low",
      missingSignals,
      seniorityEvidence,
      sponsorshipSignal,
    },
    hitlFlags,
    enrichmentVersion: ENRICHMENT_VERSION,
    createdAt: input.now,
    updatedAt: input.now,
  })
}

function rawSnapshotFromJob(
  jobId: string,
  job: RawJobDoc,
  capturedAt: string,
  supersedesDraftId?: string,
): MarketplaceJobOpportunityDraft["rawSnapshot"] {
  const title = firstString(job.roleTitle, job.jobTitle, job.title)
  if (!title) throw new HttpsError("failed-precondition", `job_title_missing:${jobId}`)
  const companyName = firstString(job.companyName, job.company, job.employerName)
  const description = firstString(job.jobDescription, job.description)
  const applyUrl = validUrl(firstString(job.atsApplyUrl, job.applyUrl, job.url))
  const locationText = firstString(job.locationRaw, job.location, job.jobLocation, job.workplace)
  const compensationText = compensationTextFromJob(job)
  return {
    source: snapshotSource(job.source),
    capturedAt,
    title,
    ...(companyName ? { companyName } : {}),
    ...(description ? { description } : {}),
    ...(applyUrl ? { applyUrl } : {}),
    ...(locationText ? { locationText } : {}),
    ...(compensationText ? { compensationText } : {}),
    metadata: {
      jobId,
      sourceRepo: stringOrNull(job.sourceRepo),
      contentHash: stringOrNull(job.contentHash),
      supersedesDraftId: supersedesDraftId ?? null,
    },
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function validUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value).toString()
  } catch {
    return undefined
  }
}

function snapshotSource(value: unknown): "ats" | "admin" | "crawler" | "employer" | "system" {
  if (value === "ats" || value === "admin" || value === "crawler" || value === "employer" || value === "system") {
    return value
  }
  return "system"
}

function compensationTextFromJob(job: RawJobDoc): string | undefined {
  const direct = firstString(job.compensationText, job.salaryRange)
  if (direct) return direct
  const min = typeof job.salaryMin === "number" ? job.salaryMin : typeof job.salaryMinUsd === "number" ? job.salaryMinUsd : undefined
  const max = typeof job.salaryMax === "number" ? job.salaryMax : typeof job.salaryMaxUsd === "number" ? job.salaryMaxUsd : undefined
  if (min !== undefined && max !== undefined) return `${min}-${max} USD`
  if (min !== undefined) return `from ${min} USD`
  if (max !== undefined) return `up to ${max} USD`
  return undefined
}

function parseSalaryRange(value: string | undefined): { min?: number; max?: number; currency?: string } | null {
  if (!value) return null
  const numbers = [...value.matchAll(/\$?\s*(\d{2,3})(?:,\d{3})?\s*(k)?/gi)].map((match) => {
    const n = Number(match[1])
    return match[2] ? n * 1000 : n >= 1000 ? n : n * 1000
  })
  if (numbers.length === 0) return null
  return {
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    currency: /\b(cad|eur|gbp)\b/i.test(value) ? value.match(/\b(cad|eur|gbp)\b/i)![1]!.toUpperCase() : "USD",
  }
}

function correctionEventId(jobId: string, draftId: string, corrections: string, now: string): string {
  const hash = createHash("sha256").update(`${jobId}|${draftId}|${corrections}|${now}`).digest("hex")
  return `job_enrichment_correction_${hash.slice(0, 32)}`
}

function hydrateEnrichmentSecrets(): void {
  try {
    const openAiKey = PA_OPENAI_AGENT_API_KEY.value().trim()
    if (openAiKey) process.env.PA_OPENAI_AGENT_API_KEY = openAiKey
  } catch {
    // Optional in unit/local harnesses.
  }
  try {
    const anthropicKey = ANTHROPIC_API_KEY.value().trim()
    if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey
  } catch {
    // Optional fallback tier.
  }
}

function toHttpsError(err: unknown): HttpsError {
  if (err instanceof HttpsError) return err
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes("_missing")) return new HttpsError("not-found", message)
  if (message.includes("_not_approval_ready") || message.includes("_rejected") || message.includes("_already_approved")) {
    return new HttpsError("failed-precondition", message)
  }
  if (message.includes("link_mismatch") || message.includes("conflicting_duplicate_event")) {
    return new HttpsError("failed-precondition", message)
  }
  return new HttpsError("internal", message)
}

function nowIso(): string {
  return new Date().toISOString()
}
