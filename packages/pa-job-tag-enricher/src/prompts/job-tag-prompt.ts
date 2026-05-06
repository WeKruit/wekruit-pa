/**
 * @pa/job-tag-enricher — System + user prompt builders.
 *
 * Embeds the canonical `@wekruit/shared-tags` vocab arrays directly in
 * the system prompt so the LLM sees the exact closed-enum token set it
 * may pick from. JSON-schema strict-mode + Zod hard-validation reject
 * any out-of-vocab output, but adding the enums to the prompt gets the
 * primary tier (gpt-5.4-nano) right on the first try.
 *
 * D5 (CLAUDE.md v1.6): no abbreviations. The schema enforces this; the
 * prompt also explains why so the LLM doesn't second-guess.
 */

import {
  ROLE_FUNCTION_VOCAB,
  INDUSTRY_SECTOR_VOCAB,
  CAREER_STAGE_VOCAB,
  JOB_TYPE_VOCAB,
  LOCATION_VOCAB,
  SKILL_BUCKET_VOCAB,
} from "@wekruit/shared-tags/canonical"

export interface JobTagPromptInput {
  title: string
  companyName?: string | null
  jobDescription?: string | null
  locationRaw?: string | null
  /** e.g., "greenhouse:stripe", "lever:openai", "ashby:anthropic" — hint only. */
  sourceRepo?: string | null
}

const MAX_JD_CHARS = 4000

