/**
 * v2.0 External Supply V2 — Wave C (Executor D) — Agent ranking layer
 * prompt builder, defensive JSON parser, ensemble majority, token estimator,
 * cost projector, pricing table.
 *
 * Pure module — zero Firestore / network access. Tests pin everything via
 * golden fixtures + deterministic estimators.
 *
 * Lead resolutions consumed verbatim (EXECUTOR-PLANS.md §D):
 *  - L-D1 Pricing table HARD-CODED with COST_TABLE_VERSION stamp.
 *  - L-D2 Token estimator duplicated locally (no orchestrator dep).
 *  - L-D5 OUTPUT_TOKEN_BUDGET=400 (max_tokens=500 set caller-side).
 *  - L-D6 Truncate experience to last 10 + skills to top 30; note inline.
 *  - L-D7 Ensemble tie → deterministic fallback + outreach_after_research.
 *
 * Output JSON contract emitted in the prompt body (the agent must echo back
 * this schema exactly):
 *
 *   {
 *     "schemaVersion": "agent-rank-result-2026-05-A",
 *     "proposedAgentTier": "<EvaluationTier enum>",
 *     "agentRationale": "<1-3 sentences>",
 *     "agentRisks": ["..."],
 *     "agentRecommendedAction": "<AgentRankingAction enum>"
 *   }
 */

import { z } from "zod"
import {
  AgentRankingActionSchema,
  EvaluationTierSchema,
  type AgentRankingEnsembleVote,
  type EvaluationTier,
} from "@pa/core-types"

// ---------------------------------------------------------------------------
// Version stamps
// ---------------------------------------------------------------------------

export const AGENT_RANK_PROMPT_VERSION = "agent-rank-2026-05-A"
export const AGENT_RANK_EXPECTED_SCHEMA_VERSION = "agent-rank-result-2026-05-A"

// ---------------------------------------------------------------------------
// Cost table — hard-coded per L-D1 with COST_TABLE_VERSION stamped on every
// ledger + ranking row downstream. Bump version on any pricing change.
// ---------------------------------------------------------------------------

export const MODEL_PRICING_USD_PER_1K = {
  "gpt-5.4-nano": { in: 0.00015, out: 0.0006 },
  "gpt-4.1-mini": { in: 0.0004, out: 0.0016 },
  "claude-sonnet-4-6": { in: 0.003, out: 0.015 },
} as const

export type AgentRankingModel = keyof typeof MODEL_PRICING_USD_PER_1K

export const COST_TABLE_VERSION = "pricing-2026-05-A"
export const OUTPUT_TOKEN_BUDGET = 400

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface AgentRankingPromptExperience {
  company: string
  title: string
  startDate?: string
  endDate?: string
  durationMonths?: number
}

export interface AgentRankingPromptCandidate {
  recordId: string
  candidateId?: string
  /** Full name; the builder PII-scrubs into initial + last-name-initial. */
  name?: string
  canonicalLinkedInUrl?: string
  currentTitle?: string
  currentCompany?: string
  /** Full list — the builder truncates to last 10 with a "..." note. */
  experience?: AgentRankingPromptExperience[]
  /** Full skills list — the builder truncates to top 30. */
  skills?: string[]
}

export interface AgentRankingPromptJobContext {
  jobId: string
  jobTitle?: string
  roleFunction?: string[]
  seniorityLevel?: string
  requiredSkills?: string[]
  locationBuckets?: string[]
  industrySector?: string[]
}

export interface AgentRankingPromptCompanyContext {
  companyId: string
  companyName?: string
  industrySector?: string[]
  competitorCompanies?: string[]
  size?: string
}

export interface AgentRankingPromptResearchFinding {
  field: string
  value: unknown
  confidence: number
  evidenceUrls: string[]
  uncertainty?: string
}

