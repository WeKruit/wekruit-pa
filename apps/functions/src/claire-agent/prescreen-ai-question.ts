/**
 * prescreen-ai-question.ts — the DEFAULT "how do you use AI?" prescreen question.
 *
 * Adam directive (asked 3×): EVERY prescreen session asks ONE open-ended question —
 * "right now, how are you using AI to speed up your day-to-day work?" — TAILORED to the
 * role (designer vs engineer vs PM vs …). It is a DEFAULT appended to every job's screen,
 * SKIPPED only if the candidate already answered it in ANY prior session.
 *
 * This is question COMPOSITION (allowed) — a roleFunction → tailored prompt MAP, NOT
 * text→enum tagging (the no-regex-in-tagging rule does not apply: nothing here classifies
 * candidate free text into an enum; we only pick a canned PROMPT from the JOB's roleFunction).
 *
 * NON-GATING: the appended question is marked `informational` so the prescreen FSM records
 * its answer (advancing the flow) but EXCLUDES it from the PASS/FAIL average. The captured
 * answer is persisted GLOBALLY to `pa-users.tags.aiAccelerationUsage` (via the existing
 * applyPartialUserTags sole writer) so it is asked once across the candidate's lifetime.
 *
 * Pure + dependency-free (no Firestore, no LLM) — L1-testable.
 */
import { ROLE_FUNCTION_VOCAB, type RoleFunction } from "@wekruit/shared-tags"

/** Stable qId for the default AI-acceleration question (the cross-session skip key). */
export const AI_QUESTION_QID = "q_ai_acceleration"

/** Durable global tag field the captured answer is written to (cross-session skip signal). */
export const AI_USAGE_TAG_FIELD = "aiAccelerationUsage" as const

/**
 * roleFunction → the role-specific phrasing of the open-ended AI question. Each is an
 * open-ended ask for tools + workflows + concrete examples. Covers the common functions;
 * any unmapped/missing roleFunction falls through to GENERIC_AI_PROMPT.
 */
const AI_PROMPT_BY_ROLE: Partial<Record<RoleFunction, string>> = {
  software_engineering:
    "Switching gears a bit — right now, how are you using AI to speed up your engineering work? " +
    "Walk me through the tools and workflows (e.g. coding copilots, test/PR generation, debugging, " +
    "agents) and a concrete example from something you shipped recently.",
  engineering_and_development:
    "Switching gears a bit — right now, how are you using AI to speed up your day-to-day engineering work? " +
    "Tell me about the tools and workflows you lean on and a concrete recent example.",
  data_analysis:
    "Switching gears a bit — right now, how are you using AI to speed up your data work? " +
    "Think SQL/query generation, analysis, dashboards, modeling — what tools and workflows, and a concrete example.",
  product_management:
    "Switching gears a bit — right now, how are you using AI to speed up your product work? " +
    "PRDs, user research synthesis, prioritization, prototyping, specs — what tools and workflows, and a concrete example.",
  business_analyst:
    "Switching gears a bit — right now, how are you using AI to speed up your analysis work? " +
    "Requirements, reporting, process mapping, data pulls — what tools and workflows, and a concrete example.",
  creatives_and_design:
    "Switching gears a bit — right now, how are you using AI to speed up your design work? " +
    "Ideation, mockups, copy, image/asset generation, design systems — what tools and workflows, and a concrete example.",
  consultant:
    "Switching gears a bit — right now, how are you using AI to speed up your consulting work? " +
    "Research, deck building, analysis, client deliverables — what tools and workflows, and a concrete example.",
  accounting_and_finance:
    "Switching gears a bit — right now, how are you using AI to speed up your finance work? " +
    "Modeling, reconciliation, reporting, forecasting — what tools and workflows, and a concrete example.",
  marketing:
    "Switching gears a bit — right now, how are you using AI to speed up your marketing work? " +
    "Content, campaigns, copy, audience analysis, creative — what tools and workflows, and a concrete example.",
  management_and_executive:
    "Switching gears a bit — right now, how are you using AI to speed up your work and your team's? " +
    "Decision support, comms, planning, ops — what tools and workflows, and a concrete example.",
  sales:
    "Switching gears a bit — right now, how are you using AI to speed up your sales work? " +
    "Prospecting, outreach, research, call prep/notes, CRM — what tools and workflows, and a concrete example.",
  human_resources:
    "Switching gears a bit — right now, how are you using AI to speed up your HR/people work? " +
    "Sourcing, screening, comms, policy, onboarding — what tools and workflows, and a concrete example.",
  legal_and_compliance:
    "Switching gears a bit — right now, how are you using AI to speed up your legal/compliance work? " +
    "Research, drafting, review, summarization — what tools and workflows, and a concrete example.",
  arts_and_entertainment:
    "Switching gears a bit — right now, how are you using AI to speed up your creative work? " +
    "What tools and workflows do you lean on, and a concrete example from a recent project?",
  education_and_training:
    "Switching gears a bit — right now, how are you using AI to speed up your teaching/training work? " +
    "Curriculum, content, grading, personalization — what tools and workflows, and a concrete example.",
  public_sector_and_government:
    "Switching gears a bit — right now, how are you using AI to speed up your day-to-day work? " +
    "What tools and workflows do you lean on, and a concrete recent example?",
  customer_service_and_support:
    "Switching gears a bit — right now, how are you using AI to speed up your support work? " +
    "Drafting replies, knowledge base, triage, summarization — what tools and workflows, and a concrete example.",
}

