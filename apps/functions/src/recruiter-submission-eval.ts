/**
 * AI-first recruiter-submission evaluation trigger.
 *
 * Flow:
 *   1. Trigger fires on `pa-recruiter-submissions/{submissionId}` create.
 *   2. Idempotent re-fire guard: skip when the doc already carries
 *      `aiEvaluation` (fresh re-read, since onDocumentCreated re-fires
 *      deliver the at-creation snapshot).
 *   3. Load `pa-jobs/{jobId}` → recruiterBoard.checklist groups
 *      (hard/fit/bonus/anti) + jdBlocks + title/company.
 *   4. STEP A (research, best-effort): LinkedIn-looking candidate link →
 *      Coresignal `searchEmployeeIdByLinkedinUrl` → `fetchEmployeeCollect`
 *      → companies/roles/tenures research block. Any failure / no key →
 *      research undefined, eval continues.
 *   5. STEP B (critical judgment): ONE strict-JSON LLM call through the
 *      unified `callWithFallback` 3-tier router (gpt-5.4-nano →
 *      claude-sonnet-4-6 → gpt-4.1-mini). Recruiter ticks are treated as
 *      CLAIMS to verify, never facts. One retry on throw/invalid output.
 *   6. WRITE: merge `{ aiEvaluation }` onto the submission doc. Status is
 *      NEVER touched — AI never changes status (operator-only transitions,
 *      locked product rule).
 *   7. Any unrecoverable error → write the borderline/confidence-0 error
 *      shape so the review board always shows SOMETHING.
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { z } from "zod"
import { callWithFallback } from "@pa/pa-resume-parser"
import {
  fetchEmployeeCollect,
  searchEmployeeIdByLinkedinUrl,
  type CoresignalEmployeeCollectV2,
} from "@pa/external-supply"
import { getOrFetchCoresignalByLinkedin } from "./lib/coresignal-cache.js"
import { getAnthropicConfig, getOpenAIConfig } from "./lib/llm-providers.js"
import { ensureRecruiterSubmissionCandidateTracked } from "./recruiter-candidate-tracking.js"

const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY")
const CORESIGNAL_API_KEY = defineSecret("CORESIGNAL_API_KEY")

const SUBMISSIONS_COLLECTION = "pa-recruiter-submissions"
const JOBS_COLLECTION = "pa-jobs"

export const SUBMISSION_EVAL_VERSION = "submission-eval-v2"

// ---------------------------------------------------------------------------
// Pinned aiEvaluation shape (submission-eval-v1)
// ---------------------------------------------------------------------------

export type SubmissionEvalTally = { met: number; total: number; gaps: string[] }
export type SubmissionEvalAntiTally = { flagged: number; total: number; flags: string[] }

export type SubmissionEvalResearch = {
  source: "coresignal"
  headline: string
  companies: Array<{ name: string; role?: string; years?: string }>
  education: Array<{ school: string; degree?: string }>
  signals: string[]
  risks: string[]
}

// AI's independent read of a background pillar. Stored ALONGSIDE the recruiter's
// candidateBackground self-flag so operators see recruiter-said vs AI-found.
export type SubmissionEvalPillar = { verdict: "strong" | "weak" | "unknown"; evidence: string }
export type SubmissionEvalBackground = {
  school: SubmissionEvalPillar
  gpa: SubmissionEvalPillar
  degree: SubmissionEvalPillar
  company: SubmissionEvalPillar
}

export type SubmissionAiEvaluation = {
  verdict: "advance" | "borderline" | "reject"
  confidence: number
  summary: string
  reasons: string[]
  checklist: {
    hard: SubmissionEvalTally
    fit: SubmissionEvalTally
    bonus: SubmissionEvalTally
    anti: SubmissionEvalAntiTally
  }
  background: SubmissionEvalBackground
  research?: SubmissionEvalResearch
  evaluatedAt: string
  model: string
  version: "submission-eval-v2"
  error?: string
}

const TallySchema = z.object({
  met: z.number(),
  total: z.number(),
  gaps: z.array(z.string()),
})
const AntiTallySchema = z.object({
  flagged: z.number(),
  total: z.number(),
  flags: z.array(z.string()),
})
const PillarSchema = z.object({
  verdict: z.enum(["strong", "weak", "unknown"]),
  evidence: z.string(),
})
const BackgroundSchema = z.object({
  school: PillarSchema,
  gpa: PillarSchema,
  degree: PillarSchema,
  company: PillarSchema,
})
const EvalJudgmentSchema = z.object({
  verdict: z.enum(["advance", "borderline", "reject"]),
  confidence: z.number(),
  summary: z.string(),
  reasons: z.array(z.string()),
  checklist: z.object({
    hard: TallySchema,
    fit: TallySchema,
    bonus: TallySchema,
    anti: AntiTallySchema,
  }),
  background: BackgroundSchema,
})
type EvalJudgment = z.infer<typeof EvalJudgmentSchema>

// Strict-mode JSON schema (every property required, additionalProperties
// false at every level) for callWithFallback's json_schema response format.
const TALLY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["met", "total", "gaps"],
  properties: {
    met: { type: "number" },
    total: { type: "number" },
    gaps: { type: "array", items: { type: "string" } },
  },
} as const
const ANTI_TALLY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["flagged", "total", "flags"],
  properties: {
    flagged: { type: "number" },
    total: { type: "number" },
    flags: { type: "array", items: { type: "string" } },
  },
} as const
const PILLAR_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "evidence"],
  properties: {
    verdict: { type: "string", enum: ["strong", "weak", "unknown"] },
    evidence: { type: "string", description: "The specific school/degree/company that drove this verdict, or why it is unknown." },
  },
} as const
const BACKGROUND_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["school", "gpa", "degree", "company"],
  properties: {
    school: PILLAR_JSON_SCHEMA,
    gpa: PILLAR_JSON_SCHEMA,
    degree: PILLAR_JSON_SCHEMA,
    company: PILLAR_JSON_SCHEMA,
  },
} as const
const EVAL_JUDGMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "summary", "reasons", "checklist", "background"],
  properties: {
    verdict: { type: "string", enum: ["advance", "borderline", "reject"] },
    confidence: { type: "number", description: "0..1 confidence in the verdict given the evidence." },
    summary: { type: "string", description: "1-2 sentence operator-facing summary of the candidate vs the rubric." },
    reasons: { type: "array", items: { type: "string" } },
    checklist: {
      type: "object",
      additionalProperties: false,
      required: ["hard", "fit", "bonus", "anti"],
      properties: {
        hard: TALLY_JSON_SCHEMA,
        fit: TALLY_JSON_SCHEMA,
        bonus: TALLY_JSON_SCHEMA,
        anti: ANTI_TALLY_JSON_SCHEMA,
      },
    },
    background: BACKGROUND_JSON_SCHEMA,
  },
} as const

const JUDGE_SYSTEM_PROMPT = `You are WeKruit's SUPER CRITICAL recruiter-submission evaluator. A third-party recruiter submitted a candidate against a job rubric and self-reported which checklist items the candidate meets. Recruiters are incentivized to over-claim: every tick is a CLAIM to verify against the candidate info and independent research, NEVER a fact.

Rules:
- Independently assess EVERY hard (must-have) item. An item counts as met ONLY when the candidate info or research contains concrete supporting evidence (named companies, durations, specific work). Unmet or unverifiable hard items go in checklist.hard.gaps, listed by their exact item text.
- Apply the same evidence bar to fit and bonus items; list unmet/unverifiable item texts in their gaps arrays.
- For anti-signal items, flagged = items that plausibly apply to this candidate; list their exact item texts in checklist.anti.flags. Also flag anti-signals you observe in the research even when the recruiter left them unticked.
- met/total (and flagged/total) must tally the rubric items per group; total = number of items in that group.
- Be stingy. verdict "advance" ONLY when checklist.hard.gaps is empty AND the supporting evidence is concrete. Thin, generic, or unverifiable submissions are "borderline". Clear hard gaps or applicable anti-signals push toward "reject".
- confidence is 0..1 — how confident you are in the verdict given the evidence quality.
- reasons: short concrete bullets citing the specific evidence (or its absence) that drove the verdict.
- Also independently assess the candidate's BACKGROUND pillars from the research + resume, and output \`background\` with one of strong / weak / unknown per pillar plus short \`evidence\`:
  - school: "strong" for a target / strong / well-known university; "weak" for clearly non-target; "unknown" if no education info is available.
  - degree: "strong" for a relevant degree/field for this role; "weak" if mismatched; "unknown" if absent.
  - company: "strong" if the candidate has worked at fast-growing startups or strong / brand-name tech companies; "weak" if only unknown / no-name employers; "unknown" if no work history is available.
  - gpa: ALMOST ALWAYS "unknown". Set "strong"/"weak" ONLY if the resume/notes explicitly state a GPA. NEVER infer GPA from the school or LinkedIn.
  The recruiter's background self-flag (shown in the prompt) is a HINT, not a fact — assess each pillar independently from the evidence.
- Output STRICT JSON matching the schema. Nothing else.`

// ---------------------------------------------------------------------------
// Tolerant readers
// ---------------------------------------------------------------------------

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

type ChecklistGroup = {
  kind: "hard" | "fit" | "bonus" | "anti"
  heading: string
  items: Array<{ id: string; text: string }>
}

export function extractChecklistGroups(job: Record<string, unknown>): ChecklistGroup[] {
  const groups = asRecord(asRecord(job.recruiterBoard)?.checklist)?.groups
  if (!Array.isArray(groups)) return []
  const out: ChecklistGroup[] = []
  for (const raw of groups) {
    const group = asRecord(raw)
    if (!group) continue
    const kind = group.kind
    if (kind !== "hard" && kind !== "fit" && kind !== "bonus" && kind !== "anti") continue
    const items = Array.isArray(group.items)
      ? group.items.flatMap((item) => {
        const record = asRecord(item)
        const id = cleanString(record?.id)
        const text = cleanString(record?.text)
        return id && text ? [{ id, text }] : []
      })
      : []
    out.push({ kind, heading: cleanString(group.heading) ?? kind, items })
  }
  return out
}

type SubmissionCandidate = {
  name: string
  link: string
  linkedinUrl?: string
  email?: string
  currentRole?: string
  yoe?: string
  notes?: string
}

function extractCandidate(submission: Record<string, unknown>): SubmissionCandidate {
  const candidate = asRecord(submission.candidate) ?? {}
  return {
    name: cleanString(candidate.name) ?? "(unknown)",
    link: cleanString(candidate.link) ?? "",
    ...(cleanString(candidate.linkedinUrl) ? { linkedinUrl: cleanString(candidate.linkedinUrl) } : {}),
    ...(cleanString(candidate.email) ? { email: cleanString(candidate.email) } : {}),
    ...(cleanString(candidate.currentRole) ? { currentRole: cleanString(candidate.currentRole) } : {}),
    ...(cleanString(candidate.yoe) ? { yoe: cleanString(candidate.yoe) } : {}),
    ...(cleanString(candidate.notes) ? { notes: cleanString(candidate.notes) } : {}),
  }
}

function extractChecklistTicks(submission: Record<string, unknown>): Record<string, boolean> {
  const checklist = asRecord(submission.checklist) ?? {}
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(checklist)) {
    if (typeof value === "boolean") out[key] = value
  }
  return out
}

/**
 * Host check only — this is URL routing, not text→enum classification.
 * Recruiters paste links with or without a scheme.
 */