export interface AgentRankingPromptDeterministicRubric {
  proposedTier: EvaluationTier
  generalRubricScore: number
  companyRubricScore: number
  jobRubricScore: number
  softScore: number
  hardGateResult: "pass" | "soft_block" | "hard_block"
  hardGateReasons: string[]
  missingInfo: string[]
  risks: string[]
  explanation: string
}

export interface AgentRankingPromptInput {
  candidate: AgentRankingPromptCandidate
  company: AgentRankingPromptCompanyContext
  job: AgentRankingPromptJobContext
  /** Only approved findings should be passed in by the caller. */
  approvedResearchFindings: AgentRankingPromptResearchFinding[]
  deterministicRubric: AgentRankingPromptDeterministicRubric
  promptVersion?: string
  expectedSchemaVersion?: string
}

export interface AgentRankingPromptResult {
  prompt: string
  promptVersion: string
  expectedSchemaVersion: string
}

// ---------------------------------------------------------------------------
// PII scrub helpers (mirror agent-prompt.ts)
// ---------------------------------------------------------------------------

const EMAIL_LIKE = /[A-Z0-9._%+\-]{1,64}@[A-Z0-9.\-]{1,255}\.[A-Z]{2,24}/i
const PHONE_LIKE = /(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.\-]?\d{3,4}[\s.\-]?\d{3,4}/

function scrubFreeText(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const cleaned = trimmed.replace(EMAIL_LIKE, "[email]").replace(PHONE_LIKE, "[phone]")
  return cleaned
}

/**
 * Reduce a full name to "First L." — first-name initial token is preserved
 * full only when name has 1 token; otherwise we emit `Firstname L.` style.
 * Email-shaped names return undefined.
 */
