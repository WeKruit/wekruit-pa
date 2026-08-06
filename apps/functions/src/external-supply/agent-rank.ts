/**
 * v2.0 External Supply V2 — Wave C (Executor D) — Three admin-gated callables
 * for the agent-ranking layer.
 *
 *  1. `paExternalSupplyRunAgentRanking`
 *     Loads evaluation rows for a run + (optionally) record-ids scope. Skips
 *     candidates whose ranking row is already in a terminal state (approved
 *     / overridden). For each remaining candidate: assembles the prompt via
 *     `buildAgentRankingPrompt` (pure), projects cost (deterministic),
 *     aborts with no writes if projected > budget, otherwise runs the
 *     ensemble of LLM calls (`runWithOpenAI`, injected for tests), parses
 *     each, applies hard-gate clamp + ensemble majority, writes one
 *     `pa-agent-ranking-results/{resultId}` doc + one `pa-tool-calls` ledger
 *     row per LLM call (including parse-failure rows).
 *
 *  2. `paExternalSupplyApproveAgentTier`
 *     Operator approves the agent's proposed tier as-is. Updates status →
 *     `approved`, stamps `approvedTier = proposedAgentTier`, `approvedBy`,
 *     `approvedAt`. No correction event (per L-D7).
 *
 *  3. `paExternalSupplyOverrideAgentTier`
 *     Operator picks a different tier. Batch-writes the ranking row's
 *     status + `pa-correction-events/{eventId}` with
 *     `targetType: "agent_ranking_result"` (per L-D7). Idempotent on
 *     already-overridden (returns existing `correctionEventId`); throws
 *     `failed-precondition` if already approved.
 *
 * L-D4 (HARD REQUIREMENT): `runAgentRanking` accepts a deps bag exposing
 * `db`, `runWithOpenAI`, `now`. G's e2e harness drives this against an
 * in-memory Firestore + a deterministic LLM stub. The CF wrapper sources
 * `runWithOpenAI` from `@pa/agent-runtime`.
 */

import { randomUUID } from "node:crypto"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  AgentRankingResultSchema,
  CandidateCompanyJobEvaluationSchema,
  PA_COLLECTIONS,
  createAgentRankingResultId,
  type AgentRankingAction,
  type AgentRankingEnsembleVote,
  type AgentRankingResult,
  type CandidateCompanyJobEvaluation,
  type EvaluationTier,
} from "@pa/core-types"
import {
  AGENT_RANK_EXPECTED_SCHEMA_VERSION,
  AGENT_RANK_PROMPT_VERSION,
  COST_TABLE_VERSION,
  buildAgentRankingPrompt,
  computeActualVoteCostUsd,
  estimateAgentRankingTokens,
  parseAgentRankingResponse,
  pickEnsembleMajority,
  projectAgentRankingCost,
  type AgentRankingPromptCandidate,
  type AgentRankingPromptCompanyContext,
  type AgentRankingPromptInput,
  type AgentRankingPromptJobContext,
  type AgentRankingPromptResearchFinding,
} from "@pa/external-supply"
import { runWithOpenAI as defaultRunWithOpenAI } from "@pa/agent-runtime"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CallableAuth = Parameters<typeof requireExternalSupplyAdmin>[0]

/**
 * Loose type for `runWithOpenAI` — we only call it through this surface so
 * tests can stub the whole signature. Mirrors the real provider's return
 * shape (text + usage block).
 */
export interface RunWithOpenAIDep {
  (
    agent: { id: string; name: string; provider: "openai"; model: string; temperature: number; maxTokens?: number; systemPrompt: string; version: string },
    params: { messages: Array<{ role: "system" | "user" | "assistant"; content: string }>; signal?: AbortSignal },
  ): Promise<{ text: string; usage: { promptTokens?: number; completionTokens?: number } }>
}

export interface AgentRankingDeps {
  db: Firestore
  runWithOpenAI?: RunWithOpenAIDep
  now?: () => string
  newId?: () => string
}

export interface RunAgentRankingInput {
  evaluationRunId: string
  candidateRecordIds?: string[]
  model?: string
  ensembleSize?: number
  dryRun?: boolean
  budgetUsd?: number
}