export function looksLikeLinkedinUrl(link: string): boolean {
  const trimmed = link.trim()
  if (!trimmed) return false
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`
  try {
    const host = new URL(candidate).hostname.toLowerCase()
    return host === "linkedin.com" || host.endsWith(".linkedin.com")
  } catch {
    return false
  }
}

export function buildResearchFromEmployee(employee: CoresignalEmployeeCollectV2): SubmissionEvalResearch {
  const experiences = Array.isArray(employee.experience) ? employee.experience : []
  const companies: SubmissionEvalResearch["companies"] = []
  for (const entry of experiences) {
    const name = cleanString(entry.company_name)
    if (!name) continue
    if (companies.length >= 10) break
    const from = cleanString(entry.date_from)
    const to = cleanString(entry.date_to)
    const years = from || to ? `${from ?? "?"} - ${to ?? "present"}` : undefined
    companies.push({
      name,
      ...(cleanString(entry.position_title) ? { role: cleanString(entry.position_title) } : {}),
      ...(years ? { years } : {}),
    })
  }

  const signals: string[] = []
  const months = employee.total_experience_duration_months
  if (typeof months === "number" && months > 0) {
    signals.push(`~${Math.round(months / 12)} years total experience on profile`)
  }
  const working = employee.is_working === true || employee.is_working === 1
  const activeTitle = cleanString(employee.active_experience_title)
  if (working && activeTitle) signals.push(`currently: ${activeTitle}`)
  const skills = Array.isArray(employee.inferred_skills)
    ? employee.inferred_skills.filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0).slice(0, 8)
    : []
  if (skills.length > 0) signals.push(`profile skills: ${skills.join(", ")}`)

  const education: SubmissionEvalResearch["education"] = []
  for (const entry of Array.isArray(employee.education) ? employee.education : []) {
    // Coresignal V2 collect names the school `institution_name` (not `school`).
    const e = entry as { institution_name?: string | null; school?: string | null; degree?: string | null }
    const school = cleanString(e.institution_name) ?? cleanString(e.school)
    if (!school) continue
    if (education.length >= 6) break
    const degree = cleanString(e.degree)
    education.push({ school, ...(degree ? { degree } : {}) })
  }

  const risks: string[] = []
  if (companies.length === 0) risks.push("no work experience listed on Coresignal profile")
  else if (!working) risks.push("no active role on Coresignal profile")

  return {
    source: "coresignal",
    headline: cleanString(employee.headline) ?? activeTitle ?? "",
    companies,
    education,
    signals,
    risks,
  }
}

// ---------------------------------------------------------------------------
// Pure handler — deps-injected for tests
// ---------------------------------------------------------------------------

export interface RecruiterSubmissionEvalDeps {
  db: Firestore
  /** One judge call — returns STRICT JSON per EVAL_JUDGMENT_JSON_SCHEMA. */
  callJudge: (args: {
    systemPrompt: string
    userText: string
    schemaName: string
    schema: Record<string, unknown>
  }) => Promise<{ rawJson: string; usedModel: string }>
  research: {
    apiKey: string | null
    searchEmployeeIdByLinkedinUrl: (
      url: string,
      config: { apiKey: string },
    ) => Promise<number | null>
    fetchEmployeeCollect: (
      id: number,
      config: { apiKey: string },
    ) => Promise<CoresignalEmployeeCollectV2>
  }
  now?: () => string
  log?: (event: string, fields?: Record<string, unknown>) => void
}

export type RecruiterSubmissionEvalResult = {
  status: "skipped_existing" | "written" | "error_written"
  submissionId: string
  aiEvaluation?: SubmissionAiEvaluation
}

// The cache key + the unified Coresignal store live in ./lib/coresignal-cache.
// Re-exported so existing importers (and tests) keep working.
export { coresignalCacheKey } from "./lib/coresignal-cache.js"

async function researchCandidate(
  link: string,
  deps: RecruiterSubmissionEvalDeps,
  submissionId: string,
): Promise<SubmissionEvalResearch | undefined> {
  if (!looksLikeLinkedinUrl(link)) {
    deps.log?.("research_skipped_not_linkedin", { submissionId })
    return undefined
  }
  // Single unified path: cache hit (no key) → else fetch + store the complete
  // response keyed by canonical-LinkedIn hash.
  const employee = await getOrFetchCoresignalByLinkedin({
    db: deps.db,
    link,
    apiKey: deps.research.apiKey,
    now: deps.now?.() ?? new Date().toISOString(),
    source: "recruiter_submission_eval",
    search: deps.research.searchEmployeeIdByLinkedinUrl,
    fetch: deps.research.fetchEmployeeCollect,
    log: (event, fields) => deps.log?.(event, { submissionId, ...(fields ?? {}) }),
  })
  return employee ? buildResearchFromEmployee(employee) : undefined
}

function renderJdBlocks(job: Record<string, unknown>): string {
  const blocks = Array.isArray(job.jdBlocks) ? job.jdBlocks : []
  return blocks
    .slice(0, 8)
    .flatMap((raw) => {
      const block = asRecord(raw)
      const heading = cleanString(block?.heading)
      const body = cleanString(block?.body)
      if (!heading && !body) return []
      return [`${heading ?? "(section)"}: ${(body ?? "").slice(0, 400)}`]
    })
    .join("\n")
}

function renderChecklist(groups: ChecklistGroup[], ticks: Record<string, boolean>): string {
  if (groups.length === 0) return "(no rubric checklist configured for this job)"
  return groups
    .map((group) => {
      const items = group.items
        .map((item) => `- [recruiter claims: ${ticks[item.id] === true ? "yes" : "no"}] ${item.text}`)
        .join("\n")
      return `### ${group.kind.toUpperCase()} — ${group.heading}\n${items || "(no items)"}`
    })
    .join("\n")
}