function piiScrubName(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (EMAIL_LIKE.test(trimmed) || PHONE_LIKE.test(trimmed)) return undefined
  const tokens = trimmed.split(/\s+/)
  if (tokens.length === 1) return tokens[0]
  const first = tokens[0]!
  const last = tokens[tokens.length - 1]!
  const lastInitial = last.charAt(0).toUpperCase()
  return `${first} ${lastInitial}.`
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

const MAX_EXPERIENCE_ENTRIES = 10
const MAX_SKILLS = 30

function truncateExperience(
  list: AgentRankingPromptExperience[] | undefined,
): {
  rows: AgentRankingPromptExperience[]
  truncated: boolean
  originalLength: number
} {
  if (!list || list.length === 0) {
    return { rows: [], truncated: false, originalLength: 0 }
  }
  if (list.length <= MAX_EXPERIENCE_ENTRIES) {
    return { rows: list, truncated: false, originalLength: list.length }
  }
  // Keep last N (most recent).
  return {
    rows: list.slice(list.length - MAX_EXPERIENCE_ENTRIES),
    truncated: true,
    originalLength: list.length,
  }
}

function truncateSkills(list: string[] | undefined): {
  rows: string[]
  truncated: boolean
  originalLength: number
} {
  if (!list || list.length === 0) {
    return { rows: [], truncated: false, originalLength: 0 }
  }
  if (list.length <= MAX_SKILLS) {
    return { rows: list, truncated: false, originalLength: list.length }
  }
  return { rows: list.slice(0, MAX_SKILLS), truncated: true, originalLength: list.length }
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderJobCompany(
  company: AgentRankingPromptCompanyContext,
  job: AgentRankingPromptJobContext,
): string {
  const lines: string[] = []
  lines.push("Job + Company:")
  lines.push(`  companyId: ${company.companyId}`)
  if (company.companyName) lines.push(`  companyName: ${company.companyName}`)
  if (company.industrySector && company.industrySector.length > 0) {
    lines.push(`  companyIndustrySector: ${company.industrySector.join(", ")}`)
  }
  if (company.competitorCompanies && company.competitorCompanies.length > 0) {
    lines.push(`  competitorCompanies: ${company.competitorCompanies.join(", ")}`)
  }
  if (company.size) lines.push(`  companySize: ${company.size}`)
  lines.push(`  jobId: ${job.jobId}`)
  if (job.jobTitle) lines.push(`  jobTitle: ${job.jobTitle}`)
  if (job.roleFunction && job.roleFunction.length > 0) {
    lines.push(`  roleFunction: ${job.roleFunction.join(", ")}`)
  }
  if (job.seniorityLevel) lines.push(`  seniorityLevel: ${job.seniorityLevel}`)
  if (job.requiredSkills && job.requiredSkills.length > 0) {
    lines.push(`  requiredSkills: ${job.requiredSkills.join(", ")}`)
  }
  if (job.locationBuckets && job.locationBuckets.length > 0) {
    lines.push(`  locationBuckets: ${job.locationBuckets.join(", ")}`)
  }
  if (job.industrySector && job.industrySector.length > 0) {
    lines.push(`  jobIndustrySector: ${job.industrySector.join(", ")}`)
  }
  return lines.join("\n")
}

function renderCandidate(c: AgentRankingPromptCandidate): string {
  const lines: string[] = []
  lines.push("Candidate:")
  lines.push(`  recordId: ${c.recordId}`)
  if (c.candidateId) lines.push(`  candidateId: ${c.candidateId}`)
  const name = piiScrubName(c.name)
  if (name) lines.push(`  name: ${name}`)
  if (c.canonicalLinkedInUrl) lines.push(`  linkedinUrl: ${c.canonicalLinkedInUrl}`)
  const title = scrubFreeText(c.currentTitle)
  if (title) lines.push(`  currentTitle: ${title}`)
  const company = scrubFreeText(c.currentCompany)
  if (company) lines.push(`  currentCompany: ${company}`)

  const exp = truncateExperience(c.experience)
  if (exp.rows.length > 0) {
    lines.push(
      `  experience (showing ${exp.rows.length} of ${exp.originalLength}${exp.truncated ? "; most recent only" : ""}):`,
    )
    for (const e of exp.rows) {
      const t = scrubFreeText(e.title) ?? "(unknown title)"
      const co = scrubFreeText(e.company) ?? "(unknown company)"
      const start = e.startDate ?? "?"
      const end = e.endDate ?? "present"
      const dur =
        typeof e.durationMonths === "number" ? ` (${e.durationMonths}mo)` : ""
      lines.push(`    - ${t} @ ${co} [${start} - ${end}]${dur}`)
    }
  }

  const sk = truncateSkills(c.skills)
  if (sk.rows.length > 0) {
    lines.push(
      `  skills (showing ${sk.rows.length} of ${sk.originalLength}${sk.truncated ? "; top by relevance" : ""}):`,
    )
    lines.push(`    ${sk.rows.join(", ")}`)
  }
  return lines.join("\n")
}

function renderApprovedFindings(findings: AgentRankingPromptResearchFinding[]): string {
  if (findings.length === 0) {
    return "Approved agent-research findings:\n  (none)"
  }
  const lines: string[] = []
  lines.push("Approved agent-research findings:")
  for (const f of findings) {
    const val = stringifyValue(f.value)
    const urls = f.evidenceUrls.length > 0 ? ` cites=${f.evidenceUrls.join(",")}` : ""
    const unc = f.uncertainty ? ` uncertainty=${f.uncertainty}` : ""
    lines.push(
      `  - ${f.field}: ${val} (confidence=${f.confidence.toFixed(2)})${urls}${unc}`,
    )
  }
  return lines.join("\n")
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "(null)"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function renderDeterministicRubric(r: AgentRankingPromptDeterministicRubric): string {
  const lines: string[] = []
  lines.push("Deterministic rubric output:")
  lines.push(`  proposedTier: ${r.proposedTier}`)
  lines.push(`  hardGateResult: ${r.hardGateResult}`)
  if (r.hardGateReasons.length > 0) {
    lines.push(`  hardGateReasons: ${r.hardGateReasons.join(", ")}`)
  }
  lines.push(
    `  scores: general=${r.generalRubricScore.toFixed(2)} company=${r.companyRubricScore.toFixed(2)} job=${r.jobRubricScore.toFixed(2)} soft=${r.softScore.toFixed(2)}`,
  )
  if (r.missingInfo.length > 0) {
    lines.push(`  missingInfo: ${r.missingInfo.join(", ")}`)
  }
  if (r.risks.length > 0) {
    lines.push(`  risks: ${r.risks.join(", ")}`)
  }
  lines.push(`  explanation: ${r.explanation}`)
  return lines.join("\n")
}

function renderRankingAsk(): string {
  return [
    "Ranking ask:",
    "- Read the candidate, the job/company, the approved research findings, and the deterministic rubric output above.",
    "- Decide a `proposedAgentTier` from the EvaluationTier enum (tier_1_personal_linkedin_and_email, tier_2_personal_email, tier_3_general_email, retain_only, blocked).",
    "- Write a concise `agentRationale` (1-3 sentences) explaining the tier in human terms.",
    "- Surface `agentRisks` (short strings, optional).",
    "- Pick `agentRecommendedAction` from (outreach_now, outreach_after_research, retain_warm, do_not_contact).",
    "- If the deterministic rubric hard-gated blocked, you SHOULD agree with `blocked` unless you have direct contradicting evidence.",
    "- Do NOT fabricate signals. The approved findings above are the only verified extra evidence.",
  ].join("\n")
}

function renderOutputContract(expectedSchemaVersion: string): string {
  return [
    "Output JSON contract:",
    "```",
    "{",
    `  "schemaVersion": "${expectedSchemaVersion}",`,
    `  "proposedAgentTier": "<EvaluationTier enum>",`,
    `  "agentRationale": "<1-3 sentences>",`,
    `  "agentRisks": ["..."],`,
    `  "agentRecommendedAction": "<outreach_now|outreach_after_research|retain_warm|do_not_contact>"`,
    "}",
    "```",
    "Emit a single JSON object. No prose, no markdown after the closing brace.",
  ].join("\n")
}

const PROMPT_HEADER = `You are a ranking assistant. Decide an outreach tier for the candidate against the listed job/company. Output strict JSON only.`

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

export function buildAgentRankingPrompt(
  input: AgentRankingPromptInput,
): AgentRankingPromptResult {
  const promptVersion = input.promptVersion ?? AGENT_RANK_PROMPT_VERSION
  const expectedSchemaVersion =
    input.expectedSchemaVersion ?? AGENT_RANK_EXPECTED_SCHEMA_VERSION

  const parts: string[] = []
  parts.push(PROMPT_HEADER)
  parts.push("")
  parts.push(`promptVersion: ${promptVersion}`)
  parts.push(`expectedSchemaVersion: ${expectedSchemaVersion}`)
  parts.push("")
  parts.push(renderJobCompany(input.company, input.job))
  parts.push("")
  parts.push(renderCandidate(input.candidate))
  parts.push("")
  parts.push(renderApprovedFindings(input.approvedResearchFindings))
  parts.push("")
  parts.push(renderDeterministicRubric(input.deterministicRubric))
  parts.push("")
  parts.push(renderRankingAsk())
  parts.push("")
  parts.push(renderOutputContract(expectedSchemaVersion))

  return { prompt: parts.join("\n"), promptVersion, expectedSchemaVersion }
}

// ---------------------------------------------------------------------------
// Defensive parser
// ---------------------------------------------------------------------------

const RankingResultEnvelopeSchema = z.object({
  schemaVersion: z.string().min(1),
  proposedAgentTier: EvaluationTierSchema,
  agentRationale: z.string().min(1).max(4_000),
  agentRisks: z.array(z.string().min(1)).default([]),
  agentRecommendedAction: AgentRankingActionSchema,
})

/**
 * Vote shape returned by the pure parser — caller stamps `modelUsed`,
 * `inputTokens`, `outputTokens`, `costUsd` after the LLM call lands.
 */
export type ParsedAgentRankingVote = Omit<
  AgentRankingEnsembleVote,
  "modelUsed" | "inputTokens" | "outputTokens" | "costUsd"
>

export interface AgentRankingParseSuccess {
  ok: true
  vote: ParsedAgentRankingVote
  schemaVersionMismatch: boolean
}

export interface AgentRankingParseFailure {
  ok: false
  parseErrors: string[]
  schemaVersionMismatch: boolean
}

export type AgentRankingParseResult =
  | AgentRankingParseSuccess
  | AgentRankingParseFailure

const FENCED_JSON_RE = /```(?:json)?\s{0,32}([\s\S]*?)```/i

function locateJsonBlock(raw: string): string | null {
  const fenced = FENCED_JSON_RE.exec(raw)
  if (fenced && typeof fenced[1] === "string" && fenced[1].trim().length > 0) {
    return fenced[1].trim()
  }
  const firstBrace = raw.indexOf("{")
  const lastBrace = raw.lastIndexOf("}")
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null
  }
  return raw.slice(firstBrace, lastBrace + 1)
}

export function parseAgentRankingResponse(
  raw: string,
  expectedSchemaVersion: string = AGENT_RANK_EXPECTED_SCHEMA_VERSION,
): AgentRankingParseResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, parseErrors: ["empty_input"], schemaVersionMismatch: false }
  }
  const candidate = locateJsonBlock(raw)
  if (!candidate) {
    return {
      ok: false,
      parseErrors: ["no_json_block_found"],
      schemaVersionMismatch: false,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch (err) {
    return {
      ok: false,
      parseErrors: [
        `json_parse_failed: ${err instanceof Error ? err.message : String(err)}`,
      ],
      schemaVersionMismatch: false,
    }
  }
  const envelope = RankingResultEnvelopeSchema.safeParse(parsed)
  if (!envelope.success) {
    return {
      ok: false,
      parseErrors: [
        `envelope_invalid: ${envelope.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      ],
      schemaVersionMismatch: false,
    }
  }
  const mismatch = envelope.data.schemaVersion !== expectedSchemaVersion
  const vote: ParsedAgentRankingVote = {
    proposedAgentTier: envelope.data.proposedAgentTier,
    agentRationale: envelope.data.agentRationale,
    agentRisks: envelope.data.agentRisks,
    agentRecommendedAction: envelope.data.agentRecommendedAction,
  }
  return { ok: true, vote, schemaVersionMismatch: mismatch }
}

// ---------------------------------------------------------------------------
// Ensemble majority
// ---------------------------------------------------------------------------

export interface EnsembleMajorityResult {
  proposedAgentTier: EvaluationTier
  agentRationale: string
  agentRecommendedAction: ReturnType<typeof AgentRankingActionSchema.parse>
  agentRisks: string[]
  tieFellBackToDeterministic: boolean
}

/**
 * Strict majority on `proposedAgentTier`. Tie -> deterministic fallback +
 * force `agentRecommendedAction = "outreach_after_research"`.
 *
 * `agentRisks` are concatenated across votes, each prefixed with
 * `[modelUsed]` for audit.
 */
export function pickEnsembleMajority(
  votes: AgentRankingEnsembleVote[],
  deterministicTier: EvaluationTier,
): EnsembleMajorityResult {
  if (votes.length === 0) {
    return {
      proposedAgentTier: deterministicTier,
      agentRationale:
        "Empty ensemble — deferring to deterministic tier and routing to follow-up research.",
      agentRecommendedAction: "outreach_after_research",
      agentRisks: [],
      tieFellBackToDeterministic: true,
    }
  }

  // Tally tier votes.
  const tally = new Map<EvaluationTier, AgentRankingEnsembleVote[]>()
  for (const v of votes) {
    const list = tally.get(v.proposedAgentTier) ?? []
    list.push(v)
    tally.set(v.proposedAgentTier, list)
  }

  // Strict majority = more than half.
  const half = votes.length / 2
  let winningTier: EvaluationTier | null = null
  let winningVotes: AgentRankingEnsembleVote[] = []
  for (const [tier, list] of tally) {
    if (list.length > half) {
      winningTier = tier
      winningVotes = list
      break
    }
  }

  const risks: string[] = []
  for (const v of votes) {
    for (const r of v.agentRisks) {
      risks.push(`[${v.modelUsed}] ${r}`)
    }
  }

  if (winningTier === null) {
    return {
      proposedAgentTier: deterministicTier,
      agentRationale:
        "Ensemble tie — deferring to deterministic tier and routing to follow-up research.",
      agentRecommendedAction: "outreach_after_research",
      agentRisks: risks,
      tieFellBackToDeterministic: true,
    }
  }

  // Pick the first winning vote's rationale + action.
  const lead = winningVotes[0]!
  return {
    proposedAgentTier: winningTier,
    agentRationale: lead.agentRationale,
    agentRecommendedAction: lead.agentRecommendedAction,
    agentRisks: risks,
    tieFellBackToDeterministic: false,
  }
}

// ---------------------------------------------------------------------------
// Token estimator + cost projector
//
// Local 30-line approximation — keeps `@pa/external-supply` free of the
// `@pa/pa-orchestrator` dep. Numbers are deliberately coarse; the real
// `max_tokens=500` cap inside the callable bounds spend regardless of
// estimator drift.
// ---------------------------------------------------------------------------

export function estimateAgentRankingTokens(prompt: string): number {
  if (!prompt || prompt.length === 0) return 0
  // ~4 characters per token for English-heavy prompts; round up.
  const byChars = Math.ceil(prompt.length / 4)
  // Floor at 1 token so empty-but-nonzero strings still consume budget.
  return Math.max(1, byChars)
}

export interface AgentRankingCostProjection {
  perCandidateCostUsd: number
  totalProjectedCostUsd: number
}

export function projectAgentRankingCost(input: {
  prompts: string[]
  model: string
  ensembleSize: number
}): AgentRankingCostProjection {
  const pricing =
    MODEL_PRICING_USD_PER_1K[input.model as AgentRankingModel] ??
    MODEL_PRICING_USD_PER_1K["gpt-5.4-nano"]
  const ensembleSize = Math.max(1, input.ensembleSize)
  let totalIn = 0
  let totalOut = 0
  for (const p of input.prompts) {
    const inTokens = estimateAgentRankingTokens(p)
    // Round per-candidate per-call to thousands to match the doc-text spec.
    const inThousands = Math.ceil(inTokens / 1000)
    totalIn += inThousands * ensembleSize
    totalOut += (OUTPUT_TOKEN_BUDGET / 1000) * ensembleSize
  }
  const totalProjectedCostUsd = totalIn * pricing.in + totalOut * pricing.out
  const perCandidateCostUsd =
    input.prompts.length === 0 ? 0 : totalProjectedCostUsd / input.prompts.length
  return { perCandidateCostUsd, totalProjectedCostUsd }
}

/**
 * Compute the post-LLM-call cost in USD for a single completed vote.
 * Caller passes raw input/output tokens reported by the provider and we
 * apply the matching pricing row. Falls back to `gpt-5.4-nano` if the
 * model is unknown.
 */
export function computeActualVoteCostUsd(input: {
  model: string
  inputTokens: number
  outputTokens: number
}): number {
  const pricing =
    MODEL_PRICING_USD_PER_1K[input.model as AgentRankingModel] ??
    MODEL_PRICING_USD_PER_1K["gpt-5.4-nano"]
  return (
    (input.inputTokens / 1000) * pricing.in +
    (input.outputTokens / 1000) * pricing.out
  )
}
