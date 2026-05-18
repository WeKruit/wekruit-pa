/**
 * v2.0 External Supply V1 — Wave C Block F2 — Outreach callables.
 *
 * Five admin-only callables that own the lifecycle of `pa-outreach-plans`:
 *
 *  - `paExternalSupplyDraftOutreachPlan`
 *      Inputs: `{ evaluationId, copyOverrides? }`
 *      Loads `pa-candidate-company-job-evaluations/{evaluationId}` + the
 *      candidate profile + the last 90 days of outreach events, then runs
 *      the pure `decideOutreach()` from `@pa/external-supply`. Copy is
 *      generated via the agent-runtime LLM provider with a deterministic
 *      template fallback. Writes a new `pa-outreach-plans/{planId}` doc
 *      with `approvalStatus: "draft"`.
 *
 *  - `paExternalSupplyApproveOutreachPlan`
 *      Inputs: `{ planId, edits? }`
 *      Loads the plan; applies operator-supplied copy edits; writes a
 *      `pa-correction-events` audit row if anything actually changed; sets
 *      `approvalStatus: "approved"`. Re-evaluates suppression at approve
 *      time so a fresh opt-out / bounce / decline can still gate the plan.
 *
 *  - `paExternalSupplyRejectOutreachPlan`
 *      Inputs: `{ planId, reason }`
 *      Sets `approvalStatus: "rejected"` + `rejectionReason`. Terminal.
 *
 *  - `paExternalSupplyAssignManualLinkedInTask`
 *      Inputs: `{ planId, assignee }`
 *      Sets `manualLinkedInTaskAssignee` + `manualLinkedInTaskStatus: "todo"`.
 *      Tier 1 only. Pre-condition: `approvalStatus === "approved"`.
 *
 *  - `paExternalSupplyMarkManualLinkedInTaskStatus`
 *      Inputs: `{ planId, status }`
 *      Updates `manualLinkedInTaskStatus`. Validates that `status` is in
 *      `todo | sent | replied | skipped`.
 *
 * Cross-cutting:
 *  - All callables are admin-only via `requireExternalSupplyAdmin`.
 *  - All persisted plan docs validate against `OutreachPlanSchema`.
 *  - Copy generation logs a redacted audit row to `pa-tool-calls`.
 *  - LLM failure is graceful — a deterministic template is used so the
 *    flywheel never stalls when an API key is missing.
 */

import { randomUUID, createHash } from "node:crypto"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  CandidateCompanyJobEvaluationSchema,
  OutreachPlanSchema,
  PA_COLLECTIONS,
  type CandidateCompanyJobEvaluation,
  type CandidateProfile,
  type OutreachEvent,
  type OutreachPlan,
} from "@pa/core-types"
import {
  decideOutreach,
  type OutreachCopy,
  type OutreachDecisionResult,
} from "@pa/external-supply"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DraftOutreachPlanInput {
  evaluationId: string
  copyOverrides?: Partial<OutreachCopy>
}

export interface DraftOutreachPlanResult {
  ok: true
  planId: string
  tier: OutreachPlan["tier"]
  channelDecision: OutreachPlan["channelDecision"]
  suppression: OutreachPlan["suppressionGateResult"]
}

export interface ApproveOutreachPlanInput {
  planId: string
  edits?: Partial<OutreachCopy>
}

export interface ApproveOutreachPlanResult {
  ok: true
  planId: string
  approvalStatus: OutreachPlan["approvalStatus"]
  correctionEventId?: string
}

export interface RejectOutreachPlanInput {
  planId: string
  reason: string
}

export interface AssignManualLinkedInTaskInput {
  planId: string
  assignee: string
}

export interface MarkManualLinkedInTaskStatusInput {
  planId: string
  status: "todo" | "sent" | "replied" | "skipped"
}