function renderScore(submission: Record<string, unknown>): string {
  const score = asRecord(submission.score)
  if (!score) return "(none)"
  const part = (checked: unknown, total: unknown, label: string): string =>
    `${label} ${typeof checked === "number" ? checked : 0}/${typeof total === "number" ? total : 0}`
  return [
    part(score.hardChecked, score.hardTotal, "hard"),
    part(score.fitChecked, score.fitTotal, "fit"),
    part(score.bonusChecked, score.bonusTotal, "bonus"),
    part(score.antiChecked, score.antiTotal, "anti"),
  ].join(", ")
}

function renderResearch(research: SubmissionEvalResearch | undefined): string {
  if (!research) return "(none available — judge on the submitted info alone, and weigh unverifiability accordingly)"
  const companies = research.companies
    .map((company) => `- ${company.name}${company.role ? ` — ${company.role}` : ""}${company.years ? ` (${company.years})` : ""}`)
    .join("\n")
  const education = research.education
    .map((e) => `- ${e.school}${e.degree ? ` — ${e.degree}` : ""}`)
    .join("\n")
  return [
    `Headline: ${research.headline || "(none)"}`,
    `Companies:\n${companies || "(none)"}`,
    `Education:\n${education || "(none — no school/degree on the profile)"}`,
    `Signals: ${research.signals.join("; ") || "(none)"}`,
    `Risks: ${research.risks.join("; ") || "(none)"}`,
  ].join("\n")
}

