/**
 * v2.0 External Supply V1 — Wave C Block E1 — Deterministic ChatGPT Agent
 * Mode research prompt generator.
 *
 * After D's evaluation surfaces `missingInfo[]` for a candidate, the operator
 * presses "Generate research prompt" on `/admin/external-supply/research` and
 * copies the result into ChatGPT Agent Mode (or any equivalent web-research
 * agent). The agent investigates each row + returns strict JSON that E's
 * `parseAgentResearchResult` consumes.
 *
 * The prompt is a pure function of `(candidates, missingInfoByCandidate,
 * companyJobContext, promptVersion?, expectedJsonSchemaVersion?)` so the
 * golden-file test can pin the exact byte output.
 *
 * Hard guardrails baked into the prompt body (PLAN §14):
 *  - Emails + phones MUST NOT appear in findings — the prompt strips/refuses
 *    email-shaped strings from candidate inputs before rendering.
 *  - The agent MUST cite at least one public web URL per finding.
 *  - When no public data is found, the agent emits `confidence: 0` with an
 *    `uncertainty` reason rather than fabricating.
 *
 * Lead resolutions (EXECUTOR-PLANS.md §E):
 *  - E Q3 → `AGENT_PROMPT_VERSION = "agent-prompt-2026-05-A"` (bump on any
 *    structural change; golden fixture must be re-cut).
 *  - E Q4 → `expectedJsonSchemaVersion` defaults to
 *    `AGENT_RESULT_SCHEMA_VERSION` imported from `agent-parse.ts` so the
 *    two surfaces stay in lockstep.
 */

import { AGENT_RESULT_SCHEMA_VERSION } from "./agent-parse.js"

/**
 * Bump on any structural prompt change. Goldens MUST be re-cut.
 */
export const AGENT_PROMPT_VERSION = "agent-prompt-2026-05-A"

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AgentResearchPromptCandidate {
  /** UUID of the underlying `ExternalCandidateRecord` (always present). */
  recordId: string
  /** Optional pa-users uid once identity is resolved. */
  candidateId?: string
  /** First name only — never the full name, never email. */
  name?: string
  /** Canonical LinkedIn URL is fine to send to a web-research agent. */
  canonicalLinkedInUrl?: string
  /** Current job title hint. */
  currentTitle?: string
  /** Current employer name. */
  currentCompany?: string
}

export interface AgentResearchPromptCompanyJobContext {
  companyId: string
  companyName?: string
  industrySector?: string[]
  competitorCompanies?: string[]
  jobId: string
  jobTitle?: string
  jobRoleFunction?: string[]
  seniorityLevel?: string
}

export interface AgentResearchPromptInput {
  candidates: AgentResearchPromptCandidate[]
  /** Map keyed by recordId OR candidateId — caller may use either. */
  missingInfoByCandidate: Record<string, string[]>
  companyJobContext: AgentResearchPromptCompanyJobContext
  promptVersion?: string
  expectedJsonSchemaVersion?: string
}

export interface AgentResearchPromptResult {
  prompt: string
  promptVersion: string
  expectedJsonSchemaVersion: string
}

// ---------------------------------------------------------------------------
// PII safety helpers
// ---------------------------------------------------------------------------

/**
 * Anything matching this regex is treated as an email shape and stripped from
 * the rendered prompt. We deliberately do not try to be RFC-5322 strict —
 * false positives are safer than letting a real email reach the prompt.
 */
// Bounded quantifiers per RFC 5321 (local-part ≤ 64, domain ≤ 255, TLD ≤ 24)
// to avoid polynomial-time backtracking on adversarial inputs (CodeQL js/redos).
const EMAIL_LIKE = /[A-Z0-9._%+\-]{1,64}@[A-Z0-9.\-]{1,255}\.[A-Z]{2,24}/i

/** US phone, E.164, and common formatted variants. */
const PHONE_LIKE = /(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.\-]?\d{3,4}[\s.\-]?\d{3,4}/

/**
 * Strip raw PII shapes (email / phone) from a candidate-supplied field so the
 * rendered prompt never leaks it. Returns `null` if the entire field was
 * email- or phone-shaped (caller drops the field in that case).
 */
function scrubPiiOrNull(raw: string | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (EMAIL_LIKE.test(trimmed) || PHONE_LIKE.test(trimmed)) {
    // Strip the matched shapes and see if anything intelligible remains.
    const cleaned = trimmed.replace(EMAIL_LIKE, "").replace(PHONE_LIKE, "").trim()
    return cleaned.length >= 2 ? cleaned : null
  }
  return trimmed
}

/**
 * Reduce a full name to a first-name token. Falls back to `null` if input is
 * email-shaped / phone-shaped / empty after PII scrub.
 */