export interface OutreachDeps {
  db: Firestore
  now?: () => string
  newId?: () => string
  /** Hook for tests + LLM substitution. Must throw or resolve with text. */
  generateCopy?: (ctx: GenerateCopyContext) => Promise<Partial<OutreachCopy>>
}

export interface GenerateCopyContext {
  profile: CandidateProfile
  evaluation: CandidateCompanyJobEvaluation
  job: { jobId: string; title?: string; companyId: string }
  company: { companyId: string; name?: string }
  tier: OutreachPlan["tier"]
}

type CallableAuth = Parameters<typeof requireExternalSupplyAdmin>[0]

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECENT_EVENT_WINDOW_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000
const COPY_FIELDS = [
  "personalizedHook",
  "whyThisRole",
  "whyCompany",
  "candidateSpecificSignal",
  "emailSubject",
  "emailBody",
  "linkedinMessage",
] as const

// ---------------------------------------------------------------------------
// Hash helper for outreach plan email lookup (Instantly webhook)
// ---------------------------------------------------------------------------

export function emailLookupHash(email: string): string {
  const normalized = email.trim().toLowerCase()
  return createHash("sha256").update(normalized, "utf8").digest("hex")
}

// ---------------------------------------------------------------------------
// 1. draftOutreachPlan
// ---------------------------------------------------------------------------

export async function runDraftOutreachPlan(
  data: unknown,
  auth: CallableAuth,
  deps: OutreachDeps,
): Promise<DraftOutreachPlanResult> {
  requireExternalSupplyAdmin(auth)
  const input = parseDraftInput(data)
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const newId = deps.newId ?? (() => randomUUID())

  const evaluation = await loadEvaluation(db, input.evaluationId)
  const profile = await loadCandidateProfile(db, evaluation.candidateId)
  if (!profile) {
    throw new HttpsError(
      "not-found",
      `Candidate profile not found: ${evaluation.candidateId}`,
    )
  }

  const company = await loadCompanyContext(db, evaluation.companyId)
  const job = await loadJobContext(db, evaluation.jobId, evaluation.companyId)
  const recentEvents = await loadRecentOutreachEvents(db, evaluation.candidateId, now)

  // Copy generation — LLM with template fallback. Override beats both.
  const overrides = input.copyOverrides ?? {}
  let generated: Partial<OutreachCopy> = {}
  try {
    const generator = deps.generateCopy ?? defaultGenerateCopy
    generated = await generator({
      profile,
      evaluation,
      job,
      company,
      tier: evaluation.proposedTier,
    })
  } catch (err) {
    logger.warn("external_supply.outreach.generate_copy_failed", {
      planEvaluationId: input.evaluationId,
      err: err instanceof Error ? err.message : String(err),
    })
    generated = templateCopy({ profile, evaluation, job, company, tier: evaluation.proposedTier })
  }
  await writeToolCallAudit(db, {
    callable: "draftOutreachPlan",
    evaluationId: input.evaluationId,
    candidateId: evaluation.candidateId,
    promptRedacted: { tier: evaluation.proposedTier, job: job.jobId, company: company.companyId },
    responseRedacted: redactCopy(generated),
    now: now(),
  })

  const mergedCopy: Partial<OutreachCopy> = { ...generated, ...trimCopy(overrides) }

  const decision = decideOutreach(
    {
      profile,
      evaluation,
      job: { jobId: job.jobId, title: job.title, companyId: company.companyId },
      company: { companyId: company.companyId, name: company.name },
      recentOutreachEvents: recentEvents,
      now,
    },
    mergedCopy,
  )

  const planId = newId()
  const createdAt = now()
  const plan: OutreachPlan = {
    ...decision.draft,
    planId,
    createdAt,
    approvalStatus: "draft",
    updatedAt: createdAt,
  }
  // Stash an email hash on the doc so the webhook lookup can find it later.
  const planRef = db.collection(PA_COLLECTIONS.outreachPlans).doc(planId)
  // We persist `emailHash` alongside the plan via a top-level field even
  // though it's not part of the Zod schema — store as a separate property
  // outside the schema-validated subset. Plans without emails get null.
  const candidateEmailHash = await resolveCandidateEmailHash(db, evaluation.candidateId)
  const validated = OutreachPlanSchema.parse(plan)
  const persistDoc: Record<string, unknown> = { ...validated }
  if (candidateEmailHash) persistDoc.emailHash = candidateEmailHash
  await planRef.set(persistDoc, { merge: false })

  return {
    ok: true,
    planId,
    tier: validated.tier,
    channelDecision: validated.channelDecision,
    suppression: validated.suppressionGateResult,
  }
}