function renderRecruiterBackgroundFlag(submission: Record<string, unknown>): string {
  const bg = asRecord(submission.candidateBackground)
  if (!bg) return "(recruiter did not flag any background pillars)"
  const parts = (["school", "gpa", "degree", "company"] as const)
    .map((k) => (cleanString(bg[k]) ? `${k}: ${cleanString(bg[k])}` : null))
    .filter((x): x is string => Boolean(x))
  return parts.length ? parts.join(" · ") : "(recruiter did not flag any background pillars)"
}

function buildJudgeUserText(args: {
  jobId: string
  job: Record<string, unknown>
  groups: ChecklistGroup[]
  candidate: SubmissionCandidate
  ticks: Record<string, boolean>
  submission: Record<string, unknown>
  research: SubmissionEvalResearch | undefined
}): string {
  const title = cleanString(args.job.title) ?? cleanString(asRecord(args.job.prescreenConfig)?.jobTitle) ?? args.jobId
  const company =
    cleanString(args.job.company) ??
    cleanString(asRecord(asRecord(args.job.recruiterBoard)?.label)?.company) ??
    "(unknown company)"
  return `## Job
${title} @ ${company}

## Job description
${renderJdBlocks(args.job) || "(none)"}

## Rubric checklist (recruiter tick = CLAIM, not fact)
${renderChecklist(args.groups, args.ticks)}

## Recruiter self-reported score
${renderScore(args.submission)}

## Candidate (as submitted by the recruiter)
Name: ${args.candidate.name}
Link: ${args.candidate.link || "(none)"}
${args.candidate.email ? `Email: ${args.candidate.email}\n` : ""}${args.candidate.currentRole ? `Current role: ${args.candidate.currentRole}\n` : ""}${args.candidate.yoe ? `Years of experience: ${args.candidate.yoe}\n` : ""}Recruiter notes: ${(args.candidate.notes ?? "(none)").slice(0, 1500)}

## Independent research (Coresignal)
${renderResearch(args.research)}

## Recruiter background self-flag (HINT only — verify independently)
${renderRecruiterBackgroundFlag(args.submission)}

Return STRICT JSON per the schema: verdict, confidence, summary, reasons, checklist {hard, fit, bonus, anti}, and background {school, gpa, degree, company} each {verdict, evidence}.`
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)]
}