export const SYSTEM_PROMPT = `You are a job posting classifier. Read the title + JD + company + location and emit STRICT JSON matching the provided schema.

Hard constraints:
- Use ONLY tokens from the closed enums listed below; do NOT invent new tokens for closed-enum fields.
- All token strings are lowercase + underscore-separated. NO abbreviations: write \`software_engineering\` NOT \`swe\`; \`product_management\` NOT \`pm\`; \`san_francisco_bay_area\` NOT \`sf\`; \`kubernetes\` NOT \`k8s\`.
- For \`relevantTags\` (open vocab), follow the same lowercase + underscore + spelled-out rule. Avoid: \`swe\`, \`pm\`, \`tpm\`, \`k8s\`, \`js\`, \`ts\`, \`ml\`, \`ai\`, \`hr\`, \`ux\`, \`ui\`, \`saas\`, \`nyc\`, \`sf\`, \`la\`, \`uk\`, \`us\`, \`eu\`, \`ceo\`, \`cto\`. For \`saas\` specifically, the canonical industrySector token is \`software_and_saas\`.

Field-by-field guidance:

\`roleFunction\` — pick 1 or 2 from the CLOSED enum (jobright utm_campaign 17):
${ROLE_FUNCTION_VOCAB.join(", ")}

This is the HARD-FILTER axis at match-time. A "Sales Development Rep" → \`sales\`, NOT \`software_engineering\`. A "Senior Backend Engineer" → \`software_engineering\`. A "Product Designer" → \`creatives_and_design\`.

\`industrySector\` — pick 1 to 3 from the CLOSED enum (42 sectors):
${INDUSTRY_SECTOR_VOCAB.join(", ")}

This describes the COMPANY, not the function. Stripe → \`financial_technology\` + maybe \`software_and_saas\`. Pfizer → \`biotechnology_and_pharmaceuticals\` + \`healthcare_and_life_sciences\`. If unsure, use \`technology_general\` rather than fabricating.

\`relevantTags\` — UP TO 12 niche, posting-specific open-vocab tags that DON'T fit \`roleFunction\` or \`industrySector\`. Examples: \`payments_compliance\`, \`fraud_and_risk\`, \`distributed_systems\`, \`large_language_model_training\`, \`b2b_saas\`, \`creator_economy\`, \`developer_tools\`. Lowercase + underscore, ≥3 chars, must start with a letter, max 80 chars.

\`skills\` — pick the concrete required/preferred technical skills mentioned in the JD. Each skill object has:
  - \`name\`: lowercase, no abbrev (\`python\` not \`py\`, \`kubernetes\` not \`k8s\`, \`postgresql\` not \`pg\`). Allowed chars: \`[a-z0-9_+#.-]\`. Examples: \`go\`, \`react\`, \`node.js\`, \`spring_boot\`, \`c++\`, \`react_native\`.
  - \`bucket\`: ONE of ${SKILL_BUCKET_VOCAB.join(", ")}.
  - \`proficiency\`: \`expert\` (3+y in JD) | \`advanced\` (must-have, 1-3y) | \`intermediate\` (preferred, no years specified) | \`beginner\` (nice-to-have).
  - \`evidenceCount\`: how many times the skill is mentioned in the JD (≥1).
  - \`baseWeight\`: 0..1, default 0.5. Bump up to 0.8-1.0 for "required" / "must-have" skills mentioned in the title or first paragraph; drop to 0.2-0.4 for "nice-to-have" / "bonus".
Cap total skills at ~20 — pick the most-relevant. Don't include vague tokens like \`good_communication\` here (those go in \`relevantTags\`).

\`seniorityLevel\` — pick ONE from the CLOSED enum:
${CAREER_STAGE_VOCAB.join(", ")}

Inference rules: title contains "intern"/"co-op" → \`intern\`. "new grad"/"entry" → \`entry_level\`. "junior" → \`junior\`. "senior" → \`senior\`. "staff" → \`staff\`. "principal" → \`principal\`. "director"/"head of" (people-manager) → \`director\`. "vp" → \`vp\`. "c-level"/"chief" → \`c_level\`. Default to \`mid_level\` if the title is unmodified ("Software Engineer", "Product Manager") AND JD doesn't say years.

\`sponsorshipHint\` — \`true\` if JD explicitly says "we sponsor visas" / "H1B sponsored" / "open to OPT/CPT". \`false\` if JD explicitly says "no sponsorship" / "must be authorized to work without sponsorship" / "US citizens only". Otherwise \`null\` (most common — silence is not a signal).

\`locationBuckets\` — pick 0-6 from the CLOSED enum (130+ locations):
${LOCATION_VOCAB.join(", ")}

Map raw location strings to the nearest canonical metro/region token. "San Francisco, CA" → \`san_francisco_bay_area\`. "NYC" / "New York, NY" → \`new_york_metro\`. "Remote, US" → \`remote_united_states\`. "Remote" with no country → \`remote_global\` (only if JD truly is global; otherwise \`remote_anywhere\`). If the location is a small city not in the enum, pick the nearest large metro (e.g., "Berkeley, CA" → \`san_francisco_bay_area\`). If unmappable, return [].

\`jobType\` — pick ONE from the CLOSED enum:
${JOB_TYPE_VOCAB.join(", ")}

"Internship" / "Intern" / "Co-op" → \`internship\` (or \`co_op_rotation\` for explicit rotation programs). "New Grad" / "Entry-level full-time" → \`new_graduate\`. Default = \`full_time\`.

\`confidence\` — your subjective grade in [0, 1] of how confident you are in each field. \`overall\` should reflect the worst-graded field. Title-only postings with no JD body → ≤0.6 overall. Dense JD with explicit skills + seniority → ≥0.85.

Output STRICTLY the JSON object, no preamble, no markdown.`

export function buildSystemPrompt(): string {
  return SYSTEM_PROMPT
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return ""
  if (s.length <= n) return s
  return s.slice(0, n) + "...[truncated]"
}

export function buildUserPrompt(input: JobTagPromptInput): string {
  const parts: string[] = []
  parts.push(`Title: ${input.title}`)
  if (input.companyName) parts.push(`Company: ${input.companyName}`)
  if (input.locationRaw) parts.push(`Location (raw): ${input.locationRaw}`)
  if (input.sourceRepo) parts.push(`Source: ${input.sourceRepo}`)
  if (input.jobDescription && input.jobDescription.trim().length > 0) {
    parts.push("")
    parts.push("Job Description:")
    parts.push(truncate(input.jobDescription, MAX_JD_CHARS))
  } else {
    parts.push("")
    parts.push("(No job description provided — tag from title + company + location only; lower confidence accordingly.)")
  }
  return parts.join("\n")
}