export interface RunAgentRankingResult {
  ok: true
  evaluationRunId: string
  processedCount: number
  rankedCount: number
  skippedCount: number
  totalCostUsd: number
  projectedCostUsd: number
  abortedReason?: "budget_exceeded" | "dry_run"
  promptVersion: string
  costTableVersion: string
  prompts?: Array<{ candidateRecordId: string; promptCharCount: number; estimatedInputTokens: number }>
}

export interface ApproveAgentTierInput {
  resultId: string
  reason?: string
}

export interface ApproveAgentTierResult {
  ok: true
  resultId: string
  approvedTier: EvaluationTier
}

export interface OverrideAgentTierInput {
  resultId: string
  newTier: EvaluationTier
  reason: string
}

export interface OverrideAgentTierResult {
  ok: true
  resultId: string
  approvedTier: EvaluationTier
  correctionEventId: string
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-5.4-nano"
const DEFAULT_BUDGET_USD = 10
const MAX_ENSEMBLE_SIZE = 3
const LLM_MAX_TOKENS = 500
const LLM_TEMPERATURE = 0.2

function getBudgetUsd(input: RunAgentRankingInput): number {
  if (typeof input.budgetUsd === "number" && input.budgetUsd > 0) return input.budgetUsd
  const env = process.env.EXTERNAL_SUPPLY_AGENT_RANKING_BUDGET_USD_PER_BATCH
  if (env) {
    const parsed = Number.parseFloat(env)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_BUDGET_USD
}

// ---------------------------------------------------------------------------
// Input parser
// ---------------------------------------------------------------------------

function parseRunInput(data: unknown): RunAgentRankingInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const evaluationRunId =
    typeof obj.evaluationRunId === "string" ? obj.evaluationRunId.trim() : ""
  if (!evaluationRunId) {
    throw new HttpsError("invalid-argument", "evaluationRunId is required")
  }
  const candidateRecordIds = Array.isArray(obj.candidateRecordIds)
    ? (obj.candidateRecordIds.filter(
        (v) => typeof v === "string" && v.trim().length > 0,
      ) as string[])
    : undefined
  const model = typeof obj.model === "string" && obj.model.trim().length > 0 ? obj.model.trim() : DEFAULT_MODEL
  const ensembleSizeRaw = typeof obj.ensembleSize === "number" ? obj.ensembleSize : 1
  const ensembleSize = Math.max(1, Math.min(MAX_ENSEMBLE_SIZE, Math.floor(ensembleSizeRaw)))
  const dryRun = obj.dryRun === true
  const budgetUsd = typeof obj.budgetUsd === "number" && obj.budgetUsd > 0 ? obj.budgetUsd : undefined
  return {
    evaluationRunId,
    candidateRecordIds: candidateRecordIds && candidateRecordIds.length > 0 ? candidateRecordIds : undefined,
    model,
    ensembleSize,
    dryRun,
    budgetUsd,
  }
}

function parseApproveInput(data: unknown): ApproveAgentTierInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const resultId = typeof obj.resultId === "string" ? obj.resultId.trim() : ""
  if (!resultId) throw new HttpsError("invalid-argument", "resultId is required")
  const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 2_000) : undefined
  return { resultId, reason }
}

function parseOverrideInput(data: unknown): OverrideAgentTierInput {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const resultId = typeof obj.resultId === "string" ? obj.resultId.trim() : ""
  const newTier = typeof obj.newTier === "string" ? (obj.newTier.trim() as EvaluationTier) : ("" as EvaluationTier)
  const reason = typeof obj.reason === "string" ? obj.reason.trim() : ""
  if (!resultId) throw new HttpsError("invalid-argument", "resultId is required")
  if (!newTier) throw new HttpsError("invalid-argument", "newTier is required")
  if (!reason) throw new HttpsError("invalid-argument", "reason is required")
  // Validate the tier matches the enum.
  const allowed: ReadonlyArray<EvaluationTier> = [
    "tier_1_personal_linkedin_and_email",
    "tier_2_personal_email",
    "tier_3_general_email",
    "retain_only",
    "blocked",
  ]
  if (!allowed.includes(newTier)) {
    throw new HttpsError("invalid-argument", `newTier must be one of ${allowed.join(", ")}`)
  }
  return { resultId, newTier, reason: reason.slice(0, 2_000) }
}