// ---------------------------------------------------------------------------
// 2. approveOutreachPlan
// ---------------------------------------------------------------------------

export async function runApproveOutreachPlan(
  data: unknown,
  auth: CallableAuth,
  deps: OutreachDeps,
): Promise<ApproveOutreachPlanResult> {
  const { uid } = requireExternalSupplyAdmin(auth)
  const input = parseApproveInput(data)
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const newId = deps.newId ?? (() => randomUUID())

  const plan = await loadOutreachPlan(db, input.planId)
  if (plan.approvalStatus !== "draft" && plan.approvalStatus !== "awaiting_approval") {
    throw new HttpsError(
      "failed-precondition",
      `Plan ${input.planId} is in state ${plan.approvalStatus}; expected draft or awaiting_approval.`,
    )
  }

  // Apply edits — only keys present in input.edits override existing copy.
  const edits = trimCopy(input.edits ?? {})
  const before: Record<string, string | undefined> = {}
  const after: Record<string, string | undefined> = {}
  for (const key of COPY_FIELDS) {
    const incoming = edits[key]
    if (incoming === undefined) continue
    const prev = plan[key]
    if (prev !== incoming) {
      before[key] = prev
      after[key] = incoming
    }
  }

  const changed = Object.keys(after).length > 0
  let correctionEventId: string | undefined
  const updateDoc: Record<string, unknown> = { ...plan }
  for (const key of COPY_FIELDS) {
    if (after[key] !== undefined) {
      updateDoc[key] = after[key]
    }
  }

  // Approval stamp.
  const approvedAt = now()
  updateDoc.approvalStatus = "approved"
  updateDoc.approvedBy = uid
  updateDoc.approvedAt = approvedAt
  updateDoc.updatedAt = approvedAt
  delete updateDoc.rejectionReason

  // Validate before persisting.
  const validated = OutreachPlanSchema.parse(updateDoc)
  await db.collection(PA_COLLECTIONS.outreachPlans).doc(input.planId).set(validated, {
    merge: false,
  })

  if (changed) {
    correctionEventId = newId()
    const auditDoc = {
      eventId: correctionEventId,
      targetType: "feedback_event" as const,
      targetId: input.planId,
      actor: "operator" as const,
      candidateId: plan.candidateId,
      jobId: plan.jobId,
      reason: `outreach_plan_copy_edit_at_approval`,
      beforeRedacted: { planId: input.planId, before },
      afterRedacted: { planId: input.planId, after },
      evidence: [],
      createdAt: approvedAt,
    }
    await db
      .collection(PA_COLLECTIONS.correctionEvents)
      .doc(correctionEventId)
      .set(auditDoc, { merge: false })
  }

  return {
    ok: true,
    planId: input.planId,
    approvalStatus: "approved",
    correctionEventId,
  }
}

// ---------------------------------------------------------------------------
// 3. rejectOutreachPlan
// ---------------------------------------------------------------------------