/** Clean generic fallback when the job's roleFunction is unknown/unmapped. */
const GENERIC_AI_PROMPT =
  "Switching gears a bit — right now, how are you using AI to speed up your day-to-day work? " +
  "Tell me about the tools and workflows you lean on and a concrete recent example."

/** The judge/grounding rubric for the AI question (informational, but kept on-topic). */
const AI_QUESTION_RUBRIC =
  "How the candidate uses AI in their day-to-day work: specific tools, concrete workflows, and " +
  "real examples. Informational only — captures their AI fluency; does not gate PASS/FAIL."

/** First roleFunction token that maps to a tailored prompt (jobs are multi-pick on roleFunction). */
function pickRoleFunction(roleFunctions: readonly string[] | null | undefined): RoleFunction | null {
  if (!Array.isArray(roleFunctions)) return null
  for (const rf of roleFunctions) {
    if (typeof rf === "string" && (ROLE_FUNCTION_VOCAB as readonly string[]).includes(rf)) {
      return rf as RoleFunction
    }
  }
  return null
}

/** Compose the role-tailored AI question prompt from the job's roleFunction (generic fallback). */
export function aiQuestionPromptFor(roleFunctions: readonly string[] | null | undefined): string {
  const rf = pickRoleFunction(roleFunctions)
  return (rf && AI_PROMPT_BY_ROLE[rf]) || GENERIC_AI_PROMPT
}

/** The judge/grounding rubric for the AI question. */
export function aiQuestionRubric(): string {
  return AI_QUESTION_RUBRIC
}

/**
 * Read a job's roleFunction tokens off its raw doc / prescreen config (defensive — the field
 * lives on the job doc as `roleFunction`, occasionally mirrored onto the config).
 */
export function roleFunctionFromJob(
  job: Record<string, unknown> | null | undefined,
  config: Record<string, unknown> | null | undefined,
): string[] {
  const fromJob = job?.roleFunction
  if (Array.isArray(fromJob)) return fromJob.filter((s): s is string => typeof s === "string")
  if (typeof fromJob === "string" && fromJob.trim()) return [fromJob.trim()]
  const fromCfg = config?.roleFunction
  if (Array.isArray(fromCfg)) return fromCfg.filter((s): s is string => typeof s === "string")
  if (typeof fromCfg === "string" && fromCfg.trim()) return [fromCfg.trim()]
  return []
}

/**
 * Cross-session SKIP signal: has the candidate already answered the AI question?
 *   1. durable global tag `pa-users.tags.aiAccelerationUsage` is set (simplest, one read) — OR
 *   2. (backup) the qId was already scored in some prior terminal session.
 * Either → do NOT re-append the question.
 *
 * @param userTags the `pa-users.tags` map (already loaded by the caller).
 * @param priorScoredAiQuestion true if any prior session scored AI_QUESTION_QID.
 */
export function shouldSkipAiQuestion(
  userTags: Record<string, unknown> | null | undefined,
  priorScoredAiQuestion: boolean,
): boolean {
  const tag = userTags?.[AI_USAGE_TAG_FIELD]
  const tagSet =
    typeof tag === "object" && tag !== null
      ? typeof (tag as Record<string, unknown>).value === "string" &&
        ((tag as Record<string, unknown>).value as string).trim().length > 0
      : typeof tag === "string" && tag.trim().length > 0
  return tagSet || priorScoredAiQuestion
}