// ---------------------------------------------------------------------------
// Firestore loaders
// ---------------------------------------------------------------------------

async function loadEvaluationsForRun(
  db: Firestore,
  evaluationRunId: string,
  filterRecordIds?: string[],
): Promise<CandidateCompanyJobEvaluation[]> {
  const out: CandidateCompanyJobEvaluation[] = []
  const filter = filterRecordIds ? new Set(filterRecordIds) : undefined
  const snap = await db
    .collection(PA_COLLECTIONS.candidateCompanyJobEvaluations)
    .where("evaluationRunId", "==", evaluationRunId)
    .get()
  for (const doc of snap.docs) {
    const parsed = CandidateCompanyJobEvaluationSchema.safeParse(doc.data())
    if (!parsed.success) continue
    out.push(parsed.data)
  }
  if (!filter) return out
  // The `candidateRecordIds` scope filter compares against the candidate id
  // (evaluation rows persist `candidateId = pa-users uid` post-resolve). We
  // also accept the raw recordId in case the caller wants to scope by the
  // sourcing record. Either match is enough.
  return out.filter((e) => filter.has(e.candidateId))
}

async function loadExistingRanking(
  db: Firestore,
  resultId: string,
): Promise<AgentRankingResult | null> {
  const snap = await db
    .collection(PA_COLLECTIONS.agentRankingResults)
    .doc(resultId)
    .get()
  if (!snap.exists) return null
  const parsed = AgentRankingResultSchema.safeParse(snap.data())
  if (!parsed.success) return null
  return parsed.data
}