function firstNameOrNull(raw: string | undefined): string | null {
  const scrubbed = scrubPiiOrNull(raw)
  if (!scrubbed) return null
  const first = scrubbed.split(/\s+/, 1)[0]
  if (!first) return null
  return first
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const PROMPT_HEADER = `You are a research assistant. Investigate the following candidates against the listed job/company context. Output strict JSON only. Do not fabricate.`

const GUARDRAIL_LINES = [
  "Hard guardrails:",
  "- Do NOT include personal email addresses or phone numbers in findings.",
  "- Cite at least one public web URL per finding in `evidenceUrls`.",
  "- If you cannot find the information, set `confidence: 0` and `uncertainty: 'no_public_data_found'` rather than guessing.",
  "- All findings MUST reference either `candidateId` or `recordId` from the candidate block below.",
  "- Output a single JSON object. No surrounding prose. No markdown after the closing brace.",
]

/**
 * Render a single candidate block. Returns a multi-line string suitable for
 * concatenation into the prompt body.
 */
function renderCandidateBlock(
  index: number,
  candidate: AgentResearchPromptCandidate,
  missingFields: string[],
): string {
  const lines: string[] = []
  lines.push(`Candidate ${index + 1}:`)
  lines.push(`  recordId: ${candidate.recordId}`)
  if (candidate.candidateId) {
    lines.push(`  candidateId: ${candidate.candidateId}`)
  }
  const firstName = firstNameOrNull(candidate.name)
  if (firstName) {
    lines.push(`  firstName: ${firstName}`)
  }
  // LinkedIn URL is a public profile pointer — safe to include.
  if (candidate.canonicalLinkedInUrl) {
    lines.push(`  linkedinUrl: ${candidate.canonicalLinkedInUrl}`)
  }
  const title = scrubPiiOrNull(candidate.currentTitle)
  if (title) {
    lines.push(`  currentTitle: ${title}`)
  }
  const company = scrubPiiOrNull(candidate.currentCompany)
  if (company) {
    lines.push(`  currentCompany: ${company}`)
  }
  lines.push(`  missingInfo:`)
  if (missingFields.length === 0) {
    lines.push(`    - (none — please confirm any of the public-profile claims above)`)
  } else {
    for (const field of missingFields) {
      lines.push(`    - ${field}`)
    }
  }
  return lines.join("\n")
}

function renderCompanyJobBlock(ctx: AgentResearchPromptCompanyJobContext): string {
  const lines: string[] = []
  lines.push("Target company + job:")
  lines.push(`  companyId: ${ctx.companyId}`)
  if (ctx.companyName) lines.push(`  companyName: ${ctx.companyName}`)
  if (ctx.industrySector && ctx.industrySector.length > 0) {
    lines.push(`  industrySector: ${ctx.industrySector.join(", ")}`)
  }
  if (ctx.competitorCompanies && ctx.competitorCompanies.length > 0) {
    lines.push(`  competitorCompanies: ${ctx.competitorCompanies.join(", ")}`)
  }
  lines.push(`  jobId: ${ctx.jobId}`)
  if (ctx.jobTitle) lines.push(`  jobTitle: ${ctx.jobTitle}`)
  if (ctx.jobRoleFunction && ctx.jobRoleFunction.length > 0) {
    lines.push(`  jobRoleFunction: ${ctx.jobRoleFunction.join(", ")}`)
  }
  if (ctx.seniorityLevel) lines.push(`  seniorityLevel: ${ctx.seniorityLevel}`)
  return lines.join("\n")
}

function renderOutputContract(expectedSchemaVersion: string): string {
  return [
    "Output JSON contract:",
    "```",
    "{",
    `  "schemaVersion": "${expectedSchemaVersion}",`,
    `  "findings": [`,
    `    {`,
    `      "candidateId": "<string, optional if recordId set>",`,
    `      "recordId": "<string, optional if candidateId set>",`,
    `      "field": "<string, e.g. currentCompany, yearsExperience, education>",`,
    `      "value": <string | number | boolean | array | object>,`,
    `      "confidence": <number 0..1>,`,
    `      "uncertainty": "<string, optional>",`,
    `      "evidenceUrls": ["https://..."]`,
    `    }`,
    `  ]`,
    "}",
    "```",
  ].join("\n")
}

/**
 * Build a deterministic ChatGPT Agent Mode research prompt.
 *
 * Deterministic in: `candidates` order, `missingInfo` order per candidate,
 * `companyJobContext` field order, prompt + schema version constants.
 *
 * Non-deterministic input is rejected upstream (caller is expected to pass
 * sorted arrays where needed); this function does not re-sort.
 */
export function buildAgentResearchPrompt(
  input: AgentResearchPromptInput,
): AgentResearchPromptResult {
  const promptVersion = input.promptVersion ?? AGENT_PROMPT_VERSION
  const expectedJsonSchemaVersion =
    input.expectedJsonSchemaVersion ?? AGENT_RESULT_SCHEMA_VERSION

  const parts: string[] = []
  parts.push(PROMPT_HEADER)
  parts.push("")
  parts.push(`promptVersion: ${promptVersion}`)
  parts.push(`expectedJsonSchemaVersion: ${expectedJsonSchemaVersion}`)
  parts.push("")
  parts.push(renderCompanyJobBlock(input.companyJobContext))
  parts.push("")
  parts.push("Candidates to research:")
  parts.push("")

  for (let i = 0; i < input.candidates.length; i += 1) {
    const candidate = input.candidates[i]!
    const key1 = candidate.recordId
    const key2 = candidate.candidateId
    const missing =
      (key1 && input.missingInfoByCandidate[key1]) ||
      (key2 && input.missingInfoByCandidate[key2]) ||
      []
    parts.push(renderCandidateBlock(i, candidate, missing))
    parts.push("")
  }

  parts.push(...GUARDRAIL_LINES)
  parts.push("")
  parts.push(renderOutputContract(expectedJsonSchemaVersion))

  const prompt = parts.join("\n")
  return { prompt, promptVersion, expectedJsonSchemaVersion }
}