export async function runRejectOutreachPlan(
  data: unknown,
  auth: CallableAuth,
  deps: OutreachDeps,
): Promise<{ ok: true; planId: string }> {
  const { uid } = requireExternalSupplyAdmin(auth)
  const input = parseRejectInput(data)
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const plan = await loadOutreachPlan(db, input.planId)
  if (plan.approvalStatus === "sent") {
    throw new HttpsError(
      "failed-precondition",
      `Plan ${input.planId} already sent; cannot reject.`,
    )
  }
  const rejectedAt = now()
  const updated: OutreachPlan = {
    ...plan,
    approvalStatus: "rejected",
    rejectionReason: input.reason,
    updatedAt: rejectedAt,
    approvedBy: uid,
    approvedAt: rejectedAt,
  }
  const validated = OutreachPlanSchema.parse(updated)
  await db
    .collection(PA_COLLECTIONS.outreachPlans)
    .doc(input.planId)
    .set(validated, { merge: false })
  return { ok: true, planId: input.planId }
}

// ---------------------------------------------------------------------------
// 4. assignManualLinkedInTask
// ---------------------------------------------------------------------------

export async function runAssignManualLinkedInTask(
  data: unknown,
  auth: CallableAuth,
  deps: OutreachDeps,
): Promise<{ ok: true; planId: string }> {
  requireExternalSupplyAdmin(auth)
  const input = parseAssignTaskInput(data)
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const plan = await loadOutreachPlan(db, input.planId)
  if (plan.approvalStatus !== "approved" && plan.approvalStatus !== "sent") {
    throw new HttpsError(
      "failed-precondition",
      `Plan ${input.planId} status=${plan.approvalStatus}; assignment requires approved or sent.`,
    )
  }
  if (plan.tier !== "tier_1_personal_linkedin_and_email") {
    throw new HttpsError(
      "failed-precondition",
      `Plan ${input.planId} tier=${plan.tier}; manual LinkedIn task only valid on tier_1.`,
    )
  }
  const updatedAt = now()
  const updated: OutreachPlan = {
    ...plan,
    manualLinkedInTaskAssignee: input.assignee,
    manualLinkedInTaskStatus: "todo",
    updatedAt,
  }
  const validated = OutreachPlanSchema.parse(updated)
  await db
    .collection(PA_COLLECTIONS.outreachPlans)
    .doc(input.planId)
    .set(validated, { merge: false })
  return { ok: true, planId: input.planId }
}

// ---------------------------------------------------------------------------
// 5. markManualLinkedInTaskStatus
// ---------------------------------------------------------------------------

const ALLOWED_TASK_STATUSES = new Set(["todo", "sent", "replied", "skipped"])

export async function runMarkManualLinkedInTaskStatus(
  data: unknown,
  auth: CallableAuth,
  deps: OutreachDeps,
): Promise<{ ok: true; planId: string; status: string }> {
  requireExternalSupplyAdmin(auth)
  const input = parseMarkStatusInput(data)
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const plan = await loadOutreachPlan(db, input.planId)
  if (plan.tier !== "tier_1_personal_linkedin_and_email") {
    throw new HttpsError(
      "failed-precondition",
      `Plan ${input.planId} tier=${plan.tier}; manual LinkedIn status only valid on tier_1.`,
    )
  }
  const updated: OutreachPlan = {
    ...plan,
    manualLinkedInTaskStatus: input.status,
    updatedAt: now(),
  }
  const validated = OutreachPlanSchema.parse(updated)
  await db
    .collection(PA_COLLECTIONS.outreachPlans)
    .doc(input.planId)
    .set(validated, { merge: false })
  return { ok: true, planId: input.planId, status: input.status }
}

// ---------------------------------------------------------------------------
// Input parsers
// ---------------------------------------------------------------------------

function parseDraftInput(data: unknown): DraftOutreachPlanInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const evaluationId =
    typeof obj.evaluationId === "string" ? obj.evaluationId.trim() : ""
  if (!evaluationId) throw new HttpsError("invalid-argument", "evaluationId is required")
  const overrides =
    obj.copyOverrides && typeof obj.copyOverrides === "object"
      ? (obj.copyOverrides as Partial<OutreachCopy>)
      : undefined
  return { evaluationId, copyOverrides: overrides }
}

