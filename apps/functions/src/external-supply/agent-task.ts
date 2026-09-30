/**
 * v2.0 External Supply V1 — Wave C Block E3 — Three admin-gated callables
 * wiring up the operator-side ChatGPT Agent Mode research flow.
 *
 *  1. `paExternalSupplyGenerateAgentResearchPrompt`
 *     - Read candidate / record / company / job context from Firestore.
 *     - Call `buildAgentResearchPrompt` (pure).
 *     - Persist `pa-agent-research-tasks/{taskId}` with status `draft_prompt`.
 *     - Return the prompt + version metadata so the dashboard can copy it.
 *
 *  2. `paExternalSupplyImportAgentResearchResult`
 *     - Operator pastes the agent's raw text reply.
 *     - Call `parseAgentResearchResult` (pure, defensive).
 *     - Persist `rawResult`, `parsedFindings`, `parseErrors` and flip status
 *       to `result_imported`. Allows re-import (draft_prompt | prompt_copied
 *       | result_imported are all valid input states for re-running parse).
 *
 *  3. `paExternalSupplyApproveAgentResearchFinding`
 *     - Operator flips an individual finding's `approved` flag.
 *     - When approving, append an `agent_research` MarketplaceEvidence to
 *       the task. When rejecting, do NOT touch `task.evidence` (we don't
 *       want to clutter the audit trail with rejection noise).
 *     - Status transitions:
 *         result_imported -> still result_imported until every finding has
 *         been approved or rejected.
 *         all approved/rejected with at least one approved -> `approved`.
 *         all rejected (none approved) -> `rejected`.
 *
 * Auth: same `requireExternalSupplyAdmin` helper used by `resolve-identity.ts`
 * and `evaluate.ts` — `@wekruit.com` Firebase Auth OR `token.admin === true`.
 *
 * No global pa-users writes from this surface. No automatic propagation
 * into `pa-candidate-company-job-evaluations` — D's `runEvaluation` reads
 * approved findings on the operator's next manual run (per lead resolution
 * E Q1).
 */

import { randomUUID } from "node:crypto"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  AgentResearchTaskSchema,
  PA_COLLECTIONS,
  type AgentResearchFinding,
  type AgentResearchTask,
  type ExternalCandidateRecord,
  type MarketplaceEvidence,
} from "@pa/core-types"
import {
  AGENT_PROMPT_VERSION,
  AGENT_RESULT_SCHEMA_VERSION,
  buildAgentResearchPrompt,
  parseAgentResearchResult,
  type AgentResearchPromptCandidate,
  type AgentResearchPromptCompanyJobContext,
} from "@pa/external-supply"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"
import { parseExternalCandidateRecordDoc } from "./record-doc.js"

// ---------------------------------------------------------------------------
// Shared deps
// ---------------------------------------------------------------------------

type CallableAuth = Parameters<typeof requireExternalSupplyAdmin>[0]

export interface AgentTaskDeps {
  db: Firestore
  now?: () => string
  newId?: () => string
}

function ensureDeps(deps: AgentTaskDeps): Required<AgentTaskDeps> {
  return {
    db: deps.db,
    now: deps.now ?? (() => new Date().toISOString()),
    newId: deps.newId ?? (() => randomUUID()),
  }
}

// ---------------------------------------------------------------------------
// 1. Generate prompt
// ---------------------------------------------------------------------------

export interface GenerateAgentResearchPromptInput {
  evaluationRunId?: string
  candidateIds?: string[]
  recordIds?: string[]
  missingInfoOverride?: Record<string, string[]>
  companyId?: string
  jobId?: string
}

export interface GenerateAgentResearchPromptResult {
  ok: true
  taskId: string
  prompt: string
  promptVersion: string
  expectedJsonSchemaVersion: string
}

