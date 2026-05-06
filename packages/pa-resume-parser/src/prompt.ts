/**
 * iter30 WS1 / Phase 53 — System + user prompt for parseResume v2.
 *
 * Lang-hint plumbing: when the caller knows the resume language, we tell
 * the LLM to keep `inferredAnswers` text in that language. Without a hint,
 * the model auto-detects from the resume body.
 *
 * Phase 53 (PARSE-03..PARSE-05): extends the prompt to extract
 * `relevantIndustry`, `relevantSpecialization`, `proposedTags`. The
 * `INDUSTRY_SECTOR_VOCAB` enum is embedded inline so the model can pick
 * canonical tokens directly. Abbreviations (`swe`, `pm`, `k8s`, ...) are
 * explicitly rejected — model must use spelled-out form.
 */

/**
 * Phase 53 — copy of `INDUSTRY_SECTOR_VOCAB` from
 * `@wekruit/shared-tags/canonical/industry-sector` embedded as a string for
 * prompt injection. Kept inline (rather than imported) because this file is
 * a bundled prompt artifact and we want zero runtime dep on shared-tags
 * for the parser package's prompt-build path.
 */
const INDUSTRY_SECTOR_PROMPT_LIST = [
  "artificial_intelligence_and_machine_learning",
  "financial_technology",
  "healthcare_and_life_sciences",
  "biotechnology_and_pharmaceuticals",
  "software_and_saas",
  "hardware_and_semiconductors",
  "e_commerce_and_retail",
  "consumer_goods",
  "cybersecurity",
  "crypto_web3_blockchain",
  "gaming_and_esports",
  "education_technology",
  "real_estate_and_proptech",
  "transportation_and_logistics",
  "automotive_and_mobility",
  "aerospace_and_defense",
  "energy_and_utilities",
  "clean_energy_and_climate_tech",
  "manufacturing_and_industrial",
  "construction_and_built_environment",
  "agriculture_and_foodtech",
  "hospitality_and_travel",
  "media_and_entertainment",
  "advertising_and_marketing",
  "telecommunications",
  "professional_services",
  "legal_services",
  "accounting_and_audit",
  "management_consulting",
  "human_resources_and_recruiting",
  "non_profit_and_social_impact",
  "public_sector_and_government",
  "research_and_academia",
  "sports_and_recreation",
  "fashion_and_apparel",
  "beauty_and_personal_care",
  "arts_and_culture",
  "accessibility_and_assistive_technology",
  "robotics_and_automation",
  "quantum_computing",
  "space_technology",
  "technology_general",
] as const

const SPECIALIZATION_EXAMPLES = [
  "frontend_development",
  "backend_development",
  "mobile_development",
  "platform_engineering",
  "site_reliability_engineering",
  "infrastructure_security",
  "application_security",
  "data_engineering",
  "data_science",
  "machine_learning_engineering",
  "mlops",
  "natural_language_processing",
  "computer_vision",
  "payments_compliance",
  "fraud_and_risk",
  "growth_engineering",
  "developer_tools",
  "developer_experience",
  "embedded_systems",
  "robotics",
  "quantitative_research",
  "trading_systems",
] as const

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

──────────────────────────────────────────────────────────────────────
Phase 53 — relevantIndustry / relevantSpecialization / proposedTags
──────────────────────────────────────────────────────────────────────

ALL extracted tokens MUST be lowercase + underscore-separated. NO abbreviations
(write \`software_engineering\` NOT \`swe\`; \`product_management\` NOT \`pm\`;
\`san_francisco_bay_area\` NOT \`sf\`; \`kubernetes\` NOT \`k8s\`).

For relevantIndustry: extract up to 6 industry sectors that describe the
COMPANIES this candidate has worked at (or that are otherwise central to
their experience). Pick from this CLOSED enum (use these exact tokens):

${INDUSTRY_SECTOR_PROMPT_LIST.join(", ")}

If no listed sector fits, omit it — do NOT invent new tokens here.

For relevantSpecialization: extract up to 6 sub-domain expertise tokens
that describe what the candidate does at a finer grain than role-function.
Open vocab (lowercase + underscore). Examples:

${SPECIALIZATION_EXAMPLES.join(", ")}

For proposedTags: extract up to 12 niche, candidate-specific tags that DO
NOT fit \`relevantIndustry\` or \`relevantSpecialization\`. Lowercase +
underscore, must start with a letter, 2-80 chars. Examples:
\`large_language_model_training\`, \`b2b_saas\`, \`creator_economy\`,
\`quantitative_trading\`. NEVER emit abbreviations such as \`swe\`, \`pm\`,
\`tpm\`, \`k8s\`, \`js\`, \`ts\`, \`ml\`, \`ai\`, \`hr\`, \`ux\`, \`ui\`, \`saas\`, \`nyc\`,
\`sf\`, \`la\`, \`uk\`, \`us\`, \`eu\`, \`ceo\`, \`cto\`, etc. — spell them out
(\`software_engineering\`, \`new_york_city\`, \`united_states\`, etc.).
For "saas" specifically, use the canonical industrySector token
\`software_and_saas\` — do NOT invent \`software_as_a_service\`.

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
