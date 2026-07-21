/**
 * headhunter-mcp/job-intake.ts — process a raw JD a client/recruiter sends.
 *
 * The DEMAND-side counterpart to the candidate tools: reuses the production job
 * enricher (`enrichJobTags` 3-tier LLM router) + `deriveJobOpportunityDraft` (the
 * exact path the admin job-enrichment callable uses) to turn raw JD text into
 * canonical tags, hard filters, auto-generated prescreen questions, a per-field
 * confidence, and HITL flags — which we map to plain-English CLARIFYING QUESTIONS
 * the agent asks the client to fill the gaps. In-memory only (no job doc is
 * created); persisting an approved draft is a separate operator step.
 */
import { enrichJobTags, deriveJobOpportunityDraft } from "@pa/job-tag-enricher"

type Rec = Record<string, unknown>

/** Map each enrichment HITL flag to a concrete question for the client. */
const FLAG_QUESTION: Record<string, string> = {
  LOW_OVERALL_CONFIDENCE:
    "The JD is light on detail — can you share more on the role's scope and the must-haves?",
  AMBIGUOUS_ROLE_FUNCTION:
    "The role function reads ambiguous — what's the PRIMARY function (e.g. software engineering vs product vs data)?",
  WEAK_ROLE_FUNCTION_COVERAGE: "What is the core function of this role?",
  MISSING_SKILLS_COVERAGE: "What are the 3-5 MUST-HAVE skills for this role?",
  WEAK_SKILLS_COVERAGE: "Which skills are truly required vs nice-to-have?",
  WEAK_SENIORITY_COVERAGE:
    "What seniority level is this — junior, mid, senior, staff, or leadership?",
  WEAK_LOCATION_COVERAGE: "Where is this role based, and is remote / hybrid allowed?",
  MISSING_SALARY_COVERAGE: "What's the salary range (and currency) for this role?",
  SPONSORSHIP_SILENT: "Does this role offer visa sponsorship?",
}

export type IntakeJobInput = {
  title: string
  jobDescription: string
  companyName?: string
  locationRaw?: string
  salaryMin?: number
  salaryMax?: number
  currency?: string
}

export async function runIntakeJob(input: IntakeJobInput): Promise<Rec> {
  const title = (input.title ?? "").trim()
  if (!title) return { error: "title_required", note: "pass the role title (extract it from the JD if needed)" }
  const jd = (input.jobDescription ?? "").trim()
  if (!jd) return { error: "job_description_required" }

  const enriched = await enrichJobTags({
    title,
    jobDescription: jd,
    companyName: input.companyName ?? null,
    locationRaw: input.locationRaw ?? null,
    sourceRepo: "headhunter_mcp",
  })

  const salaryRange =
    typeof input.salaryMin === "number" || typeof input.salaryMax === "number"
      ? { min: input.salaryMin, max: input.salaryMax, currency: input.currency ?? "USD" }
      : undefined

  const draft = deriveJobOpportunityDraft({
    rawJob: {
      title,
      companyName: input.companyName,
      locationRaw: input.locationRaw,
      jobDescription: jd,
      salaryRange,
    },
    enrichedJobTags: enriched.tags,
  })

  const clarifyingQuestions = draft.hitlFlags.map((f) => FLAG_QUESTION[f] ?? f)

  return {
    enrichedTags: enriched.tags,
    hardFilters: draft.hardFilters,
    prescreenQuestions: draft.prescreenConfigDraft.questions,
    confidence: enriched.tags.confidence,
    hitlFlags: draft.hitlFlags,
    clarifyingQuestions,
    approvalReady: draft.approvalReady,
    candidateBrief: draft.candidateBrief,
    modelUsed: enriched.modelUsed,
    note:
      clarifyingQuestions.length > 0
        ? "Ask the client these clarifying questions, then call intake_job again with the answers folded into the JD / fields to re-enrich."
        : "Enrichment is high-confidence; no clarifying questions needed.",
  }
}