function parseGenerateInput(data: unknown): GenerateAgentResearchPromptInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const candidateIds = Array.isArray(obj.candidateIds)
    ? (obj.candidateIds.filter((v) => typeof v === "string" && v.trim().length > 0) as string[])
    : undefined
  const recordIds = Array.isArray(obj.recordIds)
    ? (obj.recordIds.filter((v) => typeof v === "string" && v.trim().length > 0) as string[])
    : undefined
  if ((!candidateIds || candidateIds.length === 0) && (!recordIds || recordIds.length === 0)) {
    throw new HttpsError(
      "invalid-argument",
      "either candidateIds[] or recordIds[] must be provided",
    )
  }
  return {
    evaluationRunId:
      typeof obj.evaluationRunId === "string" && obj.evaluationRunId.trim().length > 0
        ? obj.evaluationRunId.trim()
        : undefined,
    candidateIds: candidateIds && candidateIds.length > 0 ? candidateIds : undefined,
    recordIds: recordIds && recordIds.length > 0 ? recordIds : undefined,
    missingInfoOverride:
      obj.missingInfoOverride && typeof obj.missingInfoOverride === "object"
        ? (obj.missingInfoOverride as Record<string, string[]>)
        : undefined,
    companyId:
      typeof obj.companyId === "string" && obj.companyId.trim().length > 0
        ? obj.companyId.trim()
        : undefined,
    jobId:
      typeof obj.jobId === "string" && obj.jobId.trim().length > 0 ? obj.jobId.trim() : undefined,
  }
}

async function loadRecordsForPrompt(
  db: Firestore,
  input: GenerateAgentResearchPromptInput,
): Promise<ExternalCandidateRecord[]> {
  const col = db.collection(PA_COLLECTIONS.externalCandidateRecords)
  const out: ExternalCandidateRecord[] = []

  // Path 1 — explicit recordIds[].
  if (input.recordIds && input.recordIds.length > 0) {
    for (const id of input.recordIds) {
      const snap = await col.doc(id).get()
      if (!snap.exists) continue
      const record = parseExternalCandidateRecordDoc(snap.data())
      if (record) out.push(record)
    }
  }

  // Path 2 — candidateIds[] (resolved). We look up records where
  // `resolvedUserId == candidateId` via a `.where` query.
  if (input.candidateIds && input.candidateIds.length > 0) {
    for (const cid of input.candidateIds) {
      const snap = await col.where("resolvedUserId", "==", cid).get()
      for (const doc of snap.docs) {
        const record = parseExternalCandidateRecordDoc(doc.data())
        if (record) out.push(record)
      }
    }
  }

  return dedupeRecords(out)
}

function dedupeRecords(records: ExternalCandidateRecord[]): ExternalCandidateRecord[] {
  const seen = new Set<string>()
  const out: ExternalCandidateRecord[] = []
  for (const r of records) {
    if (seen.has(r.recordId)) continue
    seen.add(r.recordId)
    out.push(r)
  }
  return out
}