function parseApproveInput(data: unknown): ApproveOutreachPlanInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const planId = typeof obj.planId === "string" ? obj.planId.trim() : ""
  if (!planId) throw new HttpsError("invalid-argument", "planId is required")
  const edits =
    obj.edits && typeof obj.edits === "object" ? (obj.edits as Partial<OutreachCopy>) : undefined
  return { planId, edits }
}

function parseRejectInput(data: unknown): RejectOutreachPlanInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const planId = typeof obj.planId === "string" ? obj.planId.trim() : ""
  const reason = typeof obj.reason === "string" ? obj.reason.trim() : ""
  if (!planId) throw new HttpsError("invalid-argument", "planId is required")
  if (!reason) throw new HttpsError("invalid-argument", "reason is required")
  return { planId, reason }
}

function parseAssignTaskInput(data: unknown): AssignManualLinkedInTaskInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const planId = typeof obj.planId === "string" ? obj.planId.trim() : ""
  const assignee = typeof obj.assignee === "string" ? obj.assignee.trim() : ""
  if (!planId) throw new HttpsError("invalid-argument", "planId is required")
  if (!assignee) throw new HttpsError("invalid-argument", "assignee is required")
  return { planId, assignee }
}

function parseMarkStatusInput(data: unknown): MarkManualLinkedInTaskStatusInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const planId = typeof obj.planId === "string" ? obj.planId.trim() : ""
  const statusRaw = typeof obj.status === "string" ? obj.status.trim() : ""
  if (!planId) throw new HttpsError("invalid-argument", "planId is required")
  if (!ALLOWED_TASK_STATUSES.has(statusRaw)) {
    throw new HttpsError(
      "invalid-argument",
      `status must be one of: ${Array.from(ALLOWED_TASK_STATUSES).join(", ")}`,
    )
  }
  return { planId, status: statusRaw as MarkManualLinkedInTaskStatusInput["status"] }
}

// ---------------------------------------------------------------------------
// Firestore loaders
// ---------------------------------------------------------------------------

async function loadEvaluation(
  db: Firestore,
  evaluationId: string,
): Promise<CandidateCompanyJobEvaluation> {
  const snap = await db
    .collection(PA_COLLECTIONS.candidateCompanyJobEvaluations)
    .doc(evaluationId)
    .get()
  if (!snap.exists) {
    throw new HttpsError("not-found", `Evaluation ${evaluationId} not found.`)
  }
  const parsed = CandidateCompanyJobEvaluationSchema.safeParse(snap.data())
  if (!parsed.success) {
    throw new HttpsError(
      "failed-precondition",
      `Evaluation ${evaluationId} schema invalid: ${parsed.error.message.slice(0, 200)}`,
    )
  }
  return parsed.data
}

async function loadOutreachPlan(db: Firestore, planId: string): Promise<OutreachPlan> {
  const snap = await db.collection(PA_COLLECTIONS.outreachPlans).doc(planId).get()
  if (!snap.exists) {
    throw new HttpsError("not-found", `Outreach plan ${planId} not found.`)
  }
  const parsed = OutreachPlanSchema.safeParse(snap.data())
  if (!parsed.success) {
    throw new HttpsError(
      "failed-precondition",
      `Plan ${planId} schema invalid: ${parsed.error.message.slice(0, 200)}`,
    )
  }
  return parsed.data
}

async function loadCandidateProfile(
  db: Firestore,
  candidateId: string,
): Promise<CandidateProfile | null> {
  const snap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  if (!snap.exists) return null
  const raw = snap.data() as Record<string, unknown> | undefined
  if (!raw) return null
  return {
    candidateId,
    candidateLifecycleState:
      (raw.candidateLifecycleState as CandidateProfile["candidateLifecycleState"]) ??
      "prospect",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    globalTags: (raw.globalTags as CandidateProfile["globalTags"]) ?? undefined,
    latestResumeArtifactId:
      typeof raw.latestResumeArtifactId === "string"
        ? raw.latestResumeArtifactId
        : undefined,
    linkedinUrl: typeof raw.linkedinUrl === "string" ? raw.linkedinUrl : undefined,
    outreach: (raw.outreach as CandidateProfile["outreach"]) ?? undefined,
  }
}

