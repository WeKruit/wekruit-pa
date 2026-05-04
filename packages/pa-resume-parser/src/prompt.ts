/**
 * iter30 WS1 — System + user prompt for parseResume v2.
 *
 * Lang-hint plumbing: when the caller knows the resume language, we tell
 * the LLM to keep `inferredAnswers` text in that language. Without a hint,
 * the model auto-detects from the resume body.
 */

export const SYSTEM_PROMPT = `You are a resume parser. Extract structured data from the CV text.
Be accurate; null when unknown. Match the user's resume language for inferred answers
(zh resume → zh answers; en resume → en answers; mixed → user's dominant language).

For workHistory.bullets: split each job description into individual sentences. Each bullet = one responsibility.
For skills: extract individual atomic skills, NOT categories. "Python, Java" → ["Python", "Java"].
For totalYearsExperience: compute from earliest start to latest end across workHistory.
For inferredAnswers: generate 7-9 entries covering common recruiter questions:
  years experience, highest education, current/most-recent title, work-authorization,
  relocation willingness, salary range (if inferable), start date, remote-preference,
  sponsorship need.

For every property listed in the schema's required array, emit a value (use null for
missing string fields, [] for missing arrays). parseConfidence ∈ [0, 1] = your subjective
confidence in the extraction (0.5 if resume text is short/noisy; ≥0.7 for dense, well-formed CVs).`

export type LangHint = "zh" | "en" | "mixed"

export function buildSystemPrompt(langHint?: LangHint): string {
  if (!langHint) return SYSTEM_PROMPT
  const hint =
    langHint === "zh"
      ? "\n\nLANG HINT: resume is primarily Chinese — produce inferredAnswers in Chinese."
      : langHint === "en"
        ? "\n\nLANG HINT: resume is primarily English — produce inferredAnswers in English."
        : "\n\nLANG HINT: resume is mixed zh+en — match the dominant language per inferredAnswer."
  return SYSTEM_PROMPT + hint
}

export function buildUserPrompt(resumeText: string): string {
  return `Resume text:\n\n${resumeText}`
}
