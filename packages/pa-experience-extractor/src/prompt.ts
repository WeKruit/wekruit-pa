/**
 * Phase EX1 PR-A — LLM prompt for per-entry skill extraction.
 *
 * Kept in its own file so eval harness can diff prompt revisions
 * without re-importing the whole extractor pipeline.
 */

import type { WorkEntryExtractionInput } from "./types.js"

export const SYSTEM_PROMPT = `You extract skills, industry, and responsibility level from a SINGLE work-history entry.

Output JSON only, matching the provided schema exactly.

Rules:
- extractedSkills: lowercase_snake_case canonical skill identifiers (e.g. "python", "react", "kubernetes", "model_risk_management"). Up to 12. Include both technical tools/languages and meaningful domain skills (e.g. "stakeholder_management"). DO NOT include vague filler ("teamwork", "hard_working").
- The candidate may have provided self-reported skills as a hint. Treat them as candidates ONLY — emit them when this specific work entry's bullets/description/title demonstrate them, omit otherwise. You MAY add skills not in the hint when the entry clearly demonstrates them.
- industryGuess: a free-form lowercase_snake_case industry label (e.g. "financial_services", "renewable_energy", "robotics"). Use "unknown" only when the entry truly carries no industry signal — never invent.
- responsibilityLevel: "individual_contributor" (no reports), "tech_lead" (peer leadership, no HR responsibility), "people_manager" (formal direct reports), "executive" (org/company-level scope), or "unknown".
- confidence: your own 0-1 estimate. Below 0.4 means the entry was too thin to extract reliably; downstream may suppress low-confidence outputs.
- Do not fabricate. If bullets are empty and the title is generic, return few skills with low confidence.`

/**
 * Build the user-side prompt body from a single {@link WorkEntryExtractionInput}.
 * Pure string assembly — no I/O — so test harness can pin exact wording.
 */
export function buildUserPrompt(input: WorkEntryExtractionInput): string {
  const datePart =
    input.startDate || input.endDate
      ? `Dates: ${input.startDate ?? "(unknown start)"} → ${input.endDate ?? "present"}`
      : "Dates: (unknown)"
  const candidate =
    input.candidateSkills.length > 0
      ? `Self-reported skill hints (candidates only): ${input.candidateSkills.slice(0, 30).join(", ")}`
      : "Self-reported skill hints: (none)"
  const description =
    input.description && input.description.trim().length > 0
      ? `Description: ${input.description.trim().slice(0, 2000)}`
      : "Description: (none)"
  const bullets =
    input.bullets.length > 0
      ? `Bullets:\n${input.bullets.map((b, i) => `  ${i + 1}. ${b.trim().slice(0, 500)}`).join("\n")}`
      : "Bullets: (none)"
  const achievements =
    input.achievements.length > 0
      ? `Achievements:\n${input.achievements.map((b, i) => `  ${i + 1}. ${b.trim().slice(0, 500)}`).join("\n")}`
      : ""

  return [
    `Title: ${input.title}`,
    `Company: ${input.company}`,
    datePart,
    candidate,
    description,
    bullets,
    achievements,
  ]
    .filter((p) => p.length > 0)
    .join("\n")
}