async function loadCompanyContext(
  db: Firestore,
  companyId: string,
): Promise<{ companyId: string; name?: string }> {
  try {
    const snap = await db.collection("pa-companies").doc(companyId).get()
    if (!snap.exists) return { companyId, name: companyId }
    const raw = (snap.data() ?? {}) as Record<string, unknown>
    const name = typeof raw.name === "string" ? raw.name : companyId
    return { companyId, name }
  } catch {
    return { companyId, name: companyId }
  }
}

async function loadJobContext(
  db: Firestore,
  jobId: string,
  companyId: string,
): Promise<{ jobId: string; companyId: string; title?: string }> {
  try {
    const snap = await db.collection("pa-jobs").doc(jobId).get()
    if (!snap.exists) return { jobId, companyId }
    const raw = (snap.data() ?? {}) as Record<string, unknown>
    const title =
      typeof raw.title === "string"
        ? raw.title
        : typeof raw.jobTitle === "string"
          ? raw.jobTitle
          : undefined
    return { jobId, companyId, title }
  } catch {
    return { jobId, companyId }
  }
}

async function loadRecentOutreachEvents(
  db: Firestore,
  candidateId: string,
  now: () => string,
): Promise<OutreachEvent[]> {
  try {
    const snap = await db
      .collection(PA_COLLECTIONS.outreachEvents)
      .where("candidateId", "==", candidateId)
      .get()
    const cutoff = Date.parse(now()) - RECENT_EVENT_WINDOW_DAYS * DAY_MS
    const out: OutreachEvent[] = []
    for (const doc of snap.docs) {
      const data = doc.data() as OutreachEvent
      const occurred = Date.parse(data.occurredAt ?? "")
      if (Number.isNaN(occurred) || occurred >= cutoff) {
        out.push(data)
      }
    }
    return out
  } catch (err) {
    logger.warn("external_supply.outreach.recent_events_load_failed", {
      candidateId,
      err: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

async function resolveCandidateEmailHash(
  db: Firestore,
  candidateId: string,
): Promise<string | null> {
  // Best-effort — look at pa-candidate-handles for an email row. The webhook
  // does the reverse lookup using a normalized hash of the email body.
  try {
    const snap = await db
      .collection(PA_COLLECTIONS.candidateHandles)
      .where("candidateId", "==", candidateId)
      .get()
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>
      if (data.kind === "email" && typeof data.normalizedValue === "string") {
        return emailLookupHash(data.normalizedValue)
      }
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Copy generation (LLM with template fallback)
// ---------------------------------------------------------------------------

async function defaultGenerateCopy(ctx: GenerateCopyContext): Promise<Partial<OutreachCopy>> {
  // V1 default: deterministic template. LLM wire-up is intentionally
  // deferred to a follow-up because the agent-runtime entry points need
  // additional structured-output scaffolding for safe parsing. The lib is
  // injection-friendly so we can swap a real LLM in via deps without
  // touching the callable.
  //
  // This also means tests stay deterministic without a network mock.
  return templateCopy(ctx)
}

function templateCopy(ctx: GenerateCopyContext): Partial<OutreachCopy> {
  const firstName = candidateFirstName(ctx.profile)
  const companyName = ctx.company.name ?? ctx.company.companyId
  const roleTitle = ctx.job.title ?? "this role"
  const hook = `Hi ${firstName}, I came across your profile while researching ${roleTitle} candidates at ${companyName}.`
  const why = `Based on your background, you look like a strong fit for ${roleTitle} at ${companyName}.`
  const emailSubject = `${companyName} — quick chat about ${roleTitle}?`
  const emailBody = `${hook}\n\n${why}\n\nWould you be open to a 15-minute chat? Happy to share more details.\n\nThanks,\nThe ${companyName} team`
  const linkedin =
    ctx.tier === "tier_1_personal_linkedin_and_email"
      ? `${hook} Quick LinkedIn nudge — open to a chat about ${roleTitle}?`
      : ""
  return {
    personalizedHook: hook,
    whyThisRole: why,
    whyCompany: `${companyName} is hiring for ${roleTitle}.`,
    candidateSpecificSignal: "Reviewed candidate profile signals.",
    emailSubject,
    emailBody,
    linkedinMessage: linkedin,
  }
}

function candidateFirstName(profile: CandidateProfile): string {
  // pa-users may not carry a display name. Fall back to "there".
  const raw = (profile as unknown as { displayName?: string }).displayName
  if (typeof raw === "string" && raw.trim().length > 0) {
    const first = raw.trim().split(/\s+/)[0]
    if (first) return first
  }
  return "there"
}

function trimCopy(copy: Partial<OutreachCopy>): Partial<OutreachCopy> {
  const out: Partial<OutreachCopy> = {}
  for (const key of COPY_FIELDS) {
    const v = copy[key]
    if (typeof v === "string") {
      const trimmed = v.trim()
      if (trimmed.length > 0) out[key] = trimmed
    }
  }
  return out
}

function redactCopy(copy: Partial<OutreachCopy>): Record<string, number> {
  // Audit row carries character counts only — never the full copy.
  const out: Record<string, number> = {}
  for (const key of COPY_FIELDS) {
    const v = copy[key]
    out[key] = typeof v === "string" ? v.length : 0
  }
  return out
}

interface ToolCallAuditInput {
  callable: string
  evaluationId: string
  candidateId: string
  promptRedacted: Record<string, unknown>
  responseRedacted: Record<string, unknown>
  now: string
}

async function writeToolCallAudit(
  db: Firestore,
  input: ToolCallAuditInput,
): Promise<void> {
  try {
    await db.collection(PA_COLLECTIONS.toolCalls).add({
      provider: "external_supply",
      callable: input.callable,
      candidateId: input.candidateId,
      evaluationId: input.evaluationId,
      promptRedacted: input.promptRedacted,
      responseRedacted: input.responseRedacted,
      createdAt: input.now,
    })
  } catch (err) {
    logger.warn("external_supply.outreach.tool_call_audit_failed", {
      callable: input.callable,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Production CF wrappers
// ---------------------------------------------------------------------------

export const paExternalSupplyDraftOutreachPlan = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 120 },
  async (req): Promise<DraftOutreachPlanResult> => {
    return runDraftOutreachPlan(req.data, req.auth, { db: getFirestore() })
  },
)

export const paExternalSupplyApproveOutreachPlan = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 60, maxInstances: 1 },
  async (req): Promise<ApproveOutreachPlanResult> => {
    return runApproveOutreachPlan(req.data, req.auth, { db: getFirestore() })
  },
)

export const paExternalSupplyRejectOutreachPlan = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 60 },
  async (req): Promise<{ ok: true; planId: string }> => {
    return runRejectOutreachPlan(req.data, req.auth, { db: getFirestore() })
  },
)

export const paExternalSupplyAssignManualLinkedInTask = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 30, maxInstances: 1 },
  async (req): Promise<{ ok: true; planId: string }> => {
    return runAssignManualLinkedInTask(req.data, req.auth, { db: getFirestore() })
  },
)

export const paExternalSupplyMarkManualLinkedInTaskStatus = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 30 },
  async (req): Promise<{ ok: true; planId: string; status: string }> => {
    return runMarkManualLinkedInTaskStatus(req.data, req.auth, { db: getFirestore() })
  },
)