/**
 * Deterministic tallies: totals come from the JOB config group sizes, never
 * the LLM output. met/flagged are clamped to [0, total], gaps/flags deduped.
 */
function normalizeChecklist(
  checklist: EvalJudgment["checklist"],
  groups: ChecklistGroup[],
): EvalJudgment["checklist"] {
  const totals: Record<ChecklistGroup["kind"], number> = { hard: 0, fit: 0, bonus: 0, anti: 0 }
  for (const group of groups) totals[group.kind] += group.items.length
  const tally = (raw: SubmissionEvalTally, total: number): SubmissionEvalTally => ({
    met: Math.max(0, Math.min(Number.isFinite(raw.met) ? raw.met : 0, total)),
    total,
    gaps: dedupeStrings(raw.gaps),
  })
  return {
    hard: tally(checklist.hard, totals.hard),
    fit: tally(checklist.fit, totals.fit),
    bonus: tally(checklist.bonus, totals.bonus),
    anti: {
      flagged: Math.max(0, Math.min(Number.isFinite(checklist.anti.flagged) ? checklist.anti.flagged : 0, totals.anti)),
      total: totals.anti,
      flags: dedupeStrings(checklist.anti.flags),
    },
  }
}

async function judgeSubmission(
  deps: RecruiterSubmissionEvalDeps,
  userText: string,
  submissionId: string,
  groups: ChecklistGroup[],
): Promise<{ judgment: EvalJudgment; usedModel: string }> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await deps.callJudge({
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        userText,
        schemaName: "RecruiterSubmissionEvaluation",
        schema: EVAL_JUDGMENT_JSON_SCHEMA as unknown as Record<string, unknown>,
      })
      const parsed = EvalJudgmentSchema.safeParse(JSON.parse(result.rawJson))
      if (!parsed.success) {
        throw new Error(`judge_invalid_output: ${parsed.error.message.slice(0, 200)}`)
      }
      let judgment: EvalJudgment = {
        ...parsed.data,
        confidence: clamp01(parsed.data.confidence),
        checklist: normalizeChecklist(parsed.data.checklist, groups),
      }
      // Deterministic guard on the locked stinginess rule: "advance" is only
      // valid with zero hard gaps. LLM judges; the reducer enforces.
      if (judgment.verdict === "advance" && judgment.checklist.hard.gaps.length > 0) {
        deps.log?.("verdict_clamped_hard_gaps", {
          submissionId,
          gaps: judgment.checklist.hard.gaps.length,
        })
        judgment = { ...judgment, verdict: "borderline" }
      }
      return { judgment, usedModel: result.usedModel }
    } catch (err) {
      lastErr = err
      deps.log?.("judge_attempt_failed", {
        submissionId,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  throw lastErr ?? new Error("judge_exhausted")
}

export function errorEvaluation(message: string, evaluatedAt: string): SubmissionAiEvaluation {
  return {
    verdict: "borderline",
    confidence: 0,
    summary: "evaluation failed",
    reasons: [],
    checklist: {
      hard: { met: 0, total: 0, gaps: [] },
      fit: { met: 0, total: 0, gaps: [] },
      bonus: { met: 0, total: 0, gaps: [] },
      anti: { flagged: 0, total: 0, flags: [] },
    },
    background: {
      school: { verdict: "unknown", evidence: "evaluation failed" },
      gpa: { verdict: "unknown", evidence: "evaluation failed" },
      degree: { verdict: "unknown", evidence: "evaluation failed" },
      company: { verdict: "unknown", evidence: "evaluation failed" },
    },
    evaluatedAt,
    model: "none",
    version: SUBMISSION_EVAL_VERSION,
    error: message.slice(0, 500),
  }
}

export async function runRecruiterSubmissionEval(
  raw: { submissionId: string; submission: Record<string, unknown> },
  deps: RecruiterSubmissionEvalDeps,
): Promise<RecruiterSubmissionEvalResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const ref = deps.db.collection(SUBMISSIONS_COLLECTION).doc(raw.submissionId)

  // Idempotent re-fire guard on the FRESH doc — onDocumentCreated re-fires
  // deliver the at-creation snapshot, which never contains aiEvaluation.
  const fresh = await ref.get()
  const submission = fresh.exists ? (fresh.data() ?? {}) : raw.submission
  if (asRecord(submission.aiEvaluation)) {
    deps.log?.("skipped_existing_evaluation", { submissionId: raw.submissionId })
    return { status: "skipped_existing", submissionId: raw.submissionId }
  }

  try {
    const jobId = cleanString(submission.jobId)
    if (!jobId) throw new Error("submission_missing_jobId")
    const jobSnap = await deps.db.collection(JOBS_COLLECTION).doc(jobId).get()
    if (!jobSnap.exists) throw new Error(`job_not_found:${jobId}`)
    const job = (jobSnap.data() ?? {}) as Record<string, unknown>

    const groups = extractChecklistGroups(job)
    const candidate = extractCandidate(submission)
    const ticks = extractChecklistTicks(submission)
    const research = await researchCandidate(candidate.linkedinUrl ?? candidate.link, deps, raw.submissionId)
    const evaluatedAt = now()
    const tracking = await ensureRecruiterSubmissionCandidateTracked(deps.db, {
      submissionId: raw.submissionId,
      submission,
      now: evaluatedAt,
      writeCreatedEvent: true,
    })
    const trackingPatch = tracking.status === "tracked" && tracking.candidateId
      ? {
          candidateId: tracking.candidateId,
          candidateTracking: {
            candidateId: tracking.candidateId,
            linkedinUrl: tracking.canonicalLinkedInUrl,
            linkedAt: evaluatedAt,
            source: "recruiter_submission",
          },
        }
      : {}

    const userText = buildJudgeUserText({ jobId, job, groups, candidate, ticks, submission, research })
    const { judgment, usedModel } = await judgeSubmission(deps, userText, raw.submissionId, groups)

    const aiEvaluation: SubmissionAiEvaluation = {
      ...judgment,
      ...(research ? { research } : {}),
      evaluatedAt,
      model: usedModel,
      version: SUBMISSION_EVAL_VERSION,
    }
    await ref.set({ aiEvaluation, ...trackingPatch }, { merge: true })
    deps.log?.("evaluation_written", {
      submissionId: raw.submissionId,
      verdict: aiEvaluation.verdict,
      model: usedModel,
      hasResearch: Boolean(research),
    })
    return { status: "written", submissionId: raw.submissionId, aiEvaluation }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.log?.("evaluation_failed_writing_error_shape", {
      submissionId: raw.submissionId,
      error: message,
    })
    const aiEvaluation = errorEvaluation(message, now())
    await ref.set({ aiEvaluation }, { merge: true })
    return { status: "error_written", submissionId: raw.submissionId, aiEvaluation }
  }
}

// ---------------------------------------------------------------------------
// Production CF — thin shim over runRecruiterSubmissionEval.
// ---------------------------------------------------------------------------

function makeProdEvalDeps(db: Firestore): RecruiterSubmissionEvalDeps {
  const openai = getOpenAIConfig()
  const anthropic = getAnthropicConfig()
  return {
    db,
    callJudge: async (args) => {
      if (!openai.apiKey) throw new Error("openai_key_missing")
      const result = await callWithFallback({
        apiKey: openai.apiKey,
        baseURL: openai.baseURL,
        ...(anthropic.apiKey ? { anthropicApiKey: anthropic.apiKey } : {}),
        systemPrompt: args.systemPrompt,
        userText: args.userText,
        schemaName: args.schemaName,
        schema: args.schema,
        log: (event, payload) => logger.info(event, payload as Record<string, unknown>),
      })
      return { rawJson: result.rawJson, usedModel: result.usedModel }
    },
    research: {
      apiKey: CORESIGNAL_API_KEY.value().trim() || null,
      searchEmployeeIdByLinkedinUrl,
      fetchEmployeeCollect,
    },
    now: () => new Date().toISOString(),
    log: (event, fields) => logger.info(`[recruiter-submission-eval] ${event}`, fields),
  }
}

export const paRecruiterSubmissionEval = onDocumentCreated(
  {
    document: "pa-recruiter-submissions/{submissionId}",
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 300,
    retry: false,
    secrets: [PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY, CORESIGNAL_API_KEY],
  },
  async (event) => {
    const submissionId = event.params.submissionId
    const data = event.data?.data() as Record<string, unknown> | undefined
    if (!data) {
      logger.warn("[recruiter-submission-eval] fired without snapshot", { submissionId })
      return
    }
    try {
      const result = await runRecruiterSubmissionEval(
        { submissionId, submission: data },
        makeProdEvalDeps(getFirestore()),
      )
      logger.info("[recruiter-submission-eval] result", {
        submissionId,
        status: result.status,
        verdict: result.aiEvaluation?.verdict,
      })
    } catch (err) {
      // Fail-open: log and move on — the error shape is written inside the
      // run fn; this catch only guards the write itself failing.
      logger.error("[recruiter-submission-eval] error", {
        submissionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
)