async function loadCompanyJobContext(
  db: Firestore,
  input: GenerateAgentResearchPromptInput,
): Promise<AgentResearchPromptCompanyJobContext> {
  // Best effort — missing fields just contribute more missingInfo.
  const ctx: AgentResearchPromptCompanyJobContext = {
    companyId: input.companyId ?? "unknown",
    jobId: input.jobId ?? "unknown",
  }
  if (input.companyId) {
    try {
      const snap = await db.collection("pa-companies").doc(input.companyId).get()
      if (snap.exists) {
        const raw = (snap.data() ?? {}) as Record<string, unknown>
        const stringArray = (v: unknown): string[] | undefined =>
          Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : undefined
        if (typeof raw.name === "string") ctx.companyName = raw.name
        const industry = stringArray(raw.industrySector)
        if (industry) ctx.industrySector = industry
        const competitors = stringArray(raw.competitorCompanies)
        if (competitors) ctx.competitorCompanies = competitors
      }
    } catch (err) {
      logger.warn("external_supply.agent_task.company_load_failed", {
        companyId: input.companyId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (input.jobId) {
    try {
      const snap = await db.collection("pa-jobs").doc(input.jobId).get()
      if (snap.exists) {
        const raw = (snap.data() ?? {}) as Record<string, unknown>
        const stringArray = (v: unknown): string[] | undefined =>
          Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : undefined
        const title = typeof raw.title === "string" ? raw.title : typeof raw.jobTitle === "string" ? raw.jobTitle : undefined
        if (title) ctx.jobTitle = title
        const roleFunction = stringArray(raw.roleFunction)
        if (roleFunction) ctx.jobRoleFunction = roleFunction
        if (typeof raw.seniorityLevel === "string") ctx.seniorityLevel = raw.seniorityLevel
      }
    } catch (err) {
      logger.warn("external_supply.agent_task.job_load_failed", {
        jobId: input.jobId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return ctx
}

function recordToPromptCandidate(record: ExternalCandidateRecord): AgentResearchPromptCandidate {
  const out: AgentResearchPromptCandidate = { recordId: record.recordId }
  if (record.resolvedUserId) out.candidateId = record.resolvedUserId
  if (record.name) out.name = record.name
  if (record.canonicalLinkedInUrl) out.canonicalLinkedInUrl = record.canonicalLinkedInUrl
  if (record.currentTitle) out.currentTitle = record.currentTitle
  if (record.currentCompany) out.currentCompany = record.currentCompany
  return out
}

export async function runGenerateAgentResearchPrompt(
  data: unknown,
  auth: CallableAuth,
  rawDeps: AgentTaskDeps,
): Promise<GenerateAgentResearchPromptResult> {
  requireExternalSupplyAdmin(auth)
  const deps = ensureDeps(rawDeps)
  const input = parseGenerateInput(data)

  const records = await loadRecordsForPrompt(deps.db, input)
  if (records.length === 0) {
    throw new HttpsError("not-found", "no records resolved for the given ids")
  }

  const candidates = records.map(recordToPromptCandidate)
  const ctx = await loadCompanyJobContext(deps.db, input)

  // missingInfo — caller-supplied override wins; otherwise we surface a
  // minimal "confirm" prompt by leaving the list empty (the prompt builder
  // renders the fallback line in that case).
  const missingInfoByCandidate: Record<string, string[]> = {}
  if (input.missingInfoOverride) {
    for (const [k, v] of Object.entries(input.missingInfoOverride)) {
      if (Array.isArray(v)) missingInfoByCandidate[k] = v.filter((s) => typeof s === "string")
    }
  }

  const built = buildAgentResearchPrompt({
    candidates,
    missingInfoByCandidate,
    companyJobContext: ctx,
  })

  const taskId = deps.newId()
  const createdAt = deps.now()
  // `AgentResearchTaskSchema.evaluationRunId` requires a non-empty string.
  // When the operator hasn't tied this prompt to a specific evaluation run
  // we synthesize a deterministic placeholder so the schema round-trip
  // succeeds; downstream UI can still filter on this with no-op semantics.
  const evaluationRunId = input.evaluationRunId ?? `ad-hoc__${taskId}`
  const task: AgentResearchTask = {
    taskId,
    evaluationRunId,
    candidateIds: candidates.map((c) => c.candidateId ?? c.recordId),
    promptVersion: built.promptVersion,
    prompt: built.prompt,
    expectedJsonSchemaVersion: built.expectedJsonSchemaVersion,
    reviewStatus: "draft_prompt",
    evidence: [],
    createdAt,
  }
  // Sanity round-trip — better to surface a schema bug here than at read time.
  AgentResearchTaskSchema.parse(task)

  await deps.db.collection(PA_COLLECTIONS.agentResearchTasks).doc(taskId).set(task, { merge: false })

  return {
    ok: true,
    taskId,
    prompt: built.prompt,
    promptVersion: built.promptVersion,
    expectedJsonSchemaVersion: built.expectedJsonSchemaVersion,
  }
}

// ---------------------------------------------------------------------------
// 2. Import agent reply
// ---------------------------------------------------------------------------

export interface ImportAgentResearchResultInput {
  taskId: string
  rawResult: string
}

export interface ImportAgentResearchResultResult {
  ok: true
  taskId: string
  parsedCount: number
  parseErrorCount: number
  schemaVersionMismatch: boolean
}

function parseImportInput(data: unknown): ImportAgentResearchResultInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const taskId = typeof obj.taskId === "string" ? obj.taskId.trim() : ""
  const rawResult = typeof obj.rawResult === "string" ? obj.rawResult : ""
  if (!taskId) throw new HttpsError("invalid-argument", "taskId is required")
  if (!rawResult) throw new HttpsError("invalid-argument", "rawResult is required")
  return { taskId, rawResult }
}

const IMPORT_ALLOWED_STATUSES: ReadonlySet<AgentResearchTask["reviewStatus"]> = new Set([
  "draft_prompt",
  "prompt_copied",
  "result_imported",
])

export async function runImportAgentResearchResult(
  data: unknown,
  auth: CallableAuth,
  rawDeps: AgentTaskDeps,
): Promise<ImportAgentResearchResultResult> {
  requireExternalSupplyAdmin(auth)
  const deps = ensureDeps(rawDeps)
  const input = parseImportInput(data)

  const ref = deps.db.collection(PA_COLLECTIONS.agentResearchTasks).doc(input.taskId)
  const snap = await ref.get()
  if (!snap.exists) {
    throw new HttpsError("not-found", `Task ${input.taskId} not found.`)
  }
  const taskParsed = AgentResearchTaskSchema.safeParse(snap.data())
  if (!taskParsed.success) {
    throw new HttpsError("internal", `Task ${input.taskId} is malformed.`)
  }
  const task = taskParsed.data
  if (!IMPORT_ALLOWED_STATUSES.has(task.reviewStatus)) {
    throw new HttpsError(
      "failed-precondition",
      `Task ${input.taskId} reviewStatus=${task.reviewStatus}; expected one of ${[...IMPORT_ALLOWED_STATUSES].join(", ")}.`,
    )
  }

  const parsed = parseAgentResearchResult(input.rawResult, task.expectedJsonSchemaVersion)

  await ref.set(
    {
      rawResult: input.rawResult,
      parsedFindings: parsed.parsedFindings,
      parseErrors: parsed.parseErrors,
      reviewStatus: "result_imported",
      updatedAt: deps.now(),
    },
    { merge: true },
  )

  return {
    ok: true,
    taskId: input.taskId,
    parsedCount: parsed.parsedFindings.length,
    parseErrorCount: parsed.parseErrors.length,
    schemaVersionMismatch: parsed.schemaVersionMismatch,
  }
}

// ---------------------------------------------------------------------------
// 3. Approve / reject a finding
// ---------------------------------------------------------------------------

export interface ApproveAgentResearchFindingInput {
  taskId: string
  findingId: string
  approved: boolean
  note?: string
}

export interface ApproveAgentResearchFindingResult {
  ok: true
  taskId: string
  findingId: string
  approved: boolean
  reviewStatus: AgentResearchTask["reviewStatus"]
}

function parseApproveInput(data: unknown): ApproveAgentResearchFindingInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const taskId = typeof obj.taskId === "string" ? obj.taskId.trim() : ""
  const findingId = typeof obj.findingId === "string" ? obj.findingId.trim() : ""
  if (!taskId) throw new HttpsError("invalid-argument", "taskId is required")
  if (!findingId) throw new HttpsError("invalid-argument", "findingId is required")
  if (typeof obj.approved !== "boolean") {
    throw new HttpsError("invalid-argument", "approved (boolean) is required")
  }
  const note = typeof obj.note === "string" ? obj.note.slice(0, 2_000) : undefined
  return { taskId, findingId, approved: obj.approved, note }
}

function stringifyFindingValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Once every finding has a terminal disposition, decide the overall task
 * `reviewStatus`. We never auto-flip out of `result_imported` while any
 * finding is still "unreviewed" (i.e. still `approved=false` AND no
 * `approvedBy/At`).
 */
function nextReviewStatus(findings: AgentResearchFinding[]): AgentResearchTask["reviewStatus"] {
  if (findings.length === 0) return "result_imported"
  const allReviewed = findings.every((f) => f.approvedBy !== undefined)
  if (!allReviewed) return "result_imported"
  const anyApproved = findings.some((f) => f.approved)
  if (anyApproved) return "approved"
  return "rejected"
}

export async function runApproveAgentResearchFinding(
  data: unknown,
  auth: CallableAuth,
  rawDeps: AgentTaskDeps,
): Promise<ApproveAgentResearchFindingResult> {
  const { uid } = requireExternalSupplyAdmin(auth)
  const deps = ensureDeps(rawDeps)
  const input = parseApproveInput(data)

  const ref = deps.db.collection(PA_COLLECTIONS.agentResearchTasks).doc(input.taskId)
  const snap = await ref.get()
  if (!snap.exists) {
    throw new HttpsError("not-found", `Task ${input.taskId} not found.`)
  }
  const taskParsed = AgentResearchTaskSchema.safeParse(snap.data())
  if (!taskParsed.success) {
    throw new HttpsError("internal", `Task ${input.taskId} is malformed.`)
  }
  const task = taskParsed.data
  const findings = task.parsedFindings ?? []
  const idx = findings.findIndex((f) => f.findingId === input.findingId)
  if (idx === -1) {
    throw new HttpsError("not-found", `Finding ${input.findingId} not on task ${input.taskId}.`)
  }
  const target = findings[idx]!
  const now = deps.now()
  const updated: AgentResearchFinding = {
    ...target,
    approved: input.approved,
    approvedBy: uid,
    approvedAt: now,
  }
  const nextFindings = findings.map((f, i) => (i === idx ? updated : f))

  // Append `agent_research` evidence on approve (per E task spec). On reject
  // we leave evidence untouched to avoid polluting the audit channel.
  const nextEvidence: MarketplaceEvidence[] = task.evidence.slice()
  if (input.approved) {
    nextEvidence.push({
      source: "agent_research",
      summary: `${updated.field}: ${stringifyFindingValue(updated.value)}`,
      confidence: updated.confidence,
      meta: {
        findingId: updated.findingId,
        evidenceUrls: updated.evidenceUrls,
        note: input.note ?? null,
      },
    })
  }

  const reviewStatus = nextReviewStatus(nextFindings)

  await ref.set(
    {
      parsedFindings: nextFindings,
      evidence: nextEvidence,
      reviewStatus,
      reviewedBy: uid,
      reviewedAt: now,
      updatedAt: now,
    },
    { merge: true },
  )

  return {
    ok: true,
    taskId: input.taskId,
    findingId: input.findingId,
    approved: input.approved,
    reviewStatus,
  }
}

// ---------------------------------------------------------------------------
// CF wrappers
// ---------------------------------------------------------------------------

export const paExternalSupplyGenerateAgentResearchPrompt = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async (req): Promise<GenerateAgentResearchPromptResult> => {
    return runGenerateAgentResearchPrompt(req.data, req.auth, { db: getFirestore() })
  },
)

export const paExternalSupplyImportAgentResearchResult = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async (req): Promise<ImportAgentResearchResultResult> => {
    return runImportAgentResearchResult(req.data, req.auth, { db: getFirestore() })
  },
)

export const paExternalSupplyApproveAgentResearchFinding = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    maxInstances: 1,
  },
  async (req): Promise<ApproveAgentResearchFindingResult> => {
    return runApproveAgentResearchFinding(req.data, req.auth, { db: getFirestore() })
  },
)

// Re-export prompt/parse version constants for downstream test convenience.
export { AGENT_PROMPT_VERSION, AGENT_RESULT_SCHEMA_VERSION }