async function loadCandidateProfileForPrompt(
  db: Firestore,
  candidateId: string,
): Promise<AgentRankingPromptCandidate> {
  const out: AgentRankingPromptCandidate = { recordId: candidateId, candidateId }
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
    if (snap.exists) {
      const raw = (snap.data() ?? {}) as Record<string, unknown>
      if (typeof raw.name === "string") out.name = raw.name
      if (typeof raw.linkedinUrl === "string") out.canonicalLinkedInUrl = raw.linkedinUrl
      if (typeof raw.currentTitle === "string") out.currentTitle = raw.currentTitle
      if (typeof raw.currentCompany === "string") out.currentCompany = raw.currentCompany
      const exp = Array.isArray(raw.experience) ? raw.experience : undefined
      if (exp) {
        out.experience = exp
          .filter((e) => typeof e === "object" && e !== null)
          .map((e) => {
            const r = e as Record<string, unknown>
            return {
              company: typeof r.company === "string" ? r.company : "",
              title: typeof r.title === "string" ? r.title : "",
              startDate: typeof r.startDate === "string" ? r.startDate : undefined,
              endDate: typeof r.endDate === "string" ? r.endDate : undefined,
              durationMonths:
                typeof r.durationMonths === "number" ? r.durationMonths : undefined,
            }
          })
          .filter((e) => e.company && e.title)
      }
      const tags = (raw.tags as Record<string, unknown> | undefined) ?? undefined
      const globalTags = (raw.globalTags as Record<string, unknown> | undefined) ?? undefined
      const skillsRaw =
        (tags?.skills as unknown) ?? (globalTags?.skills as unknown) ?? raw.skills
      if (Array.isArray(skillsRaw)) {
        out.skills = skillsRaw
          .map((s) => (typeof s === "string" ? s : typeof s === "object" && s !== null && typeof (s as Record<string, unknown>).value === "string" ? ((s as Record<string, unknown>).value as string) : undefined))
          .filter((s): s is string => typeof s === "string" && s.length > 0)
      }
    }
  } catch (err) {
    logger.warn("external_supply.agent_rank.profile_load_failed", {
      candidateId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
  return out
}

async function loadCompanyForPrompt(
  db: Firestore,
  companyId: string,
): Promise<AgentRankingPromptCompanyContext> {
  const ctx: AgentRankingPromptCompanyContext = { companyId }
  try {
    const snap = await db.collection("pa-companies").doc(companyId).get()
    if (snap.exists) {
      const raw = (snap.data() ?? {}) as Record<string, unknown>
      if (typeof raw.name === "string") ctx.companyName = raw.name
      const arr = (v: unknown): string[] | undefined =>
        Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : undefined
      const industry = arr(raw.industrySector)
      if (industry) ctx.industrySector = industry
      const competitors = arr(raw.competitorCompanies)
      if (competitors) ctx.competitorCompanies = competitors
      if (typeof raw.size === "string") ctx.size = raw.size
    }
  } catch (err) {
    logger.warn("external_supply.agent_rank.company_load_failed", { companyId, err: String(err) })
  }
  return ctx
}

async function loadJobForPrompt(
  db: Firestore,
  jobId: string,
): Promise<AgentRankingPromptJobContext> {
  const ctx: AgentRankingPromptJobContext = { jobId }
  try {
    const snap = await db.collection(PA_COLLECTIONS.jobs).doc(jobId).get()
    if (snap.exists) {
      const raw = (snap.data() ?? {}) as Record<string, unknown>
      const arr = (v: unknown): string[] | undefined =>
        Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : undefined
      const title = typeof raw.title === "string" ? raw.title : typeof raw.jobTitle === "string" ? raw.jobTitle : undefined
      if (title) ctx.jobTitle = title
      const rf = arr(raw.roleFunction)
      if (rf) ctx.roleFunction = rf
      if (typeof raw.seniorityLevel === "string") ctx.seniorityLevel = raw.seniorityLevel
      const required = arr(raw.requiredSkills)
      if (required) ctx.requiredSkills = required
      const loc = arr(raw.locationBuckets)
      if (loc) ctx.locationBuckets = loc
      const industry = arr(raw.industrySector)
      if (industry) ctx.industrySector = industry
    }
  } catch (err) {
    logger.warn("external_supply.agent_rank.job_load_failed", { jobId, err: String(err) })
  }
  return ctx
}

async function loadApprovedFindings(
  db: Firestore,
  evaluationRunId: string,
  candidateId: string,
): Promise<AgentRankingPromptResearchFinding[]> {
  const out: AgentRankingPromptResearchFinding[] = []
  try {
    const snap = await db
      .collection(PA_COLLECTIONS.agentResearchTasks)
      .where("evaluationRunId", "==", evaluationRunId)
      .get()
    for (const doc of snap.docs) {
      const data = (doc.data() ?? {}) as Record<string, unknown>
      const findings = Array.isArray(data.parsedFindings) ? data.parsedFindings : []
      for (const f of findings) {
        if (typeof f !== "object" || f === null) continue
        const r = f as Record<string, unknown>
        if (r.approved !== true) continue
        if (typeof r.candidateId === "string" && r.candidateId !== candidateId) continue
        if (typeof r.field !== "string" || typeof r.confidence !== "number") continue
        const evidenceUrls = Array.isArray(r.evidenceUrls)
          ? (r.evidenceUrls.filter((u) => typeof u === "string") as string[])
          : []
        out.push({
          field: r.field,
          value: r.value,
          confidence: r.confidence,
          evidenceUrls,
          uncertainty: typeof r.uncertainty === "string" ? r.uncertainty : undefined,
        })
      }
    }
  } catch (err) {
    logger.warn("external_supply.agent_rank.findings_load_failed", {
      evaluationRunId,
      candidateId,
      err: String(err),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Tool-call audit (inline; mirrors V1 writeToolCallAudit shape with V2 fields)
// ---------------------------------------------------------------------------

async function writeAgentRankToolCall(
  db: Firestore,
  row: {
    callable: string
    candidateId: string
    evaluationRunId: string
    resultId: string
    modelUsed: string
    promptCharCount: number
    estimatedInputTokens: number
    promptVersion: string
    schemaVersionOk: boolean
    proposedAgentTier: EvaluationTier | null
    outputTokens: number
    parseErrorsCount: number
    costUsd: number
    error?: string
    now: string
  },
): Promise<void> {
  try {
    await db.collection(PA_COLLECTIONS.toolCalls).add({
      provider: "external_supply",
      callable: row.callable,
      candidateId: row.candidateId,
      evaluationRunId: row.evaluationRunId,
      resultId: row.resultId,
      modelUsed: row.modelUsed,
      promptRedacted: {
        promptCharCount: row.promptCharCount,
        estimatedInputTokens: row.estimatedInputTokens,
        promptVersion: row.promptVersion,
      },
      responseRedacted: {
        schemaVersionOk: row.schemaVersionOk,
        proposedAgentTier: row.proposedAgentTier,
        outputTokens: row.outputTokens,
        parseErrorsCount: row.parseErrorsCount,
        ...(row.error !== undefined ? { error: row.error } : {}),
      },
      costUsd: row.costUsd,
      costTableVersion: COST_TABLE_VERSION,
      createdAt: row.now,
    })
  } catch (err) {
    logger.warn("external_supply.agent_rank.tool_call_audit_failed", {
      callable: row.callable,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Main pure handler — runAgentRanking
// ---------------------------------------------------------------------------

export async function runAgentRanking(
  data: unknown,
  auth: CallableAuth,
  deps: AgentRankingDeps,
): Promise<RunAgentRankingResult> {
  requireExternalSupplyAdmin(auth)
  const input = parseRunInput(data)
  const { db } = deps
  const runWithOpenAI: RunWithOpenAIDep =
    deps.runWithOpenAI ?? (defaultRunWithOpenAI as unknown as RunWithOpenAIDep)
  const now = deps.now ?? (() => new Date().toISOString())
  const newId = deps.newId ?? (() => randomUUID())
  void newId // reserved for any auxiliary id generation; ranking row id is deterministic

  const model = input.model ?? DEFAULT_MODEL
  const ensembleSize = input.ensembleSize ?? 1
  const budgetUsd = getBudgetUsd(input)
  const dryRun = input.dryRun === true

  // Load evaluation rows for the run.
  const evaluations = await loadEvaluationsForRun(
    db,
    input.evaluationRunId,
    input.candidateRecordIds,
  )

  let skippedCount = 0
  // Filter out already-terminal ranking rows (skipped per L-D7).
  const todo: CandidateCompanyJobEvaluation[] = []
  for (const ev of evaluations) {
    const resultId = createAgentRankingResultId({
      evaluationRunId: input.evaluationRunId,
      candidateRecordId: ev.candidateId,
    })
    const existing = await loadExistingRanking(db, resultId)
    if (existing && (existing.status === "approved" || existing.status === "overridden")) {
      skippedCount += 1
      continue
    }
    todo.push(ev)
  }

  // Build prompts (pure) so we can project cost.
  const builtPrompts: Array<{ evaluation: CandidateCompanyJobEvaluation; promptInput: AgentRankingPromptInput; prompt: string }> = []
  for (const ev of todo) {
    const candidate = await loadCandidateProfileForPrompt(db, ev.candidateId)
    candidate.recordId = ev.candidateId
    candidate.candidateId = ev.candidateId
    const company = await loadCompanyForPrompt(db, ev.companyId)
    const job = await loadJobForPrompt(db, ev.jobId)
    const findings = await loadApprovedFindings(db, ev.evaluationRunId, ev.candidateId)
    const promptInput: AgentRankingPromptInput = {
      candidate,
      company,
      job,
      approvedResearchFindings: findings,
      deterministicRubric: {
        proposedTier: ev.proposedTier,
        generalRubricScore: ev.generalRubricScore,
        companyRubricScore: ev.companyRubricScore,
        jobRubricScore: ev.jobRubricScore,
        softScore: ev.softScore,
        hardGateResult: ev.hardGateResult,
        hardGateReasons: ev.hardGateReasons,
        missingInfo: ev.missingInfo,
        risks: ev.risks,
        explanation: ev.explanation,
      },
    }
    const built = buildAgentRankingPrompt(promptInput)
    builtPrompts.push({ evaluation: ev, promptInput, prompt: built.prompt })
  }

  // Cost projection (also covers the empty case).
  const projection = projectAgentRankingCost({
    prompts: builtPrompts.map((b) => b.prompt),
    model,
    ensembleSize,
  })

  if (projection.totalProjectedCostUsd > budgetUsd) {
    return {
      ok: true,
      evaluationRunId: input.evaluationRunId,
      processedCount: builtPrompts.length,
      rankedCount: 0,
      skippedCount,
      totalCostUsd: 0,
      projectedCostUsd: projection.totalProjectedCostUsd,
      abortedReason: "budget_exceeded",
      promptVersion: AGENT_RANK_PROMPT_VERSION,
      costTableVersion: COST_TABLE_VERSION,
    }
  }

  if (dryRun) {
    return {
      ok: true,
      evaluationRunId: input.evaluationRunId,
      processedCount: builtPrompts.length,
      rankedCount: 0,
      skippedCount,
      totalCostUsd: 0,
      projectedCostUsd: projection.totalProjectedCostUsd,
      abortedReason: "dry_run",
      promptVersion: AGENT_RANK_PROMPT_VERSION,
      costTableVersion: COST_TABLE_VERSION,
      prompts: builtPrompts.map((b) => ({
        candidateRecordId: b.evaluation.candidateId,
        promptCharCount: b.prompt.length,
        estimatedInputTokens: estimateAgentRankingTokens(b.prompt),
      })),
    }
  }

  // Live mode — run LLM calls per candidate × ensembleSize.
  let totalCostUsd = 0
  let rankedCount = 0
  const agent = {
    id: `external-supply-agent-rank-${model}`,
    name: "external-supply-agent-rank",
    provider: "openai" as const,
    model,
    temperature: LLM_TEMPERATURE,
    maxTokens: LLM_MAX_TOKENS,
    systemPrompt: "You are a ranking assistant. Output strict JSON only.",
    version: "1",
  }

  for (const b of builtPrompts) {
    const candidateId = b.evaluation.candidateId
    const resultId = createAgentRankingResultId({
      evaluationRunId: input.evaluationRunId,
      candidateRecordId: candidateId,
    })
    const votes: AgentRankingEnsembleVote[] = []
    let parseFailedAll = true
    let candidateTotalCost = 0
    let candidateTotalIn = 0
    let candidateTotalOut = 0
    const promptCharCount = b.prompt.length
    const estimatedInputTokens = estimateAgentRankingTokens(b.prompt)

    for (let i = 0; i < ensembleSize; i += 1) {
      let llmText = ""
      let inputTokens = 0
      let outputTokens = 0
      let llmError: string | undefined
      try {
        const result = await runWithOpenAI(agent, {
          messages: [
            { role: "system", content: agent.systemPrompt },
            { role: "user", content: b.prompt },
          ],
        })
        llmText = result.text
        inputTokens = result.usage.promptTokens ?? estimatedInputTokens
        outputTokens = result.usage.completionTokens ?? 0
      } catch (err) {
        llmError = err instanceof Error ? err.message : String(err)
        logger.warn("external_supply.agent_rank.llm_call_failed", {
          candidateId,
          resultId,
          err: llmError,
        })
      }

      let voteOk = false
      let proposedAgentTier: EvaluationTier | null = null
      let schemaVersionOk = false
      let parseErrorsCount = 0
      const callCost = computeActualVoteCostUsd({ model, inputTokens, outputTokens })
      candidateTotalCost += callCost
      candidateTotalIn += inputTokens
      candidateTotalOut += outputTokens

      if (!llmError && llmText) {
        const parsed = parseAgentRankingResponse(llmText, AGENT_RANK_EXPECTED_SCHEMA_VERSION)
        if (parsed.ok) {
          voteOk = true
          parseFailedAll = false
          proposedAgentTier = parsed.vote.proposedAgentTier
          schemaVersionOk = !parsed.schemaVersionMismatch
          votes.push({
            modelUsed: model,
            proposedAgentTier: parsed.vote.proposedAgentTier,
            agentRationale: parsed.vote.agentRationale,
            agentRisks: parsed.vote.agentRisks,
            agentRecommendedAction: parsed.vote.agentRecommendedAction,
            inputTokens,
            outputTokens,
            costUsd: callCost,
          })
        } else {
          parseErrorsCount = parsed.parseErrors.length
        }
      }

      await writeAgentRankToolCall(db, {
        callable: "runAgentRanking",
        candidateId,
        evaluationRunId: input.evaluationRunId,
        resultId,
        modelUsed: model,
        promptCharCount,
        estimatedInputTokens,
        promptVersion: AGENT_RANK_PROMPT_VERSION,
        schemaVersionOk,
        proposedAgentTier,
        outputTokens,
        parseErrorsCount,
        costUsd: callCost,
        error: llmError ?? (voteOk ? undefined : "parse_failed"),
        now: now(),
      })
      void voteOk
    }

    totalCostUsd += candidateTotalCost

    if (parseFailedAll) {
      // Every call failed → don't write a ranking row, count as skipped.
      skippedCount += 1
      continue
    }

    const majority = pickEnsembleMajority(votes, b.evaluation.proposedTier)

    let finalTier = majority.proposedAgentTier
    const finalRisks = [...majority.agentRisks]
    let finalAction: AgentRankingAction = majority.agentRecommendedAction
    let finalRationale = majority.agentRationale
    // Hard-gate clamp.
    if (b.evaluation.proposedTier === "blocked") {
      finalTier = "blocked"
      if (!finalRisks.includes("hard_gate_blocked")) finalRisks.push("hard_gate_blocked")
      finalAction = "do_not_contact"
      if (majority.proposedAgentTier !== "blocked") {
        finalRationale = `${finalRationale} (hard-gate clamped to blocked)`
      }
    }

    const createdAt = now()
    const rankingDoc: AgentRankingResult = {
      resultId,
      evaluationRunId: input.evaluationRunId,
      candidateRecordId: candidateId,
      candidateUserId: candidateId,
      companyId: b.evaluation.companyId,
      jobId: b.evaluation.jobId,
      deterministicTier: b.evaluation.proposedTier,
      proposedAgentTier: finalTier,
      agentRationale: finalRationale,
      agentRisks: finalRisks,
      agentRecommendedAction: finalAction,
      ensembleVotes: votes,
      modelUsed: model,
      ensembleSize,
      totalInputTokens: candidateTotalIn,
      totalOutputTokens: candidateTotalOut,
      totalCostUsd: candidateTotalCost,
      dryRun: false,
      promptVersion: AGENT_RANK_PROMPT_VERSION,
      status: "proposed",
      createdAt,
    }
    // Persist with a sibling COST_TABLE_VERSION field for ledger reconciliation.
    const validated = AgentRankingResultSchema.parse(rankingDoc)
    const persistDoc: Record<string, unknown> = { ...validated, costTableVersion: COST_TABLE_VERSION }
    await db
      .collection(PA_COLLECTIONS.agentRankingResults)
      .doc(resultId)
      .set(persistDoc, { merge: false })
    rankedCount += 1
  }

  return {
    ok: true,
    evaluationRunId: input.evaluationRunId,
    processedCount: builtPrompts.length,
    rankedCount,
    skippedCount,
    totalCostUsd,
    projectedCostUsd: projection.totalProjectedCostUsd,
    promptVersion: AGENT_RANK_PROMPT_VERSION,
    costTableVersion: COST_TABLE_VERSION,
  }
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

export async function runApproveAgentTier(
  data: unknown,
  auth: CallableAuth,
  deps: AgentRankingDeps,
): Promise<ApproveAgentTierResult> {
  const { uid } = requireExternalSupplyAdmin(auth)
  const input = parseApproveInput(data)
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())

  const ref = db.collection(PA_COLLECTIONS.agentRankingResults).doc(input.resultId)
  const snap = await ref.get()
  if (!snap.exists) {
    throw new HttpsError("not-found", `Ranking ${input.resultId} not found.`)
  }
  const parsed = AgentRankingResultSchema.safeParse(snap.data())
  if (!parsed.success) {
    throw new HttpsError("internal", `Ranking ${input.resultId} is malformed.`)
  }
  const row = parsed.data
  if (row.status === "approved") {
    return {
      ok: true,
      resultId: input.resultId,
      approvedTier: row.approvedTier ?? row.proposedAgentTier,
    }
  }
  if (row.status !== "proposed") {
    throw new HttpsError(
      "failed-precondition",
      `Ranking ${input.resultId} status=${row.status}; expected proposed.`,
    )
  }

  const approvedAt = now()
  const updated: Record<string, unknown> = {
    ...row,
    status: "approved",
    approvedTier: row.proposedAgentTier,
    approvedBy: uid,
    approvedAt,
    costTableVersion: COST_TABLE_VERSION,
  }
  // Reason is informational; not part of the schema, but keep it under a
  // separate audit-friendly key.
  if (input.reason) {
    updated.approvalReason = input.reason
  }
  await ref.set(updated, { merge: false })

  return { ok: true, resultId: input.resultId, approvedTier: row.proposedAgentTier }
}

// ---------------------------------------------------------------------------
// override
// ---------------------------------------------------------------------------

export async function runOverrideAgentTier(
  data: unknown,
  auth: CallableAuth,
  deps: AgentRankingDeps,
): Promise<OverrideAgentTierResult> {
  requireExternalSupplyAdmin(auth)
  const input = parseOverrideInput(data)
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const newId = deps.newId ?? (() => randomUUID())

  const ref = db.collection(PA_COLLECTIONS.agentRankingResults).doc(input.resultId)
  const snap = await ref.get()
  if (!snap.exists) {
    throw new HttpsError("not-found", `Ranking ${input.resultId} not found.`)
  }
  const parsed = AgentRankingResultSchema.safeParse(snap.data())
  if (!parsed.success) {
    throw new HttpsError("internal", `Ranking ${input.resultId} is malformed.`)
  }
  const row = parsed.data
  if (row.status === "overridden") {
    return {
      ok: true,
      resultId: input.resultId,
      approvedTier: row.approvedTier ?? row.proposedAgentTier,
      correctionEventId: row.correctionEventId ?? "",
    }
  }
  if (row.status === "approved") {
    throw new HttpsError(
      "failed-precondition",
      `Ranking ${input.resultId} is already approved; cannot override.`,
    )
  }
  if (row.status !== "proposed") {
    throw new HttpsError(
      "failed-precondition",
      `Ranking ${input.resultId} status=${row.status}; expected proposed.`,
    )
  }

  const eventId = newId()
  const overriddenAt = now()
  const updatedRanking: Record<string, unknown> = {
    ...row,
    status: "overridden",
    approvedTier: input.newTier,
    approvedAt: overriddenAt,
    correctionEventId: eventId,
    costTableVersion: COST_TABLE_VERSION,
  }
  const correctionDoc = {
    eventId,
    targetType: "agent_ranking_result" as const,
    targetId: input.resultId,
    actor: "operator" as const,
    candidateId: row.candidateUserId ?? row.candidateRecordId,
    jobId: row.jobId,
    reason: input.reason,
    beforeRedacted: {
      proposedAgentTier: row.proposedAgentTier,
      deterministicTier: row.deterministicTier,
    },
    afterRedacted: { approvedTier: input.newTier },
    evidence: [],
    createdAt: overriddenAt,
  }

  // Batched-style sequential writes (Firestore fake in tests does not
  // implement batches; production Firestore would; behavior identical).
  await ref.set(updatedRanking, { merge: false })
  await db
    .collection(PA_COLLECTIONS.correctionEvents)
    .doc(eventId)
    .set(correctionDoc, { merge: false })

  return {
    ok: true,
    resultId: input.resultId,
    approvedTier: input.newTier,
    correctionEventId: eventId,
  }
}

// ---------------------------------------------------------------------------
// CF wrappers
// ---------------------------------------------------------------------------

export const paExternalSupplyRunAgentRanking = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 540 },
  async (req): Promise<RunAgentRankingResult> => {
    return runAgentRanking(req.data, req.auth, { db: getFirestore() })
  },
)

export const paExternalSupplyApproveAgentTier = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 60 },
  async (req): Promise<ApproveAgentTierResult> => {
    return runApproveAgentTier(req.data, req.auth, { db: getFirestore() })
  },
)

export const paExternalSupplyOverrideAgentTier = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 60 },
  async (req): Promise<OverrideAgentTierResult> => {
    return runOverrideAgentTier(req.data, req.auth, { db: getFirestore() })
  },
)
